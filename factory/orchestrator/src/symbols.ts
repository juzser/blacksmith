/**
 * The compile-time module graph that file-level path claims cannot see.
 *
 * A path claim answers "did two tasks touch the same file". It cannot answer
 * "did task A change a signature that task B's file imports", because that
 * coupling does not live inside either file — it lives on the edge between
 * them. This module reads those edges: which file imports which symbol from
 * which file, and which file exports what.
 *
 * It ships its own scanner instead of calling a compiler, and that is a
 * decision rather than an oversight. `typescript@7` is the native rewrite and
 * exposes no compiler API: its package `exports` map offers `./unstable/sync`
 * (a client that spawns a native language server) and `./unstable/ast`, both
 * under the package's own word for "this will change". `ts.createSourceFile`
 * is not there to call. Pinning the claim gate to that surface would trade a
 * small scanner for a large moving dependency.
 *
 * The trade the scanner makes in return: it is a lexer, not a type checker, so
 * some shapes are beyond it. Every one of them is *named* rather than quietly
 * dropped — `unanalyzed`, `unresolved`, `unreadExports`, `opaqueImports`. A
 * hole an operator can see is a different thing from a graph that claims to be
 * complete and is not.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path/posix';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** A source with every comment and literal interior blanked out in place. */
export interface MaskedSource {
  /** Same length and same line breaks as the input, so offsets still slice. */
  masked: string;
  /** True when a literal or comment ran off the end of the file. */
  unterminated: boolean;
}

/** One edge out of a module, as written. */
export interface ModuleImport {
  /** The specifier exactly as it appears in the source. */
  specifier: string;
  /** Repo-relative target, or null when it leaves the repo. Filled by the graph. */
  resolved: string | null;
  /**
   * The names as the *target* exports them — the left side of `as` — because
   * that is what couples the two files. `default` for a default import, `*`
   * for a namespace, a star re-export, or a dynamic import.
   */
  names: string[];
  typeOnly: boolean;
  dynamic: boolean;
}

/** Everything the scanner could read out of one file. */
export interface ModuleFacts {
  file: string;
  /** Export names in source order. `default` for a default export, `*` for `export *`. */
  exports: string[];
  imports: ModuleImport[];
  /**
   * Exported name -> the declaration text that introduces it, whitespace
   * collapsed and the body excluded. This is what makes "the signature
   * changed" answerable at all: the graph knows the name, and only the text
   * knows the shape. Reformatting is not a change; a new parameter is.
   */
  exportSignatures: Map<string, string>;
  /** Clauses recognised as exports whose name could not be extracted. */
  unreadExports: string[];
  /** Dynamic imports whose specifier is not a literal, e.g. `import(p)`. */
  opaqueImports: string[];
  /** True when masking hit an unterminated literal, so nothing here is trustworthy. */
  unterminated: boolean;
}

/** An edge seen from the imported end — the direction the impact question runs. */
export interface DependentEdge {
  from: string;
  names: string[];
  typeOnly: boolean;
  specifier: string;
  dynamic: boolean;
}

/** A relative specifier that named nothing in scope. */
export interface UnresolvedSpecifier {
  from: string;
  specifier: string;
}

export interface SymbolGraph {
  modules: ReadonlyMap<string, ModuleFacts>;
  /** Imported file -> everyone who imports it. */
  dependents: ReadonlyMap<string, DependentEdge[]>;
  /** Files the scanner refused to guess at. */
  unanalyzed: string[];
  unresolved: UnresolvedSpecifier[];
}

// ---------------------------------------------------------------------------
// Lexical helpers
// ---------------------------------------------------------------------------

/**
 * Punctuation after which a `/` opens a regex rather than dividing. Without
 * this, `const r = /['"]/;` would open a fake string and swallow the rest of
 * the file.
 */
const REGEX_ALLOWED_AFTER_PUNCT: ReadonlySet<string> = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
  '<',
  '>',
]);

const REGEX_ALLOWED_AFTER_WORD: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const EXPORT_MODIFIERS: ReadonlySet<string> = new Set(['declare', 'abstract', 'async']);

const NAMED_DECLARATION_KEYWORDS: ReadonlySet<string> = new Set([
  'function',
  'class',
  'interface',
  'type',
  'enum',
  'namespace',
  'module',
]);

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function readIdent(text: string, at: number): string {
  if (at >= text.length || !isIdentStart(text.charAt(at))) return '';
  let end = at;
  while (end < text.length && isIdentPart(text.charAt(end))) end += 1;
  return text.slice(at, end);
}

function skipSpace(text: string, at: number): number {
  let i = at;
  while (i < text.length && /\s/.test(text.charAt(i))) i += 1;
  return i;
}

function leadingWord(text: string): string {
  return readIdent(text.trimStart(), 0);
}

function startsRegex(prevToken: string): boolean {
  if (prevToken === '') return true;
  return REGEX_ALLOWED_AFTER_PUNCT.has(prevToken) || REGEX_ALLOWED_AFTER_WORD.has(prevToken);
}

function scanQuoted(
  source: string,
  start: number,
  quote: string,
): { end: number; closed: boolean } {
  let i = start + 1;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return { end: i, closed: true };
    if (ch === '\n') return { end: i, closed: false };
    i += 1;
  }
  return { end: source.length, closed: false };
}

/** Index of the closing `/`, or null when this `/` was division after all. */
function scanRegex(source: string, start: number): number | null {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '\n') return null;
    if (inClass) {
      if (ch === ']') inClass = false;
      i += 1;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      i += 1;
      continue;
    }
    if (ch === '/') return i;
    i += 1;
  }
  return null;
}

/**
 * Blank out comment and literal interiors *in place*: same length, same line
 * breaks, quote delimiters kept. That means every offset into the result still
 * slices the original, and a masked specifier is recognisable as an empty
 * quoted run.
 */
export function maskLiterals(source: string): MaskedSource {
  const out = source.split('');
  let unterminated = false;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  // Each open `${` remembers the brace depth it interrupted, so its matching
  // `}` can be told apart from a plain block close.
  const templateFrames: number[] = [];
  let inTemplate = false;
  let braceDepth = 0;
  let prevToken = '';
  let i = 0;

  while (i < source.length) {
    const ch = source.charAt(i);

    if (inTemplate) {
      if (ch === '\\') {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '`') {
        inTemplate = false;
        prevToken = '`';
        i += 1;
        continue;
      }
      if (ch === '$' && source.charAt(i + 1) === '{') {
        templateFrames.push(braceDepth);
        inTemplate = false;
        prevToken = '{';
        i += 2;
        continue;
      }
      blank(i, i + 1);
      i += 1;
      continue;
    }

    const next = source.charAt(i + 1);

    if (ch === '/' && next === '/') {
      let end = source.indexOf('\n', i);
      if (end === -1) end = source.length;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) {
        blank(i, source.length);
        unterminated = true;
        break;
      }
      blank(i, end + 2);
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quoted = scanQuoted(source, i, ch);
      blank(i + 1, quoted.end);
      if (!quoted.closed) unterminated = true;
      i = quoted.closed ? quoted.end + 1 : quoted.end;
      prevToken = ch;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      i += 1;
      continue;
    }
    if (ch === '/' && startsRegex(prevToken)) {
      const close = scanRegex(source, i);
      if (close !== null) {
        blank(i + 1, close);
        i = close + 1;
        // A closed regex is a value, so the next `/` divides.
        prevToken = 'regex';
        continue;
      }
      // Fall through: this `/` divides.
    }
    if (ch === '{') {
      braceDepth += 1;
      prevToken = ch;
      i += 1;
      continue;
    }
    if (ch === '}') {
      const frame = templateFrames[templateFrames.length - 1];
      if (frame !== undefined && braceDepth === frame) {
        templateFrames.pop();
        inTemplate = true;
        i += 1;
        continue;
      }
      braceDepth -= 1;
      prevToken = ch;
      i += 1;
      continue;
    }
    if (isIdentStart(ch)) {
      const word = readIdent(source, i);
      prevToken = word;
      i += word.length;
      continue;
    }
    if (!/\s/.test(ch)) prevToken = ch;
    i += 1;
  }

  if (inTemplate) unterminated = true;
  return { masked: out.join(''), unterminated };
}

// ---------------------------------------------------------------------------
// Clause reading
// ---------------------------------------------------------------------------

interface Clause {
  /** Index just past the clause text (exclusive of its terminator). */
  textEnd: number;
  /** Where the statement scanner should resume. */
  end: number;
  stop: ';' | '{' | 'nl' | 'eof';
}

/** Words that prove a `{` opens a declaration body, not a named import list. */
const DECLARATION_WORDS: ReadonlySet<string> = new Set([
  'function',
  'class',
  'interface',
  'enum',
  'namespace',
  'module',
  'const',
  'let',
  'var',
  'declare',
  'abstract',
  'async',
  'default',
]);

/**
 * Where the clause's own named list opens, or -1. A named list is reachable
 * from the keyword through nothing but names, commas, `*` and whitespace —
 * `import d, { a } from` qualifies, `export function f() {` does not.
 */
function findListBrace(masked: string, at: number): number {
  let i = at;
  while (i < masked.length) {
    const ch = masked.charAt(i);
    if (ch === '{') return i;
    if (ch === ',' || ch === '*' || /\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (isIdentStart(ch)) {
      const word = readIdent(masked, i);
      if (DECLARATION_WORDS.has(word)) return -1;
      i += word.length;
      continue;
    }
    return -1;
  }
  return -1;
}

/**
 * A statement clause ends at the first depth-0 `;` or `{` — unless that `{` is
 * the clause's own named import/export list, which is exactly what tells
 * `import { a } from` apart from `export function f() {`. A depth-0 newline
 * also ends it, unless the next token is `from`.
 */
function readClause(masked: string, start: number, keyword: string): Clause {
  let i = start + keyword.length;
  const listBrace = findListBrace(masked, i);

  let depth = 0;
  let consumedList = false;
  while (i < masked.length) {
    const ch = masked.charAt(i);
    if (ch === '(' || ch === '[') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')' || ch === ']') {
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === '{') {
      if (depth === 0 && !consumedList && i === listBrace) {
        consumedList = true;
        depth += 1;
        i += 1;
        continue;
      }
      if (depth === 0) return { textEnd: i, end: i, stop: '{' };
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === ';' && depth === 0) return { textEnd: i, end: i + 1, stop: ';' };
    if (ch === '\n' && depth === 0 && readIdent(masked, skipSpace(masked, i)) !== 'from') {
      return { textEnd: i, end: i, stop: 'nl' };
    }
    i += 1;
  }
  return { textEnd: masked.length, end: masked.length, stop: 'eof' };
}

function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === sep && depth === 0) {
      parts.push(text.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(text.slice(last));
  return parts;
}

/** `a as b` -> the name the target exports and the name it lands under. */
function renamedEntry(entry: string): { local: string; exported: string } | null {
  let text = entry.trim();
  if (text === '') return null;
  const withoutType = text.replace(/^type\s+/, '');
  text = withoutType;
  const asAt = text.search(/\sas\s/);
  if (asAt === -1) return { local: text, exported: text };
  const local = text.slice(0, asAt).trim();
  const exported = text.slice(asAt + 4).trim();
  if (local === '') return null;
  return { local, exported: exported === '' ? local : exported };
}

function importedName(entry: string): string | null {
  const parsed = renamedEntry(entry);
  return parsed === null ? null : parsed.local;
}

function parseImportHead(head: string): { names: string[]; typeOnly: boolean } {
  let rest = head.trim();
  let typeOnly = false;
  if (/^type\b/.test(rest)) {
    typeOnly = true;
    rest = rest.slice(4).trim();
  }
  const names: string[] = [];
  for (const part of splitTopLevel(rest, ',')) {
    const clause = part.trim();
    if (clause === '') continue;
    if (clause.startsWith('{')) {
      const inner = clause.slice(1, clause.lastIndexOf('}'));
      for (const entry of splitTopLevel(inner, ',')) {
        const name = importedName(entry);
        if (name !== null) names.push(name);
      }
      continue;
    }
    names.push(clause.startsWith('*') ? '*' : 'default');
  }
  return { names, typeOnly };
}

function parseExportFromHead(head: string): {
  importNames: string[];
  exportNames: string[];
  typeOnly: boolean;
} {
  let rest = head.trim();
  let typeOnly = false;
  if (/^type\b/.test(rest)) {
    typeOnly = true;
    rest = rest.slice(4).trim();
  }
  if (rest.startsWith('*')) {
    const after = rest.slice(1).trim();
    if (/^as\b/.test(after)) {
      const alias = after.slice(2).trim();
      return { importNames: ['*'], exportNames: alias === '' ? ['*'] : [alias], typeOnly };
    }
    return { importNames: ['*'], exportNames: ['*'], typeOnly };
  }
  if (rest.startsWith('{')) {
    const inner = rest.slice(1, rest.lastIndexOf('}'));
    const importNames: string[] = [];
    const exportNames: string[] = [];
    for (const entry of splitTopLevel(inner, ',')) {
      const parsed = renamedEntry(entry);
      if (parsed === null) continue;
      importNames.push(parsed.local);
      exportNames.push(parsed.exported);
    }
    return { importNames, exportNames, typeOnly };
  }
  return { importNames: [], exportNames: [], typeOnly };
}

function unreadLabel(clauseText: string, stoppedAtBrace: boolean): string {
  return `${clauseText.trim()}${stoppedAtBrace ? ' {' : ''}`;
}

function parseExportDeclaration(
  head: string,
  clauseText: string,
  stoppedAtBrace: boolean,
  facts: ModuleFacts,
): void {
  let rest = head.trim();
  let word = leadingWord(rest);
  while (EXPORT_MODIFIERS.has(word)) {
    rest = rest.slice(rest.indexOf(word) + word.length).trim();
    word = leadingWord(rest);
  }
  if (word === 'default') {
    facts.exports.push('default');
    return;
  }
  if (word === 'const' || word === 'let' || word === 'var') {
    const names: string[] = [];
    for (const part of splitTopLevel(rest.slice(rest.indexOf(word) + word.length), ',')) {
      const name = leadingWord(part);
      if (name !== '') names.push(name);
    }
    if (names.length > 0) {
      facts.exports.push(...names);
      return;
    }
    facts.unreadExports.push(unreadLabel(clauseText, stoppedAtBrace));
    return;
  }
  if (NAMED_DECLARATION_KEYWORDS.has(word)) {
    let after = rest.slice(rest.indexOf(word) + word.length).trim();
    if (after.startsWith('*')) after = after.slice(1).trim();
    const name = leadingWord(after);
    if (name !== '') {
      facts.exports.push(name);
      return;
    }
  }
  facts.unreadExports.push(unreadLabel(clauseText, stoppedAtBrace));
}

/** The depth-0 `from '...'` of a clause, if it has one. */
function findFromSpecifier(
  masked: string,
  from: number,
  to: number,
): { fromAt: number; quoteStart: number; quoteEnd: number } | null {
  let depth = 0;
  let i = from;
  while (i < to) {
    const ch = masked.charAt(i);
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      i += 1;
      continue;
    }
    if (isIdentStart(ch)) {
      const word = readIdent(masked, i);
      if (depth === 0 && word === 'from') {
        const quoteStart = skipSpace(masked, i + 4);
        const quote = masked.charAt(quoteStart);
        if (quoteStart < to && (quote === "'" || quote === '"')) {
          const quoteEnd = masked.indexOf(quote, quoteStart + 1);
          if (quoteEnd !== -1 && quoteEnd < to) return { fromAt: i, quoteStart, quoteEnd };
        }
      }
      i += word.length;
      continue;
    }
    i += 1;
  }
  return null;
}

/** Whitespace is formatting, not signature: collapse it before comparing. */
function normalizeSignature(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Record the declaration text against every export the clause introduced.
 * Wrapping is what keeps this honest: the clause parsers below push export
 * names from six different shapes, and one of them growing a seventh should
 * not be able to silently drop its signature.
 */
function readClauseFacts(
  source: string,
  masked: string,
  start: number,
  clause: Clause,
  keyword: string,
  facts: ModuleFacts,
): void {
  const before = facts.exports.length;
  readClauseExports(source, masked, start, clause, keyword, facts);
  const signature = normalizeSignature(source.slice(start, clause.textEnd));
  for (let i = before; i < facts.exports.length; i += 1) {
    const name = facts.exports[i];
    if (name !== undefined) facts.exportSignatures.set(name, signature);
  }
}

function readClauseExports(
  source: string,
  masked: string,
  start: number,
  clause: Clause,
  keyword: string,
  facts: ModuleFacts,
): void {
  const clauseText = source.slice(start, clause.textEnd);
  const stoppedAtBrace = clause.stop === '{';
  const headStart = start + keyword.length;
  const spec = findFromSpecifier(masked, headStart, clause.textEnd);

  if (spec !== null) {
    const specifier = source.slice(spec.quoteStart + 1, spec.quoteEnd);
    const head = masked.slice(headStart, spec.fromAt);
    if (keyword === 'import') {
      const { names, typeOnly } = parseImportHead(head);
      facts.imports.push({ specifier, resolved: null, names, typeOnly, dynamic: false });
      return;
    }
    const { importNames, exportNames, typeOnly } = parseExportFromHead(head);
    facts.imports.push({ specifier, resolved: null, names: importNames, typeOnly, dynamic: false });
    facts.exports.push(...exportNames);
    return;
  }

  if (keyword === 'import') {
    // A side-effect import carries no symbol, but it is still an edge.
    let quoteStart = skipSpace(masked, headStart);
    if (readIdent(masked, quoteStart) === 'type') quoteStart = skipSpace(masked, quoteStart + 4);
    const quote = masked.charAt(quoteStart);
    if (quote === "'" || quote === '"') {
      const quoteEnd = masked.indexOf(quote, quoteStart + 1);
      if (quoteEnd !== -1 && quoteEnd < clause.textEnd) {
        facts.imports.push({
          specifier: source.slice(quoteStart + 1, quoteEnd),
          resolved: null,
          names: [],
          typeOnly: false,
          dynamic: false,
        });
        return;
      }
    }
    facts.opaqueImports.push(clauseText.trim());
    return;
  }

  const head = masked.slice(headStart, clause.textEnd);
  const listHead = head.trim().replace(/^type\s+/, '');
  if (listHead.startsWith('{')) {
    for (const entry of splitTopLevel(listHead.slice(1, listHead.lastIndexOf('}')), ',')) {
      const parsed = renamedEntry(entry);
      if (parsed !== null) facts.exports.push(parsed.exported);
    }
    return;
  }
  parseExportDeclaration(head, clauseText, stoppedAtBrace, facts);
}

function readStatementClauses(source: string, masked: string, facts: ModuleFacts): void {
  let depth = 0;
  let i = 0;
  let prevChar = '';
  // Start of file is a statement boundary; so is a line break, because ASI.
  let sawNewline = true;

  while (i < masked.length) {
    const ch = masked.charAt(i);
    if (ch === '\n') {
      sawNewline = true;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      prevChar = ch;
      sawNewline = false;
      i += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      prevChar = ch;
      sawNewline = false;
      i += 1;
      continue;
    }
    if (isIdentStart(ch)) {
      const word = readIdent(masked, i);
      const atBoundary =
        sawNewline || prevChar === '' || prevChar === ';' || prevChar === '{' || prevChar === '}';
      const after = masked.charAt(skipSpace(masked, i + word.length));
      const isDynamicOrMeta = word === 'import' && (after === '(' || after === '.');
      if (
        depth === 0 &&
        atBoundary &&
        !isDynamicOrMeta &&
        (word === 'import' || word === 'export')
      ) {
        const clause = readClause(masked, i, word);
        readClauseFacts(source, masked, i, clause, word, facts);
        i = clause.end;
        prevChar = ';';
        sawNewline = false;
        continue;
      }
      i += word.length;
      prevChar = 'a';
      sawNewline = false;
      continue;
    }
    prevChar = ch;
    sawNewline = false;
    i += 1;
  }
}

function matchParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const ch = masked.charAt(i);
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function readDynamicImports(source: string, masked: string, facts: ModuleFacts): void {
  const pattern = /\bimport\s*\(/g;
  let match = pattern.exec(masked);
  while (match !== null) {
    const open = match.index + match[0].length - 1;
    const close = matchParen(masked, open);
    const inner = close === -1 ? masked.length : close;
    const quoteStart = skipSpace(masked, open + 1);
    const quote = masked.charAt(quoteStart);
    const quoteEnd = quote === "'" || quote === '"' ? masked.indexOf(quote, quoteStart + 1) : -1;
    if (quoteEnd !== -1 && quoteEnd < inner) {
      facts.imports.push({
        specifier: source.slice(quoteStart + 1, quoteEnd),
        resolved: null,
        names: ['*'],
        typeOnly: false,
        dynamic: true,
      });
    } else {
      facts.opaqueImports.push(`import(${source.slice(open + 1, inner).trim()})`);
    }
    pattern.lastIndex = close === -1 ? masked.length : close + 1;
    match = pattern.exec(masked);
  }
}

/** Read one file's imports and exports. Resolution is the graph's job, not this one's. */
export function parseModuleFacts(source: string, file: string): ModuleFacts {
  const facts: ModuleFacts = {
    file,
    exports: [],
    imports: [],
    exportSignatures: new Map(),
    unreadExports: [],
    opaqueImports: [],
    unterminated: false,
  };
  const { masked, unterminated } = maskLiterals(source);
  if (unterminated) {
    facts.unterminated = true;
    return facts;
  }
  readStatementClauses(source, masked, facts);
  readDynamicImports(source, masked, facts);
  return facts;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** NodeNext writes `.js` and means the TypeScript source that compiles to it. */
const SOURCE_FOR_EMITTED: ReadonlyMap<string, readonly string[]> = new Map([
  ['.js', ['.ts', '.tsx', '.js']],
  ['.jsx', ['.tsx', '.jsx']],
  ['.mjs', ['.mts', '.mjs']],
  ['.cjs', ['.cts', '.cjs']],
]);

/** The conventional emitted/authored pair, used to follow `dist/x.js` to `src/x.ts`. */
const BUILD_DIRECTORY = 'dist';
const SOURCE_DIRECTORY = 'src';

/**
 * Extensions a relative import can carry that hold no compile-time symbols. An
 * import of a stylesheet is a bundler instruction, not a module edge, so its
 * absence from the graph is not a hole worth reporting.
 */
const SYMBOL_FREE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.styl',
  '.json',
  '.json5',
  '.yaml',
  '.yml',
  '.toml',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.webm',
  '.wav',
  '.ogg',
  '.txt',
  '.md',
  '.html',
  '.wasm',
]);

const AUTHORED_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts'];

const EXTENSIONLESS_CANDIDATES: readonly string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];

const INDEX_NAMES: readonly string[] = [
  'index.ts',
  'index.tsx',
  'index.mts',
  'index.cts',
  'index.js',
  'index.jsx',
];

/**
 * Map a specifier onto a repo-relative file, or null. A bare specifier resolves
 * to null by design: a package is not this repo, so it is out of scope rather
 * than a failure. A *relative* specifier that resolves to null is a hole, and
 * the graph records it as one.
 */
function candidatesFor(base: string): string[] {
  const candidates: string[] = [];
  const ext = extname(base);
  const emitted = SOURCE_FOR_EMITTED.get(ext);
  if (emitted !== undefined) {
    const stem = base.slice(0, base.length - ext.length);
    for (const swapped of emitted) candidates.push(stem + swapped);
  } else if (AUTHORED_EXTENSIONS.includes(ext)) {
    candidates.push(base);
  } else {
    candidates.push(base);
    for (const suffix of EXTENSIONLESS_CANDIDATES) candidates.push(base + suffix);
  }
  for (const index of INDEX_NAMES) candidates.push(`${base}/${index}`);
  return candidates;
}

export function resolveSpecifier(
  fromFile: string,
  specifier: string,
  inScope: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = join(dirname(fromFile), specifier);
  for (const candidate of candidatesFor(base)) {
    if (inScope.has(candidate)) return candidate;
  }
  // Build output stands in for the source that emits it. A module importing
  // `../dist/paths.js` is coupled to `../src/paths.ts` just as tightly as if it
  // had said so: change that signature and this importer breaks. The compiled
  // copy is not in scope — it is generated — so follow the edge to the source.
  if (base.includes(`/${BUILD_DIRECTORY}/`)) {
    const asSource = base.replace(`/${BUILD_DIRECTORY}/`, `/${SOURCE_DIRECTORY}/`);
    for (const candidate of candidatesFor(asSource)) {
      if (inScope.has(candidate)) return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

/**
 * Build the graph from an in-memory corpus. Taking sources rather than a
 * directory keeps this pure and testable; `collectSources` is the half that
 * touches disk.
 */
export function buildSymbolGraph(sources: ReadonlyMap<string, string>): SymbolGraph {
  const inScope = new Set(sources.keys());
  const modules = new Map<string, ModuleFacts>();
  const dependents = new Map<string, DependentEdge[]>();
  const unanalyzed: string[] = [];
  const unresolved: UnresolvedSpecifier[] = [];
  const seenUnresolved = new Set<string>();

  const ordered = [...sources.keys()].sort();
  for (const file of ordered) {
    const source = sources.get(file);
    if (source === undefined) continue;
    const facts = parseModuleFacts(source, file);
    if (facts.unterminated) {
      unanalyzed.push(file);
      continue;
    }
    for (const edge of facts.imports) {
      edge.resolved = resolveSpecifier(file, edge.specifier, inScope);
      if (edge.resolved === null) {
        if (
          edge.specifier.startsWith('.') &&
          !SYMBOL_FREE_EXTENSIONS.has(extname(edge.specifier))
        ) {
          const key = `${file}\u0000${edge.specifier}`;
          if (!seenUnresolved.has(key)) {
            seenUnresolved.add(key);
            unresolved.push({ from: file, specifier: edge.specifier });
          }
        }
        continue;
      }
      const list = dependents.get(edge.resolved) ?? [];
      list.push({
        from: file,
        names: edge.names,
        typeOnly: edge.typeOnly,
        specifier: edge.specifier,
        dynamic: edge.dynamic,
      });
      dependents.set(edge.resolved, list);
    }
    modules.set(file, facts);
  }

  return { modules, dependents, unanalyzed, unresolved };
}

// ---------------------------------------------------------------------------
// Reading a corpus off disk
// ---------------------------------------------------------------------------

export const DEFAULT_SOURCE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];

/** Directories whose contents are never the repo's own authored source. */
export const DEFAULT_SKIPPED_DIRECTORIES: readonly string[] = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'workspaces',
  'state',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.turbo',
];

export interface SourceScanOptions {
  extensions?: readonly string[];
  skipDirectories?: readonly string[];
}

function readEntries(absolute: string) {
  try {
    return readdirSync(absolute, { withFileTypes: true });
  } catch {
    // A directory that cannot be listed is a directory this graph cannot speak for.
    return [];
  }
}

/** Read every authored source under `rootDir`, keyed by repo-relative path. */
export function collectSources(
  rootDir: string,
  options: SourceScanOptions = {},
): Map<string, string> {
  const extensions = options.extensions ?? DEFAULT_SOURCE_EXTENSIONS;
  const skipped = new Set(options.skipDirectories ?? DEFAULT_SKIPPED_DIRECTORIES);
  const sources = new Map<string, string>();

  const walk = (relativeDir: string): void => {
    const absolute = relativeDir === '' ? rootDir : `${rootDir}/${relativeDir}`;
    for (const entry of readEntries(absolute)) {
      const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (skipped.has(entry.name)) continue;
        walk(relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!extensions.some((suffix) => entry.name.endsWith(suffix))) continue;
      try {
        sources.set(relative, readFileSync(`${rootDir}/${relative}`, 'utf8'));
      } catch {
        // A file that cannot be read is not a file this graph can speak for.
      }
    }
  };

  walk('');
  return sources;
}
