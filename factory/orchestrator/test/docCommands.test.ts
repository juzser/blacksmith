import { readdirSync, readFileSync } from 'node:fs';
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

/** Directories that hold no instructions at any depth. */
const SKIP_DIRS = new Set(['.git', '.venv', 'coverage', 'dist', 'node_modules', 'test-results']);

/**
 * Runtime output, matched as a repo-relative prefix rather than a bare
 * directory name — AGENTS.md's "declarations vs state" rule names exactly
 * these three.
 *
 * A name-matched entry cannot express it. A task worktree lives at
 * `<project-parent>/.wt/<project>/<task-id>` (`worktree.ts` `worktreePath`), so a
 * `SKIP_DIRS` entry reading `worktrees` matches nothing and a dogfooded epic
 * drops N complete second checkouts into the walk — each with its own
 * mid-edit copy of these very documents. One stale worktree on disk would
 * then fail this file on main, for everyone, pointing at a gitignored path
 * nobody hand-edited.
 */
const RUNTIME_PATHS = ['state', 'workspaces', '.agents/generated'];

/**
 * Records of the past, where a verb that no longer exists is the point rather
 * than the defect: dogfood findings quote a command that never existed *as*
 * the finding, and the changelog entry that shipped a since-renamed verb stays
 * true about the old name forever.
 *
 * Matched by shape, not by a list of today's filenames, so tomorrow's dogfood
 * record is excluded the day it is written. Note what is *not* here:
 * `docs/specs/` as a directory. AGENTS.md's "Read on demand" table routes
 * agents into three files under it — the architecture spec and the two
 * interview specs — and a verb rename that misses those reaches an agent
 * exactly the way D-259 reached step 14.
 */
function recordOfThePast(rel: string): boolean {
  return (
    rel === 'CHANGELOG.md' ||
    rel.startsWith('docs/specs/dogfood-') ||
    rel.startsWith('docs/specs/evidence/') ||
    rel.endsWith('punch-list.md')
  );
}

/** Why a markdown file is not read, or undefined when it is. */
function excludedBecause(rel: string): string | undefined {
  if (RUNTIME_PATHS.some((dir) => rel === dir || rel.startsWith(`${dir}/`))) return 'runtime state';
  if (recordOfThePast(rel)) return 'record of the past';
  return undefined;
}

/**
 * Every markdown file under a directory.
 *
 * `withFileTypes` rather than a `statSync` per entry, matching the walker in
 * `test/helpers/eventTypeScan.ts`: `Dirent.isDirectory()` is false for a
 * symlink, so a pnpm workspace link or a dangling worktree symlink is stepped
 * over instead of followed into a cycle or thrown on as ENOENT.
 */
function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) markdownFiles(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function instructionFiles(): string[] {
  return markdownFiles(REPO_ROOT)
    .map((full) => path.relative(REPO_ROOT, full))
    .filter((rel) => excludedBecause(rel) === undefined);
}

/**
 * The stand-in for an alternation pipe while alternatives are carried through
 * the parse. Two colons cannot occur inside a command word, so nothing else in
 * a command line can be mistaken for one.
 */
const ALT = '::';

/**
 * An *unescaped* pipe naming alternatives rather than piping. A table cell has
 * to write `\|`, so that spelling is unambiguous, but prose is free to write
 * `approve|reject` and does. Spacing is what separates the two readings, and
 * the corpus is consistent about it: every unspaced pipe in the instruction
 * files names a family (`smith mcp init|check`), and every shell pipe is
 * written with spaces around it (`smith stats overview | jq .commands`), where
 * the standalone token ends the command line instead. Without this the family
 * line reads as one action named "init|check", and the guard reports the
 * document rather than the drift.
 */
const ALTERNATION = /(?<=\S)\|(?=\S)/g;

interface CodeSpan {
  readonly line: number;
  readonly text: string;
}

/**
 * The code in a markdown file: one span per fenced line, one per inline
 * backtick span.
 *
 * Fenced code is line-anchored on purpose. An earlier cut of this scanner let
 * a fenced block be one long string, and a command at the end of a line
 * happily swallowed the flags on the next one — inventing invocations that
 * appear nowhere and then reporting them as defects. A shell line ends at the
 * newline unless it says otherwise with a trailing backslash, which is the one
 * case joined here; a block whose last line carries one is flushed at the
 * closing fence rather than dropped.
 *
 * Inline spans are the opposite problem. Markdown hard-wraps prose, so a span
 * is regularly written across two source lines, and scanning line by line sees
 * neither half — 37 real invocations today, 17 of them in the file D-259 was
 * found in. So inline spans are matched per paragraph rather than per line.
 * Per paragraph, and not over the whole run of non-fenced text, because
 * markdown ends inline code at a blank line: a stray unpaired backtick then
 * costs its own paragraph rather than pairing with a backtick pages later and
 * swallowing every span between.
 */
function codeSpans(markdown: string): CodeSpan[] {
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

/** A token that ends the command line rather than belonging to it. */
const SHELL_OPERATORS = new Set(['|', '||', '&&', ';', '<', '>', '>>', '&', '#', '2>&1']);

/**
 * How a command line starts.
 *
 * Two spellings, because the docs have two. `smith` is the linked shim, and
 * `node <path>/cli.js` is what `docs/guide/operator-guide.md` declares
 * canonical for every one of its examples — necessarily, since the pre-install
 * docs run before the shim exists. Anchoring on `smith` alone leaves the
 * documents a new operator follows first outside the guard.
 */
const INVOKED = /(?:^|[\s(;&$])(?:smith|node[ \t]+\S*cli\.js)(?=[ \t])/g;

interface Invocation {
  readonly line: number;
  /** Non-flag words after the command, in order, before the first flag. At most two. */
  readonly words: readonly string[];
  /** Flag names as written, without the dashes and without any `=value`. */
  readonly flags: readonly string[];
}

/** A slot the reader is meant to fill in, never a verb. */
function isPlaceholder(token: string): boolean {
  return (
    token === '' ||
    token === '...' ||
    token === '…' ||
    /^[<{$]/.test(token) ||
    token.includes('/') ||
    token.includes('.')
  );
}

/**
 * Every command line in one markdown file.
 *
 * Two markdown-specific shapes are handled rather than reported:
 *
 * - An escaped pipe is a literal pipe inside a table cell, and a table cell is
 *   where the command families get written as one row: a cell reading
 *   `smith daemon run|start|stop` names three commands, not a shell pipeline.
 *   Each alternative becomes its own invocation so all three get checked, and
 *   the same holds for a cell naming two flags — `--json|--yaml` is two flag
 *   names, not one flag called `json::--yaml`.
 * - Brackets and trailing punctuation come from prose, not from argv. A
 *   sentence ending in `smith plan validate <path>.` still names a real command.
 *
 * A word that is neither a placeholder nor a flag is kept even when it looks
 * nothing like a verb, because dropping it is how `smith stats Overview`
 * quietly degraded into a clean mention of the `stats` family. Whether it is a
 * real action is `problemsWith`'s question, not the parser's.
 */
function parseInvocations(markdown: string): Invocation[] {
  const found: Invocation[] = [];
  for (const span of codeSpans(markdown)) {
    const text = span.text.replaceAll('\\|', ALT).replace(ALTERNATION, ALT);
    for (const match of text.matchAll(INVOKED)) {
      const words: string[] = [];
      const flags: string[] = [];
      for (const raw of text.slice(match.index + match[0].length).split(/[ \t]+/)) {
        if (raw === '') continue;
        if (SHELL_OPERATORS.has(raw)) break;
        const token = raw.replace(/^[[(]+/, '').replace(/[\]),.`]+$/, '');
        if (token.startsWith('--')) {
          for (const alternative of token.split(ALT))
            flags.push(alternative.replace(/^-+/, '').split('=')[0] as string);
          continue;
        }
        if (token.startsWith('-')) continue;
        if (isPlaceholder(token)) continue;
        if (flags.length === 0 && words.length < 2) words.push(token);
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

/** Namespace to the actions declared under it, empty for an action-less verb. */
const ACTIONS_OF = new Map<string, Set<string>>();
for (const doc of COMMANDS) {
  const [namespace, action] = doc.command.split(' ');
  if (namespace === undefined) continue;
  const actions = ACTIONS_OF.get(namespace) ?? new Set<string>();
  if (action !== undefined) actions.add(action);
  ACTIONS_OF.set(namespace, actions);
}

const POSITIONALS_OF = new Map(COMMANDS.map((doc) => [doc.command, doc.positionals ?? '']));

/**
 * The flags legal on *some* command of a namespace.
 *
 * A document that names a family rather than a command — "pass `--json` to
 * `smith epic`" — still names a flag, and resolving it against nothing is how
 * `smith epic --bogus-flag` read clean. The union is the most this can honestly
 * assert without deciding which command the sentence meant.
 */
function familyFlags(namespace: string): Set<string> {
  const union = new Set<string>();
  const actions = ACTIONS_OF.get(namespace) ?? new Set<string>();
  const specs = [
    ...(COMMAND_KEYS.has(namespace) ? [flagSpecFor(namespace, undefined)] : []),
    ...[...actions].map((action) => flagSpecFor(namespace, action)),
  ];
  for (const spec of specs) for (const flag of spec?.keys() ?? []) union.add(flag);
  return union;
}

interface Problem {
  readonly where: string;
  readonly wrote: string;
  readonly reason: string;
}

/**
 * Resolve one parsed invocation against the shipped command table.
 *
 * A bare namespace with nothing after it — "the `smith epic` verbs" — names a
 * family, not an invocation, and passes on its words. Anything with a second
 * word is held to the table: either it is a declared action, or it is the
 * positional an action-less verb declares, or it is a defect. `smith new
 * my-project` is the first case in that middle branch; `smith dream nonsense`
 * is not, because `dream` declares no positional to spend the slot on.
 */
function problemsWith(invocation: Invocation, where: string): Problem[] {
  const [namespace, next] = invocation.words;
  if (namespace === undefined) return [];
  const wrote = ['smith', ...invocation.words].join(' ');
  if (!NAMESPACES.has(namespace))
    return [{ where, wrote, reason: `"${namespace}" is not a namespace the CLI declares` }];

  const actions = ACTIONS_OF.get(namespace) ?? new Set<string>();
  const bare = COMMAND_KEYS.has(namespace);
  let action: string | undefined;

  if (next !== undefined) {
    if (actions.has(next)) action = next;
    else if (bare && (POSITIONALS_OF.get(namespace) ?? '') !== '') action = undefined;
    else if (bare)
      return [
        {
          where,
          wrote,
          reason: `"${namespace}" takes no argument and declares no "${next}" action`,
        },
      ];
    else return [{ where, wrote, reason: `"${namespace}" declares no "${next}" action` }];
  } else if (!bare) {
    return invocation.flags
      .filter((flag) => !familyFlags(namespace).has(flag))
      .map((flag) => ({
        where,
        wrote: `${wrote} --${flag}`,
        reason: 'no such flag in this family',
      }));
  }

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

interface SurfaceFile {
  readonly rel: string;
  readonly invocations: readonly Invocation[];
}

/**
 * Read lazily, not at module load. The walk touches the whole repo, and a
 * top-level `const` that throws takes the parser's own fixture tests down with
 * it — a stack trace naming readdirSync instead of one red assertion.
 */
let cached: SurfaceFile[] | undefined;
function surface(): SurfaceFile[] {
  cached ??= instructionFiles().map((rel) => ({
    rel,
    invocations: parseInvocations(readFileSync(path.join(REPO_ROOT, rel), 'utf8')),
  }));
  return cached;
}

describe('parseInvocations', () => {
  // Pinned against fixtures rather than the repo, so a change to the repo's
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

  it('reads a span that markdown hard-wrapped across two source lines', () => {
    // The shape 10% of this repo's invocations are written in, and the shape
    // an earlier line-anchored cut of this scanner could not see at all.
    const wrapped = [
      'Dispatch it, then read `smith dispatch',
      'check --json` before closing.',
    ].join('\n');
    expect(parseInvocations(wrapped)).toEqual([
      { line: 1, words: ['dispatch', 'check'], flags: ['json'] },
    ]);
  });

  it('ends an inline span at a blank line, so a stray backtick costs one paragraph', () => {
    const stray = ['An unpaired ` backtick.', '', 'Then `smith epic close` runs.'].join('\n');
    expect(parseInvocations(stray)).toEqual([{ line: 3, words: ['epic', 'close'], flags: [] }]);
  });

  it('flushes a continuation the closing fence would otherwise drop', () => {
    const dangling = ['```bash', 'smith dispatch check \\', '```'].join('\n');
    expect(parseInvocations(dangling)).toEqual([
      { line: 2, words: ['dispatch', 'check'], flags: [] },
    ]);
  });

  it('reads the node …/cli.js spelling the pre-install docs are written in', () => {
    const preInstall = '`node factory/orchestrator/dist/cli.js stack check --json`';
    expect(parseInvocations(preInstall)).toEqual([
      { line: 1, words: ['stack', 'check'], flags: ['json'] },
    ]);
  });

  it('splits an alternation of flags, not just of words', () => {
    expect(parseInvocations('`smith stats overview --json\\|--pretty`')).toEqual([
      { line: 1, words: ['stats', 'overview'], flags: ['json', 'pretty'] },
    ]);
  });

  it('reads an unescaped pipe as alternation when unspaced, as a pipeline when not', () => {
    // Only a table cell has to escape the pipe, and prose does not bother:
    // `docs/guide/operator-loop.md` and `factory/specs/roadmap.md` both name a
    // family with a bare one. Read as a single action, those two lines are
    // reported as commands the CLI does not ship — the guard's own false alarm,
    // and the fastest way to teach an operator to ignore it.
    expect(parseInvocations('`smith lessons approve|reject`')).toEqual([
      { line: 1, words: ['lessons', 'approve'], flags: [] },
      { line: 1, words: ['lessons', 'reject'], flags: [] },
    ]);
    // The spacing carries the other reading, and nothing after the pipe is
    // this CLI's to answer for.
    expect(parseInvocations('`smith stats overview | jq .commands`')).toEqual([
      { line: 1, words: ['stats', 'overview'], flags: [] },
    ]);
  });

  it('keeps a word that looks nothing like a verb, and drops only placeholders', () => {
    // Dropping it is how `smith stats Overview` degraded into a clean mention
    // of the `stats` family. Judging it is problemsWith's job.
    expect(parseInvocations('`smith stats Overview`')[0]?.words).toEqual(['stats', 'Overview']);
    expect(parseInvocations('`smith epic goal --epic <epic-id>`')[0]?.words).toEqual([
      'epic',
      'goal',
    ]);
    expect(parseInvocations('`smith plan validate $PLAN`')[0]?.words).toEqual(['plan', 'validate']);
  });
});

describe('problemsWith', () => {
  const reasons = (markdown: string): string[] =>
    parseInvocations(markdown).flatMap((invocation) =>
      problemsWith(invocation, 'fixture').map((problem) => problem.reason),
    );

  it('reports an action the namespace does not declare, whatever its shape', () => {
    expect(reasons('`smith dispatch audit`')).toEqual(['"dispatch" declares no "audit" action']);
    expect(reasons('`smith stats Overview`')).toEqual(['"stats" declares no "Overview" action']);
  });

  it('spends the second slot on a positional only where one is declared', () => {
    // `new` documents `<project>`; `dream` documents nothing, so a word after
    // it is a typo the CLI would refuse.
    expect(reasons('`smith new my-project`')).toEqual([]);
    expect(reasons('`smith dream nonsense`')).toEqual([
      '"dream" takes no argument and declares no "nonsense" action',
    ]);
  });

  it('checks flags on a family mention against the flags of that family', () => {
    expect(reasons('`smith epic --bogus-flag`')).toEqual(['no such flag in this family']);
    expect(reasons('`smith epic --epic <id>`')).toEqual([]);
  });

  it('passes a namespace named on its own', () => {
    expect(reasons('The `smith epic` verbs are listed above.')).toEqual([]);
  });
});

describe('the documented smith commands are the shipped smith commands', () => {
  it('names only commands and flags the CLI declares', () => {
    const problems = surface().flatMap(({ rel, invocations }) =>
      invocations.flatMap((invocation) => problemsWith(invocation, `${rel}:${invocation.line}`)),
    );
    expect(
      problems.map((problem) => `${problem.where}  ${problem.wrote}  — ${problem.reason}`),
      'a document told an agent to run a command that does not exist',
    ).toEqual([]);
  });

  it('actually resolved the instruction surface', () => {
    // A parser that silently matches nothing passes the check above forever,
    // and so does one that matches spans but extracts no words from them — the
    // floor counts invocations that reached a namespace, not spans that
    // matched. The floor sits well under today's count and the named files are
    // the ones an agent is dispatched with, so this fails on a scanner that
    // breaks rather than on prose that gets edited.
    const resolved = surface().flatMap((file) =>
      file.invocations.filter((invocation) => invocation.words.length > 0),
    );
    expect(resolved.length).toBeGreaterThan(150);
    for (const rel of ['.claude/skills/bs/SKILL.md', 'AGENTS.md', 'docs/guide/operator-loop.md']) {
      const file = surface().find((entry) => entry.rel === rel);
      const count = file?.invocations.filter((one) => one.words.length > 0).length ?? 0;
      expect(count, `${rel} contributed no resolved invocations`).toBeGreaterThan(0);
    }
  });

  it('excludes runtime state and the records of the past, and nothing else', () => {
    // The exclusion rule itself, not a sample of its output. Silencing a noisy
    // failure by widening it — `docs/specs`, `.claude` — deletes a governing
    // document from the surface, and a test that only spot-checks four paths
    // stays green while it happens.
    expect(excludedBecause('state/events/x.md')).toBe('runtime state');
    expect(excludedBecause('workspaces/.wt/blacksmith/epic-1-task-2/AGENTS.md')).toBe(
      'runtime state',
    );
    expect(excludedBecause('.agents/generated/roles.md')).toBe('runtime state');
    expect(excludedBecause('CHANGELOG.md')).toBe('record of the past');
    expect(excludedBecause('docs/specs/dogfood-4-findings.md')).toBe('record of the past');
    expect(excludedBecause('docs/specs/phase-9-punch-list.md')).toBe('record of the past');

    for (const rel of [
      'AGENTS.md',
      'INSTALL.md',
      '.claude/agents/spec-reviewer.md',
      'factory/specs/roadmap.md',
      // AGENTS.md's "Read on demand" table routes agents into these three. A
      // rename that misses them reaches an agent exactly as D-259 did.
      'docs/specs/black-smith-architecture.md',
      'docs/specs/black-smith-interview.md',
      'docs/specs/agent-interviews.md',
    ])
      expect(excludedBecause(rel), `${rel} is an instruction`).toBeUndefined();

    const read = new Set(surface().map((file) => file.rel));
    for (const rel of ['AGENTS.md', 'docs/specs/black-smith-architecture.md'])
      expect(read.has(rel), `${rel} was not read`).toBe(true);
  });
});
