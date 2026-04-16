// cmd/init unit tests — covers all three paths:
//   1. dir without .gitmodules → NOT_MONO_ROOT, ok:false.
//   2. dir with .gitmodules, first run → creates .mono, already_initialized:false.
//   3. dir with existing .mono → warns, already_initialized:true, no overwrite.
//
// Tests run the action directly (commander's .parseAsync) with stdout/stderr
// captured so we can assert the JSON envelope and warnings without spawning
// a subprocess. This keeps the unit tier fast and isolates the skin layer.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

import { initCommand } from "../../src/cmd/init.ts";
import { skin } from "../../src/skin/index.ts";
import { envelope, InitDataSchema } from "../../src/core/schemas.ts";

// ─── stdout/stderr capture (mirrors skin.test.ts) ───────────────────────────

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

// Build a fresh program wrapping only `init` so we can invoke it via argv.
function buildProgram(): Command {
  const program = new Command();
  program.name("mono").exitOverride();
  program.addCommand(initCommand());
  return program;
}

// ─── tmpdir helpers ─────────────────────────────────────────────────────────

async function makeTmpDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "mono-ts-init-"));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("cmd/init", () => {
  let cap: ReturnType<typeof installCapture>;
  let work: string;

  beforeEach(async () => {
    cap = installCapture();
    work = await makeTmpDir();
  });

  afterEach(async () => {
    cap.restore();
    await cleanup(work);
  });

  test("fails with NOT_MONO_ROOT when .gitmodules is absent (json mode)", async () => {
    skin.configure({ json: true, color: false, quiet: false, verbose: false });
    const program = buildProgram();
    await program.parseAsync(["node", "mono", "init", work]);
    skin.flush();

    expect(cap.captured.stdout).toHaveLength(1);
    const env = JSON.parse(cap.captured.stdout[0] ?? "{}");
    expect(env.ok).toBe(false);
    expect(env.command).toBe("init");
    expect(env.error).not.toBeNull();
    expect(env.error.code).toBe("NOT_MONO_ROOT");
    expect(env.error.message).toContain(work);
    expect(skin.isFailed()).toBe(true);
  });

  test("first init on a valid parent root creates .mono and emits already_initialized=false", async () => {
    await writeFile(join(work, ".gitmodules"), "", "utf8");

    skin.configure({ json: true, color: false, quiet: false, verbose: false });
    const program = buildProgram();
    await program.parseAsync(["node", "mono", "init", work]);
    skin.flush();

    const env = JSON.parse(cap.captured.stdout[0] ?? "{}");
    expect(env.ok).toBe(true);
    expect(env.command).toBe("init");
    expect(env.error).toBeNull();
    expect(env.data).toEqual({ path: work, already_initialized: false });

    // Validate the full envelope shape against the zod schema.
    const parsed = envelope(InitDataSchema).safeParse(env);
    expect(parsed.success).toBe(true);

    // .mono/ directory exists with config.yml + state.json.
    const configFile = join(work, ".mono", "config.yml");
    const stateFile = join(work, ".mono", "state.json");
    const cfgBody = await readFile(configFile, "utf8");
    expect(cfgBody).toContain("# mono config");
    const stBody = await readFile(stateFile, "utf8");
    expect(JSON.parse(stBody)).toEqual({ worktrees: [], queue: [] });
  });

  test("second init on the same dir warns, sets already_initialized=true, and does not overwrite", async () => {
    await writeFile(join(work, ".gitmodules"), "", "utf8");
    const configFile = join(work, ".mono", "config.yml");
    const stateFile = join(work, ".mono", "state.json");

    // First run creates .mono/.
    skin.configure({ json: true, color: false, quiet: false, verbose: false });
    await buildProgram().parseAsync(["node", "mono", "init", work]);
    skin.flush();

    const stBeforeCfg = await stat(configFile);
    const stBeforeSt = await stat(stateFile);
    const bodyBeforeCfg = await readFile(configFile, "utf8");
    const bodyBeforeSt = await readFile(stateFile, "utf8");

    // Reset capture for the second run.
    cap.restore();
    cap = installCapture();

    // Second run: new skin config (fresh envelope).
    skin.configure({ json: true, color: false, quiet: false, verbose: false });
    await buildProgram().parseAsync(["node", "mono", "init", work]);
    skin.flush();

    const env = JSON.parse(cap.captured.stdout[0] ?? "{}");
    expect(env.ok).toBe(true);
    expect(env.command).toBe("init");
    expect(env.error).toBeNull();
    expect(env.data).toEqual({ path: work, already_initialized: true });
    expect(env.warnings.length).toBeGreaterThan(0);
    expect(env.warnings[0]).toContain("already initialized");

    // Both files unchanged (same mtime and bytes).
    const stAfterCfg = await stat(configFile);
    const stAfterSt = await stat(stateFile);
    expect(stAfterCfg.mtimeMs).toBe(stBeforeCfg.mtimeMs);
    expect(stAfterSt.mtimeMs).toBe(stBeforeSt.mtimeMs);
    expect(await readFile(configFile, "utf8")).toBe(bodyBeforeCfg);
    expect(await readFile(stateFile, "utf8")).toBe(bodyBeforeSt);
  });

  test("envelope validates against envelope(InitDataSchema) on success path", async () => {
    await writeFile(join(work, ".gitmodules"), "", "utf8");

    skin.configure({ json: true, color: false, quiet: false, verbose: false });
    await buildProgram().parseAsync(["node", "mono", "init", work]);
    skin.flush();

    const env = JSON.parse(cap.captured.stdout[0] ?? "{}");
    const parsed = envelope(InitDataSchema).safeParse(env);
    if (!parsed.success) {
      throw new Error(`envelope schema mismatch: ${parsed.error.message}`);
    }
    expect(parsed.success).toBe(true);
  });
});
