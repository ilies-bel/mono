// cmd/config — get, set, unset, or list mono config entries.
//
// Port of cmd_config in scripts/mono:46 and the config_* helpers in
// scripts/mono-lib.sh:196. Persists into the same `.mono` registry that the
// Bash implementation reads/writes so both tools interoperate during the
// migration.
//
// Four behaviours dispatched by argument shape:
//   mono config                 → list all entries (JSON: full config object)
//   mono config <key>           → read one entry (JSON: {key, value})
//   mono config <key> <value>   → write entry    (JSON: {key, value, previous})
//   mono config <key> --unset   → remove entry   (JSON: {key, removed})
//
// Every path requires `mono init` first — missing registry fails with
// MISSING_REGISTRY. Discovery walks upward from cwd so commands run from any
// subdirectory of the project.

import { Command } from "commander";
import { skin } from "../skin/index.ts";
import {
  findProjectRoot,
  loadRegistry,
  saveRegistry,
  getConfig,
  setConfig,
  unsetConfig,
} from "../core/registry.ts";

export function configCommand(): Command {
  return new Command("config")
    .description("get, set, unset, or list mono config entries")
    .argument("[key]", "config key")
    .argument("[value]", "value to set")
    .option("--unset", "remove the given key")
    .action(
      async (
        key: string | undefined,
        value: string | undefined,
        opts: { unset?: boolean },
      ) => {
        skin.setCommand("config");

        const root = await findProjectRoot(process.cwd());
        if (!root) {
          skin.fail(
            "MISSING_REGISTRY",
            "not a mono project; run `mono init` first",
          );
          return;
        }

        const reg = await loadRegistry(root);

        // List: no key supplied.
        if (!key) {
          const sorted: Record<string, string> = {};
          for (const k of Object.keys(reg.config).sort()) {
            sorted[k] = reg.config[k] ?? "";
          }
          skin.emit(sorted);
          for (const [k, v] of Object.entries(sorted)) {
            skin.info(`${k}=${v}`);
          }
          return;
        }

        // Unset: --unset flag. Must not be combined with a positional value.
        if (opts.unset) {
          if (value !== undefined) {
            skin.fail(
              "INVALID_ARGS",
              "--unset cannot be combined with a value",
            );
            return;
          }
          const existed = getConfig(reg, key) !== undefined;
          if (existed) {
            await saveRegistry(root, unsetConfig(reg, key));
          }
          skin.emit({ key, removed: existed });
          if (existed) {
            skin.info(`unset ${key}`);
          } else {
            skin.warn(`${key} not set`);
          }
          return;
        }

        // Set: two positional args.
        if (value !== undefined) {
          const previous = getConfig(reg, key) ?? null;
          await saveRegistry(root, setConfig(reg, key, value));
          skin.emit({ key, value, previous });
          skin.info(`${key}=${value}`);
          return;
        }

        // Get: one positional arg.
        const current = getConfig(reg, key);
        if (current === undefined) {
          skin.fail("NOT_FOUND", `config key not set: ${key}`);
          return;
        }
        skin.emit({ key, value: current });
        skin.info(current);
      },
    );
}
