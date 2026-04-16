import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertParentRoot,
  mapRepos,
  reposFor,
  submodulesFor,
} from "../../src/core/repos.ts";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mono-repos-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("core/repos", () => {
  test("reposFor returns parent, frontend, backend in order", () => {
    const refs = reposFor("/tmp/wt");
    expect(refs).toHaveLength(3);
    expect(refs[0]).toEqual({ label: "parent", cwd: "/tmp/wt" });
    expect(refs[1]).toEqual({ label: "d2r2-frontend", cwd: "/tmp/wt/d2r2-frontend" });
    expect(refs[2]).toEqual({ label: "d2r2-backend", cwd: "/tmp/wt/d2r2-backend" });
  });

  test("submodulesFor drops parent", () => {
    const refs = submodulesFor("/tmp/wt");
    expect(refs.map((r) => r.label)).toEqual(["d2r2-frontend", "d2r2-backend"]);
  });

  test("mapRepos preserves input order in results", async () => {
    const refs = reposFor("/tmp/wt");
    const out = await mapRepos(refs, async (r) => r.label.toUpperCase());
    expect(out.map((o) => o.ref.label)).toEqual(["parent", "d2r2-frontend", "d2r2-backend"]);
    expect(out.map((o) => o.value)).toEqual(["PARENT", "D2R2-FRONTEND", "D2R2-BACKEND"]);
  });

  test("mapRepos runs fn in parallel (not serialised)", async () => {
    const refs = reposFor("/tmp/wt");
    const started: number[] = [];
    const delay = 60;
    const t0 = Date.now();
    await mapRepos(refs, async () => {
      started.push(Date.now() - t0);
      await new Promise((resolve) => setTimeout(resolve, delay));
    });
    const elapsed = Date.now() - t0;
    // Parallel => all three should start nearly simultaneously and total time
    // is ~delay, not 3*delay. Generous bound to keep CI non-flaky.
    expect(elapsed).toBeLessThan(delay * 2.5);
    expect(Math.max(...started) - Math.min(...started)).toBeLessThan(30);
  });

  test("assertParentRoot throws when .gitmodules is missing", async () => {
    const dir = join(root, "not-a-parent");
    mkdirSync(dir);
    let err: unknown = null;
    try {
      await assertParentRoot(dir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain(".gitmodules");
  });

  test("assertParentRoot passes when .gitmodules exists", async () => {
    const dir = join(root, "with-gitmodules");
    mkdirSync(dir);
    writeFileSync(join(dir, ".gitmodules"), "");
    await assertParentRoot(dir); // should not throw
  });
});
