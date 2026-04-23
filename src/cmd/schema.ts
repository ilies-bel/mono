// cmd/schema — expose a JSON Schema description of each command's envelope.
//
// Purpose: make the `mono` CLI self-describing for LLM tool consumers.
// Running `mono schema ls --json` returns the JSON Schema of the full
// envelope produced by `mono ls`, with `data` tightened to the per-command
// data schema (e.g. LsDataSchema). Running `mono schema` with no argument
// returns the list of available command schema names.
//
// The converter is `zod-to-json-schema` — a small dependency that walks
// zod's internal AST and produces a draft-07 JSON Schema. Zod v3.25 does
// not ship a built-in converter (`z.toJSONSchema` landed in v4).

import { Command } from "commander";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { skin } from "../skin/index.ts";
import {
  InitDataSchema,
  ConfigDataSchema,
  LsDataSchema,
  StatusDataSchema,
  NewDataSchema,
  CommitDataSchema,
  RmDataSchema,
  RebaseDataSchema,
  PushDataSchema,
  PullDataSchema,
  envelope,
} from "../core/schemas.ts";

// Public map of CLI verb → data schema. Exported so tests (and future
// callers) can introspect the contract without parsing CLI output.
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  init: InitDataSchema,
  config: ConfigDataSchema,
  ls: LsDataSchema,
  status: StatusDataSchema,
  new: NewDataSchema,
  commit: CommitDataSchema,
  rm: RmDataSchema,
  rebase: RebaseDataSchema,
  push: PushDataSchema,
  pull: PullDataSchema,
};

export const SCHEMA_NAMES: readonly string[] = Object.keys(SCHEMAS).sort();

function schemaFor(cmd: string): object {
  const dataSchema = SCHEMAS[cmd];
  if (!dataSchema) {
    throw new Error(`unknown command: ${cmd}`);
  }
  // Emit the schema inline at the root (no $ref wrapper). Passing `name`
  // would nest under `definitions` — we prefer a flat, directly-usable
  // schema so consumers can `jq '.properties.data'` without indirection.
  return zodToJsonSchema(envelope(dataSchema), {
    $refStrategy: "none",
  });
}

export function schemaCommand(): Command {
  return new Command("schema")
    .description(
      "print the JSON Schema envelope for a given command (LLM-discoverable contract)",
    )
    .argument("[cmd]", "command name; omit to list available schemas")
    .action((cmd: string | undefined) => {
      skin.setCommand("schema");

      if (!cmd) {
        // No arg: emit list of available schema names.
        skin.emit(SCHEMA_NAMES);
        skin.info(`available schemas: ${SCHEMA_NAMES.join(", ")}`);
        return;
      }

      if (!(cmd in SCHEMAS)) {
        skin.fail(
          "INVALID_ARGS",
          `unknown command '${cmd}'; expected one of ${SCHEMA_NAMES.join("|")}`,
          { cmd, valid: [...SCHEMA_NAMES] },
        );
        return;
      }

      const json = schemaFor(cmd);
      // In JSON mode the renderer wraps `json` into the outer envelope
      // (envelope.data = JSON Schema object). In text mode the renderer
      // pretty-prints the JSON Schema directly to stdout — which is the
      // human-useful rendering since JSON Schema is itself JSON.
      skin.emit(json);
    });
}
