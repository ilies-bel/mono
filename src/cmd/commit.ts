// cmd/commit — commit staged changes across parent + submodules for a
// worktree, using the same message for each repo.
//
// Port of cmd_commit in scripts/mono:292. Notable behaviours:
//
//   * `-m <message>` is required. Missing → INVALID_ARGS.
//   * `-a / --add-all` stages everything in each submodule before deciding
//     whether to commit it.
//   * Sequencing matters: submodules are processed sequentially (frontend
//     then backend) BEFORE the parent. The parent stages the two submodule
//     gitlinks after the submodule commits, so the parent commit captures
//     the freshly-moved HEADs. Parallelising this would lose that ordering.
//   * A repo with no staged changes is skipped; we still record it in the
//     result with `committed: false, reason: "nothing-staged"`.
//   * The parent commit only stages the two submodule gitlinks (`git add
//     d2r2-frontend d2r2-backend`), mirroring the bash implementation —
//     parent-only working-tree changes are not auto-staged.

import { Command } from "commander";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { skin } from "../skin/index.ts";
import {
  findProjectRoot,
  isInitialized,
  loadRegistry,
  findWorktree,
} from "../core/registry.ts";
import {
  add as gitAdd,
  addAll as gitAddAll,
  commit as gitCommit,
  hasStagedChanges,
  head as gitHead,
} from "../core/git.ts";
import type { CommitData, CommitRepo } from "../core/schemas.ts";

const SUBMODULES = ["d2r2-frontend", "d2r2-backend"] as const;
type Submodule = (typeof SUBMODULES)[number];

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

interface CommitStepResult {
  committed: boolean;
  sha: string | null;
  reason: "committed" | "nothing-staged";
}

async function commitIfStaged(
  cwd: string,
  message: string,
): Promise<CommitStepResult> {
  if (!(await hasStagedChanges(cwd))) {
    return { committed: false, sha: null, reason: "nothing-staged" };
  }
  const r = await gitCommit(cwd, message, false);
  if (!r.ok) {
    throw new Error(
      `git commit failed in ${cwd}: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  const sha = await gitHead(cwd);
  return { committed: true, sha, reason: "committed" };
}

export function commitCommand(): Command {
  return new Command("commit")
    .description(
      "commit staged changes in each submodule then the parent gitlinks",
    )
    .argument("<name>", "worktree name")
    .requiredOption("-m, --message <message>", "commit message")
    .option("-a, --add-all", "run `git add -A` in each submodule first", false)
    .action(
      async (
        name: string,
        opts: { message: string; addAll?: boolean },
      ) => {
        skin.setCommand("commit");

        const message = opts.message;
        if (!message || message.length === 0) {
          skin.fail("INVALID_ARGS", "commit requires -m <message>");
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

        const reg = await loadRegistry(root);
        const wt = findWorktree(reg, name);
        if (!wt) {
          skin.fail("NOT_FOUND", `worktree not registered: ${name}`);
          return;
        }
        if (!(await dirExists(wt.path))) {
          skin.fail("NOT_FOUND", `worktree path missing: ${wt.path}`);
          return;
        }

        const repos: CommitRepo[] = [];
        const addAll = Boolean(opts.addAll);

        // ─── Submodules (sequential: frontend → backend) ────────────────
        try {
          for (const sub of SUBMODULES) {
            const subPath = join(wt.path, sub);
            if (!(await dirExists(subPath))) {
              // Missing submodule checkout — record as nothing-staged so the
              // envelope stays well-formed. `mono status` surfaces the
              // missing dir separately.
              repos.push({
                repo: sub,
                committed: false,
                sha: null,
                reason: "nothing-staged",
              });
              continue;
            }
            if (addAll) {
              const r = await gitAddAll(subPath);
              if (!r.ok) {
                throw new Error(
                  `git add -A failed in ${sub}: ${r.stderr.trim() || r.stdout.trim()}`,
                );
              }
            }
            const result = await commitIfStaged(subPath, message);
            repos.push({
              repo: sub,
              committed: result.committed,
              sha: result.sha,
              reason: result.reason,
            });
            if (result.committed) {
              skin.info(`${sub}: committed ${shortSha(result.sha as string)}`);
            } else {
              skin.info(`${sub}: nothing to commit`);
            }
          }

          // ─── Parent (stage gitlinks only, then commit) ─────────────────
          // `git add d2r2-frontend d2r2-backend` stages gitlink updates when
          // the submodule HEADs moved above. Missing submodule dirs would
          // make `git add` fail; guard by restricting to the ones that
          // actually exist on disk.
          const existingSubs: Submodule[] = [];
          for (const sub of SUBMODULES) {
            if (await dirExists(join(wt.path, sub))) existingSubs.push(sub);
          }
          if (existingSubs.length > 0) {
            const r = await gitAdd(wt.path, [...existingSubs]);
            if (!r.ok) {
              // Non-fatal: bash runs `git add ... 2>/dev/null || true`. We
              // mirror that here — treat it as "nothing to stage" rather
              // than aborting the whole commit.
              skin.debug(
                `git add submodules returned non-zero in parent: ${r.stderr.trim() || r.stdout.trim()}`,
              );
            }
          }

          const parentResult = await commitIfStaged(wt.path, message);
          repos.push({
            repo: "parent",
            committed: parentResult.committed,
            sha: parentResult.sha,
            reason: parentResult.reason,
          });
          if (parentResult.committed) {
            skin.info(
              `parent: committed ${shortSha(parentResult.sha as string)}`,
            );
          } else {
            skin.info("parent: nothing to commit");
          }
        } catch (err) {
          skin.fail(
            "GIT_FAILED",
            err instanceof Error ? err.message : String(err),
          );
          return;
        }

        // ─── Emit ───────────────────────────────────────────────────────
        // Bash order in the JSON is submodules first, then parent — we
        // preserve that shape.
        const data: CommitData = { name, message, repos };
        skin.emit(data);

        const anyCommitted = repos.some((r) => r.committed);
        if (!anyCommitted) {
          skin.warn("nothing to commit");
        }
      },
    );
}
