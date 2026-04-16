// Repo iteration helpers for the parent worktree + its two submodules.
// Mirrors mono-lib.sh repo_dirs_for / submodule_dirs_for, but typed and
// usable with Promise.all.

import { access } from "node:fs/promises";
import { join } from "node:path";

export type RepoLabel = "parent" | "d2r2-frontend" | "d2r2-backend";

export interface RepoRef {
  label: RepoLabel;
  cwd: string;
}

const SUBMODULES: ReadonlyArray<Extract<RepoLabel, "d2r2-frontend" | "d2r2-backend">> = [
  "d2r2-frontend",
  "d2r2-backend",
] as const;

// Stable order: parent first, then submodules (frontend, backend). The
// bash rebase path iterates submodules first — callers needing that order
// can use `submodulesFor` or reorder the output.
export function reposFor(worktreeRoot: string): RepoRef[] {
  return [
    { label: "parent", cwd: worktreeRoot },
    ...SUBMODULES.map(
      (label): RepoRef => ({ label, cwd: join(worktreeRoot, label) }),
    ),
  ];
}

export function submodulesFor(worktreeRoot: string): RepoRef[] {
  return SUBMODULES.map(
    (label): RepoRef => ({ label, cwd: join(worktreeRoot, label) }),
  );
}

// Run fn against every ref in parallel. Results are returned in the same
// order as `refs` (Promise.all preserves index order).
export async function mapRepos<T>(
  refs: RepoRef[],
  fn: (r: RepoRef) => Promise<T>,
): Promise<Array<{ ref: RepoRef; value: T }>> {
  const values = await Promise.all(refs.map((ref) => fn(ref)));
  return refs.map((ref, i) => ({ ref, value: values[i] as T }));
}

// A parent worktree root must contain a .gitmodules file — same marker
// the bash tool uses (assert_in_parent_root in mono-lib.sh:117).
export async function assertParentRoot(worktreeRoot: string): Promise<void> {
  const marker = join(worktreeRoot, ".gitmodules");
  try {
    await access(marker);
  } catch {
    throw new Error(`not a mono parent root (no .gitmodules): ${worktreeRoot}`);
  }
}
