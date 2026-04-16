# `mono` — monorepo-style CLI for parent + submodules

## Overview

`mono` treats the parent repo and its two submodules (`d2r2-frontend`, `d2r2-backend`) as a single unit. It creates matching `feature/<name>` branches on all three repos, places them in a shared worktree tree under `.qa-worktrees/<name>/`, and provides verbs that operate atomically across the set. The parent worktree's gitlinks track the submodule HEADs, so `commit`, `rebase`, and `push` move the three repos as one. Use `mono` when a feature spans both frontend and backend; for single-subproject work, prefer `fleet add` or `scripts/subworktree-add.sh`.

The implementation is a Bun + TypeScript project at `/Users/ib472e5l/project/perso/tools/mono/`, compiled to a single static binary at `dist/mono`. Output is JSON-first (`--json`), errors are typed with stable codes, and git ops across the three repos run concurrently.

## Installation

One-time build + symlink to `~/.local/bin/mono` (or `$BIN_DIR`):

```bash
cd /Users/ib472e5l/project/perso/tools/mono
bash bootstrap.sh --build   # bun install + bun run build, then symlink
```

Re-run `bash bootstrap.sh` (no flag) after any rebuild to refresh the symlink. `bash bootstrap.sh --uninstall` removes it.

## Subcommands

### `mono init [dir]`

Initialize mono in the parent repo (the one with `.gitmodules`). Creates the empty `.mono` registry.

```bash
mono init                 # current repo
mono init /path/to/parent
```

### `mono config [key] [value]`

Get, set, unset, or list config entries stored in `.mono`.

```bash
mono config                           # list all
mono config worktree.base             # get
mono config worktree.base .worktrees  # set
mono config --unset worktree.base     # remove
```

### `mono new <name> [path] [base]`

Create `feature/<name>` on parent + both submodules, place worktrees at `.qa-worktrees/<name>/{.,d2r2-frontend,d2r2-backend}`, and align the parent gitlinks so the feature branch tracks the submodule feature branches from commit 0.

- `base` defaults to `main`.
- Reuses existing local `feature/<name>` when present; otherwise branches from local `base`, then `origin/base`.

```bash
mono new bundle-idgr-modify
mono new hotfix-x .qa-worktrees/hotfix-x release/2026.04
```

### `mono ls`

List registered worktrees with parent + submodule HEADs.

```bash
mono ls
mono ls --json
```

`--json` envelope data:

```json
{"data": [{"name": "bundle-idgr-modify", "path": ".qa-worktrees/bundle-idgr-modify",
           "parent_head": "a1b2c3d", "submodules": {"d2r2-frontend": "e4f5…", "d2r2-backend": "6789…"}}]}
```

### `mono status <name>`

Run `git status --short --branch` across the three repos in parallel.

```bash
mono status bundle-idgr-modify
mono status bundle-idgr-modify --json
```

### `mono commit <name> -m "msg" [-a]`

Commit across repos with a single message. Submodules first, then parent gitlinks. With `-a`, `git add -A` runs first in each repo. Repos with nothing staged are skipped (no empty commits).

```bash
mono commit bundle-idgr-modify -a -m "feat(bundle): support IDGR modify"
```

### `mono rm <name> [--force|-f]`

Remove all three worktrees. Branches are preserved. Refuses if any working tree is dirty unless `--force` is passed.

```bash
mono rm bundle-idgr-modify
mono rm bundle-idgr-modify --force
```

### `mono rebase <name|all> [upstream] [--keep-going]`

`git fetch origin` in each repo (offline fetch failures warn, don't abort), then rebase submodules first (frontend, backend), then parent. After the parent rebase, if any submodule HEAD moved, stages the gitlinks and `--amend --no-edit`s the parent tip. Default upstream: `origin/main`.

```bash
mono rebase bundle-idgr-modify
mono rebase bundle-idgr-modify origin/release/2026.04
```

Pass `all` to rebase every registered worktree sequentially. By default the command stops at the first conflict so you clean up one partial rebase at a time. `--keep-going` attempts every worktree and returns all conflicts in one envelope:

```bash
mono rebase all
mono rebase all origin/main --keep-going
```

On conflict, exits with `CONFLICT`; re-run the same command after resolving (or re-run per-worktree `mono rebase <name>`).

### `mono push <name>`

Push `feature/<name>` on all three repos via `git-push-or-queue` (VPN-aware queueing). Iterates parent first, then submodules. Honors `BEAD_ID` from env — if set, each push gets `--bead=$BEAD_ID`.

```bash
BEAD_ID=app-123 mono push bundle-idgr-modify
# Once on VPN:
bash /Users/ib472e5l/project/perso/tools/git-push-or-queue/push-exec.sh
```

### `mono schema [cmd]`

Emit JSON Schema for a command's `data` payload. With no argument, lists commands that publish a schema.

```bash
mono schema --json              # list verbs
mono schema ls --json | jq '.data'
```

### `mono help`

Print the verb summary.

## Global flags

| Flag          | Meaning                                                 |
|---------------|---------------------------------------------------------|
| `--json`      | Emit a single JSON envelope on stdout instead of text   |
| `--no-color`  | Disable ANSI colors (auto-off on non-TTY)               |
| `--quiet`     | Suppress `info`-level messages                          |
| `--verbose`   | Emit debug messages                                     |
| `--cwd <dir>` | Run as if invoked from `<dir>`                          |

## Error codes

| Code               | Meaning                                                        |
|--------------------|----------------------------------------------------------------|
| `NOT_MONO_ROOT`    | Current/target dir is not a parent repo (no `.gitmodules`)     |
| `MISSING_REGISTRY` | `.mono` registry not found — run `mono init`                   |
| `BAD_NAME`         | Feature name fails `^[a-z0-9][a-z0-9-]*$`                      |
| `NOT_FOUND`        | Named worktree or config key does not exist                    |
| `ALREADY_EXISTS`   | A worktree with that name / path is already registered         |
| `DIRTY_WORKTREE`   | `rm` without `--force` on a worktree with local changes        |
| `CONFLICT`         | `rebase` stopped mid-flight; resolve then re-run               |
| `OFFLINE`          | Remote unreachable (surface on `push` / `rebase fetch`)        |
| `INVALID_ARGS`     | Missing or malformed CLI arguments                             |
| `GIT_FAILED`       | Unhandled `git` non-zero exit; details in `error.details`      |

## Environment variables

- `BEAD_ID` — when set, `mono push` appends `--bead=$BEAD_ID` to each `git-push-or-queue` invocation so the push queue records the originating bead.
- `BIN_DIR` — consumed by `bootstrap.sh` to pick the install directory.

## JSON envelope

Every `--json` invocation emits one line on stdout, identical shape for every command:

```json
{
  "ok": true,
  "command": "ls",
  "data": [ /* command-specific payload */ ],
  "warnings": [],
  "error": null,
  "meta": { "mono_version": "0.3.0", "elapsed_ms": 42 }
}
```

On failure: `ok: false`, `data: null`, and `error: { "code": "…", "message": "…", "details": {…} }`. Use `mono schema <cmd> --json` to pull the JSON Schema for a given command's `data` shape.

## Tests

```bash
cd /Users/ib472e5l/project/perso/tools/mono
bun test                 # unit + integration (125+ tests)
bun test --coverage      # bun run coverage; standards.md target: ≥80%
bun test tests/integration/   # end-to-end against fixture bare repos
```

Integration tests build throwaway bare parent + submodule repos in a tmpdir and exercise the full new → commit → rebase → push → rm flow. Snapshot tests in `tests/snapshots/` guard the JSON envelope contract per command.

## Architecture

- `src/skin/` — output layer. `text.ts` (colored TTY) or `json.ts` (buffered envelope). Commands never call `console.log`.
- `src/core/` — `registry.ts` (`.mono` read/write), `git.ts` (typed `execa` wrappers), `repos.ts` (parent + submodule iteration), `schemas.ts` (zod per-command shapes, exported as JSON Schema).
- `src/cmd/` — one file per verb. Each exports a `commander` subcommand wired to the skin and core.

See `README.md` for dev commands.
