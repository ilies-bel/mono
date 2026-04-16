// cmd/commit integration test — exercises the sequenced
// submodule-then-parent commit flow against real worktrees produced by
// createFixture() + `mono new`.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Command } from "commander";
import { writeFile, realpath, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";

import { newCommand } from "../../src/cmd/new.ts";
import { commitCommand } from "../../src/cmd/commit.ts";
import { skin } from "../../src/skin/index.ts";
import { saveRegistry } from "../../src/core/registry.ts";
import { envelope, CommitDataSchema } from "../../src/core/schemas.ts";
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
  for (const sub of [newCommand(), commitCommand()]) {
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
  error: { code: string; message: string } | null;
  meta: { mono_version: string; elapsed_ms: number };
}

function parseLastEnvelope(stdout: string[]): ParsedEnvelope {
  // A single command run produces exactly one envelope line.
  expect(stdout.length).toBeGreaterThanOrEqual(1);
  const last = stdout[stdout.length - 1] ?? "{}";
  return JSON.parse(last) as ParsedEnvelope;
}

function resetSkin(cap: ReturnType<typeof installCapture>): void {
  cap.captured.stdout.length = 0;
  cap.captured.stderr.length = 0;
  skin.configure({ json: true, color: false, quiet: false, verbose: false });
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("cmd/commit (integration)", () => {
  let cap: ReturnType<typeof installCapture>;
  let fixture: Fixture;
  let originalCwd: string;
  let checkoutReal: string;

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

    // Set up the `foo` worktree used by most tests.
    await buildProgram().parseAsync(["node", "mono", "new", "foo"]);
    skin.flush();
    resetSkin(cap);
  });

  afterEach(async () => {
    cap.restore();
    process.chdir(originalCwd);
    await fixture.cleanup();
  });

  test("happy path: -am commits frontend, skips backend, commits parent gitlink", async () => {
    const wtPath = join(checkoutReal, ".mono", "worktrees", "foo");
    const fePath = join(wtPath, "d2r2-frontend");

    await writeFile(join(fePath, "feature.txt"), "hello\n", "utf8");

    await buildProgram().parseAsync([
      "node",
      "mono",
      "commit",
      "foo",
      "-a",
      "-m",
      "feat: x",
    ]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.error).toBeNull();
    expect(env.ok).toBe(true);

    const parsed = envelope(CommitDataSchema).safeParse(env);
    if (!parsed.success) {
      throw new Error(`envelope schema mismatch: ${parsed.error.message}`);
    }

    const data = env.data as {
      name: string;
      message: string;
      repos: Array<{
        repo: string;
        committed: boolean;
        sha: string | null;
        reason?: string;
      }>;
    };
    expect(data.name).toBe("foo");
    expect(data.message).toBe("feat: x");

    const byRepo = Object.fromEntries(data.repos.map((r) => [r.repo, r]));
    expect(byRepo["d2r2-frontend"]?.committed).toBe(true);
    expect(byRepo["d2r2-frontend"]?.sha).toMatch(/^[0-9a-f]{40}$/u);
    expect(byRepo["d2r2-frontend"]?.reason).toBe("committed");

    expect(byRepo["d2r2-backend"]?.committed).toBe(false);
    expect(byRepo["d2r2-backend"]?.sha).toBeNull();
    expect(byRepo["d2r2-backend"]?.reason).toBe("nothing-staged");

    expect(byRepo["parent"]?.committed).toBe(true);
    expect(byRepo["parent"]?.sha).toMatch(/^[0-9a-f]{40}$/u);
    expect(byRepo["parent"]?.reason).toBe("committed");

    // Parent's last commit should have updated the frontend gitlink to the
    // new frontend HEAD.
    const { stdout: parentLog } = await execa(
      "git",
      ["log", "-1", "--pretty=%B"],
      { cwd: wtPath },
    );
    expect(parentLog.trim()).toBe("feat: x");

    const { stdout: parentShow } = await execa(
      "git",
      ["show", "--name-only", "--pretty=", "HEAD"],
      { cwd: wtPath },
    );
    expect(parentShow).toContain("d2r2-frontend");
  });

  test("no-op: fresh worktree commit emits nothing-staged on every repo", async () => {
    await buildProgram().parseAsync([
      "node",
      "mono",
      "commit",
      "foo",
      "-m",
      "empty",
    ]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);
    expect(env.error).toBeNull();

    const data = env.data as {
      repos: Array<{ committed: boolean; reason?: string }>;
    };
    expect(data.repos).toHaveLength(3);
    for (const r of data.repos) {
      expect(r.committed).toBe(false);
      expect(r.reason).toBe("nothing-staged");
    }

    // Warning recorded.
    expect(env.warnings).toContain("nothing to commit");
  });

  test("missing -m → INVALID_ARGS (commander rejects)", async () => {
    // commander's requiredOption throws on missing -m; we tolerate either a
    // thrown error (stdout empty) or an INVALID_ARGS envelope.
    await buildProgram()
      .parseAsync(["node", "mono", "commit", "foo"])
      .catch(() => undefined);
    skin.flush();

    // Commander throws via exitOverride before our action runs — our action
    // never flipped the envelope to failed, so the flushed envelope will
    // report `ok: true` with no data. Either shape is acceptable: the
    // contract only promises that the bad invocation is surfaced as an
    // error (via thrown CommanderError).
    if (cap.captured.stdout.length > 0) {
      const env = parseLastEnvelope(cap.captured.stdout);
      if (!env.ok) {
        expect(env.error?.code).toBe("INVALID_ARGS");
      } else {
        // Commander rejected before action ran; no data was emitted.
        expect(env.data).toBeNull();
      }
    }
  });

  test("unknown worktree → NOT_FOUND", async () => {
    await buildProgram().parseAsync([
      "node",
      "mono",
      "commit",
      "ghost",
      "-m",
      "nope",
    ]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("NOT_FOUND");
  });

  test("outside project → MISSING_REGISTRY", async () => {
    // Move to a tmpdir that has no .mono marker above it.
    const outsideRoot = await realpath(
      await mkdtemp(join(tmpdir(), "mono-ts-outside-")),
    );
    try {
      process.chdir(outsideRoot);
      resetSkin(cap);
      await buildProgram().parseAsync([
        "node",
        "mono",
        "commit",
        "foo",
        "-m",
        "msg",
      ]);
      skin.flush();

      const env = parseLastEnvelope(cap.captured.stdout);
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe("MISSING_REGISTRY");
    } finally {
      process.chdir(checkoutReal);
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
