// cmd/rebase — rebase a feature worktree's parent + both submodules onto an
// upstream ref, preserving the "submodules first, then parent, then amend
// the parent's gitlinks if anything moved" sequencing from the bash
// implementation (scripts/mono:227 cmd_rebase).
//
// Behavioural contract:
//
//   * `upstream` defaults to `origin/main`.
//   * Fetch origin in every repo in parallel. A failed fetch is a warning,
//     not an error — we tolerate offline mode and keep going with whatever
//     refs we already have locally.
//   * Rebase submodules sequentially (frontend → backend) before touching
//     the parent. A submodule rebase conflict short-circuits: we emit a
//     CONFLICT envelope pointing at the offending repo and stop, so the
//     user isn't left with a half-amended parent.
//   * After both submodules land cleanly, rebase the parent. Parent
//     conflicts report the same CONFLICT shape with `repo: "parent"`.
//   * Once all three are clean, stage both submodule paths in the parent
//     (`git add d2r2-frontend d2r2-backend`). If the index differs from
//     HEAD, `git commit --amend --no-edit` — this preserves the rebased
//     commit message while updating the gitlinks. Matches bash line 273-280.
//
// `mono rebase all` iterates every registered worktree sequentially (not
// parallel — each worktree already fans its three repos in parallel, and
// sequential output is far easier to debug). The default policy stops at
// the first conflict so the operator cleans up one partial rebase at a
// time; `--keep-going` attempts every worktree and surfaces all conflicts
// in one envelope.

import { Command } from "commander";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { skin } from "../skin/index.ts";
import {
  findProjectRoot,
  findWorktree,
  isInitialized,
  loadRegistry,
  type Worktree,
} from "../core/registry.ts";
import {
  add as gitAdd,
  fetch as gitFetch,
  hasStagedChanges,
  head as gitHead,
  isRebasing,
  rebase as gitRebase,
} from "../core/git.ts";
import { mapRepos, reposFor, type RepoRef } from "../core/repos.ts";
import type { RebaseAllData, RebaseData } from "../core/schemas.ts";

const SUBMODULES = ["d2r2-frontend", "d2r2-backend"] as const;
type Submodule = (typeof SUBMODULES)[number];

type FetchStatus = "ok" | "failed";

interface RebaseStepResult {
  old_head: string;
  new_head: string;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

// Returns the short git-label friendly name used in log lines and error
// details ("parent" / "d2r2-frontend" / "d2r2-backend").
function labelForConflict(label: RepoRef["label"]): RebaseData["conflict"] {
  return { repo: label, step: "rebase" };
}

type WorktreeOutcome =
  | { kind: "ok"; data: RebaseData }
  | { kind: "conflict"; data: RebaseData; repo: RepoRef["label"] }
  | { kind: "not_found"; message: string }
  | { kind: "error"; message: string };

// Rebase a single worktree's parent + submodules. Returns the per-worktree
// envelope data plus an outcome the caller uses to decide whether to fail
// the whole command (single mode) or keep going (all mode).
async function rebaseOneWorktree(
  wt: Worktree,
  upstream: string,
): Promise<WorktreeOutcome> {
  if (!(await dirExists(wt.path))) {
    return {
      kind: "not_found",
      message: `worktree path missing: ${wt.path}`,
    };
  }

  skin.info(`rebasing '${wt.name}' onto ${upstream}`);

  // ─── Discover which repos are actually present on disk ────────────
  const allRefs = reposFor(wt.path);
  const presentRefs: RepoRef[] = [];
  for (const ref of allRefs) {
    if (await dirExists(ref.cwd)) presentRefs.push(ref);
  }

  // ─── Step 1: fetch all repos in parallel (warn-only) ──────────────
  const fetchStatus: Record<RepoRef["label"], FetchStatus> = {
    parent: "ok",
    "d2r2-frontend": "ok",
    "d2r2-backend": "ok",
  };
  const fetchResults = await mapRepos(presentRefs, async (ref) => {
    const r = await gitFetch(ref.cwd, "origin");
    return { label: ref.label, ok: r.ok };
  });
  for (const { value } of fetchResults) {
    if (!value.ok) {
      fetchStatus[value.label] = "failed";
      skin.warn(`  fetch failed in ${value.label} (offline?) — continuing`);
    } else {
      skin.info(`  fetched origin in ${value.label}`);
    }
  }

  const rebaseResults: Record<
    "parent" | "frontend" | "backend",
    RebaseStepResult | null
  > = { parent: null, frontend: null, backend: null };

  const rebaseOne = async (
    ref: RepoRef,
  ): Promise<
    | { kind: "ok"; step: RebaseStepResult }
    | { kind: "conflict" }
    | { kind: "error"; message: string }
  > => {
    let oldHead: string;
    try {
      oldHead = await gitHead(ref.cwd);
    } catch (err) {
      return {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    skin.info(`  rebasing ${ref.label}`);
    const result = await gitRebase(ref.cwd, upstream);
    if (!result.ok) {
      if (await isRebasing(ref.cwd)) {
        return { kind: "conflict" };
      }
      return {
        kind: "error",
        message:
          `git rebase ${upstream} failed in ${ref.label}: ` +
          (result.stderr.trim() || result.stdout.trim() ||
            `exit ${result.exitCode}`),
      };
    }
    let newHead: string;
    try {
      newHead = await gitHead(ref.cwd);
    } catch (err) {
      return {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    return { kind: "ok", step: { old_head: oldHead, new_head: newHead } };
  };

  const buildData = (
    overrides?: Partial<Pick<RebaseData, "amended" | "conflict">>,
  ): RebaseData => ({
    name: wt.name,
    upstream,
    fetch: {
      parent: fetchStatus.parent,
      frontend: fetchStatus["d2r2-frontend"],
      backend: fetchStatus["d2r2-backend"],
    },
    rebase: {
      parent: rebaseResults.parent,
      frontend: rebaseResults.frontend,
      backend: rebaseResults.backend,
    },
    amended: overrides?.amended ?? false,
    conflict: overrides?.conflict ?? null,
  });

  // ─── Step 2: rebase submodules sequentially ───────────────────────
  for (const sub of SUBMODULES) {
    const subRef = presentRefs.find((r) => r.label === sub);
    if (!subRef) continue; // submodule absent on disk — skip silently.

    const res = await rebaseOne(subRef);
    if (res.kind === "conflict") {
      skin.err(`rebase conflict in ${subRef.label}`);
      skin.err(`  resolve, then: git -C '${subRef.cwd}' rebase --continue`);
      skin.err(`  then re-run: mono rebase ${wt.name} ${upstream}`);
      return {
        kind: "conflict",
        repo: subRef.label,
        data: buildData({ conflict: labelForConflict(subRef.label) }),
      };
    }
    if (res.kind === "error") {
      return { kind: "error", message: res.message };
    }
    const key: "frontend" | "backend" =
      sub === "d2r2-frontend" ? "frontend" : "backend";
    rebaseResults[key] = res.step;
  }

  // ─── Step 3: rebase the parent ────────────────────────────────────
  const parentRef = presentRefs.find((r) => r.label === "parent");
  if (!parentRef) {
    return {
      kind: "not_found",
      message: `parent worktree missing: ${wt.path}`,
    };
  }

  const parentRes = await rebaseOne(parentRef);
  if (parentRes.kind === "conflict") {
    skin.err(`rebase conflict in parent`);
    skin.err(
      `  resolve (likely gitlinks), then: git -C '${wt.path}' rebase --continue`,
    );
    return {
      kind: "conflict",
      repo: "parent",
      data: buildData({ conflict: { repo: "parent", step: "rebase" } }),
    };
  }
  if (parentRes.kind === "error") {
    return { kind: "error", message: parentRes.message };
  }
  rebaseResults.parent = parentRes.step;

  // ─── Step 4: amend parent gitlinks if any submodule moved ─────────
  let amended = false;
  try {
    const existing: Submodule[] = [];
    for (const sub of SUBMODULES) {
      if (await dirExists(join(wt.path, sub))) existing.push(sub);
    }
    if (existing.length > 0) {
      const addRes = await gitAdd(wt.path, [...existing]);
      if (!addRes.ok) {
        skin.debug(
          `git add submodules returned non-zero: ${
            addRes.stderr.trim() || addRes.stdout.trim()
          }`,
        );
      }
      if (await hasStagedChanges(wt.path)) {
        const { execa } = await import("execa");
        const amend = await execa(
          "git",
          ["commit", "--amend", "--no-edit"],
          { cwd: wt.path, reject: false },
        );
        const exitCode =
          typeof amend.exitCode === "number" ? amend.exitCode : 1;
        if (exitCode === 0) {
          amended = true;
          // The amend moves HEAD; refresh the recorded new_head so
          // consumers see the post-amend SHA.
          try {
            const newHead = await gitHead(wt.path);
            if (rebaseResults.parent) {
              rebaseResults.parent = {
                old_head: rebaseResults.parent.old_head,
                new_head: newHead,
              };
            }
          } catch {
            // non-fatal — leave the recorded new_head as-is.
          }
          skin.info("  amended parent tip with updated gitlinks");
        } else {
          skin.warn(
            `git commit --amend failed: ${
              String(amend.stderr).trim() || String(amend.stdout).trim()
            }`,
          );
        }
      }
    }
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  return { kind: "ok", data: buildData({ amended }) };
}

export function rebaseCommand(): Command {
  return new Command("rebase")
    .description(
      "rebase parent + submodules onto <upstream>; amend parent gitlinks if submodules moved. Use 'all' to rebase every registered worktree.",
    )
    .argument(
      "<name>",
      "worktree name, or 'all' to rebase every registered worktree",
    )
    .argument("[upstream]", "upstream ref (default: origin/main)")
    .option(
      "--keep-going",
      "in 'all' mode, continue past conflicts and collect them all",
    )
    .action(
      async (
        name: string,
        upstreamArg: string | undefined,
        opts: { keepGoing?: boolean },
      ) => {
        skin.setCommand("rebase");

        const upstream = upstreamArg ?? "origin/main";
        const keepGoing = Boolean(opts.keepGoing);

        // ─── Project root + registry ──────────────────────────────────
        const root = await findProjectRoot(process.cwd());
        if (!root || !(await isInitialized(root))) {
          skin.fail(
            "MISSING_REGISTRY",
            "not a mono project; run `mono init` first",
          );
          return;
        }

        const reg = await loadRegistry(root);

        // ─── `mono rebase all` ────────────────────────────────────────
        // Literal "all" iterates every registered worktree sequentially.
        // A worktree named "all" wins over the keyword (defensive: same
        // guard as `push all`).
        if (name === "all" && !findWorktree(reg, "all")) {
          if (reg.worktrees.length === 0) {
            const data: RebaseAllData = {
              upstream,
              keep_going: keepGoing,
              worktrees: [],
              stopped_at: null,
            };
            skin.emit(data);
            skin.info("no worktrees registered");
            return;
          }

          skin.info(
            `rebasing all worktrees (${reg.worktrees.length}) onto ${upstream}`,
          );
          if (keepGoing) skin.info("  --keep-going: will continue past conflicts");

          const worktreesData: RebaseData[] = [];
          const conflictedWorktrees: string[] = [];
          let stoppedAt: string | null = null;
          let fatalError: string | null = null;

          for (const wt of reg.worktrees) {
            const res = await rebaseOneWorktree(wt, upstream);

            if (res.kind === "ok") {
              worktreesData.push(res.data);
              continue;
            }

            if (res.kind === "conflict") {
              worktreesData.push(res.data);
              conflictedWorktrees.push(wt.name);
              if (!keepGoing) {
                stoppedAt = wt.name;
                skin.err(
                  `stopping: conflict in '${wt.name}'; pass --keep-going to continue past conflicts`,
                );
                break;
              }
              skin.warn(
                `conflict in '${wt.name}' — continuing (--keep-going)`,
              );
              continue;
            }

            if (res.kind === "not_found") {
              skin.warn(`skipping '${wt.name}': ${res.message}`);
              continue;
            }

            // Unrecoverable error (e.g. git crashed). Always stops.
            fatalError = `'${wt.name}': ${res.message}`;
            stoppedAt = wt.name;
            break;
          }

          const data: RebaseAllData = {
            upstream,
            keep_going: keepGoing,
            worktrees: worktreesData,
            stopped_at: stoppedAt,
          };
          skin.emit(data);

          if (fatalError) {
            skin.fail("GIT_FAILED", fatalError);
            return;
          }

          if (conflictedWorktrees.length > 0) {
            skin.fail(
              "CONFLICT",
              `rebase conflict in ${conflictedWorktrees.length} worktree(s): ${conflictedWorktrees.join(", ")}`,
              {
                conflicted: conflictedWorktrees,
                stopped_at: stoppedAt,
                hint:
                  "resolve conflicts per worktree (git rebase --continue), " +
                  "then re-run `mono rebase <name>` or `mono rebase all`",
              },
            );
            return;
          }

          skin.info(`rebase all complete (${worktreesData.length} worktrees)`);
          return;
        }

        // ─── single worktree ─────────────────────────────────────────
        const wt = findWorktree(reg, name);
        if (!wt) {
          skin.fail("NOT_FOUND", `worktree not registered: ${name}`);
          return;
        }

        const res = await rebaseOneWorktree(wt, upstream);

        if (res.kind === "not_found") {
          skin.fail("NOT_FOUND", res.message);
          return;
        }

        if (res.kind === "conflict") {
          skin.emit(res.data);
          skin.fail(
            "CONFLICT",
            `rebase conflict in ${res.repo}`,
            {
              repo: res.repo,
              step: "rebase",
              hint:
                "resolve conflicts, run `git rebase --continue`, then re-run " +
                `\`mono rebase ${name}\``,
            },
          );
          return;
        }

        if (res.kind === "error") {
          skin.fail("GIT_FAILED", res.message);
          return;
        }

        skin.emit(res.data);
        skin.info("rebase complete");
      },
    );
}
