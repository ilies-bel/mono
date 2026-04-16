// cmd/status — show git status across parent + submodules for a worktree.
//
// Port of cmd_status in scripts/mono:213. The bash version serially shells
// `git status --short --branch` against each of the three repos; this port
// reads `currentBranch` + `statusPorcelain` concurrently via mapRepos() so
// wall-clock scales with the slowest repo, not the sum.
//
// Behaviours:
//   - Missing <name>          → commander emits the usage error (INVALID_ARGS
//                               semantics — argument is declared required).
//   - Outside a mono project  → MISSING_REGISTRY (envelope ok:false).
//   - Unknown worktree name   → NOT_FOUND.
//   - Registered path missing → NOT_FOUND (stale checkout).
//   - Submodule dir missing   → per-repo `{missing:true, clean:false}` +
//                               warning, other repos still report normally.
//   - Detached HEAD           → branch is normalised to `null` (raw git
//                               reports the literal "HEAD" for
//                               `rev-parse --abbrev-ref`).

import { Command } from "commander";
import { promises as fs } from "node:fs";
import { skin } from "../skin/index.ts";
import {
  findProjectRoot,
  loadRegistry,
  findWorktree,
} from "../core/registry.ts";
import { reposFor, mapRepos, type RepoLabel } from "../core/repos.ts";
import { currentBranch, statusPorcelain } from "../core/git.ts";

interface StatusRepoEntry {
  repo: RepoLabel;
  branch: string | null;
  clean: boolean;
  porcelain: string;
  missing: boolean;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export function statusCommand(): Command {
  return new Command("status")
    .description(
      "show git status across parent + submodules for a worktree",
    )
    .argument("<name>", "worktree name")
    .action(async (name: string) => {
      skin.setCommand("status");

      const root = await findProjectRoot(process.cwd());
      if (!root) {
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

      const refs = reposFor(wt.path);
      const results = await mapRepos(refs, async (r) => {
        if (!(await dirExists(r.cwd))) {
          return {
            branch: null,
            clean: false,
            porcelain: "",
            missing: true,
          };
        }
        const [branchRaw, porc] = await Promise.all([
          currentBranch(r.cwd).catch(() => ""),
          statusPorcelain(r.cwd).catch(() => ""),
        ]);
        const branch = branchRaw && branchRaw !== "HEAD" ? branchRaw : null;
        return {
          branch,
          clean: porc.length === 0,
          porcelain: porc,
          missing: false,
        };
      });

      const repos: StatusRepoEntry[] = results.map((r) => ({
        repo: r.ref.label,
        branch: r.value.branch,
        clean: r.value.clean,
        porcelain: r.value.porcelain,
        missing: r.value.missing,
      }));

      const data = { name, repos };
      skin.emit(data);

      skin.info(`status ${name}`);
      for (const entry of repos) {
        if (entry.missing) {
          skin.warn(`${entry.repo}: missing`);
          continue;
        }
        skin.info(
          `=== ${entry.repo} (${entry.branch ?? "detached"}) ===`,
        );
        if (entry.clean) {
          skin.info("clean");
          continue;
        }
        for (const line of entry.porcelain.split("\n").filter(Boolean)) {
          skin.info(line);
        }
      }
    });
}
