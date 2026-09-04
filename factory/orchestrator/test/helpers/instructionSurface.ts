/**
 * The live instruction surface: which markdown a guard is allowed to hold the
 * repo to, and where the code inside it starts and stops.
 *
 * Extracted from `docCommands.test.ts` when a second guard (D-265) needed the
 * same answer. Two copies of "which documents govern an agent" is two answers
 * to that question the day one of them gains a `SKIP_DIRS` entry the other
 * does not -- and the whole value of these guards is that they read the same
 * surface the dispatcher does.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../src/paths.js';

/** Directories that hold no instructions at any depth. */
export const SKIP_DIRS = new Set([
  '.git',
  '.venv',
  'coverage',
  'dist',
  'node_modules',
  'test-results',
]);

/**
 * Runtime output, matched as a repo-relative prefix rather than a bare
 * directory name -- AGENTS.md's "declarations vs state" rule names exactly
 * these three.
 *
 * A name-matched entry cannot express it. A task worktree lives at
 * `<project-parent>/.wt/<project>/<task-id>` (`worktree.ts` `worktreePath`), so a
 * `SKIP_DIRS` entry reading `worktrees` matches nothing and a dogfooded epic
 * drops N complete second checkouts into the walk -- each with its own
 * mid-edit copy of these very documents. One stale worktree on disk would
 * then fail this file on main, for everyone, pointing at a gitignored path
 * nobody hand-edited.
 */
export const RUNTIME_PATHS = ['state', 'workspaces', '.agents/generated'];

/**
 * Records of the past, where a name that no longer resolves is the point
 * rather than the defect: dogfood findings quote a command that never existed
 * *as* the finding, and the changelog entry that shipped a since-renamed verb
 * or a since-renamed error code stays true about the old name forever.
 *
 * Matched by shape, not by a list of today's filenames, so tomorrow's dogfood
 * record is excluded the day it is written. Note what is *not* here:
 * `docs/specs/` as a directory. AGENTS.md's "Read on demand" table routes
 * agents into three files under it -- the architecture spec and the two
 * interview specs -- and a rename that misses those reaches an agent exactly
 * the way D-259 reached step 14.
 */
export function recordOfThePast(rel: string): boolean {
  return (
    rel === 'CHANGELOG.md' ||
    rel.startsWith('docs/specs/dogfood-') ||
    rel.startsWith('docs/specs/evidence/') ||
    rel.endsWith('punch-list.md')
  );
}

/** Why a markdown file is not read, or undefined when it is. */
export function excludedBecause(rel: string): string | undefined {
  if (RUNTIME_PATHS.some((dir) => rel === dir || rel.startsWith(`${dir}/`))) return 'runtime state';
  if (recordOfThePast(rel)) return 'record of the past';
  return undefined;
}

/**
 * Every file under a directory whose name the caller keeps.
 *
 * `withFileTypes` rather than a `statSync` per entry, matching the walker in
 * `test/helpers/eventTypeScan.ts`: `Dirent.isDirectory()` is false for a
 * symlink, so a pnpm workspace link or a dangling worktree symlink is stepped
 * over instead of followed into a cycle or thrown on as ENOENT.
 */
export function filesUnder(
  dir: string,
  keep: (name: string) => boolean,
  out: string[] = [],
): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) filesUnder(full, keep, out);
      continue;
    }
    if (entry.isFile() && keep(entry.name)) out.push(full);
  }
  return out;
}

export function markdownFiles(dir: string, out: string[] = []): string[] {
  return filesUnder(dir, (name) => name.endsWith('.md'), out);
}

/** The repo-relative markdown that governs an agent, in walk order. */
export function instructionFiles(): string[] {
  return markdownFiles(REPO_ROOT)
    .map((full) => path.relative(REPO_ROOT, full))
    .filter((rel) => excludedBecause(rel) === undefined);
}

export interface CodeSpan {
  readonly line: number;
  readonly text: string;
}

/**
 * The code in a markdown file: one span per fenced line, one per inline
 * backtick span.
 *
 * Fenced code is line-anchored on purpose. An earlier cut of this scanner let
 * a fenced block be one long string, and a command at the end of a line
 * happily swallowed the flags on the next one -- inventing invocations that
 * appear nowhere and then reporting them as defects. A shell line ends at the
 * newline unless it says otherwise with a trailing backslash, which is the one
 * case joined here; a block whose last line carries one is flushed at the
 * closing fence rather than dropped.
 *
 * Inline spans are the opposite problem. Markdown hard-wraps prose, so a span
 * is regularly written across two source lines, and scanning line by line sees
 * neither half -- 37 real invocations today, 17 of them in the file D-259 was
 * found in. So inline spans are matched per paragraph rather than per line.
 * Per paragraph, and not over the whole run of non-fenced text, because
 * markdown ends inline code at a blank line: a stray unpaired backtick then
 * costs its own paragraph rather than pairing with a backtick pages later and
 * swallowing every span between.
 */
export function codeSpans(markdown: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  let fenced = false;
  let continued: { line: number; text: string } | null = null;
  let prose: { line: number; text: string }[] = [];

  const flushProse = (): void => {
    let paragraph: { line: number; text: string }[] = [];
    const emit = (): void => {
      const joined = paragraph.map((entry) => entry.text).join('\n');
      for (const match of joined.matchAll(/`([^`]+)`/g)) {
        const start = joined.slice(0, match.index).split('\n').length - 1;
        spans.push({
          line: paragraph[start]?.line ?? 1,
          text: (match[1] as string).replace(/\s+/g, ' ').trim(),
        });
      }
      paragraph = [];
    };
    for (const entry of prose) {
      if (entry.text.trim() === '') emit();
      else paragraph.push(entry);
    }
    emit();
    prose = [];
  };

  markdown.split('\n').forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      if (fenced) {
        if (continued) spans.push(continued);
        continued = null;
      } else flushProse();
      fenced = !fenced;
      return;
    }
    if (fenced) {
      const body = line.replace(/\\$/, '');
      if (continued) continued.text += ` ${body.trim()}`;
      else continued = { line: index + 1, text: body };
      if (!/\\$/.test(line)) {
        spans.push(continued);
        continued = null;
      }
      return;
    }
    prose.push({ line: index + 1, text: line });
  });
  flushProse();
  if (continued) spans.push(continued);
  return spans;
}
