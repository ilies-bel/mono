// Smoke test for tests/helpers/fixture-repo.ts — proves the scaffold
// produces the layout documented in that file and that `cleanup()`
// fully removes the tmpdir.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";

import { execa } from "execa";

import { createFixture, type Fixture } from "./fixture-repo.ts";

let fixture: Fixture;

beforeAll(async () => {
  fixture = await createFixture();
});

afterAll(async () => {
  await fixture.cleanup();
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function gitHead(cwd: string): Promise<string> {
  const r = await execa("git", ["rev-parse", "HEAD"], { cwd });
  return String(r.stdout).trim();
}

async function gitCurrentBranch(cwd: string): Promise<string> {
  const r = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  return String(r.stdout).trim();
}

async function isBareRepo(cwd: string): Promise<boolean> {
  const r = await execa("git", ["rev-parse", "--is-bare-repository"], { cwd });
  return String(r.stdout).trim() === "true";
}

describe("helpers/fixture-repo", () => {
  test("root and checkout exist", async () => {
    expect(await exists(fixture.root)).toBe(true);
    expect(await exists(fixture.checkout)).toBe(true);
    expect((await stat(fixture.checkout)).isDirectory()).toBe(true);
  });

  test(".gitmodules is committed at the checkout root", async () => {
    expect(await exists(join(fixture.checkout, ".gitmodules"))).toBe(true);
    // Must be tracked (not just present on disk).
    const r = await execa(
      "git",
      ["ls-files", "--error-unmatch", ".gitmodules"],
      { cwd: fixture.checkout, reject: false },
    );
    expect(r.exitCode).toBe(0);
  });

  test("parent is on branch main with a HEAD", async () => {
    expect(await gitCurrentBranch(fixture.checkout)).toBe("main");
    expect(await gitHead(fixture.checkout)).toMatch(/^[0-9a-f]{40}$/u);
  });

  test("both submodule checkouts have main + a HEAD", async () => {
    for (const sub of ["d2r2-frontend", "d2r2-backend"] as const) {
      const subPath = join(fixture.checkout, sub);
      expect(await exists(subPath)).toBe(true);
      expect(await gitCurrentBranch(subPath)).toBe("main");
      expect(await gitHead(subPath)).toMatch(/^[0-9a-f]{40}$/u);
    }
  });

  test("all three origins are bare and reachable", async () => {
    for (const origin of [
      fixture.origins.parent,
      fixture.origins.frontend,
      fixture.origins.backend,
    ]) {
      expect(await exists(origin)).toBe(true);
      expect(await isBareRepo(origin)).toBe(true);
      // `ls-remote` against the bare repo should list a `main` head.
      const r = await execa("git", ["ls-remote", "--heads", origin, "main"]);
      expect(String(r.stdout)).toMatch(/\brefs\/heads\/main\b/u);
    }
  });

  test("parent's origin remote points at origins.parent", async () => {
    const r = await execa("git", ["remote", "get-url", "origin"], {
      cwd: fixture.checkout,
    });
    expect(String(r.stdout).trim()).toBe(fixture.origins.parent);
  });

  test("cleanup removes the tmpdir", async () => {
    const throwaway = await createFixture();
    expect(await exists(throwaway.root)).toBe(true);
    await throwaway.cleanup();
    expect(await exists(throwaway.root)).toBe(false);
    // Second call is a no-op (idempotent).
    await throwaway.cleanup();
  });
});
