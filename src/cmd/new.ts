// cmd/new — create a matching feature/<name> branch + worktree on parent and
// both submodules, then (if needed) commit an aligning gitlink snapshot on
// the parent worktree so its feature branch tracks the submodule HEADs from
// commit zero.
//
// Port of cmd_new in scripts/mono:104. Notable behaviours:
//
//   * Name validation — `^[a-z0-9][a-z0-9-]*$`. Invalid → BAD_NAME.
//   * Path resolution — explicit positional arg wins; else config
//     `worktree-base` joined with <name>; else default
//     `<project_root>/.mono/worktrees/<name>`.
//   * Branch reuse — if `feature/<name>` already exists locally in a given
//     repo, the worktree is attached to the existing branch (`created: reused`)
//     instead of creating a new one (`created: created`). Mirrors the bash
//     `has_local_branch` fast-path that drops `-b` and `<base>`.
//   * Submodule placeholder dirs — the parent worktree materialises empty
//     directories at each submodule path; we drop them (after confirming they
//     are empty) before `git worktree add` inside the submodule repo.
//   * Gitlink alignment — after all three worktrees exist, `git add
//     d2r2-frontend d2r2-backend` in the parent worktree; if the index differs
//     from HEAD, auto-commit `chore: align submodule heads for <name>`.
//   * Rollback — if any step after the parent worktree was created fails, we
//     best-effort remove the parent worktree so the user isn't left with an
//     orphaned checkout. Submodule worktrees are intentionally NOT unwound if
//     one of them is the failing step; a follow-up `mono rm` is cheaper than
//     silently hiding half-created state.

import { Command } from "commander";
import { access, mkdir, readdir, rmdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { skin } from "../skin/index.ts";
import {
  defaultWorktreeBase,
  findProjectRoot,
  getConfig,
  isInitialized,
  isRegistered,
  loadRegistry,
  registerWorktree,
  saveRegistry,
} from "../core/registry.ts";
import { assertParentRoot } from "../core/repos.ts";
import {
  add as gitAdd,
  commit as gitCommit,
  hasLocalBranch,
  statusPorcelain,
  worktreeAdd,
  worktreeRemove,
} from "../core/git.ts";
import type { NewData, WorktreeCreatedState } from "../core/schemas.ts";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const SUBMODULES = ["d2r2-frontend", "d2r2-backend"] as const;

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function dirIsEmpty(p: string): Promise<boolean> {
  const entries = await readdir(p);
  return entries.length === 0;
}

/**
 * Add a worktree for `branch` at `wtPath` rooted at `repoCwd`. If the branch
 * already exists locally we reuse it (no base required); otherwise create it
 * off `base`. Mirrors the bash has_local_branch / has_remote_branch ladder
 * simplified: `base` may be a local name or `origin/<name>` — caller decides.
 */
async function addWorktreeReuseOrCreate(
  repoCwd: string,
  wtPath: string,
  branch: string,
  base: string,
): Promise<WorktreeCreatedState> {
  if (await hasLocalBranch(repoCwd, branch)) {
    const r = await worktreeAdd(repoCwd, wtPath, branch);
    if (!r.ok) {
      throw new Error(
        `git worktree add ${wtPath} ${branch} failed in ${repoCwd}: ${r.stderr.trim() || r.stdout.trim()}`,
      );
    }
    return "reused";
  }
  const r = await worktreeAdd(repoCwd, wtPath, branch, base);
  if (!r.ok) {
    throw new Error(
      `git worktree add -b ${branch} ${wtPath} ${base} failed in ${repoCwd}: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  return "created";
}

export function newCommand(): Command {
  return new Command("new")
    .description(
      "create feature/<name> branch + worktree across parent + submodules",
    )
    .argument("<name>", "feature name (lowercase letters, digits, hyphens)")
    .argument("[path]", "worktree path (overrides worktree-base config)")
    .argument("[base]", "base branch (default: main)")
    .action(
      async (
        name: string,
        pathArg: string | undefined,
        baseArg: string | undefined,
      ) => {
        skin.setCommand("new");

        // ─── Name validation ─────────────────────────────────────────────
        if (!NAME_RE.test(name)) {
          skin.fail(
            "BAD_NAME",
            `invalid name '${name}' — use lowercase letters, digits, hyphens`,
            { name },
          );
          return;
        }

        // ─── Project root + registry ────────────────────────────────────
        const root = await findProjectRoot(process.cwd());
        if (!root || !(await isInitialized(root))) {
          skin.fail(
            "MISSING_REGISTRY",
            "not a mono project; run `mono init` first",
          );
          return;
        }

        try {
          await assertParentRoot(root);
        } catch (err) {
          skin.fail(
            "NOT_MONO_ROOT",
            err instanceof Error ? err.message : String(err),
            { path: root },
          );
          return;
        }

        const reg = await loadRegistry(root);
        if (isRegistered(reg, name)) {
          skin.fail(
            "ALREADY_EXISTS",
            `worktree already registered: ${name}`,
            { name },
          );
          return;
        }

        // ─── Resolve path + base ────────────────────────────────────────
        const base = baseArg ?? "main";
        const branch = `feature/${name}`;

        let wtPath: string;
        if (pathArg) {
          wtPath = isAbsolute(pathArg)
            ? pathArg
            : resolve(process.cwd(), pathArg);
        } else {
          const configured = getConfig(reg, "worktree-base");
          const baseDir = configured && configured.length > 0
            ? configured
            : defaultWorktreeBase(root);
          wtPath = join(baseDir.replace(/\/+$/u, ""), name);
        }

        if (await pathExists(wtPath)) {
          skin.fail(
            "ALREADY_EXISTS",
            `worktree dir already exists: ${wtPath}`,
            { path: wtPath },
          );
          return;
        }

        // Ensure parent dir exists (mirrors bash `mkdir -p "$(dirname "$wt")"`).
        await mkdir(dirname(wtPath), { recursive: true });

        skin.info(
          `creating feature '${name}' (branch: ${branch}, base: ${base})`,
        );

        // ─── Parent worktree ────────────────────────────────────────────
        skin.info(`  parent worktree @ ${wtPath}`);
        let parentCreated: WorktreeCreatedState;
        try {
          parentCreated = await addWorktreeReuseOrCreate(
            root,
            wtPath,
            branch,
            base,
          );
        } catch (err) {
          skin.fail(
            "GIT_FAILED",
            err instanceof Error ? err.message : String(err),
          );
          return;
        }

        // ─── Submodule worktrees ────────────────────────────────────────
        const submoduleStates: Record<string, WorktreeCreatedState> = {};
        try {
          for (const sub of SUBMODULES) {
            const subSrc = join(root, sub);
            const subPath = join(wtPath, sub);

            if (!(await pathExists(subSrc))) {
              // Preserve shape of the bash warning — but this is genuinely
              // abnormal in the monorepo contract, so fail hard.
              throw new Error(`submodule source missing: ${subSrc}`);
            }

            if (await pathExists(subPath)) {
              if (!(await dirIsEmpty(subPath))) {
                throw new Error(
                  `${subPath} is not empty — refusing to overwrite`,
                );
              }
              await rmdir(subPath);
            }

            skin.info(`  ${sub} worktree @ ${subPath}`);
            const state = await addWorktreeReuseOrCreate(
              subSrc,
              subPath,
              branch,
              base,
            );
            submoduleStates[sub] = state;
          }
        } catch (err) {
          // Rollback: remove parent worktree (best-effort).
          await worktreeRemove(root, wtPath, true).catch(() => undefined);
          skin.fail(
            "GIT_FAILED",
            err instanceof Error ? err.message : String(err),
          );
          return;
        }

        // ─── Gitlink alignment ──────────────────────────────────────────
        let aligned = false;
        try {
          // Stage any submodule HEAD differences relative to parent's base.
          const addRes = await gitAdd(wtPath, [...SUBMODULES]);
          if (!addRes.ok) {
            throw new Error(
              `git add submodules failed: ${addRes.stderr.trim() || addRes.stdout.trim()}`,
            );
          }

          const porcelain = await statusPorcelain(wtPath);
          if (porcelain.trim().length > 0) {
            skin.info("  recording submodule HEADs in parent");
            const commitRes = await gitCommit(
              wtPath,
              `chore: align submodule heads for ${name}`,
              false,
            );
            if (!commitRes.ok) {
              throw new Error(
                `git commit gitlinks failed: ${commitRes.stderr.trim() || commitRes.stdout.trim()}`,
              );
            }
            aligned = true;
          }
        } catch (err) {
          await worktreeRemove(root, wtPath, true).catch(() => undefined);
          skin.fail(
            "GIT_FAILED",
            err instanceof Error ? err.message : String(err),
          );
          return;
        }

        // ─── Register ───────────────────────────────────────────────────
        // Use realpath so we match what registry consumers (tests, tooling)
        // resolve on macOS where /var → /private/var.
        let realPath = wtPath;
        try {
          realPath = await realpath(wtPath);
        } catch {
          // Fallback to the as-computed path.
        }

        const nextReg = registerWorktree(reg, { name, path: realPath });
        await saveRegistry(root, nextReg);

        const data: NewData = {
          name,
          path: realPath,
          branch,
          base,
          created: {
            parent: parentCreated,
            frontend: submoduleStates["d2r2-frontend"] ?? "created",
            backend: submoduleStates["d2r2-backend"] ?? "created",
          },
          aligned,
        };

        skin.emit(data);
        skin.info(`feature '${name}' ready at ${realPath}`);
      },
    );
}
