// cmd/push integration test — exercises the parallel push + queue-on-failure
// flow against real worktrees produced by createFixture() + `mono new`.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Command } from "commander";
import {
  writeFile,
  realpath,
  mkdtemp,
  rm,
  rename,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";

import { newCommand } from "../../src/cmd/new.ts";
import { commitCommand } from "../../src/cmd/commit.ts";
import { pushCommand } from "../../src/cmd/push.ts";
import { skin } from "../../src/skin/index.ts";
import { loadRegistry, saveRegistry } from "../../src/core/registry.ts";
import {
  envelope,
  PushAllDataSchema,
  PushDataSchema,
} from "../../src/core/schemas.ts";
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
  for (const sub of [newCommand(), commitCommand(), pushCommand()]) {
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

interface PushResultShape {
  repo: "parent" | "d2r2-frontend" | "d2r2-backend";
  branch: string;
  pushed: boolean;
  queued: boolean;
  mr_url: string | null;
  error: string | null;
}

interface PushDataShape {
  name: string;
  bead_id: string | null;
  results: PushResultShape[];
}

async function dirExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("cmd/push (integration)", () => {
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

    // Create worktree `foo` and commit something to each repo so there's
    // actually a branch tip to push.
    await buildProgram().parseAsync(["node", "mono", "new", "foo"]);
    skin.flush();
    resetSkin(cap);

    wtPath = join(checkoutReal, ".mono", "worktrees", "foo");

    // Touch a file in each submodule so `mono commit -a -m` produces
    // commits on the feature branches we'll push.
    await writeFile(
      join(wtPath, "d2r2-frontend", "feature-fe.txt"),
      "fe\n",
      "utf8",
    );
    await writeFile(
      join(wtPath, "d2r2-backend", "feature-be.txt"),
      "be\n",
      "utf8",
    );
    await buildProgram().parseAsync([
      "node",
      "mono",
      "commit",
      "foo",
      "-a",
      "-m",
      "feat: seed push",
    ]);
    skin.flush();
    resetSkin(cap);

    // Clear any BEAD_ID that may have leaked from the host env.
    delete process.env.BEAD_ID;
  });

  afterEach(async () => {
    cap.restore();
    process.chdir(originalCwd);
    delete process.env.BEAD_ID;
    await fixture.cleanup();
  });

  test("happy path: pushes all three repos, envelope validates", async () => {
    await buildProgram().parseAsync(["node", "mono", "push", "foo"]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.error).toBeNull();
    expect(env.ok).toBe(true);

    const parsed = envelope(PushDataSchema).safeParse(env);
    if (!parsed.success) {
      throw new Error(`envelope schema mismatch: ${parsed.error.message}`);
    }

    const data = env.data as PushDataShape;
    expect(data.name).toBe("foo");
    expect(data.bead_id).toBeNull();
    expect(data.results).toHaveLength(3);

    const byRepo = Object.fromEntries(data.results.map((r) => [r.repo, r]));
    for (const label of ["parent", "d2r2-frontend", "d2r2-backend"] as const) {
      const row = byRepo[label];
      expect(row).toBeDefined();
      expect(row?.pushed).toBe(true);
      expect(row?.queued).toBe(false);
      expect(row?.error).toBeNull();
      // file:// remotes don't emit a MR URL from the server. The fallback
      // parser only produces URLs for GitLab/GitHub-shaped remotes — our
      // origin is a local `.git` directory, so mr_url stays null.
      expect(row?.mr_url).toBeNull();
      expect(row?.branch).toBe("feature/foo");
    }

    // The bare parent origin now has the feature branch.
    const { stdout: lsRemote } = await execa("git", [
      "ls-remote",
      "--heads",
      fixture.origins.parent,
      "feature/foo",
    ]);
    expect(lsRemote).toMatch(/feature\/foo/u);

    // Queue is empty on success.
    const reg = await loadRegistry(checkoutReal);
    expect(reg.queue).toEqual([]);
  });

  test("failure: broken origin gets queued; retry after repair clears queue", async () => {
    // Temporarily rename the frontend bare origin so its push fails.
    const brokenOrigin = `${fixture.origins.frontend}.broken`;
    await rename(fixture.origins.frontend, brokenOrigin);

    try {
      await buildProgram().parseAsync(["node", "mono", "push", "foo"]);
      skin.flush();

      const env = parseLastEnvelope(cap.captured.stdout);
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe("GIT_FAILED");

      const data = env.data as PushDataShape;
      const byRepo = Object.fromEntries(data.results.map((r) => [r.repo, r]));

      expect(byRepo["d2r2-frontend"]?.pushed).toBe(false);
      expect(byRepo["d2r2-frontend"]?.queued).toBe(true);
      expect(byRepo["d2r2-frontend"]?.error).not.toBeNull();

      // Parent + backend still succeeded.
      expect(byRepo["parent"]?.pushed).toBe(true);
      expect(byRepo["d2r2-backend"]?.pushed).toBe(true);

      // Queue persisted exactly one entry for the failed repo/branch.
      const reg = await loadRegistry(checkoutReal);
      expect(reg.queue).toEqual([
        { repo: "d2r2-frontend", branch: "feature/foo" },
      ]);
    } finally {
      await rename(brokenOrigin, fixture.origins.frontend);
    }

    // Repair → retry → queue should clear via queueRemove.
    resetSkin(cap);
    await buildProgram().parseAsync(["node", "mono", "push", "foo"]);
    skin.flush();

    const env2 = parseLastEnvelope(cap.captured.stdout);
    expect(env2.ok).toBe(true);
    expect(env2.error).toBeNull();

    const reg2 = await loadRegistry(checkoutReal);
    expect(reg2.queue).toEqual([]);
  });

  test("BEAD_ID env var is surfaced in envelope and data", async () => {
    process.env.BEAD_ID = "app-6pm.14";
    try {
      await buildProgram().parseAsync(["node", "mono", "push", "foo"]);
      skin.flush();
    } finally {
      delete process.env.BEAD_ID;
    }

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);
    const data = env.data as PushDataShape;
    expect(data.bead_id).toBe("app-6pm.14");
  });

  test("unknown worktree → NOT_FOUND", async () => {
    await buildProgram().parseAsync(["node", "mono", "push", "ghost"]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("NOT_FOUND");
  });

  test("push all: pushes every registered worktree and aggregates results", async () => {
    // Create a second worktree `bar` with commits on each repo.
    await buildProgram().parseAsync(["node", "mono", "new", "bar"]);
    skin.flush();
    resetSkin(cap);

    const barPath = join(checkoutReal, ".mono", "worktrees", "bar");
    await writeFile(join(barPath, "d2r2-frontend", "bar-fe.txt"), "bar-fe\n", "utf8");
    await writeFile(join(barPath, "d2r2-backend", "bar-be.txt"), "bar-be\n", "utf8");
    await buildProgram().parseAsync([
      "node",
      "mono",
      "commit",
      "bar",
      "-a",
      "-m",
      "feat: seed bar",
    ]);
    skin.flush();
    resetSkin(cap);

    await buildProgram().parseAsync(["node", "mono", "push", "all"]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.error).toBeNull();
    expect(env.ok).toBe(true);

    const parsed = envelope(PushAllDataSchema).safeParse(env);
    if (!parsed.success) {
      throw new Error(`envelope schema mismatch: ${parsed.error.message}`);
    }

    const data = env.data as { bead_id: string | null; worktrees: PushDataShape[] };
    expect(data.bead_id).toBeNull();
    expect(data.worktrees).toHaveLength(2);

    const byName = Object.fromEntries(data.worktrees.map((w) => [w.name, w]));
    for (const name of ["foo", "bar"] as const) {
      const wtData = byName[name];
      expect(wtData).toBeDefined();
      expect(wtData?.results).toHaveLength(3);
      for (const r of wtData?.results ?? []) {
        expect(r.pushed).toBe(true);
        expect(r.queued).toBe(false);
        expect(r.branch).toBe(`feature/${name}`);
      }
    }

    // Both feature branches made it to the bare parent origin.
    const { stdout: lsRemote } = await execa("git", [
      "ls-remote",
      "--heads",
      fixture.origins.parent,
    ]);
    expect(lsRemote).toMatch(/feature\/foo/u);
    expect(lsRemote).toMatch(/feature\/bar/u);

    const reg = await loadRegistry(checkoutReal);
    expect(reg.queue).toEqual([]);
  });

  test("push all: with no registered worktrees emits empty envelope", async () => {
    // Empty the registry.
    await saveRegistry(checkoutReal, {
      worktrees: [],
      config: {},
      queue: [],
    });

    await buildProgram().parseAsync(["node", "mono", "push", "all"]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);
    expect(env.error).toBeNull();
    const data = env.data as { bead_id: string | null; worktrees: unknown[] };
    expect(data.worktrees).toEqual([]);
  });

  test("outside project → MISSING_REGISTRY", async () => {
    const outsideRoot = await realpath(
      await mkdtemp(join(tmpdir(), "mono-ts-outside-")),
    );
    try {
      process.chdir(outsideRoot);
      resetSkin(cap);
      await buildProgram().parseAsync(["node", "mono", "push", "foo"]);
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
