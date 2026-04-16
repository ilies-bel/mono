// Zod schemas for every command's output envelope.
// Every command returns the same envelope shape; only `data` differs.
// Schemas marked as placeholders (z.unknown().optional()) will be tightened
// as the matching cmd/*.ts is implemented.

import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "DIRTY_WORKTREE",
  "MISSING_REGISTRY",
  "CONFLICT",
  "OFFLINE",
  "BAD_NAME",
  "NOT_MONO_ROOT",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "GIT_FAILED",
  "INVALID_ARGS",
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

export type ErrorPayload = z.infer<typeof ErrorSchema>;

export const MetaSchema = z.object({
  mono_version: z.string(),
  elapsed_ms: z.number(),
});

export type Meta = z.infer<typeof MetaSchema>;

export const RepoLabelSchema = z.enum(["parent", "d2r2-frontend", "d2r2-backend"]);

// ─── ls ─────────────────────────────────────────────────────────────────────
export const LsItemSchema = z.object({
  name: z.string(),
  path: z.string(),
  parent_head: z.string().nullable(),
  frontend_head: z.string().nullable(),
  backend_head: z.string().nullable(),
});
export type LsItem = z.infer<typeof LsItemSchema>;

export const LsDataSchema = z.array(LsItemSchema);

// ─── status ─────────────────────────────────────────────────────────────────
export const StatusRepoSchema = z.object({
  repo: RepoLabelSchema,
  branch: z.string().nullable(),
  clean: z.boolean(),
  porcelain: z.string(),
  // `true` when the repo directory is absent (stale worktree / un-inited
  // submodule). Defaulted for wire-compat with earlier envelopes that
  // predated this field.
  missing: z.boolean().default(false),
});

export const StatusDataSchema = z.object({
  name: z.string(),
  repos: z.array(StatusRepoSchema),
});

// ─── config ─────────────────────────────────────────────────────────────────
// Four shapes depending on verb form:
//   list  → Record<string,string>                  (mono config)
//   get   → { key, value }                          (mono config <key>)
//   set   → { key, value, previous: string|null }   (mono config <key> <value>)
//   unset → { key, removed: boolean }               (mono config <key> --unset)
//
// The union is structural (no `.op` discriminator tag) because the Bash
// implementation emits raw objects without a discriminator and we preserve
// wire compatibility. Downstream consumers branch on property presence.
export const ConfigListDataSchema = z.record(z.string());
export const ConfigGetDataSchema = z.object({
  key: z.string(),
  value: z.string(),
});
export const ConfigSetDataSchema = z.object({
  key: z.string(),
  value: z.string(),
  previous: z.string().nullable(),
});
export const ConfigUnsetDataSchema = z.object({
  key: z.string(),
  removed: z.boolean(),
});
export const ConfigDataSchema = z.union([
  ConfigListDataSchema,
  ConfigGetDataSchema,
  ConfigSetDataSchema,
  ConfigUnsetDataSchema,
]);

// ─── init ───────────────────────────────────────────────────────────────────
export const InitDataSchema = z.object({
  path: z.string(),
  already_initialized: z.boolean(),
});
export type InitData = z.infer<typeof InitDataSchema>;

// ─── new ────────────────────────────────────────────────────────────────────
export const WorktreeCreatedStateSchema = z.enum(["created", "reused"]);
export type WorktreeCreatedState = z.infer<typeof WorktreeCreatedStateSchema>;

export const NewDataSchema = z.object({
  name: z.string(),
  path: z.string(),
  branch: z.string(),
  base: z.string(),
  created: z.object({
    parent: WorktreeCreatedStateSchema,
    frontend: WorktreeCreatedStateSchema,
    backend: WorktreeCreatedStateSchema,
  }),
  aligned: z.boolean(),
});
export type NewData = z.infer<typeof NewDataSchema>;

// ─── commit ─────────────────────────────────────────────────────────────────
export const CommitRepoSchema = z.object({
  repo: RepoLabelSchema,
  committed: z.boolean(),
  sha: z.string().nullable(),
  reason: z.enum(["committed", "nothing-staged"]).optional(),
});
export type CommitRepo = z.infer<typeof CommitRepoSchema>;

export const CommitDataSchema = z.object({
  name: z.string(),
  message: z.string(),
  repos: z.array(CommitRepoSchema),
});
export type CommitData = z.infer<typeof CommitDataSchema>;

// ─── rm ─────────────────────────────────────────────────────────────────────
export const RmDataSchema = z.object({
  name: z.string(),
  removed: z.object({
    parent: z.boolean(),
    frontend: z.boolean(),
    backend: z.boolean(),
  }),
  unregistered: z.boolean(),
});
export type RmData = z.infer<typeof RmDataSchema>;

// ─── rebase ─────────────────────────────────────────────────────────────────
export const RebaseStepSchema = z
  .object({ old_head: z.string(), new_head: z.string() })
  .nullable();

export const RebaseFetchStatusSchema = z.enum(["ok", "failed"]);

export const RebaseDataSchema = z.object({
  name: z.string(),
  upstream: z.string(),
  fetch: z.object({
    parent: RebaseFetchStatusSchema,
    frontend: RebaseFetchStatusSchema,
    backend: RebaseFetchStatusSchema,
  }),
  rebase: z.object({
    parent: RebaseStepSchema,
    frontend: RebaseStepSchema,
    backend: RebaseStepSchema,
  }),
  amended: z.boolean(),
  conflict: z
    .object({
      repo: z.enum(["parent", "d2r2-frontend", "d2r2-backend"]),
      step: z.literal("rebase"),
    })
    .nullable(),
});
export type RebaseData = z.infer<typeof RebaseDataSchema>;

// `mono rebase all` aggregates one RebaseData per registered worktree.
// Default policy stops at the first conflict; with --keep-going every
// worktree is attempted and the caller sees per-worktree outcomes.
export const RebaseAllDataSchema = z.object({
  upstream: z.string(),
  keep_going: z.boolean(),
  worktrees: z.array(RebaseDataSchema),
  stopped_at: z.string().nullable(),
});
export type RebaseAllData = z.infer<typeof RebaseAllDataSchema>;

// ─── push ───────────────────────────────────────────────────────────────────
export const PushResultSchema = z.object({
  repo: RepoLabelSchema,
  branch: z.string(),
  pushed: z.boolean(),
  queued: z.boolean(),
  mr_url: z.string().nullable(),
  error: z.string().nullable(),
});
export type PushResult = z.infer<typeof PushResultSchema>;

export const PushDataSchema = z.object({
  name: z.string(),
  bead_id: z.string().nullable(),
  results: z.array(PushResultSchema),
});
export type PushData = z.infer<typeof PushDataSchema>;

// `mono push all` aggregates one PushData per registered worktree.
export const PushAllDataSchema = z.object({
  bead_id: z.string().nullable(),
  worktrees: z.array(PushDataSchema),
});
export type PushAllData = z.infer<typeof PushAllDataSchema>;

// ─── placeholders (tightened by sibling beads) ──────────────────────────────
export const SchemaDataSchema = z.unknown().optional();

// ─── envelope factory ───────────────────────────────────────────────────────
export function envelope<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    ok: z.boolean(),
    command: z.string(),
    data: dataSchema.nullable(),
    warnings: z.array(z.string()),
    error: ErrorSchema.nullable(),
    meta: MetaSchema,
  });
}

export type Envelope<T> = {
  ok: boolean;
  command: string;
  data: T | null;
  warnings: string[];
  error: ErrorPayload | null;
  meta: Meta;
};
