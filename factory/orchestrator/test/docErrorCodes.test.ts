import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';
import { type ErrorCodeScan, raisedErrorCodes, scanErrorCodes } from './helpers/errorCodeScan.js';
import { codeSpans, instructionFiles } from './helpers/instructionSurface.js';

// ---------------------------------------------------------------------------
// `docCommands.test.ts` holds the documented verbs to the shipped verbs. This
// file holds the documented *failures* to the shipped ones.
//
// An error code is the only part of a failure an operator can act on. The
// guide's "Error code | What you actually did" tables, the runbooks, and the
// agent role files all name codes by hand, and a code is a string literal in
// one constructor call -- renameable by anyone, referenced by nothing the
// compiler checks. So a rename leaves the tables reading true and answering
// wrong: the operator greps the guide for the code the CLI just printed, finds
// nothing, and concludes the failure is undocumented rather than renamed.
//
// The failure mode is quieter than D-259's. A verb that does not exist fails
// immediately and loudly in an agent's hands. A code that does not exist fails
// only later, in a person's, while they are already debugging something else.
// ---------------------------------------------------------------------------

/**
 * Final segments that make a dotted token a filename rather than a code.
 *
 * Most error namespaces are named after the module that raises them, so
 * `lessons.ts`, `severity.yml` and `daemon.log` all read as `<namespace>.<x>`
 * and would otherwise be reported as codes nothing raises -- 29 of them today,
 * enough noise to make the guard worth ignoring. The extension is what tells
 * the two apart, and it is a closed set: prose names files with the extensions
 * this repo actually contains.
 */
const FILE_EXTENSIONS = new Set([
  'cjs',
  'css',
  'db',
  'env',
  'gz',
  'html',
  'js',
  'json',
  'jsonl',
  'lock',
  'log',
  'md',
  'mjs',
  'pid',
  'py',
  'sh',
  'sql',
  'toml',
  'ts',
  'tsx',
  'txt',
  'vue',
  'yaml',
  'yml',
]);

interface NotAnErrorCode {
  readonly token: string;
  readonly reason: string;
}

/**
 * Dotted tokens that borrow an error namespace and are not error codes, each
 * with the reason. A token that merely fails to resolve is a defect; a token
 * that fails to resolve *with a reason written down* is a decision, and this
 * list is the difference -- the same bargain `eventTypeScan.ts` strikes with
 * `FREE_EVENT_TYPES`.
 *
 * Both halves are checked below. An entry that stops appearing in the prose,
 * or that becomes a real code, fails rather than sits.
 */
const NOT_ERROR_CODES: NotAnErrorCode[] = [
  {
    token: 'task.judges',
    reason:
      "A key path in `budgets.yml`, not a code: the guide's budget section names the policy key that prices the four judges. `task` is an error namespace too (`task.unknown`, `task.not-claimed`), which is the only reason this collides.",
  },
];

const EXCUSED = new Map(NOT_ERROR_CODES.map((entry) => [entry.token, entry.reason]));

/**
 * Whether a backtick token is prose claiming an error code exists.
 *
 * Three gates, narrowest first. It must be dotted and code-shaped, because an
 * undotted code (`unsupported-runtime`) is indistinguishable from an ordinary
 * hyphenated word and guarding it would report English. Its first segment must
 * be a namespace something in the tree raises, because otherwise the guard
 * grows into every dotted string in the repo. And its last segment must not be
 * a file extension.
 */
function isCodeClaim(token: string, namespaces: ReadonlySet<string>): boolean {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(token)) return false;
  if (!namespaces.has(token.split('.')[0] as string)) return false;
  if (FILE_EXTENSIONS.has(token.split('.').pop() as string)) return false;
  return !EXCUSED.has(token);
}

interface Claim {
  readonly line: number;
  readonly token: string;
}

/** Every error code one markdown file claims exists. */
function codeClaims(markdown: string, namespaces: ReadonlySet<string>): Claim[] {
  return codeSpans(markdown)
    .filter((span) => isCodeClaim(span.text, namespaces))
    .map((span) => ({ line: span.line, token: span.text }));
}

interface SurfaceFile {
  readonly rel: string;
  readonly claims: readonly Claim[];
}

/** Read lazily, for the reason `docCommands.test.ts` gives at the same place. */
let cached: SurfaceFile[] | undefined;
function surface(scan: ErrorCodeScan): SurfaceFile[] {
  cached ??= instructionFiles().map((rel) => ({
    rel,
    claims: codeClaims(readFileSync(path.join(REPO_ROOT, rel), 'utf8'), scan.namespaces),
  }));
  return cached;
}

describe('scanErrorCodes', () => {
  // Pinned against fixtures rather than the repo, so a change to the repo's
  // sources can never quietly relax the scanner it is being checked by.
  const fixture = [
    {
      file: 'src/errors.ts',
      text: 'export class SmithError extends Error {}\nclass PlanError extends SmithError {}\n',
    },
    {
      file: 'src/plan.ts',
      text: [
        "throw new PlanError('plan.unreadable', 'no');",
        'throw new RangeError("Scope.sessionIds was empty: nothing to widen.");',
        "throw new PlanError(\n  'plan.wrapped-by-the-formatter',\n  'yes',\n);",
      ].join('\n'),
    },
  ];

  it('reads a literal code, a wrapped one, and nothing from a built-in error', () => {
    const scan = scanErrorCodes(fixture);
    expect([...scan.codes].sort()).toEqual(['plan.unreadable', 'plan.wrapped-by-the-formatter']);
    expect([...scan.namespaces]).toEqual(['plan']);
    expect(scan.opaque).toEqual([]);
  });

  it('reads the code of a subclass that builds its own, and of one held in a table', () => {
    // git.ts and lessons.ts in miniature: the first overrides the constructor
    // so the code lives in its `super(...)`, the second raises `rule.code` off
    // a table so it lives in a `code:` field. Both are invisible to shape A.
    const scan = scanErrorCodes([
      ...fixture,
      {
        file: 'src/git.ts',
        text: "class GitCommandError extends SmithError {\n  constructor(cwd: string) {\n    super('git.command-failed', cwd);\n  }\n}\n",
      },
      {
        file: 'src/lessons.ts',
        text: "const RULES = [{ code: 'lessons.missing-claim-path', field: 'claim_path' }];\nconst reason = { code: 'security-surface' };\n",
      },
    ]);
    expect(scan.codes.has('git.command-failed')).toBe(true);
    expect(scan.codes.has('lessons.missing-claim-path')).toBe(true);
    // An undotted `code:` is an autonomy decision reason, not a code.
    expect(scan.codes.has('security-surface')).toBe(false);
  });

  it('reports a construction whose code it cannot read rather than dropping it', () => {
    const scan = scanErrorCodes([
      ...fixture,
      { file: 'src/x.ts', text: 'throw new PlanError(rule.code, rule.message);\n' },
    ]);
    expect(scan.opaque).toEqual([{ file: 'src/x.ts', line: 1, klass: 'PlanError' }]);
  });
});

describe('codeClaims', () => {
  const namespaces = new Set(['cli', 'lessons', 'task', 'scope']);
  const tokens = (markdown: string): string[] =>
    codeClaims(markdown, namespaces).map((claim) => claim.token);

  it('reads a code out of prose and out of a table cell', () => {
    expect(tokens('Exits 1 with `cli.missing-flag`.')).toEqual(['cli.missing-flag']);
    expect(tokens('| `scope.bad-request` | you widened nothing |')).toEqual(['scope.bad-request']);
  });

  it('still pairs the backticks when another span in the paragraph hard-wraps', () => {
    // A code never wraps -- it has no space to break at -- but the span before
    // it does, all the time. Scanned line by line, the wrapped span's backticks
    // pair with the code's instead of with each other, and the claim vanishes.
    const paragraph = ['Run `smith stats overview', '--json` first, then read `cli.missing-flag`.'];
    expect(tokens(paragraph.join('\n'))).toEqual(['cli.missing-flag']);
  });

  it('ignores a filename, a namespace named alone, and a foreign namespace', () => {
    expect(tokens('Edit `lessons.ts` and `severity.yml`, then read `daemon.log`.')).toEqual([]);
    expect(tokens('The `lessons` family is in `docs/guide/operator-guide.md`.')).toEqual([]);
    expect(tokens('Set `autonomy.confidence_floor` to 0.8.')).toEqual([]);
  });

  it('ignores a token excused with a written reason, and only that token', () => {
    expect(tokens('The policy prices them at `task.judges`.')).toEqual([]);
    expect(tokens('It refuses with `task.judges-missing`.')).toEqual(['task.judges-missing']);
  });
});

describe('the documented error codes are the raised error codes', () => {
  const scan = raisedErrorCodes();

  it('names only codes the factory can raise', () => {
    const unresolved = surface(scan).flatMap(({ rel, claims }) =>
      claims
        .filter((claim) => !scan.codes.has(claim.token))
        .map((claim) => `${rel}:${claim.line}  ${claim.token}`),
    );
    expect(
      unresolved,
      'a document named an error code no code path raises: renamed, deleted, or never real',
    ).toEqual([]);
  });

  it('bites on a code the sources stopped raising', () => {
    // The check above passes on an empty scan, on an empty surface, and on a
    // predicate that matches nothing. This is the one that says it can fail.
    const stale = 'A rename left this behind: `cli.missing-flags`.';
    const claims = codeClaims(stale, scan.namespaces);
    expect(claims).toEqual([{ line: 1, token: 'cli.missing-flags' }]);
    expect(scan.codes.has('cli.missing-flags')).toBe(false);
    expect(scan.codes.has('cli.missing-flag')).toBe(true);
  });

  it('actually resolved both sides', () => {
    // Floors well under today's counts, so this fails on a scanner that breaks
    // rather than on prose or sources that get edited. The named files are the
    // ones an operator and a dispatched agent read first.
    expect(scan.subclasses.size).toBeGreaterThan(40);
    expect(scan.codes.size).toBeGreaterThan(200);
    expect(scan.namespaces.size).toBeGreaterThan(40);
    const claims = surface(scan).flatMap((file) => file.claims);
    expect(claims.length).toBeGreaterThan(30);
    for (const rel of ['docs/guide/operator-guide.md', '.claude/skills/bs/SKILL.md']) {
      const file = surface(scan).find((entry) => entry.rel === rel);
      expect(file?.claims.length ?? 0, `${rel} contributed no code claims`).toBeGreaterThan(0);
    }
  });

  it('sees every raise site, or names the ones it cannot', () => {
    // Two constructions in this tree hide their code from shape A, and both are
    // recovered by another shape. Pinned by class rather than by line so
    // ordinary edits do not touch it, and so a third one has to be explained.
    expect(scan.opaque.map((site) => `${site.file}  ${site.klass}`).sort()).toEqual([
      // Overrides the constructor; its code is the literal in its own super().
      'factory/orchestrator/src/git.ts  GitCommandError',
      // Raised as rule.code off SELECTOR_RULES; the literals are in the table.
      'factory/orchestrator/src/lessons.ts  LessonsError',
    ]);
    expect(scan.codes.has('git.command-failed')).toBe(true);
    expect(scan.codes.has('lessons.missing-claim-path')).toBe(true);
  });

  it('keeps every excused token earning its excuse', () => {
    // An excuse outlives what it excused twice over: the prose can drop the
    // token, and the sources can start raising it. Either way the entry is now
    // a hole in the guard that reads like a decision.
    const written = new Set(
      instructionFiles().flatMap((rel) =>
        codeSpans(readFileSync(path.join(REPO_ROOT, rel), 'utf8')).map((span) => span.text),
      ),
    );
    for (const { token } of NOT_ERROR_CODES) {
      expect(written.has(token), `${token} is excused but no live document writes it`).toBe(true);
      expect(scan.codes.has(token), `${token} is excused but the sources now raise it`).toBe(false);
    }
  });
});
