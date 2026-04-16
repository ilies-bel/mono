// cmd/new integration test — exercises `git worktree add` against the three
// repos produced by createFixture(), plus the auto-alignment commit on the
// parent worktree's gitlinks.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Command } from "commander";
import { writeFile, mkdir, rm, realpath, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";

import { newCommand } from "../../src/cmd/new.ts";
import { skin } from "../../src/skin/index.ts";
import {
  loadRegistry,
  saveRegistry,
  setConfig,
} from "../../src/core/registry.ts";
import { envelope, NewDataSchema } from "../../src/core/schemas.ts";
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
  const sub = newCommand();
  sub.exitOverride().configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  program.addCommand(sub);
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

describe("cmd/new (integration)", () => {
  let cap: ReturnType<typeof installCapture>;
  let fixture: Fixture;
  let originalCwd: string;
  let checkoutReal: string;
  const extraPaths: string[] = [];

  beforeEach(async () => {
    originalCwd = process.cwd();
    cap = installCapture();
    fixture = await createFixture();
    // macOS tmpdir may resolve via /var -> /private/var; normalise.
    checkoutReal = await realpath(fixture.checkout);
    process.chdir(checkoutReal);
    skin.configure({ json: true, color: false, quiet: false, verbose: false });

    // Initialize mono registry (what `mono init` would do) so findProjectRoot
    // sees the marker.
    await saveRegistry(checkoutReal, {
      worktrees: [],
      config: {},
      queue: [],
    });

    // Keep .mono out of the parent's working tree so gitlink alignment only
    // picks up the submodule HEAD diffs we care about.
    await writeFile(join(checkoutReal, ".gitignore"), ".mono\n", "utf8");
    await execa("git", ["add", ".gitignore"], { cwd: checkoutReal });
    await execa("git", ["commit", "-m", "chore: ignore .mono"], {
      cwd: checkoutReal,
    });
  });

  afterEach(async () => {
    cap.restore();
    process.chdir(originalCwd);
    for (const p of extraPaths.splice(0)) {
      await rm(p, { recursive: true, force: true });
    }
    await fixture.cleanup();
  });

  test("happy path: creates branches + worktrees in all three repos", async () => {
    await buildProgram().parseAsync(["node", "mono", "new", "foo"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.error).toBeNull();
    expect(env.ok).toBe(true);

    const parsed = envelope(NewDataSchema).safeParse(env);
    if (!parsed.success) {
      throw new Error(`envelope schema mismatch: ${parsed.error.message}`);
    }

    const data = env.data as {
      name: string;
      path: string;
      branch: string;
      base: string;
      created: { parent: string; frontend: string; backend: string };
      aligned: boolean;
    };
    expect(data.name).toBe("foo");
    expect(data.branch).toBe("feature/foo");
    expect(data.base).toBe("main");
    expect(data.created.parent).toBe("created");
    expect(data.created.frontend).toBe("created");
    expect(data.created.backend).toBe("created");

    const expectedPath = join(checkoutReal, ".mono", "worktrees", "foo");
    expect(data.path).toBe(expectedPath);

    // Dirs exist.
    expect(existsSync(expectedPath)).toBe(true);
    expect(existsSync(join(expectedPath, "d2r2-frontend"))).toBe(true);
    expect(existsSync(join(expectedPath, "d2r2-backend"))).toBe(true);

    // Branch feature/foo exists in all three source repos.
    for (const repoCwd of [
      checkoutReal,
      join(checkoutReal, "d2r2-frontend"),
      join(checkoutReal, "d2r2-backend"),
    ]) {
      const r = await execa(
        "git",
        ["show-ref", "--verify", "--quiet", "refs/heads/feature/foo"],
        { cwd: repoCwd, reject: false },
      );
      expect(r.exitCode).toBe(0);
    }

    // Registry updated.
    const reg = await loadRegistry(checkoutReal);
    expect(reg.worktrees.map((w) => w.name)).toContain("foo");
  });

  test("invalid name (uppercase) → BAD_NAME", async () => {
    await buildProgram().parseAsync(["node", "mono", "new", "Foo"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("BAD_NAME");
  });

  test("invalid name (leading hyphen) → BAD_NAME", async () => {
    // Pass with `--` so commander doesn't try to parse `-bad` as an option.
    await buildProgram()
      .parseAsync(["node", "mono", "new", "--", "-bad"])
      .catch(() => undefined);
    skin.flush();

    // Either commander rejects or our validator rejects — we accept either
    // "BAD_NAME envelope" or a throw (stdout empty).
    if (cap.captured.stdout.length > 0) {
      const env = parseEnvelope(cap.captured.stdout);
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe("BAD_NAME");
    }
  });

  test("duplicate name → ALREADY_EXISTS", async () => {
    await buildProgram().parseAsync(["node", "mono", "new", "foo"]);
    skin.flush();
    expect(parseEnvelope(cap.captured.stdout).ok).toBe(true);

    // Reset capture buffer and renderer for the second invocation.
    cap.captured.stdout.length = 0;
    cap.captured.stderr.length = 0;
    skin.configure({ json: true, color: false, quiet: false, verbose: false });
    skin.setCommand("new");

    await buildProgram().parseAsync(["node", "mono", "new", "foo"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("ALREADY_EXISTS");
  });

  test("custom worktree-base config is respected", async () => {
    const customBase = await realpath(tmpdir());
    const baseDir = join(customBase, `mono-new-test-${Date.now()}`);
    await mkdir(baseDir, { recursive: true });
    extraPaths.push(baseDir);

    const reg = await loadRegistry(checkoutReal);
    await saveRegistry(
      checkoutReal,
      setConfig(reg, "worktree-base", baseDir),
    );

    await buildProgram().parseAsync(["node", "mono", "new", "bar"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.error).toBeNull();
    expect(env.ok).toBe(true);

    const data = env.data as { path: string };
    expect(data.path).toBe(join(baseDir, "bar"));
    const st = await stat(data.path);
    expect(st.isDirectory()).toBe(true);
  });
});
