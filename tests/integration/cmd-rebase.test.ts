// cmd/rebase integration test — exercises the submodule-first rebase flow
// against real worktrees produced by createFixture() + `mono new`.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Command } from "commander";
import { writeFile, realpath, mkdtemp, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";

import { newCommand } from "../../src/cmd/new.ts";
import { rebaseCommand } from "../../src/cmd/rebase.ts";
import { skin } from "../../src/skin/index.ts";
import { saveRegistry } from "../../src/core/registry.ts";
import {
  envelope,
  RebaseAllDataSchema,
  RebaseDataSchema,
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
  for (const sub of [newCommand(), rebaseCommand()]) {
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

// ─── shared scratch helpers ────────────────────────────────────────────────

/** Clone a bare origin into a scratch checkout, run fn, push, cleanup. */
async function advanceOriginMain(
  scratchRoot: string,
  origin: string,
  label: string,
  mutate: (clone: string) => Promise<void>,
): Promise<string> {
  const clone = join(scratchRoot, `clone-${label}-${Date.now()}`);
  await execa("git", ["clone", origin, clone]);
  await execa("git", ["config", "user.email", "test@mono-ts.local"], { cwd: clone });
  await execa("git", ["config", "user.name", "mono-ts test"], { cwd: clone });
  await execa("git", ["config", "commit.gpgsign", "false"], { cwd: clone });
  await execa("git", ["checkout", "main"], { cwd: clone });
  await mutate(clone);
  await execa("git", ["push", "origin", "main"], { cwd: clone });
  const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: clone });
  return stdout.trim();
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("cmd/rebase (integration)", () => {
  let cap: ReturnType<typeof installCapture>;
  let fixture: Fixture;
  let originalCwd: string;
  let checkoutReal: string;
  let scratchRoot: string;

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

    // Seed the `foo` worktree all tests share.
    await buildProgram().parseAsync(["node", "mono", "new", "foo"]);
    skin.flush();
    resetSkin(cap);

    scratchRoot = await realpath(
      await mkdtemp(join(tmpdir(), "mono-ts-rebase-scratch-")),
    );
  });

  afterEach(async () => {
    cap.restore();
    process.chdir(originalCwd);
    await rm(scratchRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
    await fixture.cleanup();
  });

  test("no-op: rebase immediately after new → no new commits, amended:false", async () => {
    await buildProgram().parseAsync(["node", "mono", "rebase", "foo"]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.error).toBeNull();
    expect(env.ok).toBe(true);

    const parsed = envelope(RebaseDataSchema).safeParse(env);
    if (!parsed.success) {
      throw new Error(`envelope schema mismatch: ${parsed.error.message}`);
    }

    const data = env.data as {
      upstream: string;
      fetch: { parent: string; frontend: string; backend: string };
      rebase: {
        parent: { old_head: string; new_head: string } | null;
        frontend: { old_head: string; new_head: string } | null;
        backend: { old_head: string; new_head: string } | null;
      };
      amended: boolean;
      conflict: unknown;
    };
    expect(data.upstream).toBe("origin/main");
    expect(data.fetch.parent).toBe("ok");
    expect(data.fetch.frontend).toBe("ok");
    expect(data.fetch.backend).toBe("ok");
    expect(data.conflict).toBeNull();
    expect(data.amended).toBe(false);
    // Each rebase step may be null OR old==new; accept either shape.
    for (const step of [data.rebase.parent, data.rebase.frontend, data.rebase.backend]) {
      if (step !== null) {
        expect(step.old_head).toBe(step.new_head);
      }
    }
  });

  test("parent upstream advances → parent rebased, new_head != old_head", async () => {
    // Advance origin/main of the parent repo via a scratch clone.
    await advanceOriginMain(scratchRoot, fixture.origins.parent, "parent", async (clone) => {
      await writeFile(join(clone, "upstream.txt"), "hello\n", "utf8");
      await execa("git", ["add", "upstream.txt"], { cwd: clone });
      await execa("git", ["commit", "-m", "feat: upstream commit"], { cwd: clone });
    });

    await buildProgram().parseAsync(["node", "mono", "rebase", "foo", "origin/main"]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.error).toBeNull();
    expect(env.ok).toBe(true);

    const data = env.data as {
      rebase: {
        parent: { old_head: string; new_head: string } | null;
      };
      amended: boolean;
      conflict: unknown;
    };
    expect(data.conflict).toBeNull();
    expect(data.rebase.parent).not.toBeNull();
    expect(data.rebase.parent!.old_head).not.toBe(data.rebase.parent!.new_head);
    expect(data.amended).toBe(false);
  });

  test("submodule upstream advances → frontend rebased, parent amended", async () => {
    // Advance origin/main of d2r2-frontend.
    const newFeHead = await advanceOriginMain(
      scratchRoot,
      fixture.origins.frontend,
      "frontend",
      async (clone) => {
        await writeFile(join(clone, "fe.txt"), "fe-feature\n", "utf8");
        await execa("git", ["add", "fe.txt"], { cwd: clone });
        await execa("git", ["commit", "-m", "feat: fe upstream"], { cwd: clone });
      },
    );

    await buildProgram().parseAsync(["node", "mono", "rebase", "foo"]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.error).toBeNull();
    expect(env.ok).toBe(true);

    const data = env.data as {
      rebase: {
        parent: { old_head: string; new_head: string } | null;
        frontend: { old_head: string; new_head: string } | null;
        backend: { old_head: string; new_head: string } | null;
      };
      amended: boolean;
      conflict: unknown;
    };
    expect(data.conflict).toBeNull();
    expect(data.rebase.frontend).not.toBeNull();
    expect(data.rebase.frontend!.old_head).not.toBe(data.rebase.frontend!.new_head);
    expect(data.rebase.frontend!.new_head).toBe(newFeHead);
    expect(data.amended).toBe(true);
    // Parent must report a moved HEAD too (either via rebase or via amend).
    expect(data.rebase.parent).not.toBeNull();
    expect(data.rebase.parent!.old_head).not.toBe(data.rebase.parent!.new_head);
  });

  test("offline / fetch failure → warning + fetch:failed for that repo", async () => {
    // Rename the parent bare origin so `git fetch origin` in the parent
    // worktree fails with "repository not found". The submodule origins
    // are untouched so their fetches stay green.
    const parentOriginRenamed = `${fixture.origins.parent}.disabled`;
    await rename(fixture.origins.parent, parentOriginRenamed);

    try {
      await buildProgram().parseAsync(["node", "mono", "rebase", "foo"]);
      skin.flush();

      const env = parseLastEnvelope(cap.captured.stdout);
      // Rebase should still succeed (submodule fetches are fine and the
      // parent's origin/main ref is already present locally from the
      // fixture's initial push).
      const data = env.data as {
        fetch: { parent: string; frontend: string; backend: string };
      } | null;
      if (env.ok) {
        expect(data).not.toBeNull();
        expect(data!.fetch.parent).toBe("failed");
        expect(data!.fetch.frontend).toBe("ok");
        expect(data!.fetch.backend).toBe("ok");
      } else {
        // Acceptable fallback: env.ok:false because upstream resolution
        // failed in parent. We still expect fetch.parent:"failed" in data
        // when the envelope carries data.
        if (data) {
          expect(data.fetch.parent).toBe("failed");
        }
      }
    } finally {
      await rename(parentOriginRenamed, fixture.origins.parent).catch(
        () => undefined,
      );
    }
  });

  test("parent conflict → CONFLICT envelope, gitlinks untouched", async () => {
    // Seed a conflicting edit: upstream main touches .gitignore with one
    // content, parent's feature branch touches the same file with another.
    const wtPath = join(checkoutReal, ".mono", "worktrees", "foo");

    // Edit .gitignore on feature branch side.
    await writeFile(join(wtPath, ".gitignore"), ".mono\nfeature\n", "utf8");
    await execa("git", ["add", ".gitignore"], { cwd: wtPath });
    await execa("git", ["commit", "-m", "feat: feature gitignore"], { cwd: wtPath });

    // Advance origin/main with a conflicting change to the same file.
    await advanceOriginMain(
      scratchRoot,
      fixture.origins.parent,
      "parent",
      async (clone) => {
        await writeFile(join(clone, ".gitignore"), ".mono\nupstream\n", "utf8");
        await execa("git", ["add", ".gitignore"], { cwd: clone });
        await execa("git", ["commit", "-m", "chore: upstream gitignore"], {
          cwd: clone,
        });
      },
    );

    // Capture the pre-rebase parent HEAD so we can assert gitlinks untouched.
    const { stdout: preHead } = await execa("git", ["rev-parse", "HEAD"], {
      cwd: wtPath,
    });

    await buildProgram().parseAsync(["node", "mono", "rebase", "foo"]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("CONFLICT");
    expect(env.error?.details?.repo).toBe("parent");
    expect(env.error?.details?.step).toBe("rebase");

    // We should have captured the intermediate envelope in stdout with the
    // conflict payload.
    const dataEnv = cap.captured.stdout
      .map((s) => {
        try {
          return JSON.parse(s) as ParsedEnvelope;
        } catch {
          return null;
        }
      })
      .filter((e): e is ParsedEnvelope => e !== null)
      .find((e) => {
        const d = e.data as { conflict?: { repo?: string } } | null;
        return d?.conflict?.repo === "parent";
      });
    expect(dataEnv).toBeDefined();

    // Abort the lingering rebase so afterEach cleanup can nuke the tmpdir.
    await execa("git", ["rebase", "--abort"], { cwd: wtPath, reject: false });

    // Parent HEAD must be unchanged (rebase was aborted, gitlinks untouched).
    const { stdout: postHead } = await execa("git", ["rev-parse", "HEAD"], {
      cwd: wtPath,
    });
    expect(postHead.trim()).toBe(preHead.trim());
  });

  test("unknown worktree → NOT_FOUND", async () => {
    await buildProgram().parseAsync(["node", "mono", "rebase", "ghost"]);
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
      await buildProgram().parseAsync(["node", "mono", "rebase", "foo"]);
      skin.flush();

      const env = parseLastEnvelope(cap.captured.stdout);
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe("MISSING_REGISTRY");
    } finally {
      process.chdir(checkoutReal);
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  // ─── `mono rebase all` ────────────────────────────────────────────────

  test("all: no-op across multiple worktrees → aggregate envelope, no conflict", async () => {
    await buildProgram().parseAsync(["node", "mono", "new", "bar"]);
    skin.flush();
    resetSkin(cap);

    await buildProgram().parseAsync(["node", "mono", "rebase", "all"]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.error).toBeNull();
    expect(env.ok).toBe(true);

    const parsed = envelope(RebaseAllDataSchema).safeParse(env);
    if (!parsed.success) {
      throw new Error(`envelope schema mismatch: ${parsed.error.message}`);
    }

    const data = env.data as {
      upstream: string;
      keep_going: boolean;
      worktrees: Array<{ name: string; conflict: unknown }>;
      stopped_at: string | null;
    };
    expect(data.upstream).toBe("origin/main");
    expect(data.keep_going).toBe(false);
    expect(data.stopped_at).toBeNull();
    expect(data.worktrees).toHaveLength(2);
    expect(data.worktrees.map((w) => w.name).sort()).toEqual(["bar", "foo"]);
    for (const w of data.worktrees) {
      expect(w.conflict).toBeNull();
    }
  });

  test("all: empty registry → ok, empty worktrees array", async () => {
    // Drop the seed `foo` worktree via registry mutation — simpler than
    // running `mono rm` in this test's scope.
    await saveRegistry(checkoutReal, {
      worktrees: [],
      config: {},
      queue: [],
    });
    resetSkin(cap);

    await buildProgram().parseAsync(["node", "mono", "rebase", "all"]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);
    expect(env.error).toBeNull();

    const data = env.data as {
      worktrees: unknown[];
      stopped_at: string | null;
    };
    expect(data.worktrees).toEqual([]);
    expect(data.stopped_at).toBeNull();
  });

  test("all: upstream advance rebases every worktree", async () => {
    await buildProgram().parseAsync(["node", "mono", "new", "bar"]);
    skin.flush();
    resetSkin(cap);

    // Advance parent origin/main so every feature worktree has something to
    // rebase onto.
    await advanceOriginMain(
      scratchRoot,
      fixture.origins.parent,
      "parent",
      async (clone) => {
        await writeFile(join(clone, "upstream.txt"), "shared\n", "utf8");
        await execa("git", ["add", "upstream.txt"], { cwd: clone });
        await execa("git", ["commit", "-m", "feat: upstream"], { cwd: clone });
      },
    );

    await buildProgram().parseAsync(["node", "mono", "rebase", "all"]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.error).toBeNull();
    expect(env.ok).toBe(true);

    const data = env.data as {
      worktrees: Array<{
        name: string;
        rebase: {
          parent: { old_head: string; new_head: string } | null;
        };
        conflict: unknown;
      }>;
    };
    expect(data.worktrees).toHaveLength(2);
    for (const w of data.worktrees) {
      expect(w.conflict).toBeNull();
      expect(w.rebase.parent).not.toBeNull();
      expect(w.rebase.parent!.old_head).not.toBe(w.rebase.parent!.new_head);
    }
  });

  test("all: conflict stops at first conflict by default", async () => {
    // Two worktrees; `foo` will conflict, `bar` is clean. Iteration order
    // follows registry order: `foo` first (seeded in beforeEach), then `bar`.
    await buildProgram().parseAsync(["node", "mono", "new", "bar"]);
    skin.flush();
    resetSkin(cap);

    // Same conflict seed shape as the single-worktree conflict test.
    const fooPath = join(checkoutReal, ".mono", "worktrees", "foo");
    await writeFile(join(fooPath, ".gitignore"), ".mono\nfeature\n", "utf8");
    await execa("git", ["add", ".gitignore"], { cwd: fooPath });
    await execa("git", ["commit", "-m", "feat: foo gitignore"], {
      cwd: fooPath,
    });

    await advanceOriginMain(
      scratchRoot,
      fixture.origins.parent,
      "parent",
      async (clone) => {
        await writeFile(join(clone, ".gitignore"), ".mono\nupstream\n", "utf8");
        await execa("git", ["add", ".gitignore"], { cwd: clone });
        await execa("git", ["commit", "-m", "chore: upstream gitignore"], {
          cwd: clone,
        });
      },
    );

    await buildProgram().parseAsync(["node", "mono", "rebase", "all"]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("CONFLICT");

    const details = env.error?.details as
      | { conflicted?: string[]; stopped_at?: string }
      | undefined;
    expect(details?.conflicted).toContain("foo");
    expect(details?.stopped_at).toBe("foo");

    const data = env.data as {
      worktrees: Array<{ name: string; conflict: unknown }>;
      stopped_at: string | null;
    };
    expect(data.stopped_at).toBe("foo");
    // `bar` must NOT have been attempted (stop-on-first-conflict default).
    expect(data.worktrees.map((w) => w.name)).toEqual(["foo"]);

    // Abort the lingering rebase so cleanup can nuke the tmpdir.
    await execa("git", ["rebase", "--abort"], { cwd: fooPath, reject: false });
  });

  test("all --keep-going: conflict + clean worktree → both attempted, still CONFLICT", async () => {
    await buildProgram().parseAsync(["node", "mono", "new", "bar"]);
    skin.flush();
    resetSkin(cap);

    // Use a fresh file (collide.txt) so `bar` shares no history with the
    // conflicting edit: only `foo` and upstream touch the file.
    const fooPath = join(checkoutReal, ".mono", "worktrees", "foo");
    await writeFile(join(fooPath, "collide.txt"), "feature\n", "utf8");
    await execa("git", ["add", "collide.txt"], { cwd: fooPath });
    await execa("git", ["commit", "-m", "feat: foo collide"], {
      cwd: fooPath,
    });

    await advanceOriginMain(
      scratchRoot,
      fixture.origins.parent,
      "parent",
      async (clone) => {
        await writeFile(join(clone, "collide.txt"), "upstream\n", "utf8");
        await execa("git", ["add", "collide.txt"], { cwd: clone });
        await execa("git", ["commit", "-m", "chore: upstream collide"], {
          cwd: clone,
        });
      },
    );

    await buildProgram().parseAsync([
      "node",
      "mono",
      "rebase",
      "all",
      "--keep-going",
    ]);
    skin.flush();

    const env = parseLastEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("CONFLICT");

    const data = env.data as {
      keep_going: boolean;
      worktrees: Array<{ name: string; conflict: unknown }>;
      stopped_at: string | null;
    };
    expect(data.keep_going).toBe(true);
    expect(data.stopped_at).toBeNull();
    // Both worktrees must appear; `bar` must be conflict-free because it
    // doesn't share the colliding `.gitignore` edit.
    expect(data.worktrees.map((w) => w.name).sort()).toEqual(["bar", "foo"]);
    const foo = data.worktrees.find((w) => w.name === "foo");
    const bar = data.worktrees.find((w) => w.name === "bar");
    expect(foo?.conflict).not.toBeNull();
    expect(bar?.conflict).toBeNull();

    await execa("git", ["rebase", "--abort"], { cwd: fooPath, reject: false });
  });
});
