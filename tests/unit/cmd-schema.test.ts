// cmd/schema unit tests — verify the LLM-discoverable schema contract.
//
// Captures the JSON envelope on stdout, validates it against the generic
// envelope(z.unknown()) shape, then asserts the `data` payload matches
// what each verb of `mono schema` should produce.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Command } from "commander";
import { z } from "zod";

import { schemaCommand, SCHEMAS, SCHEMA_NAMES } from "../../src/cmd/schema.ts";
import { skin } from "../../src/skin/index.ts";
import { envelope } from "../../src/core/schemas.ts";

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
  program.name("mono").exitOverride();
  program.addCommand(schemaCommand());
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

describe("cmd/schema", () => {
  let cap: ReturnType<typeof installCapture>;

  beforeEach(() => {
    cap = installCapture();
    skin.configure({ json: true, color: false, quiet: false, verbose: false });
  });

  afterEach(() => {
    cap.restore();
  });

  test("SCHEMAS covers the documented verbs", () => {
    expect(SCHEMA_NAMES).toEqual(
      [
        "init",
        "config",
        "ls",
        "status",
        "new",
        "commit",
        "rm",
        "rebase",
        "push",
      ].sort(),
    );
    for (const name of SCHEMA_NAMES) {
      expect(SCHEMAS[name]).toBeDefined();
    }
  });

  test("mono schema ls --json → JSON Schema envelope with data as an array shape", async () => {
    await buildProgram().parseAsync(["node", "mono", "schema", "ls"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);
    expect(env.command).toBe("schema");
    expect(env.error).toBeNull();

    // Envelope shape holds.
    const parsed = envelope(z.unknown()).safeParse(env);
    if (!parsed.success) {
      throw new Error(`envelope mismatch: ${parsed.error.message}`);
    }

    // data is a JSON Schema object describing the envelope for `ls`.
    const schema = env.data as {
      type?: string;
      properties?: {
        data?: { anyOf?: unknown[]; type?: string | string[] };
      };
    };
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    const dataField = schema.properties?.data;
    expect(dataField).toBeDefined();
    // LsDataSchema is `z.array(...)`. Envelope wraps it as `data:
    // dataSchema.nullable()`, so the JSON Schema for `data` is either
    // `{type: 'array'}` with a `null` union, or an `anyOf` containing an
    // array schema and a null schema. We accept either.
    const stringifyData = JSON.stringify(dataField);
    expect(stringifyData).toMatch(/"type"\s*:\s*"array"|"anyOf"/);
  });

  test("mono schema bogus → INVALID_ARGS envelope", async () => {
    await buildProgram().parseAsync(["node", "mono", "schema", "bogus"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(false);
    expect(env.error).not.toBeNull();
    expect(env.error?.code).toBe("INVALID_ARGS");
    expect(env.error?.message).toContain("bogus");
    expect(skin.isFailed()).toBe(true);
  });

  test("mono schema (no arg) → data is list of cmd names", async () => {
    await buildProgram().parseAsync(["node", "mono", "schema"]);
    skin.flush();

    const env = parseEnvelope(cap.captured.stdout);
    expect(env.ok).toBe(true);
    expect(env.error).toBeNull();

    const names = env.data as string[];
    expect(Array.isArray(names)).toBe(true);
    expect(names).toEqual([...SCHEMA_NAMES]);
  });

  test("every registered verb has a parseable schema", async () => {
    for (const name of SCHEMA_NAMES) {
      // Fresh capture per iteration — schema command doesn't clear the
      // JsonRenderer buffer between calls, so we create a new program and
      // reconfigure the skin to reset renderer state.
      cap.restore();
      cap = installCapture();
      skin.configure({
        json: true,
        color: false,
        quiet: false,
        verbose: false,
      });

      await buildProgram().parseAsync(["node", "mono", "schema", name]);
      skin.flush();

      const env = parseEnvelope(cap.captured.stdout);
      expect(env.ok).toBe(true);
      expect(env.command).toBe("schema");
      const schema = env.data as { type?: string };
      expect(schema.type).toBe("object");
    }
  });
});
