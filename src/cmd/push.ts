// cmd/push — push parent + both submodules to origin in parallel, queueing
// failures for later retry.
//
// Port of cmd_push in scripts/mono:344. Behavioural contract:
//
//   * All three repos push in parallel via `mapRepos` — each runs `git push
//     -u origin <branch>` where branch is that repo's current HEAD branch.
//   * On success: remove any prior queue entry for (repo, branch) so retry
//     is idempotent; attempt to extract a merge-request / pull-request URL
//     from the push's stderr (GitLab prints one on successful push). Fall
//     back to a browsable `tree/<branch>` URL synthesised from the remote
//     origin when the server didn't print an MR link.
//   * On failure: add (repo, branch) to the queue so a later `mono push`
//     retries, and record the stderr snippet as the error. A failed repo
//     never produces an MR URL.
//   * A single `saveRegistry` call persists all queue mutations after every
//     repo finishes — concurrent pushes race on the in-memory Registry but
//     the writes are accumulated under the final lock-step save.
//   * Exit code: 0 when every repo pushed; 1 when any failed/queued (via
//     `skin.fail("GIT_FAILED", ...)` which still emits the per-repo
//     envelope detail).
//
// The `BEAD_ID` env var (optional) is surfaced both in the text table header
// and the JSON envelope so CI orchestrators can correlate pushes with work
// items.

import { Command } from "commander";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { skin } from "../skin/index.ts";
import {
  findProjectRoot,
  findWorktree,
  isInitialized,
  loadRegistry,
  queueAdd,
  queueRemove,
  saveRegistry,
  type Registry,
  type Worktree,
} from "../core/registry.ts";
import {
  currentBranch,
  getRemoteUrl,
  push as gitPush,
} from "../core/git.ts";
import { mapRepos, reposFor, type RepoRef } from "../core/repos.ts";
import type { PushAllData, PushData, PushResult } from "../core/schemas.ts";

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Find the registered worktree whose path contains `cwd`. Returns the deepest
 * match so nested worktrees resolve to the inner one. Used when `mono push`
 * is invoked without a worktree name — the user's current directory selects
 * the target.
 */
export function findWorktreeForCwd(
  reg: Registry,
  cwd: string,
): Worktree | undefined {
  const resolvedCwd = path.resolve(cwd);
  const matches: Worktree[] = [];
  for (const wt of reg.worktrees) {
    const wtPath = path.resolve(wt.path);
    const rel = path.relative(wtPath, resolvedCwd);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      matches.push(wt);
    }
  }
  matches.sort((a, b) => b.path.length - a.path.length);
  return matches[0] ? { ...matches[0] } : undefined;
}

/**
 * Extract the first MR / PR creation URL the server printed on stderr.
 * GitLab prints lines like:
 *   remote:   https://gitlab.example.com/group/project/-/merge_requests/new?merge_request[source_branch]=...
 * GitHub prints `…/pull/new/<branch>`. Any other URL shape is ignored so we
 * don't confuse, say, a remote help URL for an MR link.
 */
export function extractMrUrl(stderr: string): string | null {
  const m = stderr.match(
    /https?:\/\/\S+?\/(?:-\/merge_requests\/new|pull\/new)\S*/u,
  );
  return m ? m[0] : null;
}

/**
 * Build a browsable tree URL for <branch> from the repo's origin remote.
 * Mirrors _remote_link in scripts/mono:433. Returns null when the remote is
 * absent, not GitLab/GitHub-shaped, or cannot be parsed.
 */
export async function remoteTreeUrl(
  cwd: string,
  branch: string,
): Promise<string | null> {
  const origin = await getRemoteUrl(cwd, "origin");
  if (!origin) return null;

  let host: string;
  let repoPath: string;

  if (origin.startsWith("git@") && origin.includes(":")) {
    // ssh: git@host:group/name(.git)
    const rest = origin.slice("git@".length);
    const colon = rest.indexOf(":");
    if (colon <= 0) return null;
    host = rest.slice(0, colon);
    repoPath = rest.slice(colon + 1).replace(/\.git$/u, "");
  } else if (origin.startsWith("http://") || origin.startsWith("https://")) {
    const stripped = origin.replace(/^https?:\/\//u, "");
    const slash = stripped.indexOf("/");
    if (slash <= 0) return null;
    host = stripped.slice(0, slash);
    repoPath = stripped.slice(slash + 1).replace(/\.git$/u, "");
  } else {
    return null;
  }

  if (!host || !repoPath) return null;

  // GitLab: /-/tree/<branch>. Everything else (GitHub, generic) uses /tree/.
  if (/gitlab/iu.test(host)) {
    return `https://${host}/${repoPath}/-/tree/${branch}`;
  }
  return `https://${host}/${repoPath}/tree/${branch}`;
}

interface AttemptOutcome {
  ref: RepoRef;
  branch: string;
  ok: boolean;
  mrUrl: string | null;
  error: string | null;
}

function snippet(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "push failed";
  const oneLine = trimmed.replace(/\s+/gu, " ");
  return oneLine.length > 400 ? `${oneLine.slice(0, 400)}…` : oneLine;
}

/**
 * Push one worktree's parent + submodules in parallel. Returns the per-repo
 * results plus an updated Registry reflecting queue add/remove mutations.
 * Does not persist the registry — the caller batches writes so a multi-
 * worktree `push all` only rewrites .mono once.
 */
async function pushWorktree(
  wt: Worktree,
  reg: Registry,
  beadId: string | null,
): Promise<{ data: PushData; nextReg: Registry; allPushed: boolean }> {
  if (beadId) {
    skin.info(`BEAD_ID: ${beadId}`);
  }
  skin.info(`pushing '${wt.name}'`);

  if (!(await dirExists(wt.path))) {
    const results: PushResult[] = [
      {
        repo: "parent",
        branch: "",
        pushed: false,
        queued: false,
        mr_url: null,
        error: `worktree path missing: ${wt.path}`,
      },
    ];
    return {
      data: { name: wt.name, bead_id: beadId, results },
      nextReg: reg,
      allPushed: false,
    };
  }

  const refs = reposFor(wt.path);

  const outcomes = await mapRepos(refs, async (ref): Promise<AttemptOutcome> => {
    if (!(await dirExists(ref.cwd))) {
      return {
        ref,
        branch: "",
        ok: false,
        mrUrl: null,
        error: `repo directory missing: ${ref.cwd}`,
      };
    }
    let branch: string;
    try {
      branch = await currentBranch(ref.cwd);
    } catch (err) {
      return {
        ref,
        branch: "",
        ok: false,
        mrUrl: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    skin.info(`  push ${ref.label} (${branch})`);
    const result = await gitPush(ref.cwd, "origin", branch, true);

    if (result.ok) {
      const mrFromStderr = extractMrUrl(result.stderr);
      const mr = mrFromStderr ?? (await remoteTreeUrl(ref.cwd, branch));
      return { ref, branch, ok: true, mrUrl: mr, error: null };
    }

    return {
      ref,
      branch,
      ok: false,
      mrUrl: null,
      error: snippet(result.stderr || result.stdout),
    };
  });

  let nextReg: Registry = reg;
  const results: PushResult[] = [];

  for (const { ref, value } of outcomes) {
    const branch = value.branch;
    const repo = ref.label;

    if (value.ok) {
      if (branch.length > 0) {
        nextReg = queueRemove(nextReg, { repo, branch });
      }
      results.push({
        repo,
        branch,
        pushed: true,
        queued: false,
        mr_url: value.mrUrl,
        error: null,
      });
    } else {
      const shouldQueue = branch.length > 0;
      if (shouldQueue) {
        nextReg = queueAdd(nextReg, { repo, branch });
      }
      results.push({
        repo,
        branch,
        pushed: false,
        queued: shouldQueue,
        mr_url: null,
        error: value.error,
      });
    }
  }

  skin.table(
    results.map((r) => ({
      repo: r.repo,
      branch: r.branch,
      status: r.pushed ? "pushed" : r.queued ? "queued" : "failed",
      "MR URL": r.mr_url ?? "—",
    })),
    ["repo", "branch", "status", "MR URL"],
  );

  const allPushed = results.every((r) => r.pushed);
  return {
    data: { name: wt.name, bead_id: beadId, results },
    nextReg,
    allPushed,
  };
}

export function pushCommand(): Command {
  return new Command("push")
    .description(
      "push parent + submodules to origin; failures are queued for retry. Omit <name> to push the worktree containing the current directory. Use 'all' to push every registered worktree.",
    )
    .argument(
      "[name]",
      "worktree name, or 'all' to push every registered worktree (defaults to the worktree containing the current directory)",
    )
    .action(async (name: string | undefined) => {
      skin.setCommand("push");

      const beadId = process.env.BEAD_ID ?? null;

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

      // ─── `mono push all` ────────────────────────────────────────────────
      // A literal "all" iterates every registered worktree sequentially.
      // Sequential (not parallel across worktrees) because each worktree's
      // pushWorktree already fans out to its three repos in parallel, and
      // serializing avoids concurrent .mono queue mutations. We persist the
      // registry once at the end.
      if (name === "all" && !findWorktree(reg, "all")) {
        if (reg.worktrees.length === 0) {
          const data: PushAllData = { bead_id: beadId, worktrees: [] };
          skin.emit(data);
          skin.info("no worktrees registered");
          return;
        }

        if (beadId) {
          skin.info(`BEAD_ID: ${beadId}`);
        }
        skin.info(`pushing all worktrees (${reg.worktrees.length})`);

        let nextReg: Registry = reg;
        const worktreesData: PushData[] = [];
        let totalFailures = 0;
        let totalQueued = 0;
        const failedWorktrees: string[] = [];

        for (const wt of reg.worktrees) {
          const out = await pushWorktree(wt, nextReg, beadId);
          nextReg = out.nextReg;
          worktreesData.push(out.data);
          const failures = out.data.results.filter((r) => !r.pushed);
          if (failures.length > 0) {
            totalFailures += failures.length;
            totalQueued += failures.filter((r) => r.queued).length;
            failedWorktrees.push(wt.name);
          }
        }

        try {
          await saveRegistry(root, nextReg);
        } catch (err) {
          skin.warn(
            `failed to persist queue changes: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        const data: PushAllData = { bead_id: beadId, worktrees: worktreesData };
        skin.emit(data);

        if (totalFailures > 0) {
          skin.fail(
            "GIT_FAILED",
            `${totalFailures} repo(s) failed across ${failedWorktrees.length} worktree(s); ${totalQueued} queued for retry`,
            {
              failed_worktrees: failedWorktrees,
              queued_count: totalQueued,
            },
          );
          return;
        }

        skin.info(`push all complete (${reg.worktrees.length} worktrees)`);
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

      const out = await pushWorktree(wt, reg, beadId);

      try {
        await saveRegistry(root, out.nextReg);
      } catch (err) {
        skin.warn(
          `failed to persist queue changes: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      skin.emit(out.data);

      const failures = out.data.results.filter((r) => !r.pushed);
      if (failures.length > 0) {
        const queued = failures.filter((r) => r.queued).length;
        skin.fail(
          "GIT_FAILED",
          `${failures.length} repo(s) failed to push; ${queued} queued for retry`,
          {
            failed: failures.map((r) => r.repo),
            queued_count: queued,
          },
        );
        return;
      }

      skin.info(`push complete (${out.data.results.length} pushed)`);
    });
}
