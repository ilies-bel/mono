# mono

Bun + TypeScript implementation of `mono`. JSON-first output, typed error codes, parallel git operations across the parent repo and its two d2r2 submodules.

Full user-facing docs: [./mono.md](./mono.md).

## Dev

```bash
bun install
bun test                 # unit + integration (125+ tests)
bun test --coverage      # coverage report
bun run dev -- ls        # run without compiling
bun run build            # produces dist/mono (static binary)
bun run typecheck        # tsc --noEmit
```

## Install

Homebrew (macOS / Linux):

```bash
brew install ilies-bel/mono/mono
# (the fully-qualified name is required because homebrew-core's `mono`
# is the .NET runtime — `brew install mono` would install that instead.)
```

One-liner (downloads the right prebuilt binary for your OS/arch from the latest GitHub release, verifies SHA-256, installs to `~/.local/bin`):

```bash
curl -fsSL https://raw.githubusercontent.com/ilies-bel/mono/main/install.sh | bash
# pin a version:
curl -fsSL https://raw.githubusercontent.com/ilies-bel/mono/main/install.sh | MONO_VERSION=v0.3.0 bash
# custom dir:
curl -fsSL https://raw.githubusercontent.com/ilies-bel/mono/main/install.sh | BIN_DIR=~/bin bash
```

Supported targets (built by `.github/workflows/release.yml` on each `v*` tag): linux x64 / x64-baseline / arm64, macOS x64 / x64-baseline / arm64 (ad-hoc signed via ldid), windows x64 / x64-baseline.

From a clone:

```bash
bash bootstrap.sh --build   # one-time build + symlink into $PATH
```

### Homebrew tap setup (one-time, repo owner only)

The tap is auto-bumped by the release workflow when both of these are configured on `ilies-bel/mono`:

1. Create the tap repo: `ilies-bel/homebrew-mono` (empty is fine).
2. Add an Actions **variable** `HOMEBREW_TAP_REPO` = `ilies-bel/homebrew-mono`.
3. Add an Actions **secret** `HOMEBREW_TAP_TOKEN` = a fine-grained PAT with `contents: read & write` on `ilies-bel/homebrew-mono`.

After that, every `v*` tag triggers a commit to the tap with the new version and SHAs. To render the formula manually:

```bash
bash scripts/render-formula.sh v0.3.0 > /tmp/mono.rb
```

## Layout

```
src/
  index.ts          # entrypoint + global flags
  skin/             # text vs json output layer
  core/             # registry, git wrappers, repo iteration, schemas
  cmd/              # one file per verb (init/config/new/ls/status/commit/rm/rebase/push/schema)
tests/
  helpers/          # fixture-repo + skin capture
  unit/             # registry, schemas, skin, validators
  integration/      # end-to-end against tmpdir fixtures
  snapshots/        # JSON envelope contract guards
```

Plan: `/Users/ib472e5l/.claude/plans/tender-stirring-sutherland.md`
Epic: `app-6pm`
