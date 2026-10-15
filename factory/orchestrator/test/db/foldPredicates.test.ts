// Which event records each global fold reads is written down in
// src/db/foldPredicates.ts. This file keeps that list honest two ways: rows
// over minimal records say how a predicate treats a record's shape, and a
// source guard walks each fold's code and checks the predicate accepts every
// event type that code compares against. The guard is textual because the
// repository's typescript package exposes no compiler API (see
// helpers/eventTypeScan.ts); it reuses that helper's tokenizer.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  feedbackFoldReads,
  findingsFoldReads,
  lessonsFoldReads,
  tasksFoldReads,
} from '../../src/db/foldPredicates.js';
import type { EventRecord } from '../../src/events.js';
import { REPO_ROOT } from '../../src/paths.js';
import {
  expressionEnd,
  FUNCTION_HEADS,
  matchDelimiter,
  type Tokenized,
  tokenize,
} from '../helpers/eventTypeScan.js';

const PREDICATES = {
  tasks: tasksFoldReads,
  findings: findingsFoldReads,
  lessons: lessonsFoldReads,
  feedback: feedbackFoldReads,
};
type Fold = keyof typeof PREDICATES;
const FOLDS = Object.keys(PREDICATES) as Fold[];

function record(event_type: string, extra: Partial<EventRecord> = {}): EventRecord {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    session_id: 'session-a',
    actor: 'orchestrator',
    event_type,
    plan_version: 1,
    causal_parent: null,
    payload: {},
    ...extra,
  };
}

const withPayload = (payload: unknown): EventRecord =>
  record('demo-hub-noted', { payload: payload as Record<string, unknown> });

function acceptedBy(rec: EventRecord): Fold[] {
  return FOLDS.filter((fold) => PREDICATES[fold](rec));
}

describe('fold predicates over minimal records', () => {
  const rows: { label: string; rec: EventRecord; accepted: Fold[] }[] = [
    { label: 'invented type, names nothing', rec: record('demo-hub-noted'), accepted: [] },
    {
      label: 'envelope task_id',
      rec: record('demo-hub-noted', { task_id: 'task-1' }),
      accepted: ['tasks', 'findings'],
    },
    {
      label: 'payload task_id',
      rec: withPayload({ task_id: 'task-1' }),
      accepted: ['tasks', 'findings'],
    },
    {
      label: 'payload task_ids',
      rec: withPayload({ task_ids: ['task-1'] }),
      accepted: ['tasks', 'findings'],
    },
    {
      label: 'payload epic_id',
      rec: withPayload({ epic_id: 'epic-a' }),
      accepted: ['tasks', 'findings'],
    },
    { label: 'null payload', rec: withPayload(null), accepted: FOLDS },
    { label: 'string payload', rec: withPayload('opaque'), accepted: FOLDS },
  ];

  it.each(rows)('$label', ({ label, rec, accepted }) => {
    const got = acceptedBy(rec);
    console.log(`row ${label}: {${got.join(', ')}}`);
    expect(got).toEqual(accepted);
  });
});

// --- source guard -----------------------------------------------------------

const SRC_DIR = path.join(REPO_ROOT, 'factory', 'orchestrator', 'src');
const OPEN = '([{';
const CLOSE = ')]}';
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof']);

interface Import {
  from: string;
  /** The exported name, or '*' for a namespace import. */
  name: string;
}
interface Head {
  name: string;
  /** Offset of the head itself. */
  at: number;
  /** The body's `[start, end)`. */
  start: number;
  end: number;
}
interface Mod {
  rel: string;
  tokens: Tokenized;
  /** Top-level functions with a body. */
  heads: Head[];
  imports: Map<string, Import>;
  /** `export { a as b } from` — exported name to [source module, original name]. */
  named: Map<string, [string, string]>;
  stars: string[];
}

const mods = new Map<string, Mod>();

function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const file = path.resolve(path.dirname(from), spec.replace(/\.js$/, '.ts'));
  return file.startsWith(SRC_DIR + path.sep) && existsSync(file) ? file : `missing:${spec}`;
}

/**
 * Every named function with a body, found with the helper's FUNCTION_HEADS.
 * The body is located here rather than with the helper's own span finder,
 * which reads the `=>` of a function-typed return type as the start of an
 * arrow body and so mis-spans `function f(): (id: string) => X {`.
 */
function functionHeads(tokens: Tokenized): Head[] {
  const { code, masked } = tokens;
  const heads: Head[] = [];
  for (const m of code.matchAll(FUNCTION_HEADS)) {
    const name = m[1] ?? m[2];
    if (masked[m.index] || name === undefined) continue;
    const isDecl = m[1] !== undefined;
    const close = matchDelimiter(tokens, m.index + m[0].length - 1);
    let depth = 0;
    let angle = 0;
    let prev = ')';
    for (let i = close + 1; close !== -1 && i < code.length; i += 1) {
      const ch = code.charAt(i);
      if (masked[i]) {
        prev = 'a';
        continue;
      }
      if (ch === '=' && code.charAt(i + 1) === '>') {
        i += 1;
        prev = '=';
        if (isDecl || depth > 0 || angle > 0) continue;
        let at = i + 1;
        while (/\s/.test(code.charAt(at))) at += 1;
        const block = code.charAt(at) === '{';
        const end = block ? matchDelimiter(tokens, at) : expressionEnd(tokens, at);
        if (end !== -1) heads.push({ name, at: m.index, start: block ? at + 1 : at, end });
        break;
      }
      if (ch === '{' && isDecl && depth === 0 && angle === 0 && !':|&=,<('.includes(prev)) {
        const end = matchDelimiter(tokens, i);
        if (end !== -1) heads.push({ name, at: m.index, start: i + 1, end });
        break;
      }
      if (ch === ';' && depth === 0) break;
      if (OPEN.includes(ch)) depth += 1;
      else if (CLOSE.includes(ch)) depth -= 1;
      else if (ch === '<') angle += 1;
      else if (ch === '>') angle = Math.max(0, angle - 1);
      if (!/\s/.test(ch)) prev = ch;
    }
  }
  return heads;
}

function load(file: string): Mod {
  const cached = mods.get(file);
  if (cached) return cached;
  const tokens = tokenize(readFileSync(file, 'utf8'));
  const all = functionHeads(tokens);
  const heads = all.filter((h) => !all.some((o) => o !== h && h.at >= o.start && h.at < o.end));
  const mod: Mod = {
    rel: path.relative(SRC_DIR, file),
    tokens,
    heads,
    imports: new Map(),
    named: new Map(),
    stars: [],
  };
  mods.set(file, mod);
  const { code, masked } = tokens;
  const names = (clause: string): [string, string][] =>
    clause
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part && !part.startsWith('type '))
      .map((part) => {
        const [a = '', b = a] = part.split(/\s+as\s+/);
        return [a, b];
      });
  for (const m of code.matchAll(/\bimport\s+(?!type\b)([^;'"]*?)\s*from\s*(['"])([^'"]+)\2/g)) {
    if (masked[m.index]) continue;
    const from = resolveSpec(file, m[3] ?? '');
    if (from === null) continue;
    const clause = m[1] ?? '';
    const ns = /^\*\s+as\s+([\w$]+)/.exec(clause);
    if (ns?.[1]) mod.imports.set(ns[1], { from, name: '*' });
    const braces = /\{([^}]*)\}/.exec(clause);
    for (const [name, local] of names(braces?.[1] ?? '')) mod.imports.set(local, { from, name });
  }
  for (const m of code.matchAll(
    /\bexport\s+(?!type\b)(\*|\{([^}]*)\})\s*from\s*(['"])([^'"]+)\3/g,
  )) {
    if (masked[m.index]) continue;
    const from = resolveSpec(file, m[4] ?? '');
    if (from === null) continue;
    if (m[1] === '*') mod.stars.push(from);
    for (const [name, exported] of names(m[2] ?? '')) mod.named.set(exported, [from, name]);
  }
  return mod;
}

type Decl = { mod: Mod; fn: Head[] } | { mod: Mod; value: string };

/** The module-level function or string constant `name` is, following re-exports. */
function declOf(file: string, name: string, seen = new Set<string>()): Decl | null {
  if (file.startsWith('missing:') || seen.has(`${file}#${name}`)) return null;
  seen.add(`${file}#${name}`);
  const mod = load(file);
  const fn = mod.heads.filter((h) => h.name === name);
  if (fn.length > 0) return { mod, fn };
  const decl = new RegExp(
    `\\bconst\\s+${name}\\s*(?::\\s*[^=;]+?)?=\\s*(?:'([^'\\\\\\n]*)'|"([^"\\\\\\n]*)")\\s*(?:as\\s+const\\s*)?[;,\\n]`,
    'g',
  );
  for (const m of mod.tokens.code.matchAll(decl)) {
    const at = m.index;
    if (mod.tokens.masked[at] || mod.heads.some((h) => at >= h.start && at < h.end)) continue;
    return { mod, value: m[1] ?? m[2] ?? '' };
  }
  const named = mod.named.get(name);
  const viaNamed = named ? declOf(named[0], named[1], seen) : null;
  if (viaNamed) return viaNamed;
  for (const star of mod.stars) {
    const viaStar = declOf(star, name, seen);
    if (viaStar) return viaStar;
  }
  return null;
}

/** A name used in module `mod`: its own declaration, else the one it imports. */
function resolveName(mod: Mod, name: string): Decl | 'unresolved' | null {
  const own = declOf(path.join(SRC_DIR, mod.rel), name);
  if (own) return own;
  const imported = mod.imports.get(name);
  if (!imported) return null;
  return declOf(imported.from, imported.name) ?? 'unresolved';
}

interface Collected {
  /** type -> where it was compared. */
  types: Map<string, string>;
  problems: string[];
}

function lineText(code: string, at: number): string {
  const from = code.lastIndexOf('\n', at) + 1;
  const to = code.indexOf('\n', at);
  return code.slice(from, to === -1 ? code.length : to).trim();
}

/** Reach and read one fold's code from its entry points. */
function collect(entries: [string, string][]): Collected {
  const out: Collected = { types: new Map(), problems: [] };
  const queue: { fn: string; head: Head; mod: Mod }[] = [];
  const seen = new Set<string>();
  const reach = (mod: Mod, fns: Head[]): void => {
    for (const head of fns) {
      if (seen.has(`${mod.rel}#${head.name}@${head.start}`)) continue;
      seen.add(`${mod.rel}#${head.name}@${head.start}`);
      queue.push({ fn: head.name, head, mod });
    }
  };
  for (const [rel, name] of entries) {
    const decl = declOf(path.join(SRC_DIR, rel), name);
    if (decl && 'fn' in decl) reach(decl.mod, decl.fn);
    else out.problems.push(`entry point ${name} is not declared in ${rel}`);
  }

  for (let item = queue.shift(); item; item = queue.shift()) {
    const { fn, head, mod } = item;
    const { code, masked } = mod.tokens;
    const body = code.slice(head.start, head.end);
    const at = (offset: number): number => head.start + offset;

    // Calls: bare names, and `ns.name(` on a namespace import.
    for (const m of body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?\s*\(/g)) {
      const [call, first = '', second] = m;
      const before = body.slice(Math.max(0, m.index - 12), m.index);
      if (masked[at(m.index)] || /\b(?:new|function)\s+$/.test(before)) continue;
      const ns = second === undefined ? undefined : mod.imports.get(first);
      if (second !== undefined && ns?.name !== '*') continue;
      if (second === undefined && KEYWORDS.has(first)) continue;
      const name = second ?? first;
      const target = ns ? declOf(ns.from, name) : resolveName(mod, name);
      if (target === null) {
        if (ns)
          out.problems.push(`${fn} in ${mod.rel}: cannot resolve ${call.trim()} in ${ns.from}`);
        continue;
      }
      if (target === 'unresolved' || !('fn' in target)) {
        const from = mod.imports.get(first)?.from ?? '?';
        out.problems.push(
          `${fn} in ${mod.rel}: cannot resolve call ${name}( imported from ${from}`,
        );
      } else reach(target.mod, target.fn);
    }

    // Comparisons: every use of event_type is a switch subject or an (in)equality.
    const switches: { from: number; to: number }[] = [];
    for (const m of body.matchAll(/\bswitch\s*\(/g)) {
      const open = at(m.index + m[0].length - 1);
      const close = matchDelimiter(mod.tokens, open);
      if (masked[at(m.index)] || close === -1 || !/\bevent_type\b/.test(code.slice(open, close)))
        continue;
      switches.push({ from: open, to: close });
      const brace = code.indexOf('{', close);
      const end = matchDelimiter(mod.tokens, brace);
      let depth = 0;
      for (let i = brace + 1; i < end; i += 1) {
        if (masked[i]) continue;
        const ch = code.charAt(i);
        if (OPEN.includes(ch)) depth += 1;
        else if (CLOSE.includes(ch)) depth -= 1;
        else if (
          depth === 0 &&
          /\bcase\s/.test(code.slice(i, i + 5)) &&
          /\W/.test(code.charAt(i - 1))
        ) {
          const label = /^case\s+('[^'\\\n]*'|"[^"\\\n]*"|[A-Za-z_$][\w$.]*)\s*:/.exec(
            code.slice(i),
          );
          operand(label?.[1], lineText(code, i), fn, mod, out);
        }
      }
    }
    for (const m of body.matchAll(/\bevent_type\b/g)) {
      const pos = at(m.index);
      if (masked[pos] || switches.some((s) => pos > s.from && pos < s.to)) continue;
      const rest = /^\s*(?:===|!==)\s*('[^'\\\n]*'|"[^"\\\n]*"|[A-Za-z_$][\w$.]*)(?![\w$.(])/.exec(
        code.slice(pos + m[0].length),
      );
      operand(rest?.[1], lineText(code, pos), fn, mod, out);
    }
  }
  return out;
}

/** Record one compared operand: a literal as written, an identifier through its const. */
function operand(
  text: string | undefined,
  expr: string,
  fn: string,
  mod: Mod,
  out: Collected,
): void {
  const where = `${fn} in ${mod.rel}`;
  const quoted = text === undefined ? null : /^(['"])(.*)\1$/.exec(text);
  let value = quoted?.[2];
  if (text !== undefined && !quoted && /^[A-Za-z_$][\w$]*$/.test(text)) {
    const decl = resolveName(mod, text);
    if (decl && decl !== 'unresolved' && 'value' in decl) value = decl.value;
  }
  if (value === undefined) out.problems.push(`${where}: cannot resolve ${expr}`);
  else if (!out.types.has(value)) out.types.set(value, where);
}

const ENTRIES: Record<Fold, [string, string][]> = {
  tasks: [['db/projector.ts', 'projectTasks']],
  findings: [
    ['db/projector.ts', 'projectFindings'],
    ['findings.ts', 'foldFindingsDetailed'],
  ],
  lessons: [['db/projector.ts', 'projectLessons']],
  feedback: [
    ['db/projector.ts', 'projectOperatorFeedback'],
    ['feedback.ts', 'foldOperatorFeedback'],
  ],
};

describe('fold predicates against the folds source', () => {
  it.each(FOLDS)('the %s predicate accepts every type its fold compares', (fold) => {
    const { types, problems } = collect(ENTRIES[fold]);
    console.log(`${fold} fold compares: ${JSON.stringify([...types.keys()].sort())}`);
    expect(problems).toEqual([]);
    const rejected = [...types].filter(([type]) => !PREDICATES[fold](record(type)));
    expect(rejected.map(([type, where]) => `${type} (compared in ${where})`)).toEqual([]);
  });

  it('fails an entry point the module does not declare', () => {
    const { problems } = collect([['db/projector.ts', 'projectNothing']]);
    expect(problems).toEqual(['entry point projectNothing is not declared in db/projector.ts']);
  });
});
