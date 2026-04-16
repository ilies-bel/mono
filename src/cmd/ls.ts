// cmd/ls — list every registered worktree with its HEAD in all three repos.
//
// Port of cmd_ls in scripts/mono:192. Reads the registry at the project root,
// then for each worktree resolves HEAD concurrently across parent +
// d2r2-frontend + d2r2-backend via mapRepos(). This is the primary motivation
// for the TypeScript rewrite: the bash version serially shells out `git
// rev-parse HEAD` nine times for three worktrees; mapRepos issues them in
// parallel so wall-clock scales with the slowest repo, not the sum.
//
// Behaviours:
//   - Empty registry            → data:[], text prints "no worktrees registered"
//   - Missing worktree path     → entry kept with all *_head fields null +
//                                 a warning emitted on stderr/envelope
//   - Missing submodule dir     → that repo's *_head is null, others succeed
//   - Outside a mono project    → MISSING_REGISTRY (envelope ok:false)
//
// Text mode truncates to 7-char shas (same as the bash implementation shows
// via `repo_head`); JSON mode always emits the full 40-char sha so machine
// consumers can diff or rebase against exact commits.

import { Command } from "commander";
import { promises as fs } from "node:fs";
import { skin } from "../skin/index.ts";
import { findProjectRoot, loadRegistry } from "../core/registry.ts";
import { reposFor, mapRepos } from "../core/repos.ts";
import { head } from "../core/git.ts";
import type { LsItem } from "../core/schemas.ts";

function short(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "-";
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export function lsCommand(): Command {
  return new Command("ls")
    .description(
      "list registered worktrees with HEADs across parent + submodules",
    )
    .action(async () => {
      skin.setCommand("ls");

      const root = await findProjectRoot(process.cwd());
      if (!root) {
        skin.fail(
          "MISSING_REGISTRY",
          "not a mono project; run `mono init` first",
        );
        return;
      }

      const reg = await loadRegistry(root);
      const sorted = [...reg.worktrees].sort((a, b) =>
        a.name.localeCompare(b.name),
      );

      const items: LsItem[] = await Promise.all(
        sorted.map(async (wt): Promise<LsItem> => {
          if (!(await dirExists(wt.path))) {
            skin.warn(`worktree ${wt.name}: path missing (${wt.path})`);
            return {
              name: wt.name,
              path: wt.path,
              parent_head: null,
              frontend_head: null,
              backend_head: null,
            };
          }
          const refs = reposFor(wt.path);
          const results = await mapRepos(
            refs,
            async (r): Promise<string | null> => {
              if (!(await dirExists(r.cwd))) return null;
              try {
                return await head(r.cwd);
              } catch {
                return null;
              }
            },
          );
          const byLabel: Record<string, string | null> = {};
          for (const r of results) byLabel[r.ref.label] = r.value;
          return {
            name: wt.name,
            path: wt.path,
            parent_head: byLabel["parent"] ?? null,
            frontend_head: byLabel["d2r2-frontend"] ?? null,
            backend_head: byLabel["d2r2-backend"] ?? null,
          };
        }),
      );

      skin.emit(items);
      if (items.length === 0) {
        skin.info("no worktrees registered");
        return;
      }
      skin.table(
        items.map((i) => ({
          name: i.name,
          path: i.path,
          parent: short(i.parent_head),
          frontend: short(i.frontend_head),
          backend: short(i.backend_head),
        })),
        ["name", "path", "parent", "frontend", "backend"],
      );
    });
}
