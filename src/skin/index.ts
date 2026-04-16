// Skin module — the ONE place that writes to stdout/stderr.
//
// Two renderers:
//   - text.ts : human-readable, colored stderr (replaces mono-lib.sh logging).
//   - json.ts : buffers a single envelope, flushed once to stdout.
//
// Commands call `skin.info/warn/err/emit/table/fail` and, at the very end,
// `skin.flush()`. The active renderer is picked by `skin.configure(opts)`.

import { TextRenderer } from "./text.ts";
import { JsonRenderer } from "./json.ts";

export interface SkinOptions {
  json: boolean;
  color: boolean;
  quiet: boolean;
  verbose: boolean;
}

export interface SkinError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface Skin {
  configure(opts: SkinOptions): void;
  setCommand(name: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  err(msg: string): void;
  debug(msg: string): void;
  emit<T>(data: T): void;
  table(rows: Record<string, unknown>[], columns: string[]): void;
  fail(code: string, message: string, details?: Record<string, unknown>): void;
  flush(): void;
  isFailed(): boolean;
}

// Internal renderer contract — both text and json implementations satisfy
// this. `SkinFacade` delegates to whichever renderer is currently active.
export interface Renderer {
  setCommand(name: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  err(msg: string): void;
  debug(msg: string): void;
  emit<T>(data: T): void;
  table(rows: Record<string, unknown>[], columns: string[]): void;
  fail(code: string, message: string, details?: Record<string, unknown>): void;
  flush(): void;
  isFailed(): boolean;
}

class SkinFacade implements Skin {
  private renderer: Renderer;
  private command = "";

  constructor() {
    // Default to text mode with colors if tty, no-quiet, no-verbose. A call
    // to configure() before emitting any output is expected in production.
    this.renderer = new TextRenderer({
      color: Boolean(process.stderr.isTTY),
      quiet: false,
      verbose: false,
    });
  }

  configure(opts: SkinOptions): void {
    if (opts.json) {
      this.renderer = new JsonRenderer();
    } else {
      this.renderer = new TextRenderer({
        color: opts.color && Boolean(process.stderr.isTTY),
        quiet: opts.quiet,
        verbose: opts.verbose,
      });
    }
    if (this.command) {
      this.renderer.setCommand(this.command);
    }
  }

  setCommand(name: string): void {
    this.command = name;
    this.renderer.setCommand(name);
  }

  info(msg: string): void {
    this.renderer.info(msg);
  }

  warn(msg: string): void {
    this.renderer.warn(msg);
  }

  err(msg: string): void {
    this.renderer.err(msg);
  }

  debug(msg: string): void {
    this.renderer.debug(msg);
  }

  emit<T>(data: T): void {
    this.renderer.emit(data);
  }

  table(rows: Record<string, unknown>[], columns: string[]): void {
    this.renderer.table(rows, columns);
  }

  fail(code: string, message: string, details?: Record<string, unknown>): void {
    this.renderer.fail(code, message, details);
  }

  flush(): void {
    this.renderer.flush();
  }

  isFailed(): boolean {
    return this.renderer.isFailed();
  }
}

// Default singleton. Every command imports this.
export const skin: Skin = new SkinFacade();
