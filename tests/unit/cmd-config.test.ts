// cmd/config unit tests — covers all four code paths (list / get / set /
// unset) plus error cases (MISSING_REGISTRY, NOT_FOUND, INVALID_ARGS).
//
// Tests invoke the command via commander's parseAsync after chdir'ing into a
// temp project root seeded with an empty .gitmodules + a freshly-saved empty
// registry (matching `mono init`). Stdout/stderr are captured so we can
// assert the JSON envelope without spawning a subprocess. The real cwd is
// restored in afterEach so test ordering doesn't matter.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { Command } from "commander";

import { configCommand } from "../../src/cmd/config.ts";
import { skin } from "../../src/skin/index.ts";
import { saveRegistry } from "../../src/core/registry.ts";
import {
  envelope,
  ConfigDataSchema,
  ConfigSetDataSchema,
  ConfigGetDataSchema,
  ConfigUnsetDataSchema,
  ConfigListDataSchema,
} from "../../src/core/schemas.ts";

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
  program.addCommand(configCommand());
  return program;
}

async function makeTmpDir(prefix: string): Promise<string> {
  // realpath: on macOS mkdtemp lands under /var which is a symlink to
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

function parseEnvelope(stdout: string[]): {
  ok: boolean;
  command: string;
  data: unknown;
  warnings: string[];
  error: { code: string; message: string } | null;
  meta: { mono_version: string; elapsed_ms: number };
} {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0] ?? "{}");
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("cmd/config", () => {
  let cap: ReturnType<typeof installCapture>;
  let work: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    cap = installCapture();
    work = await makeTmpDir("mono-ts-config-");
    process.chdir(work);
    skin.configure({ json: true, color: false, quiet: false, verbose: false });
  });

  afterEach(async () => {
    cap.restore();
    process.chdir(originalCwd);
    await rm(work, { recursive: true, force: true });
  });

  test("list (no key) returns empty config object when nothing is set", async () => {
    await seedMonoProject(work);

    await buildProgram().parseAsync(["node", "mono", "config"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);
    expect(env.command).toBe("config");
    expect(env.error).toBeNull();
    expect(env.data).toEqual({});

    const parsed = envelope(ConfigListDataSchema).safeParse(env);
    expect(parsed.success).toBe(true);
  });

  test("set: first write returns {key, value, previous:null}", async () => {
    await seedMonoProject(work);

    await buildProgram().parseAsync(["node", "mono", "config", "k", "v"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ key: "k", value: "v", previous: null });

    const parsed = envelope(ConfigSetDataSchema).safeParse(env);
    expect(parsed.success).toBe(true);
  });

  test("set: second write captures previous value", async () => {
    await seedMonoProject(work);

    // First write.
    await buildProgram().parseAsync(["node", "mono", "config", "k", "v"]);
    skin.flush();

    // Reset between runs.
    cap.restore();
    cap = installCapture();
    skin.configure({ json: true, color: false, quiet: false, verbose: false });

    // Second write.
    await buildProgram().parseAsync(["node", "mono", "config", "k", "v2"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);
    const data = env.data as { key: string; value: string; previous: string | null };
    expect(data.previous).toBe("v");
    expect(data.value).toBe("v2");
  });

  test("get: returns {key, value} for a set key", async () => {
    await seedMonoProject(work);
    await buildProgram().parseAsync(["node", "mono", "config", "k", "v"]);
    skin.flush();

    cap.restore();
    cap = installCapture();
    skin.configure({ json: true, color: false, quiet: false, verbose: false });

    await buildProgram().parseAsync(["node", "mono", "config", "k"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ key: "k", value: "v" });

    const parsed = envelope(ConfigGetDataSchema).safeParse(env);
    expect(parsed.success).toBe(true);
  });

  test("get: missing key fails with NOT_FOUND mentioning the key", async () => {
    await seedMonoProject(work);

    await buildProgram().parseAsync(["node", "mono", "config", "missing"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(false);
    expect(env.error).not.toBeNull();
    expect(env.error?.code).toBe("NOT_FOUND");
    expect(env.error?.message).toContain("missing");
    expect(skin.isFailed()).toBe(true);
  });

  test("unset: removes an existing key (removed:true)", async () => {
    await seedMonoProject(work);
    await buildProgram().parseAsync(["node", "mono", "config", "k", "v"]);
    skin.flush();

    cap.restore();
    cap = installCapture();
    skin.configure({ json: true, color: false, quiet: false, verbose: false });

    await buildProgram().parseAsync(["node", "mono", "config", "k", "--unset"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ key: "k", removed: true });

    const parsed = envelope(ConfigUnsetDataSchema).safeParse(env);
    expect(parsed.success).toBe(true);
  });

  test("unset: noop on a non-existent key returns removed:false, ok:true", async () => {
    await seedMonoProject(work);

    await buildProgram().parseAsync([
      "node",
      "mono",
      "config",
      "nope",
      "--unset",
    ]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);
    expect(env.error).toBeNull();
    expect(env.data).toEqual({ key: "nope", removed: false });
  });

  test("set + --unset together fails with INVALID_ARGS", async () => {
    await seedMonoProject(work);

    await buildProgram().parseAsync([
      "node",
      "mono",
      "config",
      "k",
      "v",
      "--unset",
    ]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("INVALID_ARGS");
    expect(skin.isFailed()).toBe(true);
  });

  test("outside a mono project (no .mono up the tree) → MISSING_REGISTRY", async () => {
    // Don't seed .mono. Also ensure no ancestor has one: mkdtemp lands under
    // the OS tmpdir which is not a mono project on the test host.
    await buildProgram().parseAsync(["node", "mono", "config"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("MISSING_REGISTRY");
    expect(env.error?.message).toContain("mono init");
    expect(skin.isFailed()).toBe(true);
  });

  test("envelope validates against envelope(ConfigDataSchema) for list path", async () => {
    await seedMonoProject(work);
    await buildProgram().parseAsync(["node", "mono", "config", "a", "1"]);
    skin.flush();

    cap.restore();
    cap = installCapture();
    skin.configure({ json: true, color: false, quiet: false, verbose: false });

    await buildProgram().parseAsync(["node", "mono", "config"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    const parsed = envelope(ConfigDataSchema).safeParse(env);
    if (!parsed.success) {
      throw new Error(`envelope schema mismatch: ${parsed.error.message}`);
    }
    expect(parsed.success).toBe(true);
    expect(env.data).toEqual({ a: "1" });
  });
});
