import { test, expect, describe } from "bun:test";

import {
  envelope,
  ErrorSchema,
  LsDataSchema,
  LsItemSchema,
  StatusDataSchema,
} from "../../src/core/schemas.ts";

describe("core/schemas", () => {
  test("envelope(LsDataSchema) accepts a valid success envelope", () => {
    const payload = {
      ok: true,
      command: "ls",
      data: [
        {
          name: "feat-a",
          path: "/abs/path",
          parent_head: "main",
          frontend_head: "feature/feat-a",
          backend_head: null,
        },
      ],
      warnings: [],
      error: null,
      meta: { mono_version: "0.3.0", elapsed_ms: 42 },
    };
    const parsed = envelope(LsDataSchema).parse(payload);
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.[0]?.name).toBe("feat-a");
  });

  test("envelope(LsDataSchema) accepts null data on error", () => {
    const payload = {
      ok: false,
      command: "ls",
      data: null,
      warnings: ["registry missing"],
      error: { code: "MISSING_REGISTRY", message: "no .mono" },
      meta: { mono_version: "0.3.0", elapsed_ms: 3 },
    };
    const parsed = envelope(LsDataSchema).parse(payload);
    expect(parsed.error?.code).toBe("MISSING_REGISTRY");
  });

  test("envelope rejects an unknown error code", () => {
    const payload = {
      ok: false,
      command: "ls",
      data: null,
      warnings: [],
      error: { code: "NOPE_NOT_A_CODE", message: "x" },
      meta: { mono_version: "0.3.0", elapsed_ms: 1 },
    };
    expect(() => envelope(LsDataSchema).parse(payload)).toThrow();
  });

  test("ErrorSchema accepts all declared codes", () => {
    const codes = [
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
    ] as const;
    for (const code of codes) {
      expect(() => ErrorSchema.parse({ code, message: "m" })).not.toThrow();
    }
  });

  test("LsItemSchema rejects missing fields", () => {
    expect(() => LsItemSchema.parse({ name: "x", path: "/p" })).toThrow();
  });

  test("StatusDataSchema accepts a well-formed status payload", () => {
    const parsed = StatusDataSchema.parse({
      name: "feat-a",
      repos: [
        { repo: "parent", branch: "feature/feat-a", clean: true, porcelain: "" },
        { repo: "d2r2-frontend", branch: null, clean: false, porcelain: " M foo.ts\n" },
        { repo: "d2r2-backend", branch: "feature/feat-a", clean: true, porcelain: "" },
      ],
    });
    expect(parsed.repos).toHaveLength(3);
  });
});
