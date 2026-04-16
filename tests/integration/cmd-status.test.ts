// cmd/status integration test — exercises real `git rev-parse` +
// `git status --porcelain` across the three repos produced by
// createFixture(). Clean fixture → all repos `clean:true`; dirtying the
// parent tree → parent `clean:false` with porcelain content.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";

import { statusCommand } from "../../src/cmd/status.ts";
import { skin } from "../../src/skin/index.ts";
import { saveRegistry } from "../../src/core/registry.ts";
import { envelope, StatusDataSchema } from "../../src/core/schemas.ts";
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
  const sub = statusCommand();
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

interface StatusRepoOut {
  repo: "parent" | "d2r2-frontend" | "d2r2-backend";
  branch: string | null;
  clean: boolean;
  porcelain: string;
  missing: boolean;
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("cmd/status (integration)", () => {
  let cap: ReturnType<typeof installCapture>;
  let fixture: Fixture;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    cap = installCapture();
    fixture = await createFixture();
    process.chdir(fixture.checkout);
    skin.configure({ json: true, color: false, quiet: false, verbose: false });

    // .mono is a runtime-managed file; keep it out of the parent's working
    // tree so its presence doesn't appear as dirty output in every test.
    // `mono init` handles this in production; the fixture is a raw git repo.
    await writeFile(join(fixture.checkout, ".gitignore"), ".mono\n", "utf8");
    await execa("git", ["add", ".gitignore"], { cwd: fixture.checkout });
    await execa("git", ["commit", "-m", "chore: ignore .mono"], {
      cwd: fixture.checkout,
    });

    await saveRegistry(fixture.checkout, {
      worktrees: [{ name: "foo", path: fixture.checkout }],
      config: {},
      queue: [],
    });
  });

  afterEach(async () => {
    cap.restore();
    process.chdir(originalCwd);
    await fixture.cleanup();
  });

  test("clean fixture → all three repos clean on main", async () => {
    await buildProgram().parseAsync(["node", "mono", "status", "foo"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);
    expect(env.error).toBeNull();

    const parsed = envelope(StatusDataSchema).safeParse(env);
    if (!parsed.success) {
      throw new Error(`envelope schema mismatch: ${parsed.error.message}`);
    }

    const data = env.data as { name: string; repos: StatusRepoOut[] };
    expect(data.name).toBe("foo");
    expect(data.repos).toHaveLength(3);
    const labels = data.repos.map((r) => r.repo).sort();
    expect(labels).toEqual(["d2r2-backend", "d2r2-frontend", "parent"]);
    for (const r of data.repos) {
      expect(r.clean).toBe(true);
      expect(r.branch).toBe("main");
      expect(r.porcelain).toBe("");
      expect(r.missing).toBe(false);
    }
  });

  test("dirty parent → parent clean:false, porcelain non-empty, submodules still clean", async () => {
    await writeFile(join(fixture.checkout, "dirty.txt"), "hi\n", "utf8");

    await buildProgram().parseAsync(["node", "mono", "status", "foo"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);

    const data = env.data as { name: string; repos: StatusRepoOut[] };
    const parent = data.repos.find((r) => r.repo === "parent");
    expect(parent).toBeDefined();
    expect(parent!.clean).toBe(false);
    expect(parent!.porcelain.length).toBeGreaterThan(0);
    expect(parent!.porcelain).toContain("dirty.txt");

    for (const r of data.repos.filter((x) => x.repo !== "parent")) {
      expect(r.clean).toBe(true);
      expect(r.porcelain).toBe("");
    }
  });

  test("unknown worktree name → NOT_FOUND", async () => {
    await buildProgram().parseAsync(["node", "mono", "status", "does-not-exist"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("NOT_FOUND");
  });

  test("missing name arg → commander usage error", async () => {
    const program = buildProgram();
    let threw = false;
    try {
      await program.parseAsync(["node", "mono", "status"]);
    } catch {
      threw = true;
    }
    // commander's exitOverride throws instead of process.exit(1) when a
    // required argument is missing — either path (throw or fail envelope)
    // is acceptable per the bead contract.
    expect(threw).toBe(true);
  });
});
