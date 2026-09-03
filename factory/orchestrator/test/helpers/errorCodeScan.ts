/**
 * A textual scanner for the error codes this factory can actually raise.
 *
 * Textual, not AST-based, for the same boring reason `eventTypeScan.ts` gives:
 * the `typescript` package here is 7.0.2, whose JS entry exposes no compiler
 * API -- `createSourceFile`, `createProgram` and `forEachChild` are all
 * `undefined`. So this reads the three shapes a code is written in:
 *
 *   Shape A  `new <SmithError subclass>('<code>', ...)` -- the bulk of them
 *   Shape B  `super('<code>', ...)` inside a file that declares a subclass,
 *            for the one subclass that overrides the constructor and builds
 *            its own code (git.ts's `GitCommandError`)
 *   Shape C  a `code: '<code>'` property, for codes held in a table and raised
 *            from it (lessons.ts's `SELECTOR_RULES`)
 *
 * Shape C is narrowed to literals containing a dot. Undotted `code:` fields in
 * this tree are autonomy decision reasons (`security-surface`,
 * `below-confidence-floor`), not error codes, and admitting them would put
 * words into a vocabulary the guard then treats as raiseable.
 *
 * What the scanner cannot see, it says so about. A `new FooError(` whose first
 * argument is not a literal is reported as an opaque site rather than skipped,
 * because a scanner that quietly stops seeing raise sites passes every check
 * built on it forever.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../src/paths.js';

/**
 * The shape of a code: lowercase kebab segments, dot-separated. Every code in
 * this tree is written this way, and the grammar is what keeps a stray string
 * literal in a constructor's first slot from entering the vocabulary.
 */
export const CODE_GRAMMAR = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

/** The trees whose throws an operator can be shown by name. */
export const SCANNED_ROOTS = ['factory/orchestrator/src', 'ui/server/src'];

export interface SourceFile {
  /** Path as it should be reported, typically repo-relative. */
  readonly file: string;
  readonly text: string;
}

export interface RaiseSite {
  readonly code: string;
  readonly file: string;
  /** 1-based line of the construction. */
  readonly line: number;
  readonly via: 'new' | 'super' | 'table';
}

/**
 * A `new <subclass>(` whose code the scanner cannot read. Recorded, not
 * dropped: this is the list a guard pins, so adding a computed code fails
 * loudly instead of shrinking the vocabulary in silence.
 */
export interface OpaqueRaise {
  readonly file: string;
  readonly line: number;
  readonly klass: string;
}

export interface ErrorCodeScan {
  /** Every code the scanned tree can raise. */
  readonly codes: ReadonlySet<string>;
  /** First segments of the dotted codes -- the namespaces prose can name. */
  readonly namespaces: ReadonlySet<string>;
  readonly sites: readonly RaiseSite[];
  readonly opaque: readonly OpaqueRaise[];
  /** `SmithError` and every subclass declared in the scanned tree. */
  readonly subclasses: ReadonlySet<string>;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/** The literal a construction opens with, or undefined when it opens otherwise. */
function openingLiteral(rest: string): string | undefined {
  return /^\s*'([^'\n]*)'/.exec(rest)?.[1];
}

/**
 * Scan a set of sources for the codes they raise.
 *
 * Two passes, because shape A needs the subclass names and a subclass may be
 * declared in a file scanned after the file that raises it. The alternation is
 * built from the declarations rather than from `/[A-Z][A-Za-z]*Error/`, which
 * also matches `new RangeError(...)` and `new TypeError(...)` and admits their
 * first arguments -- whole English sentences -- as codes.
 */
export function scanErrorCodes(sources: readonly SourceFile[]): ErrorCodeScan {
  const subclasses = new Set<string>(['SmithError']);
  for (const { text } of sources)
    for (const match of text.matchAll(/class\s+([A-Za-z]+)\s+extends\s+SmithError\b/g))
      subclasses.add(match[1] as string);

  const constructed = new RegExp(`new\\s+(${[...subclasses].sort().join('|')})\\s*\\(`, 'g');
  const sites: RaiseSite[] = [];
  const opaque: OpaqueRaise[] = [];

  const keep = (code: string | undefined, site: Omit<RaiseSite, 'code'>): boolean => {
    if (code === undefined || !CODE_GRAMMAR.test(code)) return false;
    sites.push({ ...site, code });
    return true;
  };

  for (const { file, text } of sources) {
    for (const match of text.matchAll(constructed)) {
      const line = lineOf(text, match.index);
      const code = openingLiteral(text.slice(match.index + match[0].length));
      if (!keep(code, { file, line, via: 'new' }))
        opaque.push({ file, line, klass: match[1] as string });
    }
    if (text.includes('extends SmithError'))
      for (const match of text.matchAll(/\bsuper\s*\(/g))
        keep(openingLiteral(text.slice(match.index + match[0].length)), {
          file,
          line: lineOf(text, match.index),
          via: 'super',
        });
    for (const match of text.matchAll(/\bcode:\s*'([^'\n]*)'/g)) {
      const code = match[1] as string;
      if (code.includes('.')) keep(code, { file, line: lineOf(text, match.index), via: 'table' });
    }
  }

  const codes = new Set(sites.map((site) => site.code));
  const namespaces = new Set(
    [...codes].filter((code) => code.includes('.')).map((code) => code.split('.')[0] as string),
  );
  return { codes, namespaces, sites, opaque, subclasses };
}

function typescriptFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) typescriptFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Read lazily, not at module load, matching `docCommands.test.ts`: the walk
 * touches two source trees, and a top-level `const` that throws takes the
 * scanner's own fixture tests down with it -- a stack trace naming readdirSync
 * instead of one red assertion.
 */
let cached: ErrorCodeScan | undefined;
export function raisedErrorCodes(): ErrorCodeScan {
  cached ??= scanErrorCodes(
    SCANNED_ROOTS.flatMap((root) =>
      typescriptFiles(path.join(REPO_ROOT, root)).map((full) => ({
        file: path.relative(REPO_ROOT, full),
        text: readFileSync(full, 'utf8'),
      })),
    ),
  );
  return cached;
}
