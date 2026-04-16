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
