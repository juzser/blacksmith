import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { readClosedEpicWidths } from './epicWidth.js';
import { SmithError } from './errors.js';
import type { StoredEvent } from './events.js';
import { runGit } from './git.js';
import {
  type HeavyLockRecord,
  pidIsAlive,
  readHeavyLock,
  resolveHeavyLockDir,
} from './heavyLock.js';
import { detectDefaultBranch, type PorcelainEntry, parseWorktreePorcelain } from './worktree.js';

export class CleanupError extends SmithError {}

export type CleanupAction = 'remove' | 'trash' | 'keep' | 'manual' | 'prune';

/** One candidate in the report; every `keep` reason starts with the rule that kept it. */
export interface CleanupItem {
  kind: 'worktree' | 'branch' | 'directory' | 'prune';
  path?: string;
  branch?: string;
  action: CleanupAction;
  reason: string;
}

export interface CleanupReport {
  items: CleanupItem[];
  warnings: string[];
}

export interface FsStat {
  mtimeMs: number;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface CleanupOptions {
  projectDir: string;
  /** Limits worktree and branch targets to this epic; orphans and the prune stay project-wide. */
  epicId?: string;
  /** Dry run unless true. */
  apply?: boolean;
  /** Epoch milliseconds. */
  now: number;
  /** Store events: an `epic-closed` event closes an epic. */
  events: readonly StoredEvent[];
  git?: (cwd: string, args: string[]) => string;
  lstat?: (p: string) => FsStat;
  readdir?: (p: string) => string[];
  isPidAlive?: (pid: number) => boolean;
  trash?: (p: string) => void;
  platform?: string;
  heavyLockDir?: string;
}

const DAY_MS = 24 * 3_600_000;
const WALK_CAP = 20_000;
const BRANCH_RE = /^(bs|smith)\/([^/]+)\/(.+)$/;
const HARNESS_MARK = 'harness-codex-dispatch';

const defaultLstat = (p: string): FsStat => {
  const s = lstatSync(p);
  return { mtimeMs: s.mtimeMs, isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink() };
};
const defaultTrash = (p: string): void => {
  execFileSync('/usr/bin/trash', [p], { stdio: 'ignore' });
};

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function tryReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(child: string, parent: string): boolean {
  return (
    child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
  );
}

interface Entry {
  item: CleanupItem;
  /** The merge targets of a `remove` candidate; the gate is re-run against them. */
  targets: string[];
}

interface Plan {
  entries: Entry[];
  warnings: string[];
  projectDir: string;
  git: NonNullable<CleanupOptions['git']>;
  firstMerged: (branch: string, targets: string[]) => string | null;
}

async function buildPlan(o: CleanupOptions): Promise<Plan> {
  const g = o.git ?? runGit;
  const lstat = o.lstat ?? defaultLstat;
  const readdir = o.readdir ?? ((p: string) => readdirSync(p));
  const alive = o.isPidAlive ?? ((pid: number) => pidIsAlive(pid));
  const projectDir = path.resolve(o.projectDir);
  const warnings: string[] = [];
  const entries: Entry[] = [];

  try {
    g(projectDir, ['rev-parse', '--git-dir']);
  } catch {
    throw new CleanupError('cleanup.not-a-git-repo', `${projectDir} is not a git repository.`, {
      projectDir,
    });
  }

  const defaultBranch = detectDefaultBranch(projectDir);
  const defaultTargets = [`refs/heads/${defaultBranch}`, `refs/remotes/origin/${defaultBranch}`];
  const wtRoot = path.join(path.dirname(projectDir), '.wt', path.basename(projectDir));
  const rootReal = (() => {
    try {
      return realpathSync(wtRoot);
    } catch {
      return null;
    }
  })();

  const closed = new Set(readClosedEpicWidths(o.events).map((e) => e.epicId));
  const named = new Set<string>();
  for (const { record } of o.events) {
    const fromPayload = (record.payload as { epic_id?: unknown } | undefined)?.epic_id;
    if (typeof fromPayload === 'string') named.add(fromPayload);
    if (record.task_id?.includes('/')) named.add(record.task_id.split('/')[0] as string);
  }

  let heavy: HeavyLockRecord | { corrupt: true } | undefined;
  let heavyUnreadable = false;
  try {
    heavy = await readHeavyLock(resolveHeavyLockDir(o.heavyLockDir));
  } catch {
    heavyUnreadable = true;
  }

  const ancestorOf = (ref: string, target: string): boolean => {
    try {
      g(projectDir, ['merge-base', '--is-ancestor', ref, target]);
      return true;
    } catch {
      return false;
    }
  };
  const firstMerged = (branch: string, targets: string[]): string | null =>
    targets.find((t) => ancestorOf(`refs/heads/${branch}`, t)) ?? null;
  const refExists = (ref: string): boolean => {
    try {
      g(projectDir, ['rev-parse', '--verify', '--quiet', ref]);
      return true;
    } catch {
      return false;
    }
  };

  /** The reason an epic's items are kept, or null when the epic is finished. */
  const epicVerdict = (epic: string, prefix: string): string | null => {
    if (closed.has(epic)) return null;
    if (named.has(epic)) return `open-epic: ${epic} has events but no epic-closed event`;
    const integration = `${prefix}/${epic}/integration`;
    if (firstMerged(integration, defaultTargets) !== null) return null;
    return `epic-unrecorded: no events for ${epic} and ${integration} is not landed in ${defaultBranch}`;
  };

  /** Rule 5: the heavy lock, when its cwd is inside `dir` and its pid is not dead. */
  const heavyVerdict = (dir: string): string | null => {
    if (heavyUnreadable || (heavy !== undefined && 'corrupt' in heavy)) {
      return 'heavy-lock: the lock file is unreadable or unparseable';
    }
    if (heavy === undefined) return null;
    if (isInside(tryReal(heavy.cwd), dir) && alive(heavy.pid)) {
      return `heavy-lock: held by live pid ${heavy.pid} inside ${dir}`;
    }
    return null;
  };

  /** Rule 1 on the filesystem side: walk without following symlinks. */
  const walk = (dir: string): string | null => {
    const recent = (ms: number) => o.now - ms < DAY_MS;
    try {
      if (recent(lstat(dir).mtimeMs)) return `active-24h: ${dir} changed in the last 24 h`;
    } catch {
      return `unreadable: ${dir}`;
    }
    const stack = [dir];
    let count = 0;
    for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
      let names: string[];
      try {
        names = readdir(cur);
      } catch {
        return `unreadable: ${cur}`;
      }
      for (const name of names) {
        count += 1;
        if (count > WALK_CAP) return `walk-capped: more than ${WALK_CAP} entries under ${dir}`;
        const p = path.join(cur, name);
        let st: FsStat;
        try {
          st = lstat(p);
        } catch {
          return `unreadable: ${p}`;
        }
        if (recent(st.mtimeMs)) return `active-24h: ${p} changed in the last 24 h`;
        if (st.isDirectory && !st.isSymbolicLink) stack.push(p);
      }
    }
    return null;
  };

  /** Rule 1: commit time of the branch, then the index, then the tree. */
  const activity = (branch: string | null, gitDir: string | null, dir: string | null) => {
    if (branch !== null) {
      const ct = Number(g(projectDir, ['log', '-1', '--format=%ct', `refs/heads/${branch}`]));
      if (!Number.isFinite(ct)) return `unreadable: commit time of ${branch}`;
      if (o.now - ct * 1000 < DAY_MS) return `active-24h: ${branch} has a commit in the last 24 h`;
    }
    if (gitDir !== null) {
      const index = path.join(gitDir, 'index');
      try {
        if (o.now - lstat(index).mtimeMs < DAY_MS)
          return `active-24h: ${index} changed in the last 24 h`;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return `unreadable: ${index}`;
      }
    }
    return dir === null ? null : walk(dir);
  };

  const keep = (item: Omit<CleanupItem, 'action' | 'reason'>, reason: string): Entry => ({
    item: { ...item, action: 'keep', reason },
    targets: [],
  });

  const judgeWorktree = (e: PorcelainEntry, m: RegExpMatchArray): Entry => {
    const [, prefix = '', epic = '', task = ''] = m;
    const branch = e.branch as string;
    const base = { kind: 'worktree' as const, path: e.worktree, branch };
    if (`${e.worktree}\n${branch}`.includes(HARNESS_MARK)) return keep(base, HARNESS_MARK);
    try {
      if (lstat(e.worktree).isSymbolicLink) return keep(base, `symlink: ${e.worktree}`);
    } catch {
      return keep(base, `unreadable: ${e.worktree}`);
    }
    if (rootReal === null || !isInside(tryReal(e.worktree), rootReal)) {
      return keep(base, `outside-root: ${e.worktree} is not under ${wtRoot}`);
    }
    if (e.locked) return keep(base, 'git-locked: the worktree is marked locked');
    if (!refExists(`refs/heads/${branch}`)) return keep(base, `branch-missing: ${branch}`);
    const epicReason = epicVerdict(epic, prefix);
    if (epicReason !== null) return keep(base, epicReason);
    const targets =
      task === 'integration'
        ? defaultTargets
        : [`refs/heads/${prefix}/${epic}/integration`, ...defaultTargets];
    if (firstMerged(branch, targets) === null) {
      return keep(base, `not-merged: ${branch} is not an ancestor of ${targets.join(', ')}`);
    }
    const lock = heavyVerdict(tryReal(e.worktree));
    if (lock !== null) return keep(base, lock);
    let gitDir: string;
    try {
      gitDir = g(e.worktree, ['rev-parse', '--absolute-git-dir']);
      lstat(path.join(gitDir, 'index.lock'));
      return keep(base, `index-lock: ${path.join(gitDir, 'index.lock')} exists`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return keep(base, `unreadable: git dir of ${e.worktree}`);
      }
      gitDir = g(e.worktree, ['rev-parse', '--absolute-git-dir']);
    }
    try {
      if (g(e.worktree, ['status', '--porcelain']) !== '')
        return keep(base, 'dirty: uncommitted changes');
    } catch (err) {
      return keep(base, `unreadable: git status failed: ${msg(err)}`);
    }
    const busy = activity(branch, gitDir, tryReal(e.worktree));
    if (busy !== null) return keep(base, busy);
    const into = firstMerged(branch, targets);
    return { item: { ...base, action: 'remove', reason: `merged into ${into}` }, targets };
  };

  const judgeBranch = (branch: string, m: RegExpMatchArray): Entry => {
    const [, prefix = '', epic = '', task = ''] = m;
    const base = { kind: 'branch' as const, branch };
    if (branch.includes(HARNESS_MARK)) return keep(base, HARNESS_MARK);
    const epicReason = epicVerdict(epic, prefix);
    if (epicReason !== null) return keep(base, epicReason);
    const targets =
      task === 'integration'
        ? defaultTargets
        : [`refs/heads/${prefix}/${epic}/integration`, ...defaultTargets];
    const into = firstMerged(branch, targets);
    if (into === null)
      return keep(base, `not-merged: ${branch} is not an ancestor of ${targets.join(', ')}`);
    const busy = activity(branch, null, null);
    if (busy !== null) return keep(base, busy);
    return { item: { ...base, action: 'remove', reason: `merged into ${into}` }, targets };
  };

  const judgeDirectory = (name: string, commonDir: string): Entry => {
    const p = path.join(wtRoot, name);
    const base = { kind: 'directory' as const, path: p };
    let st: FsStat;
    try {
      st = lstat(p);
    } catch {
      return keep(base, `unreadable: ${p}`);
    }
    if (st.isSymbolicLink) return keep(base, `symlink: ${p} is a symlink and is never followed`);
    if (!st.isDirectory) return keep(base, `not-a-directory: ${p}`);
    const real = tryReal(p);
    if (rootReal === null || !isInside(real, rootReal)) return keep(base, `outside-root: ${p}`);
    if (name.includes(HARNESS_MARK)) return keep(base, HARNESS_MARK);
    try {
      const dotGit = lstat(path.join(p, '.git'));
      if (dotGit.isDirectory)
        return keep(base, `independent-repo: ${p} holds its own .git directory`);
      const text = readFileSync(path.join(p, '.git'), 'utf8');
      const pointed = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
      const target = pointed === undefined ? null : path.resolve(p, pointed);
      const ours = [commonDir, tryReal(commonDir)].map((c) => path.join(c, 'worktrees') + path.sep);
      if (
        target === null ||
        !ours.some((c) => target.startsWith(c) || tryReal(target).startsWith(c))
      ) {
        return keep(base, `foreign-git: the .git file in ${p} does not point into this project`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return keep(base, `unreadable: ${p}`);
    }
    const lock = heavyVerdict(real);
    if (lock !== null) return keep(base, lock);
    const busy = activity(null, null, real);
    if (busy !== null) return keep(base, busy);
    return o.platform === undefined && process.platform !== 'darwin'
      ? {
          item: {
            ...base,
            action: 'manual',
            reason: 'orphan: not registered with git; remove it by hand',
          },
          targets: [],
        }
      : (o.platform ?? process.platform) === 'darwin'
        ? {
            item: { ...base, action: 'trash', reason: 'orphan: not registered with git' },
            targets: [],
          }
        : {
            item: {
              ...base,
              action: 'manual',
              reason: 'orphan: not registered with git; remove it by hand',
            },
            targets: [],
          };
  };

  const porcelain = parseWorktreePorcelain(g(projectDir, ['worktree', 'list', '--porcelain']));
  const inEpic = (m: RegExpMatchArray) => o.epicId === undefined || m[2] === o.epicId;

  for (const e of porcelain.slice(1)) {
    if (e.prunable || e.branch === null) continue;
    const m = BRANCH_RE.exec(e.branch);
    if (m && inEpic(m)) entries.push(judgeWorktree(e, m));
  }

  const checkedOut = new Set(porcelain.map((e) => e.branch));
  const refs = g(projectDir, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads/bs/',
    'refs/heads/smith/',
  ]);
  for (const branch of refs.split('\n').filter((b) => b !== '')) {
    const m = BRANCH_RE.exec(branch);
    if (m && inEpic(m) && !checkedOut.has(branch)) entries.push(judgeBranch(branch, m));
  }

  if (rootReal !== null) {
    const registered = new Set(porcelain.map((e) => tryReal(e.worktree)));
    const commonDir = g(projectDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    let names: string[] = [];
    try {
      names = readdir(wtRoot);
    } catch (err) {
      warnings.push(`could not read ${wtRoot}: ${msg(err)}`);
    }
    for (const name of names) {
      if (!registered.has(tryReal(path.join(wtRoot, name))))
        entries.push(judgeDirectory(name, commonDir));
    }
  }

  const prunable = porcelain.filter((e) => e.prunable).length;
  if (prunable > 0) {
    entries.push({
      item: {
        kind: 'prune',
        action: 'prune',
        reason: `${prunable} registered worktree(s) whose checkout is gone`,
      },
      targets: [],
    });
  }

  return { entries, warnings, projectDir, git: g, firstMerged };
}

/**
 * Build the cleanup report without changing anything. Serves epic bs-optimize
 * criterion 14 (every safety rule is evaluated here; `runCleanup` acts on the
 * plan it builds in the same run).
 */
export async function planCleanup(o: CleanupOptions): Promise<CleanupReport> {
  const plan = await buildPlan(o);
  return { items: plan.entries.map((e) => e.item), warnings: plan.warnings };
}

/**
 * Plan, and with `apply` act on that plan in the same run. The only deletions
 * are `git worktree remove` (no force), `git branch -d`, `git worktree prune`
 * and the trash command; each branch deletion and worktree removal is preceded
 * by a fresh `merge-base --is-ancestor` gate. Serves epic bs-optimize
 * criterion 14.
 */
export async function runCleanup(o: CleanupOptions): Promise<CleanupReport> {
  const plan = await buildPlan(o);
  if (o.apply === true) {
    const trash = o.trash ?? defaultTrash;
    for (const { item, targets } of plan.entries) {
      if (item.action === 'prune') {
        attempt(item, 'prune-failed', () => plan.git(plan.projectDir, ['worktree', 'prune']));
      } else if (item.action === 'trash') {
        attempt(item, 'trash-failed', () => trash(item.path as string));
      } else if (item.action === 'remove') {
        applyRemoval(plan, item, targets);
      }
    }
  }
  return { items: plan.entries.map((e) => e.item), warnings: plan.warnings };
}

function attempt(item: CleanupItem, rule: string, fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (err) {
    item.action = 'keep';
    item.reason = `${rule}: ${msg(err)}`;
    return false;
  }
}

/** Gate, `worktree remove`, gate again, `branch -d`; any failure keeps the item. */
function applyRemoval(plan: Plan, item: CleanupItem, targets: string[]): void {
  const branch = item.branch as string;
  const gate = (): boolean => {
    if (plan.firstMerged(branch, targets) !== null) return true;
    item.action = 'keep';
    item.reason = `not-merged: ${branch} is not an ancestor of ${targets.join(', ')} at removal time`;
    return false;
  };
  if (!gate()) return;
  if (item.kind === 'worktree') {
    const removed = attempt(item, 'worktree-remove-refused', () =>
      plan.git(plan.projectDir, ['worktree', 'remove', item.path as string]),
    );
    if (!removed || !gate()) return;
  }
  attempt(item, 'branch-delete-refused', () => plan.git(plan.projectDir, ['branch', '-d', branch]));
}
