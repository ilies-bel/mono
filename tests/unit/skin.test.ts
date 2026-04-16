// Skin unit tests — text renderer writes to stderr, json renderer buffers
// and flushes a single envelope to stdout.
//
// We stub process.stdout.write and process.stderr.write to capture output,
// then restore them after each test.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { skin } from "../../src/skin/index.ts";

interface Captured {
  stdout: string[];
  stderr: string[];
}

function installCapture(): {
  captured: Captured;
  restore: () => void;
  setStderrTty: (v: boolean) => void;
  setStdoutTty: (v: boolean) => void;
} {
  const captured: Captured = { stdout: [], stderr: [] };
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  const originalStderrTty = process.stderr.isTTY;
  const originalStdoutTty = process.stdout.isTTY;

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
      Object.defineProperty(process.stderr, "isTTY", {
        value: originalStderrTty,
        configurable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: originalStdoutTty,
        configurable: true,
      });
    },
    setStderrTty: (v: boolean) => {
      Object.defineProperty(process.stderr, "isTTY", {
        value: v,
        configurable: true,
      });
    },
    setStdoutTty: (v: boolean) => {
      Object.defineProperty(process.stdout, "isTTY", {
        value: v,
        configurable: true,
      });
    },
  };
}

const ANSI_RE = /\u001b\[[0-9;]*m/;

describe("skin / text renderer", () => {
  let cap: ReturnType<typeof installCapture>;

  beforeEach(() => {
    cap = installCapture();
    cap.setStderrTty(true);
  });

  afterEach(() => {
    cap.restore();
  });

  test("info/warn/err write to stderr with ANSI when color=true", () => {
    skin.configure({ json: false, color: true, quiet: false, verbose: false });
    skin.setCommand("test");

    skin.info("hello");
    skin.warn("careful");
    skin.err("boom");

    expect(cap.captured.stdout).toEqual([]);
    expect(cap.captured.stderr.length).toBe(3);
    const [infoLine, warnLine, errLine] = cap.captured.stderr;
    expect(infoLine).toMatch(ANSI_RE);
    expect(infoLine).toContain("hello");
    expect(warnLine).toContain("! careful");
    expect(warnLine).toMatch(ANSI_RE);
    expect(errLine).toContain("x boom");
    expect(errLine).toMatch(ANSI_RE);
  });

  test("no ANSI codes when color=false", () => {
    skin.configure({ json: false, color: false, quiet: false, verbose: false });
    skin.info("plain");
    skin.warn("plain-warn");
    skin.err("plain-err");

    expect(cap.captured.stderr.length).toBe(3);
    for (const line of cap.captured.stderr) {
      expect(line).not.toMatch(ANSI_RE);
    }
    expect(cap.captured.stderr[0]).toBe("plain\n");
    expect(cap.captured.stderr[1]).toBe("! plain-warn\n");
    expect(cap.captured.stderr[2]).toBe("x plain-err\n");
  });

  test("quiet suppresses info but not warn/err", () => {
    skin.configure({ json: false, color: false, quiet: true, verbose: false });
    skin.info("hidden");
    skin.warn("shown");
    skin.err("shown-err");

    expect(cap.captured.stderr).toEqual(["! shown\n", "x shown-err\n"]);
  });

  test("debug only emits when verbose=true", () => {
    skin.configure({ json: false, color: false, quiet: false, verbose: false });
    skin.debug("dbg");
    expect(cap.captured.stderr).toEqual([]);

    skin.configure({ json: false, color: false, quiet: false, verbose: true });
    skin.debug("dbg2");
    expect(cap.captured.stderr).toEqual(["dbg2\n"]);
  });

  test("emit pretty-prints to stdout", () => {
    skin.configure({ json: false, color: false, quiet: false, verbose: false });
    skin.emit({ a: 1, b: "two" });

    expect(cap.captured.stdout).toHaveLength(1);
    expect(cap.captured.stdout[0]).toContain('"a": 1');
    expect(cap.captured.stdout[0]).toContain('"b": "two"');
  });

  test("fail writes red error line to stderr", () => {
    skin.configure({ json: false, color: true, quiet: false, verbose: false });
    skin.fail("DIRTY_WORKTREE", "you have uncommitted changes");

    expect(cap.captured.stderr).toHaveLength(1);
    const line = cap.captured.stderr[0] ?? "";
    expect(line).toContain("DIRTY_WORKTREE");
    expect(line).toContain("uncommitted changes");
    expect(line).toMatch(ANSI_RE);
  });
});

describe("skin / json renderer", () => {
  let cap: ReturnType<typeof installCapture>;

  beforeEach(() => {
    cap = installCapture();
  });

  afterEach(() => {
    cap.restore();
  });

  test("flush writes a single envelope with expected shape", () => {
    skin.configure({ json: true, color: false, quiet: false, verbose: false });
    skin.setCommand("ls");
    skin.emit([{ name: "foo" }]);
    skin.flush();

    expect(cap.captured.stderr).toEqual([]);
    expect(cap.captured.stdout).toHaveLength(1);

    const raw = cap.captured.stdout[0] ?? "";
    expect(raw.endsWith("\n")).toBe(true);
    // Single line of JSON
    expect(raw.trim().split("\n")).toHaveLength(1);

    const env = JSON.parse(raw);
    expect(env.ok).toBe(true);
    expect(env.command).toBe("ls");
    expect(env.data).toEqual([{ name: "foo" }]);
    expect(env.warnings).toEqual([]);
    expect(env.error).toBeNull();
    expect(env.meta).toBeDefined();
    expect(typeof env.meta.mono_version).toBe("string");
    expect(typeof env.meta.elapsed_ms).toBe("number");
  });

  test("info and debug are dropped in json mode", () => {
    skin.configure({ json: true, color: false, quiet: false, verbose: true });
    skin.setCommand("status");
    skin.info("noise");
    skin.debug("more noise");
    skin.flush();

    const env = JSON.parse(cap.captured.stdout[0] ?? "{}");
    expect(env.warnings).toEqual([]);
    expect(env.data).toBeNull();
  });

  test("warn accumulates into warnings[]", () => {
    skin.configure({ json: true, color: false, quiet: false, verbose: false });
    skin.setCommand("rebase");
    skin.warn("already up to date");
    skin.warn("submodule skipped");
    skin.flush();

    const env = JSON.parse(cap.captured.stdout[0] ?? "{}");
    expect(env.warnings).toEqual(["already up to date", "submodule skipped"]);
    expect(env.ok).toBe(true);
  });

  test("fail sets error and ok=false", () => {
    skin.configure({ json: true, color: false, quiet: false, verbose: false });
    skin.setCommand("commit");
    skin.fail("DIRTY_WORKTREE", "uncommitted changes", { repo: "parent" });
    skin.flush();

    const env = JSON.parse(cap.captured.stdout[0] ?? "{}");
    expect(env.ok).toBe(false);
    expect(env.error).toEqual({
      code: "DIRTY_WORKTREE",
      message: "uncommitted changes",
      details: { repo: "parent" },
    });
  });

  test("flush is idempotent — writes only once", () => {
    skin.configure({ json: true, color: false, quiet: false, verbose: false });
    skin.setCommand("ls");
    skin.emit([]);
    skin.flush();
    skin.flush();
    skin.flush();

    expect(cap.captured.stdout).toHaveLength(1);
  });

  test("emit sets data field", () => {
    skin.configure({ json: true, color: false, quiet: false, verbose: false });
    skin.setCommand("status");
    skin.emit({ clean: true, ahead: 0 });
    skin.flush();

    const env = JSON.parse(cap.captured.stdout[0] ?? "{}");
    expect(env.data).toEqual({ clean: true, ahead: 0 });
  });
});
