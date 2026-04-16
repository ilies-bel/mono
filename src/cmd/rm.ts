// cmd/rm — remove a feature worktree across parent + both submodules and
// unregister it from .mono. Branches are preserved (bash behaviour).
//
// Port of cmd_rm in scripts/mono:460. Notable behaviours:
//
//   * Dirty check — unless `--force`, every existing repo dir is probed with
//     `isClean`. Any dirty repo aborts with DIRTY_WORKTREE and a list of the
//     offending labels; nothing is removed and the registry is untouched.
//   * Sequencing — submodules first (frontend then backend), parent last.
//     Mirrors bash; avoids confusing `git worktree remove` when the parent
//     still has live submodule checkouts underneath it.
//   * Source-of-truth cwd — `git worktree remove <path>` is invoked from the
//     SOURCE repo (project root for the parent, `<root>/<submodule>` for the
//     submodules), not from inside the worktree being removed.
//   * Missing physical dir — tolerated; bash uses `|| true`. We log a warn
//     ("path missing, unregistered only") and flag `removed: false` for that
//     repo so the envelope still reflects the real on-disk state.
//   * Unregister — without --force, only on full success. With --force, the
//     registry entry is always dropped to match bash's "forge ahead" semantic.
//   * Branches — never deleted; the user does that explicitly if needed.
//
// JSON envelope:
//   { name, removed: { parent, frontend, backend }, unregistered }
//
// Error codes: NOT_FOUND · MISSING_REGISTRY · DIRTY_WORKTREE · GIT_FAILED.
// (Name/flag validation beyond `--force` is handled by commander.)

import { Command } from "commander";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { skin } from "../skin/index.ts";
import {
  findProjectRoot,
  findWorktree,
  isInitialized,
  loadRegistry,
  saveRegistry,
  unregisterWorktree,
} from "../core/registry.ts";
import { isClean, worktreeRemove } from "../core/git.ts";
import type { RmData } from "../core/schemas.ts";

const SUBMODULES = ["d2r2-frontend", "d2r2-backend"] as const;
type Submodule = (typeof SUBMODULES)[number];

type RepoLabel = "parent" | Submodule;

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

interface RepoTarget {
  label: RepoLabel;
  /** cwd for the `git worktree remove` invocation (the source repo). */
  sourceCwd: string;
  /** Path of the worktree to remove. */
  wtPath: string;
}

function buildTargets(root: string, wtPath: string): RepoTarget[] {
  // Submodules first, parent last (mirrors bash sequencing).
  const targets: RepoTarget[] = SUBMODULES.map((sub) => ({
    label: sub,
    sourceCwd: join(root, sub),
    wtPath: join(wtPath, sub),
  }));
  targets.push({ label: "parent", sourceCwd: root, wtPath });
  return targets;
}

export function rmCommand(): Command {
  return new Command("rm")
    .description(
      "remove feature/<name> worktree from parent + submodules (branches preserved)",
    )
    .argument("<name>", "worktree name")
    .option("-f, --force", "remove even when working trees are dirty", false)
    .action(async (name: string, opts: { force?: boolean }) => {
      skin.setCommand("rm");

      const force = Boolean(opts.force);

      // ─── Project root + registry ────────────────────────────────────────
      const root = await findProjectRoot(process.cwd());
      if (!root || !(await isInitialized(root))) {
        skin.fail(
          "MISSING_REGISTRY",
          "not a mono project; run `mono init` first",
        );
        return;
      }

      const reg = await loadRegistry(root);
      const wt = findWorktree(reg, name);
      if (!wt) {
        skin.fail("NOT_FOUND", `worktree not registered: ${name}`);
        return;
      }

      const targets = buildTargets(root, wt.path);

      // ─── Dirty check (skipped with --force) ─────────────────────────────
      if (!force) {
        const dirty: RepoLabel[] = [];
        for (const t of targets) {
          if (!(await dirExists(t.wtPath))) continue;
          let clean: boolean;
          try {
            clean = await isClean(t.wtPath);
          } catch (err) {
            skin.fail(
              "GIT_FAILED",
              err instanceof Error ? err.message : String(err),
              { repo: t.label, path: t.wtPath },
            );
            return;
          }
          if (!clean) dirty.push(t.label);
        }
        if (dirty.length > 0) {
          skin.fail(
            "DIRTY_WORKTREE",
            `dirty working tree(s): ${dirty.join(", ")} — pass --force to remove anyway`,
            { dirty_repos: dirty },
          );
          return;
        }
      }

      // ─── Remove each worktree (submodules first, parent last) ───────────
      const removed: Record<RepoLabel, boolean> = {
        parent: false,
        "d2r2-frontend": false,
        "d2r2-backend": false,
      };
      let anyGitFailure = false;

      for (const t of targets) {
        if (!(await dirExists(t.wtPath))) {
          skin.warn(`${t.label}: path missing, unregistered only`);
          continue;
        }
        // Source repo must exist for `git worktree remove` to work.
        if (!(await dirExists(t.sourceCwd))) {
          skin.warn(`${t.label}: source repo missing at ${t.sourceCwd}`);
          anyGitFailure = true;
          continue;
        }

        // The parent always needs --force once submodules have been removed:
        // git sees the now-missing gitlink dirs as " D" entries and refuses a
        // non-force remove. We've already validated overall cleanliness via
        // the dirty check above (when !force), so promoting --force for the
        // parent step is safe and matches user intent. Submodule removals
        // honour the user's --force as given.
        const removeForce = force || t.label === "parent";
        const r = await worktreeRemove(t.sourceCwd, t.wtPath, removeForce);
        if (r.ok) {
          removed[t.label] = true;
          skin.info(`${t.label}: removed`);
        } else {
          anyGitFailure = true;
          const detail = (r.stderr || r.stdout).trim();
          skin.warn(`${t.label}: git worktree remove failed: ${detail}`);
        }
      }

      // Best-effort: clean up an empty container dir git left behind on the
      // parent path. Ignore errors (not empty, missing, permission).
      if (await dirExists(wt.path)) {
        try {
          await fs.rmdir(wt.path);
        } catch {
          // intentional: bash does `rmdir 2>/dev/null || true`
        }
      }

      // ─── Unregister ─────────────────────────────────────────────────────
      // With --force we always drop the registry entry (bash "forge ahead").
      // Without --force we only unregister when every git removal succeeded.
      let unregistered = false;
      if (force || !anyGitFailure) {
        const nextReg = unregisterWorktree(reg, name);
        await saveRegistry(root, nextReg);
        unregistered = true;
      }

      if (!force && anyGitFailure) {
        skin.fail(
          "GIT_FAILED",
          "one or more git worktree removals failed — registry not updated",
          { name, removed },
        );
        return;
      }

      const data: RmData = {
        name,
        removed: {
          parent: removed.parent,
          frontend: removed["d2r2-frontend"],
          backend: removed["d2r2-backend"],
        },
        unregistered,
      };

      skin.emit(data);
      skin.info(`removed feature '${name}' (branches preserved)`);
    });
}
