// JSON renderer — buffers a single envelope written to stdout on flush().
//
// Envelope shape (stable contract consumed by LLM orchestrators):
//   {
//     ok: boolean,              // flipped to false by fail()
//     command: string,          // set by setCommand()
//     data: unknown,            // last value passed to emit(); default null
//     warnings: string[],       // accumulated from warn()
//     error: { code, message, details? } | null,
//     meta: { mono_version, elapsed_ms }
//   }
//
// In JSON mode, `info` and `debug` are dropped — human messages would
// pollute machine-readable output. `warn` is kept because operational
// warnings are part of the contract (e.g. "branch already up-to-date").

import type { Renderer, SkinError } from "./index.ts";

// Version stays in lockstep with package.json's "version" field. Hard-coded
// here to keep the skin pure (no fs / import.meta.resolve on a JSON file).
const MONO_VERSION = "0.3.0";

export interface JsonEnvelope {
  ok: boolean;
  command: string;
  data: unknown;
  warnings: string[];
  error: SkinError | null;
  meta: {
    mono_version: string;
    elapsed_ms: number;
  };
}

export class JsonRenderer implements Renderer {
  private readonly startedAt: number;
  private readonly envelope: JsonEnvelope;
  private flushed = false;

  constructor() {
    this.startedAt = Date.now();
    this.envelope = {
      ok: true,
      command: "",
      data: null,
      warnings: [],
      error: null,
      meta: {
        mono_version: MONO_VERSION,
        elapsed_ms: 0,
      },
    };
  }

  setCommand(name: string): void {
    this.envelope.command = name;
  }

  info(_msg: string): void {
    // Dropped: info messages are for humans only.
  }

  warn(msg: string): void {
    this.envelope.warnings.push(msg);
  }

  err(msg: string): void {
    // `err` without `fail` means "something went wrong but command isn't
    // aborting" — treat as a warning in machine output so it's preserved.
    this.envelope.warnings.push(msg);
  }

  debug(_msg: string): void {
    // Dropped: debug is for humans only.
  }

  emit<T>(data: T): void {
    this.envelope.data = data;
  }

  table(rows: Record<string, unknown>[], _columns: string[]): void {
    // Tables are a text-mode affordance. In JSON mode, `emit` should have
    // already been called with the raw rows. If not, fall back to setting
    // data so the caller's output isn't silently lost.
    if (this.envelope.data === null) {
      this.envelope.data = rows;
    }
  }

  fail(code: string, message: string, details?: Record<string, unknown>): void {
    this.envelope.ok = false;
    this.envelope.error =
      details === undefined ? { code, message } : { code, message, details };
  }

  flush(): void {
    if (this.flushed) return;
    this.flushed = true;
    this.envelope.meta.elapsed_ms = Date.now() - this.startedAt;
    process.stdout.write(JSON.stringify(this.envelope) + "\n");
  }

  isFailed(): boolean {
    return !this.envelope.ok;
  }
}
