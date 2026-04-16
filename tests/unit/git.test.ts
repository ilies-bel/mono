import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

import {
  add,
  commit,
  currentBranch,
  hasLocalBranch,
  hasRemoteBranch,
  head,
  isClean,
  getRemoteUrl,
  push,
  statusPorcelain,
  worktreeAdd,
} from "../../src/core/git.ts";

// Inline repo fixture: bare "remote" + working clone, deterministic init.
let root: string;
let bareRemote: string;
let repo: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mono-git-"));
  bareRemote = join(root, "remote.git");
  repo = join(root, "work");

  await execa("git", ["init", "--bare", "-b", "main", bareRemote]);
  await execa("git", ["init", "-b", "main", repo]);
  await execa("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await execa("git", ["-C", repo, "config", "user.name", "Test"]);
  await execa("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
  await execa("git", ["-C", repo, "remote", "add", "origin", bareRemote]);

  // Seed commit so HEAD resolves.
  writeFileSync(join(repo, "README.md"), "seed\n");
  await execa("git", ["-C", repo, "add", "README.md"]);
  await execa("git", ["-C", repo, "commit", "-m", "seed"]);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("core/git", () => {
  test("head returns a 40-char sha", async () => {
    const sha = await head(repo);
    expect(sha).toMatch(/^[0-9a-f]{40}$/u);
  });

  test("currentBranch returns the current branch name", async () => {
    const branch = await currentBranch(repo);
    expect(branch).toBe("main");
  });

  test("isClean is true on a freshly committed tree", async () => {
    expect(await isClean(repo)).toBe(true);
    expect(await statusPorcelain(repo)).toBe("");
  });

  test("isClean becomes false after an untracked file appears", async () => {
    const path = join(repo, "dirty.txt");
    writeFileSync(path, "dirty\n");
    expect(await isClean(repo)).toBe(false);
    rmSync(path);
    expect(await isClean(repo)).toBe(true);
  });

  test("add + commit + head roundtrip advances HEAD", async () => {
    const before = await head(repo);
    writeFileSync(join(repo, "a.txt"), "alpha\n");
    const addR = await add(repo, ["a.txt"]);
    expect(addR.ok).toBe(true);
    const commitR = await commit(repo, "add alpha");
    expect(commitR.ok).toBe(true);
    const after = await head(repo);
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[0-9a-f]{40}$/u);
  });

  test("hasLocalBranch returns true for main, false for unknown", async () => {
    expect(await hasLocalBranch(repo, "main")).toBe(true);
    expect(await hasLocalBranch(repo, "does-not-exist")).toBe(false);
  });

  test("hasRemoteBranch is false on empty bare, true after push", async () => {
    expect(await hasRemoteBranch(repo, "main", "origin")).toBe(false);
    const r = await push(repo, "origin", "main", true);
    expect(r.ok).toBe(true);
    expect(await hasRemoteBranch(repo, "main", "origin")).toBe(true);
  });

  test("getRemoteUrl returns the configured remote, null on unknown", async () => {
    const url = await getRemoteUrl(repo, "origin");
    expect(url).toBe(bareRemote);
    const missing = await getRemoteUrl(repo, "nope");
    expect(missing).toBeNull();
  });

  test("worktreeAdd creates a new worktree pointing at an existing branch", async () => {
    const wtPath = join(root, "wt-existing");
    // Create a branch to check out in a worktree
    await execa("git", ["-C", repo, "branch", "feature/x"]);
    const r = await worktreeAdd(repo, wtPath, "feature/x");
    expect(r.ok).toBe(true);
    expect(await currentBranch(wtPath)).toBe("feature/x");
  });
});
