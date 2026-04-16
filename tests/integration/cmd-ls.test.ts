// cmd/ls integration test — exercises real `git rev-parse HEAD` across the
// three repos produced by createFixture(). The fixture has at least one
// commit on each of parent / d2r2-frontend / d2r2-backend, so a successful
// ls must report non-null 40-char shas for all three.
//
// The registry we build here uses the fixture's `checkout/` directory as
// the mono project root AND as a registered worktree entry — the bash tool
// treats "worktrees" as arbitrary paths containing parent+submodules, so
// pointing at the canonical checkout is the simplest shape to validate.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Command } from "commander";

import { lsCommand } from "../../src/cmd/ls.ts";
import { skin } from "../../src/skin/index.ts";
import { saveRegistry } from "../../src/core/registry.ts";
import { envelope, LsDataSchema } from "../../src/core/schemas.ts";
import { createFixture, type Fixture } from "../helpers/fixture-repo.ts";

// ─── capture (same pattern as unit tests) ───────────────────────────────────

interface Captured {
  stdout: string[];
  stderr: string[];
}

function installCapture(): { captured: Captured; restore: () => void } {
  const captured: Captured = { stdout: [], stderr: [] };
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured.stdout.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured.stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;

  return {
    captured,
    restore: () => {
      process.stdout.write = originalStdout as typeof process.stdout.write;
      process.stderr.write = originalStderr as typeof process.stderr.write;
    },
  };
}

function buildProgram(): Command {
  const program = new Command();
  program.name("mono").exitOverride();
  program.addCommand(lsCommand());
  return program;
}

interface ParsedEnvelope {
  ok: boolean;
  command: string;
  data: unknown;
  warnings: string[];
  error: { code: string; message: string } | null;
  meta: { mono_version: string; elapsed_ms: number };
}

function parseEnvelope(stdout: string[]): ParsedEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0] ?? "{}") as ParsedEnvelope;
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("cmd/ls (integration)", () => {
  let cap: ReturnType<typeof installCapture>;
  let fixture: Fixture;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    cap = installCapture();
    fixture = await createFixture();
    process.chdir(fixture.checkout);
    skin.configure({ json: true, color: false, quiet: false, verbose: false });
  });

  afterEach(async () => {
    cap.restore();
    process.chdir(originalCwd);
    await fixture.cleanup();
  });

  test("registered worktree points at a real checkout → all three heads resolve", async () => {
    await saveRegistry(fixture.checkout, {
      worktrees: [{ name: "foo", path: fixture.checkout }],
      config: {},
      queue: [],
    });

    await buildProgram().parseAsync(["node", "mono", "ls"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);
    expect(env.error).toBeNull();
    expect(env.warnings).toEqual([]);

    const parsed = envelope(LsDataSchema).safeParse(env);
    if (!parsed.success) {
      throw new Error(`envelope schema mismatch: ${parsed.error.message}`);
    }

    const data = env.data as Array<{
      name: string;
      path: string;
      parent_head: string | null;
      frontend_head: string | null;
      backend_head: string | null;
    }>;
    expect(data).toHaveLength(1);
    const item = data[0]!;
    expect(item.name).toBe("foo");
    expect(item.path).toBe(fixture.checkout);

    // Full 40-char shas in JSON mode (not truncated).
    const shaRe = /^[0-9a-f]{40}$/;
    expect(item.parent_head).toMatch(shaRe);
    expect(item.frontend_head).toMatch(shaRe);
    expect(item.backend_head).toMatch(shaRe);
  });
});
