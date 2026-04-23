// cmd/pull — fast-forward-pull parent + both submodules from origin.
//
// Symmetric to cmd/push: fans out to parent + d2r2 submodules in parallel
// via `mapRepos`, one worktree at a time when `all` is requested. Uses
// `git pull --ff-only origin <current-branch>` so pulls never silently
// merge or rewrite local history; a diverged branch surfaces as `failed`
// with the git error and the user resolves it (typically via `mono rebase`).
//
// No queueing. Push failures are retryable (network, transient auth) so
// push queues them; pull failures almost always mean the user has work to
// reconcile, so retry-on-next-run isn't the right default.
//
// Missing remote branches (newly-created worktrees that haven't been
// pushed yet) resolve to `skipped`, not `failed` — a fresh branch with no
// upstream is a normal state.

import { Command } from "commander";
import { promises as fs } from "node:fs";

import { skin } from "../skin/index.ts";
import {
  findProjectRoot,
  findWorktree,
  isInitialized,
  loadRegistry,
  type Worktree,
} from "../core/registry.ts";
import {
  currentBranch,
  hasRemoteBranch,
  pull as gitPull,
} from "../core/git.ts";
import { mapRepos, reposFor, type RepoRef } from "../core/repos.ts";
import type {
  PullAllData,
  PullData,
  PullResult,
  PullStatus,
} from "../core/schemas.ts";
import { findWorktreeForCwd } from "./push.ts";

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

interface AttemptOutcome {
  branch: string;
  status: PullStatus;
  error: string | null;
}

function snippet(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "pull failed";
  const oneLine = trimmed.replace(/\s+/gu, " ");
  return oneLine.length > 400 ? `${oneLine.slice(0, 400)}…` : oneLine;
}

async function pullOne(ref: RepoRef): Promise<AttemptOutcome> {
  if (!(await dirExists(ref.cwd))) {
    return {
      branch: "",
      status: "failed",
      error: `repo directory missing: ${ref.cwd}`,
    };
  }

  let branch: string;
  try {
    branch = await currentBranch(ref.cwd);
  } catch (err) {
    return {
      branch: "",
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Skip when origin doesn't know this branch — common for brand-new
  // worktrees that haven't been pushed yet. Not an error.
  if (!(await hasRemoteBranch(ref.cwd, branch, "origin"))) {
    return { branch, status: "skipped", error: null };
  }

  skin.info(`  pull ${ref.label} (${branch})`);
  const result = await gitPull(ref.cwd, "origin", branch);
  if (result.ok) {
    return { branch, status: "pulled", error: null };
  }
  return {
    branch,
    status: "failed",
    error: snippet(result.stderr || result.stdout),
  };
}

async function pullWorktree(wt: Worktree): Promise<PullData> {
  skin.info(`pulling '${wt.name}'`);

  if (!(await dirExists(wt.path))) {
    return {
      name: wt.name,
      results: [
        {
          repo: "parent",
          branch: "",
          status: "failed",
          error: `worktree path missing: ${wt.path}`,
        },
      ],
    };
  }

  const refs = reposFor(wt.path);
  const outcomes = await mapRepos(refs, pullOne);

  const results: PullResult[] = outcomes.map(({ ref, value }) => ({
    repo: ref.label,
    branch: value.branch,
    status: value.status,
    error: value.error,
  }));

  skin.table(
    results.map((r) => ({
      repo: r.repo,
      branch: r.branch,
      status: r.status,
      error: r.error ?? "—",
    })),
    ["repo", "branch", "status", "error"],
  );

  return { name: wt.name, results };
}

export function pullCommand(): Command {
  return new Command("pull")
    .description(
      "fast-forward-pull parent + submodules from origin. Omit <name> to pull the worktree containing the current directory. Use 'all' to pull every registered worktree.",
    )
    .argument(
      "[name]",
      "worktree name, or 'all' to pull every registered worktree (defaults to the worktree containing the current directory)",
    )
    .action(async (name: string | undefined) => {
      skin.setCommand("pull");

      const root = await findProjectRoot(process.cwd());
      if (!root || !(await isInitialized(root))) {
        skin.fail(
          "MISSING_REGISTRY",
          "not a mono project; run `mono init` first",
        );
        return;
      }

      const reg = await loadRegistry(root);

      // ─── no argument → infer worktree from cwd ──────────────────────────
      if (name === undefined) {
        const inferred = findWorktreeForCwd(reg, process.cwd());
        if (!inferred) {
          skin.fail(
            "INVALID_ARGS",
            "no worktree name given and current directory is not inside a registered worktree",
          );
          return;
        }
        name = inferred.name;
      }

      // ─── `mono pull all` ────────────────────────────────────────────────
      // Sequential across worktrees (each already fans out to its three
      // repos in parallel). A literal worktree actually named "all"
      // would shadow this — the findWorktree check preserves it.
      if (name === "all" && !findWorktree(reg, "all")) {
        if (reg.worktrees.length === 0) {
          const data: PullAllData = { worktrees: [] };
          skin.emit(data);
          skin.info("no worktrees registered");
          return;
        }

        skin.info(`pulling all worktrees (${reg.worktrees.length})`);

        const worktreesData: PullData[] = [];
        let totalFailures = 0;
        const failedWorktrees: string[] = [];

        for (const wt of reg.worktrees) {
          const out = await pullWorktree(wt);
          worktreesData.push(out);
          const failures = out.results.filter((r) => r.status === "failed");
          if (failures.length > 0) {
            totalFailures += failures.length;
            failedWorktrees.push(wt.name);
          }
        }

        const data: PullAllData = { worktrees: worktreesData };
        skin.emit(data);

        if (totalFailures > 0) {
          skin.fail(
            "GIT_FAILED",
            `${totalFailures} repo(s) failed to pull across ${failedWorktrees.length} worktree(s)`,
            { failed_worktrees: failedWorktrees },
          );
          return;
        }

        skin.info(`pull all complete (${reg.worktrees.length} worktrees)`);
        return;
      }

      // ─── single worktree ────────────────────────────────────────────────
      const wt = findWorktree(reg, name);
      if (!wt) {
        skin.fail("NOT_FOUND", `worktree not registered: ${name}`);
        return;
      }
      if (!(await dirExists(wt.path))) {
        skin.fail("NOT_FOUND", `worktree path missing: ${wt.path}`);
        return;
      }

      const data = await pullWorktree(wt);
      skin.emit(data);

      const failures = data.results.filter((r) => r.status === "failed");
      if (failures.length > 0) {
        skin.fail(
          "GIT_FAILED",
          `${failures.length} repo(s) failed to pull`,
          { failed: failures.map((r) => r.repo) },
        );
        return;
      }

      const pulled = data.results.filter((r) => r.status === "pulled").length;
      const skipped = data.results.filter((r) => r.status === "skipped").length;
      skin.info(`pull complete (${pulled} pulled, ${skipped} skipped)`);
    });
}
