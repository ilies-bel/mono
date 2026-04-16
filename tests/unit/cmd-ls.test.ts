// cmd/ls unit tests — cover the "no worktrees", "missing paths" and
// "outside project" code paths without spawning real git repos.
//
// The approach mirrors cmd-config.test.ts: chdir into a temp project root,
// seed a .mono registry with the worktrees we want, run commander via
// parseAsync, and assert against the JSON envelope captured from stdout.
//
// Integration-level coverage (real git repos, HEAD resolution) lives in
// tests/integration/cmd-ls.test.ts.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { Command } from "commander";

import { lsCommand } from "../../src/cmd/ls.ts";
import { skin } from "../../src/skin/index.ts";
import { saveRegistry } from "../../src/core/registry.ts";
import { envelope, LsDataSchema } from "../../src/core/schemas.ts";

// ─── stdout/stderr capture ──────────────────────────────────────────────────

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

async function makeTmpDir(prefix: string): Promise<string> {
  // realpath: macOS mkdtemp lands under /var which is a symlink to
  // /private/var — findProjectRoot resolves real paths, so we normalize.
  const raw = await mkdtemp(join(tmpdir(), prefix));
  return realpathSync(raw);
}

async function seedMonoProject(root: string): Promise<void> {
  await writeFile(join(root, ".gitmodules"), "", "utf8");
  await saveRegistry(root, {
    worktrees: [],
    config: {},
    queue: [],
  });
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

describe("cmd/ls", () => {
  let cap: ReturnType<typeof installCapture>;
  let work: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    cap = installCapture();
    work = await makeTmpDir("mono-ts-ls-");
    process.chdir(work);
    skin.configure({ json: true, color: false, quiet: false, verbose: false });
  });

  afterEach(async () => {
    cap.restore();
    process.chdir(originalCwd);
    await rm(work, { recursive: true, force: true });
  });

  test("empty registry → data:[] and ok:true", async () => {
    await seedMonoProject(work);

    await buildProgram().parseAsync(["node", "mono", "ls"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);
    expect(env.command).toBe("ls");
    expect(env.error).toBeNull();
    expect(env.data).toEqual([]);

    const parsed = envelope(LsDataSchema).safeParse(env);
    expect(parsed.success).toBe(true);
  });

  test("registered paths that don't exist → entries with null heads + warnings", async () => {
    await writeFile(join(work, ".gitmodules"), "", "utf8");
    await saveRegistry(work, {
      worktrees: [
        { name: "beta", path: join(work, "does-not-exist-beta") },
        { name: "alpha", path: join(work, "does-not-exist-alpha") },
      ],
      config: {},
      queue: [],
    });

    await buildProgram().parseAsync(["node", "mono", "ls"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);
    expect(env.error).toBeNull();

    const parsed = envelope(LsDataSchema).safeParse(env);
    if (!parsed.success) {
      throw new Error(`envelope schema mismatch: ${parsed.error.message}`);
    }

    // Output order is stable: sorted by name.
    const data = env.data as Array<{
      name: string;
      path: string;
      parent_head: string | null;
      frontend_head: string | null;
      backend_head: string | null;
    }>;
    expect(data.map((d) => d.name)).toEqual(["alpha", "beta"]);
    for (const item of data) {
      expect(item.parent_head).toBeNull();
      expect(item.frontend_head).toBeNull();
      expect(item.backend_head).toBeNull();
    }

    // Two missing-path warnings surfaced in envelope.
    expect(env.warnings).toHaveLength(2);
    expect(env.warnings.join("\n")).toContain("alpha");
    expect(env.warnings.join("\n")).toContain("beta");
  });

  test("outside a mono project → MISSING_REGISTRY", async () => {
    // Don't seed .mono; tmpdir has no mono ancestor on the test host.
    await buildProgram().parseAsync(["node", "mono", "ls"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(false);
    expect(env.error).not.toBeNull();
    expect(env.error?.code).toBe("MISSING_REGISTRY");
    expect(env.error?.message).toContain("mono init");
    expect(skin.isFailed()).toBe(true);
  });
});
