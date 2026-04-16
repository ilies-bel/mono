// cmd/init — initialize mono in the current (or given) parent repo.
//
// Behavior (port of cmd_init in scripts/mono:87):
//   - Validate <dir> contains .gitmodules (via assertParentRoot).
//   - If <dir>/.mono already exists, warn and return ok:true with
//     { already_initialized: true }. Never overwrite.
//   - Otherwise create .mono via saveRegistry (empty registry + header).

import { Command } from "commander";
import * as path from "node:path";
import { skin } from "../skin/index.ts";
import { assertParentRoot } from "../core/repos.ts";
import { isInitialized, saveRegistry } from "../core/registry.ts";

export function initCommand(): Command {
  return new Command("init")
    .description("initialize mono in the current (or given) parent repo")
    .argument("[dir]", "project root (defaults to cwd)")
    .action(async (dir: string | undefined) => {
      skin.setCommand("init");
      const root = path.resolve(dir ?? process.cwd());

      try {
        await assertParentRoot(root);
      } catch {
        skin.fail("NOT_MONO_ROOT", `no .gitmodules found at ${root}`, {
          path: root,
        });
        return;
      }

      if (await isInitialized(root)) {
        skin.warn(`already initialized at ${root}`);
        skin.emit({ path: root, already_initialized: true });
        return;
      }

      await saveRegistry(root, {
        worktrees: [],
        config: {},
        queue: [],
      });
      skin.info(`initialized mono at ${root}`);
      skin.emit({ path: root, already_initialized: false });
    });
}
