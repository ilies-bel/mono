// core/registry.ts — read/write the .mono/ directory at the project root.
//
// Layout (project root):
//   .mono/
//   ├── config.yml   ← user-authored YAML; flat string→string map
//   ├── state.json   ← machine-written; worktree registrations + push queue
//   └── worktrees/   ← default base for `mono new <name>` (created lazily)
//
// Why split: config.yml is hand-edited and diff-friendly; state.json is
// rewritten atomically on every new/rm/push and benefits from JSON's strict
// shape. Keeping them apart means queue churn never clobbers user comments
// in the config file.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import YAML from "yaml";

export interface Worktree {
  name: string;
  path: string;
}

export type RepoKind = "parent" | "d2r2-frontend" | "d2r2-backend";

export interface QueueEntry {
  repo: RepoKind;
  branch: string;
}

export interface Registry {
  worktrees: Worktree[];
  config: Record<string, string>;
  queue: QueueEntry[];
}

const REPO_KINDS: readonly RepoKind[] = ["parent", "d2r2-frontend", "d2r2-backend"] as const;

function isRepoKind(value: unknown): value is RepoKind {
  return typeof value === "string" && (REPO_KINDS as readonly string[]).includes(value);
}

function assertValidRoot(root: string): void {
  if (!root || typeof root !== "string") {
    throw new Error("registry: root path is required");
  }
  if (!path.isAbsolute(root)) {
    throw new Error(`registry: root path must be absolute, got '${root}'`);
  }
}

function monoDir(root: string): string {
  return path.join(root, ".mono");
}

function configFile(root: string): string {
  return path.join(monoDir(root), "config.yml");
}

function stateFile(root: string): string {
  return path.join(monoDir(root), "state.json");
}

/** Default base directory for new worktrees: `<root>/.mono/worktrees`. */
export function defaultWorktreeBase(root: string): string {
  return path.join(monoDir(root), "worktrees");
}

const CONFIG_HEADER = "# mono config — user-editable\n";

function parseConfig(contents: string): Record<string, string> {
  if (contents.trim().length === 0) return {};
  const parsed = YAML.parse(contents);
  if (parsed == null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config.yml must be a YAML mapping at the top level");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    // Coerce scalars to string; reject nested objects so the shape stays flat.
    if (v == null) continue;
    if (typeof v === "object") {
      throw new Error(`config.yml: value for '${k}' must be a scalar`);
    }
    out[k] = String(v);
  }
  return out;
}

function serializeConfig(config: Record<string, string>): string {
  const keys = Object.keys(config).sort();
  if (keys.length === 0) return CONFIG_HEADER;
  const ordered: Record<string, string> = {};
  for (const k of keys) ordered[k] = config[k] ?? "";
  return CONFIG_HEADER + YAML.stringify(ordered);
}

interface StateShape {
  worktrees: Worktree[];
  queue: QueueEntry[];
}

function parseState(contents: string): StateShape {
  if (contents.trim().length === 0) return { worktrees: [], queue: [] };
  const parsed = JSON.parse(contents) as unknown;
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("state.json must be a JSON object");
  }
  const rec = parsed as Record<string, unknown>;

  const worktrees: Worktree[] = [];
  if (Array.isArray(rec.worktrees)) {
    for (const entry of rec.worktrees) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const w = entry as Record<string, unknown>;
        if (typeof w.name === "string" && typeof w.path === "string") {
          worktrees.push({ name: w.name, path: w.path });
        }
      }
    }
  }

  const queue: QueueEntry[] = [];
  if (Array.isArray(rec.queue)) {
    for (const entry of rec.queue) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const q = entry as Record<string, unknown>;
        if (isRepoKind(q.repo) && typeof q.branch === "string" && q.branch.length > 0) {
          queue.push({ repo: q.repo, branch: q.branch });
        }
      }
    }
  }

  return { worktrees, queue };
}

function serializeState(reg: Registry): string {
  const body = {
    worktrees: reg.worktrees.map((w) => ({ name: w.name, path: w.path })),
    queue: reg.queue.map((q) => ({ repo: q.repo, branch: q.branch })),
  };
  return JSON.stringify(body, null, 2) + "\n";
}

export async function isInitialized(root: string): Promise<boolean> {
  assertValidRoot(root);
  try {
    const st = await fs.stat(monoDir(root));
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function loadRegistry(root: string): Promise<Registry> {
  assertValidRoot(root);
  const [rawConfig, rawState] = await Promise.all([
    readIfExists(configFile(root)),
    readIfExists(stateFile(root)),
  ]);

  const config = rawConfig == null ? {} : parseConfig(rawConfig);
  const state = rawState == null ? { worktrees: [], queue: [] } : parseState(rawState);

  return {
    worktrees: state.worktrees,
    config,
    queue: state.queue,
  };
}

async function writeAtomic(dest: string, body: string): Promise<void> {
  const rand = Math.random().toString(36).slice(2, 10);
  const tmp = `${dest}.tmp.${process.pid}.${rand}`;
  const fh = await fs.open(tmp, "w", 0o644);
  try {
    await fh.writeFile(body, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, dest);
}

/**
 * Atomically persist the registry to <root>/.mono/{config.yml,state.json}.
 * Ensures the .mono directory exists, writes each file via tmp+rename so
 * readers never see a partial file. Writes run in parallel.
 */
export async function saveRegistry(root: string, reg: Registry): Promise<void> {
  assertValidRoot(root);
  const st = await fs.stat(root);
  if (!st.isDirectory()) {
    throw new Error(`registry: root is not a directory: ${root}`);
  }

  await fs.mkdir(monoDir(root), { recursive: true });

  await Promise.all([
    writeAtomic(configFile(root), serializeConfig(reg.config)),
    writeAtomic(stateFile(root), serializeState(reg)),
  ]);
}

/**
 * Walk upwards from `startDir` looking for a directory that contains a
 * `.mono/` subdirectory. Mirrors the previous `_find_up` shape, now on the
 * new layout. Returns the directory path, or null if no marker is found.
 */
export async function findProjectRoot(startDir: string): Promise<string | null> {
  if (!startDir || !path.isAbsolute(startDir)) return null;
  let dir = path.resolve(startDir);
  while (true) {
    try {
      const st = await fs.stat(path.join(dir, ".mono"));
      if (st.isDirectory()) return dir;
    } catch {
      // not found here, keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ─── Immutable helpers ──────────────────────────────────────────────────────

function cloneRegistry(reg: Registry): Registry {
  return {
    worktrees: reg.worktrees.map((w) => ({ ...w })),
    config: { ...reg.config },
    queue: reg.queue.map((q) => ({ ...q })),
  };
}

export function registerWorktree(reg: Registry, wt: Worktree): Registry {
  const next = cloneRegistry(reg);
  next.worktrees = next.worktrees.filter((w) => w.name !== wt.name);
  next.worktrees.push({ ...wt });
  return next;
}

export function unregisterWorktree(reg: Registry, name: string): Registry {
  const next = cloneRegistry(reg);
  next.worktrees = next.worktrees.filter((w) => w.name !== name);
  return next;
}

export function findWorktree(reg: Registry, name: string): Worktree | undefined {
  const found = reg.worktrees.find((w) => w.name === name);
  return found ? { ...found } : undefined;
}

export function isRegistered(reg: Registry, name: string): boolean {
  return findWorktree(reg, name) !== undefined;
}

export function getConfig(reg: Registry, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(reg.config, key) ? reg.config[key] : undefined;
}

export function setConfig(reg: Registry, key: string, value: string): Registry {
  const next = cloneRegistry(reg);
  next.config[key] = value;
  return next;
}

export function unsetConfig(reg: Registry, key: string): Registry {
  const next = cloneRegistry(reg);
  delete next.config[key];
  return next;
}

export function queueAdd(reg: Registry, entry: QueueEntry): Registry {
  const next = cloneRegistry(reg);
  const exists = next.queue.some((q) => q.repo === entry.repo && q.branch === entry.branch);
  if (!exists) next.queue.push({ ...entry });
  return next;
}

export function queueRemove(reg: Registry, entry: QueueEntry): Registry {
  const next = cloneRegistry(reg);
  next.queue = next.queue.filter((q) => !(q.repo === entry.repo && q.branch === entry.branch));
  return next;
}
