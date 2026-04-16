import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  loadRegistry,
  saveRegistry,
  findProjectRoot,
  isInitialized,
  registerWorktree,
  unregisterWorktree,
  findWorktree,
  getConfig,
  setConfig,
  unsetConfig,
  queueAdd,
  queueRemove,
  defaultWorktreeBase,
  type Registry,
} from "../../src/core/registry.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "mono-registry-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedMonoDir(): void {
  mkdirSync(path.join(root, ".mono"), { recursive: true });
}

describe("load / save round-trip", () => {
  test("loadRegistry returns empty registry when .mono is empty", async () => {
    seedMonoDir();
    const reg = await loadRegistry(root);
    expect(reg.worktrees).toEqual([]);
    expect(reg.config).toEqual({});
    expect(reg.queue).toEqual([]);
  });

  test("loadRegistry returns empty registry when .mono does not exist", async () => {
    const reg = await loadRegistry(root);
    expect(reg.worktrees).toEqual([]);
    expect(reg.config).toEqual({});
    expect(reg.queue).toEqual([]);
  });

  test("parses YAML config and JSON state", async () => {
    seedMonoDir();
    writeFileSync(
      path.join(root, ".mono", "config.yml"),
      "# mono config\nworktree-base: /home/me/work\nsome-key: a b c\n",
      "utf8",
    );
    writeFileSync(
      path.join(root, ".mono", "state.json"),
      JSON.stringify({
        worktrees: [
          { name: "foo", path: "/abs/foo" },
          { name: "bar", path: "/abs/with spaces/bar" },
        ],
        queue: [
          { repo: "parent", branch: "feature/x" },
          { repo: "d2r2-frontend", branch: "feature/y" },
          { repo: "d2r2-backend", branch: "feature/z" },
        ],
      }),
      "utf8",
    );

    const reg = await loadRegistry(root);
    expect(reg.worktrees).toEqual([
      { name: "foo", path: "/abs/foo" },
      { name: "bar", path: "/abs/with spaces/bar" },
    ]);
    expect(reg.config).toEqual({
      "worktree-base": "/home/me/work",
      "some-key": "a b c",
    });
    expect(reg.queue).toEqual([
      { repo: "parent", branch: "feature/x" },
      { repo: "d2r2-frontend", branch: "feature/y" },
      { repo: "d2r2-backend", branch: "feature/z" },
    ]);
  });

  test("round-trips: save then load produces equivalent data", async () => {
    const original: Registry = {
      worktrees: [{ name: "alpha", path: "/tmp/alpha" }],
      config: { key1: "v1", key2: "multi word value" },
      queue: [
        { repo: "parent", branch: "feature/a" },
        { repo: "d2r2-backend", branch: "feature/b" },
      ],
    };
    await saveRegistry(root, original);
    const reloaded = await loadRegistry(root);
    expect(reloaded.worktrees).toEqual(original.worktrees);
    expect(reloaded.config).toEqual(original.config);
    expect(reloaded.queue).toEqual(original.queue);
  });

  test("invalid queue entries in state.json are dropped", async () => {
    seedMonoDir();
    writeFileSync(
      path.join(root, ".mono", "state.json"),
      JSON.stringify({
        worktrees: [{ name: "ok", path: "/path" }],
        queue: [
          { repo: "bogus", branch: "feature/nope" },
          { repo: "parent", branch: "" },
          { repo: "parent", branch: "feature/good" },
        ],
      }),
      "utf8",
    );
    const reg = await loadRegistry(root);
    expect(reg.worktrees).toEqual([{ name: "ok", path: "/path" }]);
    expect(reg.queue).toEqual([{ repo: "parent", branch: "feature/good" }]);
  });

  test("config.yml with non-scalar value throws", async () => {
    seedMonoDir();
    writeFileSync(
      path.join(root, ".mono", "config.yml"),
      "nested:\n  bad: true\n",
      "utf8",
    );
    await expect(loadRegistry(root)).rejects.toThrow(/scalar/);
  });
});

describe("isInitialized", () => {
  test("false when .mono missing", async () => {
    expect(await isInitialized(root)).toBe(false);
  });
  test("false when .mono is a file (legacy layout is no longer recognised)", async () => {
    writeFileSync(path.join(root, ".mono"), "", "utf8");
    expect(await isInitialized(root)).toBe(false);
  });
  test("true when .mono is a directory", async () => {
    seedMonoDir();
    expect(await isInitialized(root)).toBe(true);
  });
});

describe("defaultWorktreeBase", () => {
  test("is <root>/.mono/worktrees", () => {
    expect(defaultWorktreeBase("/r")).toBe(path.join("/r", ".mono", "worktrees"));
  });
});

describe("immutable helpers", () => {
  const seed = (): Registry => ({
    worktrees: [{ name: "a", path: "/a" }],
    config: { foo: "bar" },
    queue: [{ repo: "parent", branch: "feature/x" }],
  });

  test("registerWorktree does not mutate input", () => {
    const r0 = seed();
    const snapshot = JSON.stringify(r0);
    const r1 = registerWorktree(r0, { name: "b", path: "/b" });
    expect(JSON.stringify(r0)).toBe(snapshot);
    expect(r1.worktrees).toHaveLength(2);
    expect(r1.worktrees).not.toBe(r0.worktrees);
  });

  test("registerWorktree replaces duplicate name", () => {
    const r0 = seed();
    const r1 = registerWorktree(r0, { name: "a", path: "/new" });
    expect(r1.worktrees).toEqual([{ name: "a", path: "/new" }]);
  });

  test("unregisterWorktree is no-op for missing name", () => {
    const r0 = seed();
    const r1 = unregisterWorktree(r0, "nope");
    expect(r1.worktrees).toEqual(r0.worktrees);
    expect(r1).not.toBe(r0);
  });

  test("findWorktree returns copy or undefined", () => {
    const r0 = seed();
    expect(findWorktree(r0, "a")).toEqual({ name: "a", path: "/a" });
    expect(findWorktree(r0, "missing")).toBeUndefined();
  });

  test("setConfig overwrites existing key", () => {
    const r0 = seed();
    const r1 = setConfig(r0, "foo", "baz");
    expect(getConfig(r1, "foo")).toBe("baz");
    expect(getConfig(r0, "foo")).toBe("bar");
  });

  test("setConfig adds new key without disturbing others", () => {
    const r0 = seed();
    const r1 = setConfig(r0, "new", "val");
    expect(r1.config).toEqual({ foo: "bar", new: "val" });
  });

  test("unsetConfig on missing key is a no-op", () => {
    const r0 = seed();
    const r1 = unsetConfig(r0, "absent");
    expect(r1.config).toEqual(r0.config);
  });

  test("unsetConfig removes key", () => {
    const r0 = seed();
    const r1 = unsetConfig(r0, "foo");
    expect(getConfig(r1, "foo")).toBeUndefined();
  });

  test("queueAdd dedupes by repo+branch", () => {
    const r0 = seed();
    const r1 = queueAdd(r0, { repo: "parent", branch: "feature/x" });
    expect(r1.queue).toHaveLength(1);
    const r2 = queueAdd(r1, { repo: "d2r2-frontend", branch: "feature/x" });
    expect(r2.queue).toHaveLength(2);
  });

  test("queueRemove drops only the matching entry", () => {
    const r0 = seed();
    const r1 = queueAdd(r0, { repo: "d2r2-backend", branch: "feature/y" });
    const r2 = queueRemove(r1, { repo: "parent", branch: "feature/x" });
    expect(r2.queue).toEqual([{ repo: "d2r2-backend", branch: "feature/y" }]);
  });
});

describe("saveRegistry atomicity and guards", () => {
  test("rejects non-absolute root", async () => {
    await expect(loadRegistry("relative/path")).rejects.toThrow(/absolute/);
    await expect(
      saveRegistry("", { worktrees: [], config: {}, queue: [] }),
    ).rejects.toThrow();
  });

  test("throws when root directory does not exist", async () => {
    const bogus = path.join(root, "does-not-exist");
    await expect(
      saveRegistry(bogus, { worktrees: [], config: {}, queue: [] }),
    ).rejects.toThrow();
  });

  test("leaves no tmp files behind after a successful save", async () => {
    await saveRegistry(root, {
      worktrees: [{ name: "x", path: "/x" }],
      config: {},
      queue: [],
    });
    const entries = readdirSync(path.join(root, ".mono"));
    const tmps = entries.filter((e) => e.includes(".tmp."));
    expect(tmps).toEqual([]);
    expect(existsSync(path.join(root, ".mono", "config.yml"))).toBe(true);
    expect(existsSync(path.join(root, ".mono", "state.json"))).toBe(true);
  });

  test("save rewrites state.json fully (no leftover old entries)", async () => {
    seedMonoDir();
    writeFileSync(
      path.join(root, ".mono", "state.json"),
      JSON.stringify({
        worktrees: [{ name: "old", path: "/old" }],
        queue: [],
      }),
      "utf8",
    );
    await saveRegistry(root, {
      worktrees: [{ name: "new", path: "/new" }],
      config: {},
      queue: [],
    });
    const after = readFileSync(path.join(root, ".mono", "state.json"), "utf8");
    expect(after).toContain("/new");
    expect(after).not.toContain("/old");
  });
});

describe("findProjectRoot", () => {
  test("finds .mono/ in the start directory", async () => {
    seedMonoDir();
    expect(await findProjectRoot(root)).toBe(path.resolve(root));
  });

  test("walks up from a nested directory", async () => {
    seedMonoDir();
    const nested = path.join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(await findProjectRoot(nested)).toBe(path.resolve(root));
  });

  test("returns null when only a legacy .mono file is present", async () => {
    writeFileSync(path.join(root, ".mono"), "", "utf8");
    expect(await findProjectRoot(root)).toBeNull();
  });

  test("returns null when no marker exists up to /", async () => {
    const nested = path.join(root, "deep", "dir");
    mkdirSync(nested, { recursive: true });
    const result = await findProjectRoot(nested);
    expect(result).toBeNull();
  });

  test("returns null for non-absolute input", async () => {
    expect(await findProjectRoot("relative")).toBeNull();
    expect(await findProjectRoot("")).toBeNull();
  });
});
