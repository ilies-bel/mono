#!/usr/bin/env bun
import { Command } from "commander";
import { skin } from "./skin/index.ts";
import { initCommand } from "./cmd/init.ts";
import { configCommand } from "./cmd/config.ts";
import { lsCommand } from "./cmd/ls.ts";
import { statusCommand } from "./cmd/status.ts";
import { newCommand } from "./cmd/new.ts";
import { commitCommand } from "./cmd/commit.ts";
import { pushCommand } from "./cmd/push.ts";
import { pullCommand } from "./cmd/pull.ts";
import { rebaseCommand } from "./cmd/rebase.ts";
import { rmCommand } from "./cmd/rm.ts";
import { schemaCommand } from "./cmd/schema.ts";

interface GlobalOpts {
  json?: boolean;
  color?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  cwd?: string;
}

const program = new Command();

program
  .name("mono")
  .description("Monorepo-style git orchestration across parent + d2r2 submodules")
  .version("0.3.0")
  .option("--json", "emit JSON envelope instead of human output")
  .option("--no-color", "disable ANSI colors")
  .option("--quiet", "suppress informational messages")
  .option("--verbose", "emit debug messages")
  .option("--cwd <path>", "run as if invoked from <path>");

// Configure the skin from global flags before any subcommand action runs.
// commander's --no-color sets `color: false` on opts (default true).
program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.opts<GlobalOpts>();
  if (opts.cwd) {
    process.chdir(opts.cwd);
  }
  skin.configure({
    json: Boolean(opts.json),
    color: opts.color !== false,
    quiet: Boolean(opts.quiet),
    verbose: Boolean(opts.verbose),
  });
});

program.addCommand(initCommand());
program.addCommand(configCommand());
program.addCommand(lsCommand());
program.addCommand(statusCommand());
program.addCommand(newCommand());
program.addCommand(commitCommand());
program.addCommand(rebaseCommand());
program.addCommand(pushCommand());
program.addCommand(pullCommand());
program.addCommand(rmCommand());
program.addCommand(schemaCommand());

program
  .command("help")
  .description("show help")
  .action(() => program.help());

// Flush the envelope once on process exit (json mode) and set a nonzero
// exit code when any command called `skin.fail`. Text mode streams so flush
// is a no-op there.
process.on("beforeExit", () => {
  skin.flush();
  if (skin.isFailed()) {
    process.exitCode = 1;
  }
});

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
