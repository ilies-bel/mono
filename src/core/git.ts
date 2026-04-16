// Typed git wrappers. Every function takes cwd as its first argument.
// Functions return GitResult (ok, stdout, stderr, exitCode) so callers can
// inspect failures without relying on thrown errors. Use gitError() to
// synthesise an Error when the caller decides a failure is fatal.

import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  const result = await execa("git", args, {
    cwd,
    reject: false,
    stripFinalNewline: false,
  });
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : 1;
  return {
    ok: exitCode === 0,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    exitCode,
  };
}

function trimmed(s: string): string {
  return s.replace(/\s+$/u, "");
}

export async function head(cwd: string): Promise<string> {
  const r = await git(cwd, ["rev-parse", "HEAD"]);
  if (!r.ok) throw gitError(r, "git rev-parse HEAD");
  return trimmed(r.stdout);
}

export async function currentBranch(cwd: string): Promise<string> {
  const r = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!r.ok) throw gitError(r, "git rev-parse --abbrev-ref HEAD");
  return trimmed(r.stdout);
}

export async function statusPorcelain(cwd: string): Promise<string> {
  const r = await git(cwd, ["status", "--porcelain"]);
  if (!r.ok) throw gitError(r, "git status --porcelain");
  return r.stdout;
}

export async function statusShortBranch(cwd: string): Promise<string> {
  const r = await git(cwd, ["status", "--short", "--branch"]);
  if (!r.ok) throw gitError(r, "git status --short --branch");
  return r.stdout;
}

export async function isClean(cwd: string): Promise<boolean> {
  const porcelain = await statusPorcelain(cwd);
  return trimmed(porcelain).length === 0;
}

export async function hasLocalBranch(cwd: string, branch: string): Promise<boolean> {
  const r = await git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  return r.ok;
}

export async function hasRemoteBranch(
  cwd: string,
  branch: string,
  remote: string = "origin",
): Promise<boolean> {
  const r = await git(cwd, ["ls-remote", "--exit-code", "--heads", remote, branch]);
  return r.ok;
}

export async function fetch(cwd: string, remote: string): Promise<GitResult> {
  return git(cwd, ["fetch", remote]);
}

// Does not throw on conflict; the caller inspects `ok` and decides how to
// surface a conflict (mono rebase currently aborts and prints remediation).
export async function rebase(cwd: string, upstream: string): Promise<GitResult> {
  return git(cwd, ["rebase", upstream]);
}

export async function push(
  cwd: string,
  remote: string,
  branch: string,
  setUpstream: boolean,
): Promise<GitResult> {
  const args = ["push"];
  if (setUpstream) args.push("-u");
  args.push(remote, branch);
  return git(cwd, args);
}

export async function add(cwd: string, paths: string[]): Promise<GitResult> {
  return git(cwd, ["add", ...paths]);
}

export async function addAll(cwd: string): Promise<GitResult> {
  return git(cwd, ["add", "-A"]);
}

// `git diff --cached --quiet` exits 0 when the index matches HEAD and 1 when
// there are staged changes. Any other exit code indicates a real error and we
// surface it as a throw — callers that want to treat "no repo" as "nothing
// staged" should guard with a repo-existence check first.
export async function hasStagedChanges(cwd: string): Promise<boolean> {
  const r = await git(cwd, ["diff", "--cached", "--quiet"]);
  if (r.exitCode !== 0 && r.exitCode !== 1) {
    throw gitError(r, "git diff --cached --quiet");
  }
  return r.exitCode !== 0;
}

export async function commit(
  cwd: string,
  message: string,
  allowEmpty: boolean = false,
): Promise<GitResult> {
  const args = ["commit", "-m", message];
  if (allowEmpty) args.push("--allow-empty");
  return git(cwd, args);
}

export async function worktreeAdd(
  cwd: string,
  path: string,
  branch: string,
  base?: string,
): Promise<GitResult> {
  // If base is provided we create the branch; otherwise we check out an
  // existing branch (matches the bash tool's has_local_branch path).
  const args = base
    ? ["worktree", "add", "-b", branch, path, base]
    : ["worktree", "add", path, branch];
  return git(cwd, args);
}

export async function worktreeRemove(
  cwd: string,
  path: string,
  force: boolean = false,
): Promise<GitResult> {
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(path);
  return git(cwd, args);
}

export async function getRemoteUrl(cwd: string, remote: string): Promise<string | null> {
  const r = await git(cwd, ["remote", "get-url", remote]);
  if (!r.ok) return null;
  const url = trimmed(r.stdout);
  return url.length > 0 ? url : null;
}

// Detect whether a repo has a rebase in progress. Resolves the per-worktree
// git-dir via `git rev-parse --git-dir` (worktrees keep per-worktree state
// under <main-git-dir>/worktrees/<wt>/) and checks for `rebase-merge` or
// `rebase-apply` subdirectories — the markers git drops while a rebase is
// paused on a conflict.
export async function isRebasing(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "--git-dir"], { cwd });
    const gitDir = path.resolve(cwd, stdout.trim());
    const mergeDir = await fs.stat(path.join(gitDir, "rebase-merge")).catch(() => null);
    if (mergeDir?.isDirectory()) return true;
    const applyDir = await fs.stat(path.join(gitDir, "rebase-apply")).catch(() => null);
    if (applyDir?.isDirectory()) return true;
    return false;
  } catch {
    return false;
  }
}

// Format a non-zero GitResult into a throwable Error. Callers use this when
// they've decided a failure is fatal (e.g. head() / currentBranch() on a
// repo they expect to be valid).
export function gitError(result: GitResult, op: string): Error {
  const detail = trimmed(result.stderr) || trimmed(result.stdout) || `exit ${result.exitCode}`;
  return new Error(`${op} failed: ${detail}`);
}
