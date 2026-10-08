/**
 * Where a project's Blacksmith store lives, found from a working directory.
 *
 * Shared by the dashboard's store registry and the orchestrator's own tools, so
 * "is this checkout a store" has one answer. Read-only: nothing here creates or
 * writes a file.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/** One discovered store: where its state home is and what to call it. */
export interface StoreRoot {
  root: string;
  label: string;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * Where a `.git` file (a linked worktree) really leads: the main clone, but
 * only when that clone's `.git/worktrees/<name>` exists as a directory and is
 * the very place the pointer names. A pointer is text anyone can write, so it
 * is not trusted on its own; otherwise the worktree itself is the top.
 */
export function mainCloneOf(dotGitFile: string, dir: string): string {
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGitFile, 'utf8'))?.[1]?.trim();
    if (!gitdir) return dir;
    const target = path.resolve(dir, gitdir);
    const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
    const at = target.indexOf(marker);
    if (at <= 0) return dir;
    const top = target.slice(0, at);
    const name = target.slice(at + marker.length);
    if (name === '' || name.includes(path.sep)) return dir;
    const entry = path.join(top, '.git', 'worktrees', name);
    if (!isDir(path.join(top, '.git')) || !isDir(entry)) return dir;
    return realpathSync(entry) === realpathSync(target) ? top : dir;
  } catch {
    // Unreadable or dangling pointer: treat the worktree itself as the top.
    return dir;
  }
}

/**
 * The git toplevel above `start`, or null. A `.git` directory marks a clone; a
 * `.git` file (a linked worktree) is followed to the main clone, because the
 * state home belongs to the project, not to one checkout of it.
 */
export function gitTop(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    if (isDir(dotGit)) return dir;
    if (existsSync(dotGit)) return mainCloneOf(dotGit, dir);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * A real store marker: `state/events` is a directory that lives inside `root`,
 * not a file and not a link leading out of the tree.
 */
export function hasEvents(root: string): boolean {
  const events = path.join(root, 'state', 'events');
  return isDir(events) && realOr(events) === path.join(realOr(root), 'state', 'events');
}

/** `<top>/.blacksmith` first (a BS_HOME layout), else `<top>` itself (a clone). */
export function storeRootAt(top: string): StoreRoot | null {
  for (const root of [path.join(top, '.blacksmith'), top]) {
    if (hasEvents(root)) return { root, label: path.basename(top) };
  }
  return null;
}
