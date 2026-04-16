// cmd/rm integration test — exercises the submodule-first, parent-last
// removal sequence, dirty-check/--force override, stale-path tolerance, and
// registry unregister semantics against real worktrees produced by
// createFixture() + `mono new`.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Command } from "commander";
import { writeFile, realpath, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";

import { newCommand } from "../../src/cmd/new.ts";
import { rmCommand } from "../../src/cmd/rm.ts";
import { skin } from "../../src/skin/index.ts";
import {
  loadRegistry,
  saveRegistry,
  isRegistered,
} from "../../src/core/registry.ts";
import { envelope, RmDataSchema } from "../../src/core/schemas.ts";
import { createFixture, type Fixture } from "../helpers/fixture-repo.ts";

// ─── capture ────────────────────────────────────────────────────────────────

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
  program
    .name("mono")
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
  for (const sub of [newCommand(), rmCommand()]) {
    sub.exitOverride().configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
    program.addCommand(sub);
  }
  return program;
}

interface ParsedEnvelope {
  ok: boolean;
  command: string;
  data: unknown;
  warnings: string[];
  error: { code: string; message: string; details?: Record<string, unknown> } | null;
  meta: { mono_version: string; elapsed_ms: number };
}

function parseLastEnvelope(stdout: string[]): ParsedEnvelope {
  expect(stdout.length).toBeGreaterThanOrEqual(1);
  const last = stdout[stdout.length - 1] ?? "{}";
  return JSON.parse(last) as ParsedEnvelope;
}

function resetSkin(cap: ReturnType<typeof installCapture>): void {
  cap.captured.stdout.length = 0;
  cap.captured.stderr.length = 0;
  skin.configure({ json: true, color: false, quiet: false, verbose: false });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("cmd/rm (integration)", () => {
  let cap: ReturnType<typeof installCapture>;
  let fixture: Fixture;
  let originalCwd: string;
  let checkoutReal: string;
  let wtPath: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    cap = installCapture();
    fixture = await createFixture();
    checkoutReal = await realpath(fixture.checkout);
    process.chdir(checkoutReal);
    skin.configure({ json: true, color: false, quiet: false, verbose: false });

    await saveRegistry(checkoutReal, {
      worktrees: [],
      config: {},
      queue: [],
    });

    await writeFile(join(checkoutReal, ".gitignore"), ".mono\n", "utf8");
    await execa("git", ["add", ".gitignore"], { cwd: checkoutReal });
    await execa("git", ["commit", "-m", "chore: ignore .mono"], {
      cwd: checkoutReal,
    });

    // Seed the `foo` worktree used by most tests.
    await buildProgram().parseAsync(["node", "mono", "new", "foo"]);
    skin.flush();
    resetSkin(cap);

    wtPath = join(checkoutReal, ".mono", "worktrees", "foo");
  });

  afterEach(async () => {
    cap.restore();
    process.chdir(originalCwd);
    await fixture.cleanup();
  });

  test("happy path: clean worktree removes all 3, unregisters, preserves branches", async () => {
    await buildProgram().parseAsync(["node", "mono", "rm", "foo"]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);
    expect(env.error).toBeNull();

    const parsed = envelope(RmDataSchema).safeParse(env);
    if (!parsed.success) {
      throw new Error(`envelope schema mismatch: ${parsed.error.message}`);
    }

    const data = env.data as {
      name: string;
      removed: { parent: boolean; frontend: boolean; backend: boolean };
      unregistered: boolean;
    };
    expect(data.name).toBe("foo");
    expect(data.removed.parent).toBe(true);
    expect(data.removed.frontend).toBe(true);
    expect(data.removed.backend).toBe(true);
    expect(data.unregistered).toBe(true);

    // Registry no longer contains foo.
    const reg = await loadRegistry(checkoutReal);
    expect(isRegistered(reg, "foo")).toBe(false);

    // Physical paths gone.
    expect(await pathExists(wtPath)).toBe(false);

    // Branches preserved in each repo.
    for (const repo of [
      checkoutReal,
      join(checkoutReal, "d2r2-frontend"),
      join(checkoutReal, "d2r2-backend"),
    ]) {
      const r = await execa(
        "git",
        ["show-ref", "--verify", "--quiet", "refs/heads/feature/foo"],
        { cwd: repo, reject: false },
      );
      expect(r.exitCode).toBe(0);
    }
  });

  test("dirty without --force: DIRTY_WORKTREE, worktree intact, registry intact", async () => {
    await writeFile(
      join(wtPath, "d2r2-frontend", "dirt.txt"),
      "dirty\n",
      "utf8",
    );

    await buildProgram().parseAsync(["node", "mono", "rm", "foo"]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("DIRTY_WORKTREE");
    // Submodule untracked file shows as dirty in the submodule itself AND in
    // the parent (gitlink-as-modified). Require at least the submodule.
    const dirtyRepos = env.error?.details?.dirty_repos as string[];
    expect(dirtyRepos).toContain("d2r2-frontend");

    // Worktree still present.
    expect(await pathExists(wtPath)).toBe(true);
    expect(await pathExists(join(wtPath, "d2r2-frontend"))).toBe(true);

    // Registry still has foo.
    const reg = await loadRegistry(checkoutReal);
    expect(isRegistered(reg, "foo")).toBe(true);
  });

  test("dirty with --force: succeeds, worktree gone, unregistered", async () => {
    await writeFile(
      join(wtPath, "d2r2-frontend", "dirt.txt"),
      "dirty\n",
      "utf8",
    );

    await buildProgram().parseAsync(["node", "mono", "rm", "foo", "--force"]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);
    expect(env.error).toBeNull();

    const data = env.data as {
      removed: { parent: boolean; frontend: boolean; backend: boolean };
      unregistered: boolean;
    };
    expect(data.removed.parent).toBe(true);
    expect(data.removed.frontend).toBe(true);
    expect(data.removed.backend).toBe(true);
    expect(data.unregistered).toBe(true);

    expect(await pathExists(wtPath)).toBe(false);

    const reg = await loadRegistry(checkoutReal);
    expect(isRegistered(reg, "foo")).toBe(false);
  });

  test("unknown name → NOT_FOUND", async () => {
    await buildProgram().parseAsync(["node", "mono", "rm", "ghost"]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("NOT_FOUND");
  });

  test("outside project → MISSING_REGISTRY", async () => {
    const outsideRoot = await realpath(
      await mkdtemp(join(tmpdir(), "mono-ts-outside-")),
    );
    try {
      process.chdir(outsideRoot);
      resetSkin(cap);
      await buildProgram().parseAsync(["node", "mono", "rm", "foo"]);
      skin.flush();

      const env = parseLastEnvelope(cap.captured.stdout);
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe("MISSING_REGISTRY");
    } finally {
      process.chdir(checkoutReal);
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test("stale path: physically remove one submodule dir, then --force succeeds", async () => {
    // Nuke the frontend worktree dir out from under us so `git worktree
    // remove` can't work for that repo. `--force` should still clean up what
    // remains and drop the registry entry.
    await rm(join(wtPath, "d2r2-frontend"), { recursive: true, force: true });

    await buildProgram().parseAsync(["node", "mono", "rm", "foo", "--force"]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);
    expect(env.error).toBeNull();

    const data = env.data as {
      removed: { parent: boolean; frontend: boolean; backend: boolean };
      unregistered: boolean;
    };
    // Frontend physical dir was already gone → removed=false; others removed.
    expect(data.removed.frontend).toBe(false);
    expect(data.removed.backend).toBe(true);
    expect(data.removed.parent).toBe(true);
    expect(data.unregistered).toBe(true);

    // Registry entry gone.
    const reg = await loadRegistry(checkoutReal);
    expect(isRegistered(reg, "foo")).toBe(false);

    // Parent container path cleaned.
    expect(await pathExists(wtPath)).toBe(false);
  });
});
