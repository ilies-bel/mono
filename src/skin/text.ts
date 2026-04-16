// Text renderer — colored stderr output, mirrors mono-lib.sh prefixes.
//
// Color mapping from mono-lib.sh:
//   blue   → log/info
//   green  → ok (not wired here; reserved for future success markers)
//   yellow → warn  (prefix "!")
//   red    → err   (prefix "x")
//   dim    → debug
//
// `emit` pretty-prints JSON to stdout (final command output).
// `table` writes a formatted table to stdout via cli-table3.
// `fail` writes the red error line to stderr; the exit code is owned by
// the CLI entrypoint which inspects whether `fail` was called.

import pc from "picocolors";
import Table from "cli-table3";
import type { Renderer } from "./index.ts";

export interface TextRendererOptions {
  color: boolean;
  quiet: boolean;
  verbose: boolean;
}

// picocolors auto-disables when stdout is not a TTY. We want colors driven
// by `opts.color` alone (the caller already factored TTY detection in), so
// build a fresh color set with coloring force-enabled and gate usage here.
const colors = pc.createColors(true);

export class TextRenderer implements Renderer {
  private readonly opts: TextRendererOptions;
  private failed = false;

  constructor(opts: TextRendererOptions) {
    this.opts = opts;
  }

  setCommand(_name: string): void {
    // Text renderer has no need for the command name — it's implicit from
    // the human context. Kept to satisfy the Renderer contract.
  }

  info(msg: string): void {
    if (this.opts.quiet) return;
    this.write(this.opts.color ? colors.blue(msg) : msg);
  }

  warn(msg: string): void {
    const line = `! ${msg}`;
    this.write(this.opts.color ? colors.yellow(line) : line);
  }

  err(msg: string): void {
    const line = `x ${msg}`;
    this.write(this.opts.color ? colors.red(line) : line);
  }

  debug(msg: string): void {
    if (!this.opts.verbose) return;
    this.write(this.opts.color ? colors.dim(msg) : msg);
  }

  emit<T>(data: T): void {
    // Commands final output → stdout so it can be piped.
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  }

  table(rows: Record<string, unknown>[], columns: string[]): void {
    const table = new Table({ head: columns });
    for (const row of rows) {
      table.push(columns.map((c) => String(row[c] ?? "")));
    }
    process.stdout.write(table.toString() + "\n");
  }

  fail(code: string, message: string, _details?: Record<string, unknown>): void {
    this.failed = true;
    const line = `x [${code}] ${message}`;
    this.write(this.opts.color ? colors.red(line) : line);
  }

  flush(): void {
    // Text mode streams as it goes — nothing to flush. The exit code is
    // decided by the caller based on whether `failed` was tripped.
  }

  hasFailed(): boolean {
    return this.failed;
  }

  isFailed(): boolean {
    return this.failed;
  }

  private write(line: string): void {
    process.stderr.write(line + "\n");
  }
}
