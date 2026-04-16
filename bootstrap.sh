#!/usr/bin/env bash
# bootstrap.sh — symlink `mono` into a directory on PATH so it can be
# called from anywhere. Idempotent: re-running updates the symlink.
#
# Install modes (mutually exclusive):
#   (default)     auto-detect host arch and symlink the matching prebuilt binary
#                 in dist/ (strips quarantine on macOS). No bun needed.
#   --build       bun install + bun run build, then install the shebang wrapper
#                 (needs bun at runtime).
#   --dev         install a wrapper that runs src/index.ts through bun (live
#                 edits, needs bun at runtime).
#   --static      build a standalone binary for the host arch (bun --compile)
#                 and install it. On macOS, ad-hoc signs with `ldid`.
#   --static-all  cross-compile three macOS variants (arm64, x64, x64-baseline),
#                 sign each, then install the one matching the host.
#
# Usage:
#   ./bootstrap.sh                  # auto-pick prebuilt binary for host arch
#   ./bootstrap.sh --build          # bun install + bun run build first
#   ./bootstrap.sh --dev            # install dev wrapper (live src, needs bun)
#   ./bootstrap.sh --static         # standalone binary for host arch
#   ./bootstrap.sh --static-all     # build all macOS variants, install host's
#   BIN_DIR=~/bin ./bootstrap.sh    # install to a specific directory
#   ./bootstrap.sh --uninstall      # remove the symlink

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONO_TS_DIR="${SCRIPT_DIR}"
DIST_DIR="${MONO_TS_DIR}/dist"
MONO_TS_BIN="${DIST_DIR}/mono"
MONO_X64_BIN="${DIST_DIR}/mono-darwin-x64"
MONO_X64_BASELINE_BIN="${DIST_DIR}/mono-darwin-x64-baseline"
MONO_TS_SRC="${MONO_TS_DIR}/src/index.ts"
DEV_WRAPPER_DIR="/Users/ib472e5l/project/perso/tools/mono-dev"
DEV_WRAPPER="${DEV_WRAPPER_DIR}/mono"

BUILD=0
UNINSTALL=0
DEV=0
STATIC=0
STATIC_ALL=0
for arg in "$@"; do
  case "$arg" in
    --build)      BUILD=1 ;;
    --uninstall)  UNINSTALL=1 ;;
    --dev)        DEV=1 ;;
    --static)     STATIC=1 ;;
    --static-all) STATIC_ALL=1 ;;
    -h|--help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "x unknown argument: $arg" >&2; exit 2 ;;
  esac
done

mode_count=$((BUILD + DEV + STATIC + STATIC_ALL))
if [ "$mode_count" -gt 1 ]; then
  echo "x --build, --dev, --static, and --static-all are mutually exclusive" >&2
  exit 2
fi

pick_bin_dir() {
  if [ -n "${BIN_DIR:-}" ]; then
    printf '%s\n' "$BIN_DIR"; return 0
  fi
  local candidates=(
    "${HOME}/.local/bin"
    "${HOME}/bin"
    "/usr/local/bin"
    "/opt/homebrew/bin"
  )
  local dir
  for dir in "${candidates[@]}"; do
    if [ -d "$dir" ] && [ -w "$dir" ]; then
      printf '%s\n' "$dir"; return 0
    fi
  done
  printf '%s\n' "${HOME}/.local/bin"
}

BIN_DIR="$(pick_bin_dir)"
LINK="${BIN_DIR}/mono"

if [ "$UNINSTALL" -eq 1 ]; then
  if [ -L "$LINK" ] || [ -e "$LINK" ]; then
    rm -f "$LINK"
    echo "✓ removed ${LINK}"
  else
    echo "! nothing to remove at ${LINK}"
  fi
  exit 0
fi

require_bun() {
  if ! command -v bun >/dev/null 2>&1; then
    echo "x '$1' requires 'bun' on PATH" >&2
    echo "  Install: curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
  fi
}

# bun's --compile appends the bundle payload to the Mach-O, which Apple's
# `codesign` rejects ("invalid or unsupported format for signature"). The
# reliable workaround on macOS is `ldid` (ad-hoc signer from iOS tooling),
# installable via Homebrew.
ensure_ldid() {
  if command -v ldid >/dev/null 2>&1; then
    return 0
  fi
  if command -v brew >/dev/null 2>&1; then
    echo "• installing ldid via Homebrew"
    brew install ldid >/dev/null
    return 0
  fi
  echo "x 'ldid' is required to sign bun-compiled binaries on macOS" >&2
  echo "  Install Homebrew (https://brew.sh) and re-run, or:" >&2
  echo "  brew install ldid" >&2
  exit 1
}

# Detect macOS AVX support via sysctl. AVX appears as "AVX1.0" in the CPU
# feature list. Returns 0 if AVX is present, 1 otherwise (or on error).
host_has_avx() {
  sysctl -n machdep.cpu.features 2>/dev/null | grep -qw AVX1.0
}

# Choose which prebuilt binary matches the host. Prints the absolute path on
# success; prints nothing and returns 1 if no suitable binary exists.
pick_prebuilt_for_host() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  if [ "$os" = "Darwin" ] && [ "$arch" = "arm64" ]; then
    [ -x "$MONO_TS_BIN" ] && printf '%s\n' "$MONO_TS_BIN" && return 0
  elif [ "$os" = "Darwin" ] && [ "$arch" = "x86_64" ]; then
    if host_has_avx && [ -x "$MONO_X64_BIN" ]; then
      printf '%s\n' "$MONO_X64_BIN"; return 0
    fi
    [ -x "$MONO_X64_BASELINE_BIN" ] && printf '%s\n' "$MONO_X64_BASELINE_BIN" && return 0
    [ -x "$MONO_X64_BIN" ] && printf '%s\n' "$MONO_X64_BIN" && return 0
  fi
  # Last-resort fallback: plain dist/mono (whatever it is). Lets Linux /
  # unknown hosts still pick up a binary if one is shipped there.
  [ -x "$MONO_TS_BIN" ] && printf '%s\n' "$MONO_TS_BIN" && return 0
  return 1
}

# Strip com.apple.quarantine so Gatekeeper doesn't block a downloaded binary.
# No-op on non-macOS or when the attribute isn't present.
strip_quarantine() {
  [ "$(uname -s)" = "Darwin" ] || return 0
  xattr -d com.apple.quarantine "$1" 2>/dev/null || true
}

# Cross-compile a single standalone target and ad-hoc sign it. Arguments:
#   $1 = bun --target string (e.g. bun-darwin-arm64)
#   $2 = output path
build_one_static() {
  local target="$1" out="$2"
  echo "• compiling ${out} (target=${target})"
  (cd "$MONO_TS_DIR" && bun build src/index.ts --compile --minify \
    --target="$target" --outfile "$out")
  if [ ! -x "$out" ]; then
    echo "x build did not produce ${out}" >&2
    exit 1
  fi
  if [ "$(uname -s)" = "Darwin" ]; then
    strip_quarantine "$out"
    ensure_ldid
    ldid -S "$out"
  fi
}

if [ "$DEV" -eq 1 ]; then
  # Dev mode: wrapper that runs src/index.ts via bun.
  require_bun --dev
  if [ ! -f "$MONO_TS_SRC" ]; then
    echo "x mono source not found at ${MONO_TS_SRC}" >&2
    exit 1
  fi
  mkdir -p "$DEV_WRAPPER_DIR"
  if [ ! -d "${MONO_TS_DIR}/node_modules" ]; then
    echo "• installing deps in ${MONO_TS_DIR}"
    (cd "$MONO_TS_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)
  fi
  cat >"$DEV_WRAPPER" <<EOF
#!/usr/bin/env bash
# Generated by $(basename "$0") on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Runs mono's TypeScript source directly via bun. Edits to src/ are live.
# Regenerate via: bash ${SCRIPT_DIR}/$(basename "$0") --dev
exec bun "${MONO_TS_SRC}" "\$@"
EOF
  chmod +x "$DEV_WRAPPER"
  echo "✓ wrote dev wrapper ${DEV_WRAPPER}"
  MONO_SRC="$DEV_WRAPPER"

elif [ "$STATIC" -eq 1 ]; then
  # Host-arch standalone binary into dist/mono.
  require_bun --static
  echo "• installing deps in ${MONO_TS_DIR}"
  (cd "$MONO_TS_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)
  (cd "$MONO_TS_DIR" && bun run build:static)
  if [ ! -x "$MONO_TS_BIN" ]; then
    echo "x build did not produce ${MONO_TS_BIN}" >&2
    exit 1
  fi
  if [ "$(uname -s)" = "Darwin" ]; then
    strip_quarantine "$MONO_TS_BIN"
    ensure_ldid
    echo "• ad-hoc signing ${MONO_TS_BIN} with ldid"
    ldid -S "$MONO_TS_BIN"
  fi
  MONO_SRC="$MONO_TS_BIN"

elif [ "$STATIC_ALL" -eq 1 ]; then
  # Cross-compile all three macOS variants. Always emits arm64 into dist/mono
  # so the default-mode picker finds it on Apple Silicon.
  require_bun --static-all
  echo "• installing deps in ${MONO_TS_DIR}"
  (cd "$MONO_TS_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)
  build_one_static bun-darwin-arm64          "$MONO_TS_BIN"
  build_one_static bun-darwin-x64            "$MONO_X64_BIN"
  build_one_static bun-darwin-x64-baseline   "$MONO_X64_BASELINE_BIN"
  MONO_SRC="$(pick_prebuilt_for_host || true)"
  if [ -z "${MONO_SRC:-}" ]; then
    echo "x no matching binary for host $(uname -sm) after --static-all" >&2
    exit 1
  fi

else
  # Default mode: install a prebuilt binary chosen by host arch. Also supports
  # --build which runs the TS build first and installs the shebang wrapper.
  if [ "$BUILD" -eq 1 ]; then
    require_bun --build
    echo "• building TS mono in ${MONO_TS_DIR}"
    (cd "$MONO_TS_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)
    (cd "$MONO_TS_DIR" && bun run build)
  fi

  MONO_SRC="$(pick_prebuilt_for_host || true)"
  if [ -z "${MONO_SRC:-}" ]; then
    echo "x no mono binary found for host $(uname -sm)" >&2
    echo "  Expected one of:" >&2
    echo "    ${MONO_TS_BIN}" >&2
    echo "    ${MONO_X64_BIN}" >&2
    echo "    ${MONO_X64_BASELINE_BIN}" >&2
    echo "  Run: bash ${SCRIPT_DIR}/bootstrap.sh --build       (shebang wrapper)" >&2
    echo "   or: bash ${SCRIPT_DIR}/bootstrap.sh --static      (host-arch binary)" >&2
    echo "   or: bash ${SCRIPT_DIR}/bootstrap.sh --static-all  (all macOS variants)" >&2
    echo "   or: bash ${SCRIPT_DIR}/bootstrap.sh --dev         (live source wrapper)" >&2
    exit 1
  fi
  # Important for redistributed binaries: strip Gatekeeper quarantine so a
  # downloaded dist/mono-* doesn't SIGKILL on first launch.
  strip_quarantine "$MONO_SRC"
fi

mkdir -p "$BIN_DIR"

if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  echo "x ${LINK} exists and is not a symlink — aborting" >&2
  exit 1
fi

ln -sfn "$MONO_SRC" "$LINK"
echo "✓ linked ${LINK} -> ${MONO_SRC}"

case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *)
    echo
    echo "! ${BIN_DIR} is not on your PATH."
    shell_name="$(basename "${SHELL:-bash}")"
    case "$shell_name" in
      zsh)  rc="~/.zshrc" ;;
      bash) rc="~/.bashrc" ;;
      fish) rc="~/.config/fish/config.fish" ;;
      *)    rc="your shell rc file" ;;
    esac
    echo "  Add this to ${rc}:"
    if [ "$shell_name" = "fish" ]; then
      echo "    fish_add_path ${BIN_DIR}"
    else
      echo "    export PATH=\"${BIN_DIR}:\$PATH\""
    fi
    ;;
esac
