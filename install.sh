#!/usr/bin/env bash
# install.sh — one-liner installer for `mono`.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ilies-bel/mono/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/ilies-bel/mono/main/install.sh | MONO_VERSION=v0.3.0 bash
#   curl -fsSL https://raw.githubusercontent.com/ilies-bel/mono/main/install.sh | BIN_DIR=~/bin bash
#
# Env overrides:
#   MONO_REPO     owner/repo on GitHub (default: ilies-bel/mono)
#   MONO_VERSION  release tag (default: latest)
#   BIN_DIR       install directory (default: first writable of ~/.local/bin, ~/bin,
#                 /usr/local/bin, /opt/homebrew/bin)

set -euo pipefail

REPO="${MONO_REPO:-ilies-bel/mono}"
VERSION="${MONO_VERSION:-latest}"

err()  { printf 'x %s\n' "$*" >&2; }
info() { printf '• %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }

require() {
  command -v "$1" >/dev/null 2>&1 || { err "missing required tool: $1"; exit 1; }
}
require curl
require uname
require mktemp

pick_bin_dir() {
  if [ -n "${BIN_DIR:-}" ]; then printf '%s\n' "$BIN_DIR"; return; fi
  for dir in "$HOME/.local/bin" "$HOME/bin" "/usr/local/bin" "/opt/homebrew/bin"; do
    if [ -d "$dir" ] && [ -w "$dir" ]; then printf '%s\n' "$dir"; return; fi
  done
  printf '%s\n' "$HOME/.local/bin"
}

# Detect host OS
detect_os() {
  case "$(uname -s)" in
    Darwin)               printf 'darwin\n' ;;
    Linux)                printf 'linux\n' ;;
    MINGW*|MSYS*|CYGWIN*) printf 'windows\n' ;;
    *) err "unsupported OS: $(uname -s)"; exit 1 ;;
  esac
}

# Detect host arch normalized to bun's naming (x64 / arm64)
detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  printf 'x64\n' ;;
    arm64|aarch64) printf 'arm64\n' ;;
    *) err "unsupported arch: $(uname -m)"; exit 1 ;;
  esac
}

# Pick "" or "-baseline" suffix for x64 hosts that lack AVX. bun's regular x64
# builds require AVX; baseline targets older CPUs.
detect_baseline_suffix() {
  local os="$1" arch="$2"
  [ "$arch" = "x64" ] || { printf ''; return; }
  case "$os" in
    darwin)
      if sysctl -n machdep.cpu.features machdep.cpu.leaf7_features 2>/dev/null \
          | tr ' ' '\n' | grep -qx 'AVX1.0'; then
        printf ''
      else
        printf -- '-baseline'
      fi
      ;;
    linux)
      if grep -qw avx /proc/cpuinfo 2>/dev/null; then
        printf ''
      else
        printf -- '-baseline'
      fi
      ;;
    *) printf '' ;;
  esac
}

verify_sha256() {
  local file="$1" expected="$2" actual
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    err "no sha256 tool available (sha256sum or shasum)"; return 1
  fi
  [ "$actual" = "$expected" ] || { err "checksum mismatch: $file"; return 1; }
}

OS="$(detect_os)"
ARCH="$(detect_arch)"
SUFFIX="$(detect_baseline_suffix "$OS" "$ARCH")"
EXT=""; [ "$OS" = "windows" ] && EXT=".exe"
ASSET="mono-${OS}-${ARCH}${SUFFIX}${EXT}"

if [ "$VERSION" = "latest" ]; then
  info "resolving latest release of ${REPO}"
  TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
        | grep -m1 '"tag_name"' \
        | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
  [ -n "$TAG" ] || { err "could not resolve latest tag for ${REPO}"; exit 1; }
else
  TAG="$VERSION"
fi

BASE="https://github.com/${REPO}/releases/download/${TAG}"
BIN_DIR="$(pick_bin_dir)"
LINK="${BIN_DIR}/mono"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

info "downloading ${ASSET} (${TAG})"
if ! curl -fsSL --retry 3 "${BASE}/${ASSET}" -o "${TMP}/${ASSET}"; then
  err "download failed: ${BASE}/${ASSET}"
  err "check that release ${TAG} publishes asset ${ASSET}"
  exit 1
fi

info "verifying checksum"
if curl -fsSL "${BASE}/SHA256SUMS" -o "${TMP}/SHA256SUMS" 2>/dev/null; then
  EXPECTED="$(grep -E "[[:space:]]${ASSET}\$" "${TMP}/SHA256SUMS" | awk '{print $1}' | head -n1)"
  if [ -z "$EXPECTED" ]; then
    err "no checksum entry for ${ASSET} in SHA256SUMS"; exit 1
  fi
  verify_sha256 "${TMP}/${ASSET}" "$EXPECTED"
else
  err "could not fetch SHA256SUMS — refusing to install unverified binary"
  exit 1
fi

chmod +x "${TMP}/${ASSET}"

# Strip Gatekeeper quarantine on macOS so the binary launches without prompts.
if [ "$OS" = "darwin" ]; then
  xattr -d com.apple.quarantine "${TMP}/${ASSET}" 2>/dev/null || true
fi

mkdir -p "$BIN_DIR"
if [ -e "$LINK" ] && [ ! -f "$LINK" ] && [ ! -L "$LINK" ]; then
  err "${LINK} exists and is not a regular file or symlink — aborting"; exit 1
fi
mv -f "${TMP}/${ASSET}" "$LINK"
ok "installed mono → ${LINK}"

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
    if [ "$shell_name" = "fish" ]; then
      echo "  Add to ${rc}:  fish_add_path ${BIN_DIR}"
    else
      echo "  Add to ${rc}:  export PATH=\"${BIN_DIR}:\$PATH\""
    fi
    ;;
esac

"$LINK" --version 2>/dev/null || true
