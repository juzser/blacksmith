import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';
import { COMMANDS, flagSpecFor } from '../src/usage.js';

// ---------------------------------------------------------------------------
// D-191 says a verb that exists in code but is named in no governing document
// reaches no agent. This file asserts the converse, which bites harder: a verb
// a governing document names but the CLI does not ship reaches an agent and
// then fails in its hands, mid-run, with the operator watching.
//
// `.claude/skills/bs/SKILL.md` shipped exactly that defect — it told a session
// to read `smith dispatch audit`, a verb that has never existed, because the
// module implementing `smith dispatch check` is called dispatchAudit.ts. Prose
// drifts toward the names of the things it describes. Nothing caught it,
// because nothing read the prose as a command line.
//
// So this reads it as one. Every `smith …` invocation in every backtick span
// and fenced block of the live instruction surface is parsed and resolved
// against the same COMMANDS table `--help` prints and the CLI parses with.
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  '.git',
  '.venv',
  'coverage',
  'dist',
  'node_modules',
  'test-results',
  'worktrees',
]);

/**
 * What the guard deliberately does not read, and why.
 *
 * Both exclusions are records of the past, where a verb that no longer exists
 * is the point rather than the defect:
 *
 * - `docs/specs/` holds dogfood findings and closed punch lists. Several quote
 *   a command that never existed *as the finding* — rewriting them to name a
 *   live verb would delete the evidence.
 * - `CHANGELOG.md` states what a release shipped. When a verb is renamed, the
 *   entry that shipped the old name stays true about the old name forever.
 *
 * Everything else is in by default, including files added tomorrow. An
 * allowlist would let a new document escape the guard by being new, which is
 * the direction drift actually travels.
 */
const NOT_INSTRUCTIONS: readonly string[] = ['CHANGELOG.md', 'docs/specs'];

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) markdownFiles(full, out);
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

function instructionFiles(): string[] {
  return markdownFiles(REPO_ROOT)
    .map((full) => path.relative(REPO_ROOT, full))
    .filter((rel) => !NOT_INSTRUCTIONS.some((skip) => rel === skip || rel.startsWith(`${skip}/`)));
}

/**
 * The stand-in for an escaped pipe while alternatives are carried through the
 * parse. Two colons cannot occur inside a command word, so nothing else in a
 * command line can be mistaken for one.
 */
const ALT = '::';

interface CodeSpan {
  readonly line: number;
  readonly text: string;
}

/**
 * The code in a markdown file, one entry per source line.
 *
 * Line-anchored on purpose. An earlier cut of this scanner let a fenced block
 * be one long string, and a command at the end of a line happily swallowed the
 * flags on the next one — inventing invocations that appear nowhere and then
 * reporting them as defects. A shell line ends at the newline unless it says
 * otherwise with a trailing backslash, which is the one case joined here.
 */
function codeSpans(markdown: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  let fenced = false;
  let continued: { line: number; text: string } | null = null;
  markdown.split('\n').forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continued = null;
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
    for (const match of line.matchAll(/`([^`]+)`/g))
      spans.push({ line: index + 1, text: match[1] as string });
  });
  return spans;
}

/** A token that ends the command line rather than belonging to it. */
const SHELL_OPERATORS = new Set(['|', '||', '&&', ';', '<', '>', '>>', '&', '#', '2>&1']);

interface Invocation {
  readonly line: number;
  /** Non-flag words after `smith`, in order, before the first flag. At most two. */
  readonly words: readonly string[];
  /** Flag names as written, without the dashes and without any `=value`. */
  readonly flags: readonly string[];
}

/**
 * Every `smith …` command line in one markdown file.
 *
 * Two markdown-specific shapes are handled rather than reported:
 *
 * - An escaped pipe is a literal pipe inside a table cell, and a table cell is
 *   where the command families get written as one row: a cell reading
 *   `smith daemon run|start|stop` names three commands, not a shell pipeline.
 *   Each alternative becomes its own invocation so all three get checked.
 * - Brackets and trailing punctuation come from prose, not from argv. A
 *   sentence ending in `smith plan validate <path>.` still names a real command.
 */
function parseInvocations(markdown: string): Invocation[] {
  const found: Invocation[] = [];
  const wordLike = new RegExp(`^[a-z][a-z0-9-]*(${ALT}[a-z][a-z0-9-]*)*$`);
  for (const span of codeSpans(markdown)) {
    const text = span.text.replaceAll('\\|', ALT);
    for (const match of text.matchAll(/(?:^|[\s(;&$])smith(?=[ \t])/g)) {
      const words: string[] = [];
      const flags: string[] = [];
      for (const raw of text.slice(match.index + match[0].length).split(/[ \t]+/)) {
        if (raw === '') continue;
        if (SHELL_OPERATORS.has(raw)) break;
        const token = raw.replace(/^[[(]+/, '').replace(/[\]),.`]+$/, '');
        if (token === '') continue;
        if (token.startsWith('--')) {
          flags.push(token.slice(2).split('=')[0] as string);
          continue;
        }
        if (token.startsWith('-')) continue;
        if (flags.length === 0 && words.length < 2 && wordLike.test(token)) words.push(token);
      }
      for (const expanded of expand(words)) found.push({ line: span.line, words: expanded, flags });
    }
  }
  return found;
}

/** One invocation per alternative: a cell naming `run|start` becomes two. */
function expand(words: readonly string[]): string[][] {
  return words.reduce<string[][]>(
    (rows, word) => rows.flatMap((row) => word.split(ALT).map((one) => [...row, one])),
    [[]],
  );
}

const NAMESPACES = new Set(COMMANDS.map((doc) => doc.command.split(' ')[0] as string));
const COMMAND_KEYS = new Set(COMMANDS.map((doc) => doc.command));

interface Problem {
  readonly where: string;
  readonly wrote: string;
  readonly reason: string;
}

/**
 * Resolve one parsed invocation against the shipped command table.
 *
 * A bare namespace with nothing after it — "the `smith epic` verbs" — names a
 * family, not an invocation, and passes. Anything with an action is held to
 * the table, flags included.
 */
function problemsWith(invocation: Invocation, where: string): Problem[] {
  const [namespace, next] = invocation.words;
  if (namespace === undefined) return [];
  const wrote = ['smith', ...invocation.words].join(' ');
  if (!NAMESPACES.has(namespace))
    return [{ where, wrote, reason: `"${namespace}" is not a namespace the CLI declares` }];

  let action: string | undefined;
  if (next !== undefined && COMMAND_KEYS.has(`${namespace} ${next}`)) action = next;
  else if (COMMAND_KEYS.has(namespace)) action = undefined;
  else if (next !== undefined)
    return [{ where, wrote, reason: `"${namespace}" declares no "${next}" action` }];
  else return [];

  const spec = flagSpecFor(namespace, action);
  if (spec === undefined)
    return [{ where, wrote, reason: 'no usage entry documents this command' }];
  return invocation.flags
    .filter((flag) => !spec.has(flag))
    .map((flag) => ({
      where,
      wrote: `${wrote} --${flag}`,
      reason: 'no such flag on this command',
    }));
}

const SURFACE = instructionFiles().map((rel) => ({
  rel,
  invocations: parseInvocations(readFileSync(path.join(REPO_ROOT, rel), 'utf8')),
}));

describe('parseInvocations', () => {
  // Pinned against a fixture rather than the repo, so a change to the repo's
  // prose can never quietly relax the parser it is being checked by.
  const fixture = [
    'Run `smith plan validate <path>`, or `smith daemon run\\|start\\|stop`.',
    '',
    '```bash',
    'smith epic goal-check --epic demo \\',
    '  --plan plan.json --checked-by spec-reviewer',
    'smith stats overview | jq .commands',
    'smith event tail --task T1 > /tmp/tail.json',
    '```',
    '',
    'The `smith epic` verbs are listed above.',
  ].join('\n');

  it('reads inline spans, fenced blocks, continuations and table alternatives', () => {
    expect(parseInvocations(fixture)).toEqual([
      // `<path>` is a positional, never a word: only the verb is checked.
      { line: 1, words: ['plan', 'validate'], flags: [] },
      { line: 1, words: ['daemon', 'run'], flags: [] },
      { line: 1, words: ['daemon', 'start'], flags: [] },
      { line: 1, words: ['daemon', 'stop'], flags: [] },
      { line: 4, words: ['epic', 'goal-check'], flags: ['epic', 'plan', 'checked-by'] },
      { line: 6, words: ['stats', 'overview'], flags: [] },
      { line: 7, words: ['event', 'tail'], flags: ['task'] },
      { line: 10, words: ['epic'], flags: [] },
    ]);
  });

  it('stops a command at the newline, not at the flags on the next line', () => {
    const twoLines = ['```bash', 'smith daemon start', 'smith worktree fingerprint w', '```'].join(
      '\n',
    );
    expect(parseInvocations(twoLines).map((one) => one.words.join(' '))).toEqual([
      'daemon start',
      'worktree fingerprint',
    ]);
  });
});

describe('the documented smith commands are the shipped smith commands', () => {
  it('names only commands and flags the CLI declares', () => {
    const problems = SURFACE.flatMap(({ rel, invocations }) =>
      invocations.flatMap((invocation) => problemsWith(invocation, `${rel}:${invocation.line}`)),
    );
    expect(
      problems.map((problem) => `${problem.where}  ${problem.wrote}  — ${problem.reason}`),
      'a document told an agent to run a command that does not exist',
    ).toEqual([]);
  });

  it('actually read the instruction surface', () => {
    // A parser that silently matches nothing passes the check above forever.
    // The floor sits well under today's count and the named files are the ones
    // an agent is dispatched with, so this fails on a scanner that breaks
    // rather than on prose that gets edited.
    const total = SURFACE.reduce((sum, file) => sum + file.invocations.length, 0);
    expect(total).toBeGreaterThan(150);
    for (const rel of ['.claude/skills/bs/SKILL.md', 'AGENTS.md', 'docs/guide/operator-loop.md']) {
      const file = SURFACE.find((entry) => entry.rel === rel);
      expect(file?.invocations.length ?? 0, `${rel} contributed no invocations`).toBeGreaterThan(0);
    }
  });

  it('excludes the records of the past, and nothing else', () => {
    const read = new Set(SURFACE.map((file) => file.rel));
    expect(read.has('.claude/agents/spec-reviewer.md')).toBe(true);
    expect(read.has('factory/specs/roadmap.md')).toBe(true);
    for (const rel of ['CHANGELOG.md', 'docs/specs/dogfood-4-findings.md'])
      expect(read.has(rel), `${rel} is a record, not an instruction`).toBe(false);
  });
});
