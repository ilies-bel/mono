// tests/helpers/fixture-repo.ts — reusable integration-test scaffold.
//
// Builds an isolated tmpdir containing three non-bare git repos (parent +
// d2r2-frontend + d2r2-backend) plus a bare "origin" remote for each. The
// parent repo has both submodules registered in a committed `.gitmodules`
// file so `mono new` (and any code that relies on `assertParentRoot`) can
// operate end-to-end without hitting the network or polluting the real
// repos on disk.
//
// Layout produced by `createFixture()`:
//   <root>/
//   ├── origins/
//   │   ├── parent.git/            (bare)
//   │   ├── d2r2-frontend.git/     (bare)
//   │   └── d2r2-backend.git/      (bare)
//   └── checkout/                  ← mono project root (pass this to mono-ts)
//       ├── .gitmodules
//       ├── d2r2-frontend/         (submodule checkout)
//       └── d2r2-backend/          (submodule checkout)
//
// Each repo is on branch `main`, has its `origin` remote wired up, has a
// local git identity configured (so `git commit` works without global
// config), and has at least one commit — so `git rev-parse HEAD` and
// `worktree add` both succeed from the start.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";

export interface FixtureOrigins {
  parent: string;
  frontend: string;
  backend: string;
}

export interface Fixture {
  /** Absolute path to the tmpdir that owns everything. */
  root: string;
  /** Absolute path to the mono project root — pass this to mono-ts APIs. */
  checkout: string;
  /** Absolute paths to the three bare "origin" remotes. */
  origins: FixtureOrigins;
  /** Remove the entire tmpdir. Idempotent. */
  cleanup(): Promise<void>;
}

export interface CreateFixtureOptions {
  /**
   * When `true` (default) each non-bare repo is seeded with an initial
   * commit on `main` and pushed to its origin. Set to `false` only when a
   * test explicitly needs the "empty repo" state — most callers should
   * leave this on.
   */
  initialCommits?: boolean;
}

// ─── internals ─────────────────────────────────────────────────────────────

async function run(cwd: string, args: string[]): Promise<void> {
  // `reject: true` → throw with git's stderr on any non-zero exit, so
  // fixture-setup failures surface immediately instead of silently leaving
  // a half-built scaffold behind.
  await execa("git", args, { cwd, stripFinalNewline: false });
}

async function initBare(path: string): Promise<void> {
  // `-c init.defaultBranch=main` dodges the `master`-vs-`main` footgun on
  // machines where the global default is still `master`.
  await execa("git", ["-c", "init.defaultBranch=main", "init", "--bare", path]);
}

async function initCheckout(path: string): Promise<void> {
  await execa("git", ["-c", "init.defaultBranch=main", "init", path]);
  // Per-repo identity so `git commit` works without touching ~/.gitconfig.
  await run(path, ["config", "user.email", "test@mono-ts.local"]);
  await run(path, ["config", "user.name", "mono-ts test"]);
  // Disable commit signing — CI machines/devs may have it globally enabled.
  await run(path, ["config", "commit.gpgsign", "false"]);
  // Override any global `submodule.recurse` / `push.recurseSubmodules` so a
  // parent push never drags its submodules along. The mono push command
  // orchestrates per-repo pushes explicitly, and developer/CI globals must
  // not change the outcome of integration tests.
  await run(path, ["config", "submodule.recurse", "false"]);
  await run(path, ["config", "push.recurseSubmodules", "no"]);
}

async function seedAndPush(
  checkout: string,
  origin: string,
  label: string,
): Promise<void> {
  await run(checkout, ["remote", "add", "origin", origin]);
  // `--allow-empty` keeps the fixture fast (no tree churn); the README
  // write is there to make failure diagnostics more obvious if somebody
  // inspects the tmpdir by hand.
  await writeFile(join(checkout, "README.md"), `# ${label}\n`, "utf8");
  await run(checkout, ["add", "README.md"]);
  await run(checkout, ["commit", "-m", `init ${label}`]);
  // Older gits may have created `master`; force the branch to `main`.
  await run(checkout, ["branch", "-M", "main"]);
  await run(checkout, ["push", "-u", "origin", "main"]);
}

// ─── public API ────────────────────────────────────────────────────────────

export async function createFixture(
  opts: CreateFixtureOptions = {},
): Promise<Fixture> {
  const initialCommits = opts.initialCommits ?? true;

  const root = await mkdtemp(join(tmpdir(), "mono-ts-"));
  const originsDir = join(root, "origins");
  const checkout = join(root, "checkout");

  const origins: FixtureOrigins = {
    parent: join(originsDir, "parent.git"),
    frontend: join(originsDir, "d2r2-frontend.git"),
    backend: join(originsDir, "d2r2-backend.git"),
  };

  const cleanup = async (): Promise<void> => {
    await rm(root, { recursive: true, force: true });
  };

  try {
    // 1. Bare origins for all three repos.
    await Promise.all([
      initBare(origins.parent),
      initBare(origins.frontend),
      initBare(origins.backend),
    ]);

    // 2. Seed the two submodule checkouts (in a scratch dir) and push them
    //    to their bare origins. The parent's `git submodule add` below
    //    needs the submodule origins to contain at least one commit so
    //    they can be cloned back as submodules of the parent.
    const subScratch = join(root, "sub-scratch");
    const feSeed = join(subScratch, "d2r2-frontend");
    const beSeed = join(subScratch, "d2r2-backend");

    if (initialCommits) {
      await initCheckout(feSeed);
      await seedAndPush(feSeed, origins.frontend, "d2r2-frontend");

      await initCheckout(beSeed);
      await seedAndPush(beSeed, origins.backend, "d2r2-backend");
    }

    // 3. Parent checkout.
    await initCheckout(checkout);
    await run(checkout, ["remote", "add", "origin", origins.parent]);

    if (initialCommits) {
      // Seed commit so HEAD resolves before we start adding submodules —
      // older gits can be finicky about `submodule add` on an empty repo.
      await writeFile(join(checkout, "README.md"), "# parent\n", "utf8");
      await run(checkout, ["add", "README.md"]);
      await run(checkout, ["commit", "-m", "init parent"]);
      await run(checkout, ["branch", "-M", "main"]);

      // 4. Register both submodules. Modern git refuses `file://` (and
      //    bare absolute-path) submodule sources by default as a fix for
      //    CVE-2022-39253; the `-c protocol.file.allow=always` flag has
      //    to be passed per-command because `git submodule add` invokes
      //    a nested `git clone` that does not inherit local repo config
      //    for the protocol allow-list. The fixture is entirely on-disk,
      //    so the guard is redundant here. The `--` before the path is
      //    defensive against paths that could look like flags.
      await run(checkout, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "--",
        origins.frontend,
        "d2r2-frontend",
      ]);
      await run(checkout, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "--",
        origins.backend,
        "d2r2-backend",
      ]);

      // Configure identity *inside* each submodule checkout too — git
      // creates them as independent repos and they inherit nothing from
      // the parent's local config.
      await run(join(checkout, "d2r2-frontend"), [
        "config",
        "user.email",
        "test@mono-ts.local",
      ]);
      await run(join(checkout, "d2r2-frontend"), [
        "config",
        "user.name",
        "mono-ts test",
      ]);
      await run(join(checkout, "d2r2-frontend"), [
        "config",
        "commit.gpgsign",
        "false",
      ]);
      await run(join(checkout, "d2r2-frontend"), [
        "config",
        "submodule.recurse",
        "false",
      ]);
      await run(join(checkout, "d2r2-frontend"), [
        "config",
        "push.recurseSubmodules",
        "no",
      ]);
      await run(join(checkout, "d2r2-backend"), [
        "config",
        "user.email",
        "test@mono-ts.local",
      ]);
      await run(join(checkout, "d2r2-backend"), [
        "config",
        "user.name",
        "mono-ts test",
      ]);
      await run(join(checkout, "d2r2-backend"), [
        "config",
        "commit.gpgsign",
        "false",
      ]);
      await run(join(checkout, "d2r2-backend"), [
        "config",
        "submodule.recurse",
        "false",
      ]);
      await run(join(checkout, "d2r2-backend"), [
        "config",
        "push.recurseSubmodules",
        "no",
      ]);

      // `submodule add` stages both the `.gitmodules` file and the two
      // gitlinks; commit them and push so the parent's `origin/main` is
      // in sync with its local `main` (matches the state `mono new`
      // expects when branching from `main`).
      await run(checkout, ["commit", "-m", "chore: add submodules"]);
      await run(checkout, ["push", "-u", "origin", "main"]);
    }

    return { root, checkout, origins, cleanup };
  } catch (err: unknown) {
    // Never leak a half-built tmpdir on failure.
    await cleanup();
    throw err;
  }
}
