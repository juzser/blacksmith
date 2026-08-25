/**
 * A textual scanner for literal event types written in orchestrator source.
 *
 * Textual, not AST-based, for a boring reason: the `typescript` package here
 * is 7.0.2, whose JS entry exposes no compiler API — `createSourceFile`,
 * `createProgram` and `forEachChild` are all `undefined`. Rather than add a
 * parser dependency to satisfy one lint, this reads the shapes the orchestrator
 * actually writes:
 *
 *   Rule A  an `event_type:` property whose value contains a string literal
 *   Rule B  a call to a helper whose parameter is named `eventType`, at that
 *           parameter's position (gate.ts's emit(), taskEvents.ts's envelope())
 *   Rule C  either of the above naming a module-level `const X = '...'`
 *
 * Everything else — a variable, a call, a template string — is reported as
 * nothing at all. That is deliberate: `event_type` is a free string at write
 * time on purpose (events.ts:24, projector.ts:23), and this lint only claims
 * the literals, where a typo is both possible and cheap to catch.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface EventTypeUse {
  /** The literal written, e.g. `gate-outcome`. */
  eventType: string;
  /** Path relative to the scanned root. */
  file: string;
  /** 1-based line of the call site. */
  line: number;
  /** `event_type` for a property write, otherwise the helper's name. */
  via: string;
}

export interface FreeEventType {
  eventType: string;
  /**
   * `src` — written by a literal in orchestrator source, so the scan below
   * must find it. `cli` — arrives through `smith events append` from outside
   * the orchestrator (the /bs skill, the operator, a fixture), so it must not.
   * Either way the label is checked, and a stale entry fails rather than sits.
   */
  writtenBy: 'src' | 'cli';
  reason: string;
}

/**
 * Event types this orchestrator writes that no taxonomy dimension declares,
 * each with the reason it is allowed to stay outside the vocabulary. A type
 * that is merely undeclared is a bug; a type that is undeclared *with a reason
 * written down* is a decision. This list is the difference.
 */
export const FREE_EVENT_TYPES: FreeEventType[] = [
  {
    eventType: 'session-start',
    writtenBy: 'cli',
    reason:
      'The root event of every log, and the only one allowed a null causal_parent or a parent in another session (README, /bs skill). Written by the operator opening a session, not by the orchestrator: events.ts holds ROOT_EVENT_TYPE only to recognise it on read.',
  },
  {
    eventType: 'user_prompt',
    writtenBy: 'src',
    reason:
      "The operator's own words, stored verbatim by prompts.ts (`smith prompt record`). No dimension declares it because it records no factory action — a person spoke — and it is shown on the timeline unconditionally (queries.ts FREE_TIMELINE_EVENT_TYPES). It was 'cli' until D-142, which is the finding this label change is: the type had five readers and no writer anywhere, so 'written from outside' described a write that never happened.",
  },
  {
    eventType: 'operator-note',
    writtenBy: 'cli',
    reason:
      "The operator's reasoning in their own words, appended through `smith event append` at a decision point — why a scope was cut, what a correction was for. Like user_prompt it is a person writing, not a factory action, so no dimension declares it. It is also the loudest case this list's third direction exists for: it went undeclared here for long enough to become the third most common event in the factory's own logs while reaching no operator screen at all, because a type written only from outside src is invisible to the scan and could only ever have been caught by a human adding it here.",
  },
  {
    eventType: 'dispatch_decision',
    writtenBy: 'src',
    reason:
      'A dispatch choice with its rationale. Tagged through the payload (events.ts PAYLOAD_DIMENSION_MAP: agent, provider, model_tier, model) rather than by a gate_event value, because what is recorded is the decision, not a gate outcome.',
  },
  {
    eventType: 'error-logged',
    writtenBy: 'src',
    reason:
      'An error carrying its error_class taxonomy tag in the payload (PAYLOAD_DIMENSION_MAP), so the event type itself stays outside gate_event.',
  },
  {
    eventType: 'task-result-recorded',
    writtenBy: 'src',
    reason:
      "A worker's structured Result, schema-checked against result.schema.json before it lands. It is the record the gates then score, not a gate outcome of its own.",
  },
  {
    eventType: 'judge-verdict',
    writtenBy: 'src',
    reason:
      'One external judge run (quorum.ts), payload-tagged via PAYLOAD_DIMENSION_MAP. Declared by no dimension, and it stays that way: promoting it into the vocabulary is an operator call (taxonomy version bump plus the architecture section 8 re-splice), not a change this lint should make on its own. It does now reach the operator (queries.ts FREE_TIMELINE_EVENT_TYPES) — being outside the taxonomy is a reason to stay in this list, not a reason to be invisible.',
  },
  {
    eventType: 'judge-reported',
    writtenBy: 'src',
    reason:
      'The terminal half of a judge dispatch (judges.ts), payload-tagged via PAYLOAD_TAG_MAP on agent_role. Read by the judges-outstanding gate rather than folded by the projector, and outside the taxonomy for the same reason as judge-verdict.',
  },
  {
    eventType: 'epic-closed',
    writtenBy: 'src',
    reason:
      "The close verdict for an epic (epic.ts). The projector folds it into the epics table (projector.ts foldEpics), and no dimension declares it — the same operator vocabulary call as judge-verdict. The timeline filter used to drop it too, which meant the most consequential event in an epic's life never reached the operator; that half is fixed (queries.ts FREE_TIMELINE_EVENT_TYPES) and now guarded by the timeline case in eventTypes.test.ts.",
  },
  {
    eventType: 'lesson-candidate-raised',
    writtenBy: 'src',
    reason:
      'The dreaming pass proposing a lesson, payload-tagged via PAYLOAD_DIMENSION_MAP. The lessons pipeline keeps its vocabulary (lesson_type, lesson_scope, lesson_status) in the payload rather than the event type.',
  },
  {
    eventType: 'lesson-status-changed',
    writtenBy: 'src',
    reason:
      'A lesson moving between proposed/accepted/rejected, payload-tagged via PAYLOAD_TAG_MAP on to_status. Same pipeline, same reason.',
  },
  {
    eventType: 'lesson-edited',
    writtenBy: 'src',
    reason:
      'An operator edit to a lesson, partially payload-tagged via PAYLOAD_PARTIAL_TAG_MAP (lesson_type and lesson_scope, each checked only when the edit carries it). Same pipeline, same reason.',
  },
  {
    eventType: 'finding-obligation-repaired',
    writtenBy: 'src',
    reason:
      'D-21 Part 4: repairObligation (findings.ts) correcting a malformed amends_task_ids entry on an amend-pending finding. Not a finding-transitioned event because a repair changes no status, so no finding_status dimension value applies to it; the payload carries its own from_obligation/to_obligation/reason rather than a taxonomy-tagged field.',
  },
];

export interface UnemittedEventType {
  eventType: string;
  reason: string;
}

/**
 * The list above runs from code to vocabulary. This one runs the other way:
 * taxonomy values that no literal in src writes. Both directions rot, and this
 * one rots more quietly — an undeclared literal at least lands in a log
 * somewhere, while a declared-but-unwritten value is a branch readers take that
 * nothing ever reaches, described in docs and handed to agents as real.
 *
 * An entry here is a claim that the gap is known and deliberate, so each says
 * which it is: a feature the architecture describes and the code has not built,
 * or a value that should be retired. Both are decisions; neither is silence.
 */
export const UNEMITTED_EVENT_TYPES: UnemittedEventType[] = [
  {
    eventType: 'plan-version-superseded',
    reason:
      'Unbuilt half of a shipped feature. Cutting a new plan version emits ' +
      "PLAN_AMENDED_EVENT = 'plan-version-created' (spec.ts:62), but nothing marks the " +
      'version it replaced, and projector.ts folds no such case — so a reader that wants ' +
      'to know whether a plan version is still live has to infer it from version numbers ' +
      'rather than read it. planQuorum.test.ts:464 asserts the absence, which pins the ' +
      'current behaviour without deciding it. Emitting it is a taxonomy-shaped change to ' +
      'plan amendment, not a lint fix.',
  },
  {
    eventType: 'task-split',
    reason:
      'Unbuilt third verb. The architecture names all three in one sentence — "Adding, ' +
      'splitting, or superseding tasks means cutting plan v(n+1)" — and the code has ' +
      "built two: taskEvents.ts emits 'task-added' and 'task-superseded' (:171, :177, " +
      ':339) and projector.ts folds both (:413, :463). A split is expressed today as a ' +
      'supersede plus two adds, which is lossy in exactly the way the timeline is meant ' +
      'to prevent: the diff shows three tasks changed, not one task divided.',
  },
];

export interface OffTimelineEventType {
  eventType: string;
  reason: string;
}

/**
 * A third direction, and the one the operator actually feels. The two lists
 * above ask whether a type is *declared* and whether it is *emitted*; this one
 * asks whether it is ever *seen*. `timeline()` filters on an allowlist —
 * taxonomy values plus queries.ts's FREE_TIMELINE_EVENT_TYPES — so a free type
 * that is written correctly, folded correctly and named in FREE_EVENT_TYPES
 * still vanishes if nobody thought to add it there. That is the P9-37 defect
 * class one layer out: not a typo the log rejects, but a row the operator's
 * screen drops.
 *
 * So every FREE_EVENT_TYPES entry must reach the timeline or be listed here
 * with a reason it should not. The list is empty today on purpose: of the
 * seven that were missing, none had an argument for staying hidden — they were
 * missing because the list was hand-kept, which is the whole complaint.
 */
export const OFF_TIMELINE_EVENT_TYPES: OffTimelineEventType[] = [];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

interface Tokenized {
  /** Source with comment bodies blanked; string bodies are left intact. */
  code: string;
  /** 1 where an offset sits inside a comment, string, template or regex. */
  masked: Uint8Array;
}

const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '\n']);

/**
 * One pass that blanks comments and marks quoted/regex regions. Regex literals
 * get their own case because `/'/` or `/\/\//` would otherwise open a string
 * or a comment that never closes and swallow the rest of the file.
 */
function tokenize(text: string): Tokenized {
  const code = text.split('');
  const masked = new Uint8Array(text.length);
  let previous = '';
  let i = 0;

  const blank = (from: number, to: number): void => {
    for (let j = from; j < to && j < text.length; j += 1) {
      masked[j] = 1;
      if (text[j] !== '\n') code[j] = ' ';
    }
  };
  const mask = (from: number, to: number): void => {
    for (let j = from; j < to && j < text.length; j += 1) masked[j] = 1;
  };

  while (i < text.length) {
    const ch = text.charAt(i);

    if (ch === '/' && text[i + 1] === '/') {
      let end = text.indexOf('\n', i);
      if (end === -1) end = text.length;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? text.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === ch) break;
        j += 1;
      }
      mask(i, Math.min(j + 1, text.length));
      previous = ch;
      i = j + 1;
      continue;
    }
    if (ch === '/' && REGEX_PRECEDERS.has(previous)) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j += 1;
      }
      if (j < text.length && text[j] === '/') {
        mask(i, j + 1);
        previous = '/';
        i = j + 1;
        continue;
      }
    }

    if (!/\s/.test(ch)) previous = ch;
    else if (ch === '\n') previous = '\n';
    i += 1;
  }

  return { code: code.join(''), masked };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    // In range by the loop's own bounds: `mid` is at most `high`, which starts
    // at `starts.length - 1` and only shrinks. The fallback is unreachable.
    const midStart = starts[mid] ?? 0;
    if (midStart <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

const OPENERS = '([{';
const CLOSERS = ')]}';

/** Index of the delimiter closing the one at `open`, or -1. */
function matchDelimiter({ code, masked }: Tokenized, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (masked[i]) continue;
    const ch = code.charAt(i);
    if (OPENERS.includes(ch)) depth += 1;
    else if (CLOSERS.includes(ch)) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface Span {
  text: string;
  start: number;
}

/** Split `[from, to)` on top-level commas. */
function splitTopLevel({ code, masked }: Tokenized, from: number, to: number): Span[] {
  const spans: Span[] = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i += 1) {
    if (masked[i]) continue;
    const ch = code.charAt(i);
    if (OPENERS.includes(ch)) depth += 1;
    else if (CLOSERS.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) {
      spans.push({ text: code.slice(start, i), start });
      start = i + 1;
    }
  }
  if (start < to) spans.push({ text: code.slice(start, to), start });
  return spans;
}

/** End of the expression that starts at `from`: the next top-level `,`, `;` or closer. */
function expressionEnd({ code, masked }: Tokenized, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i += 1) {
    if (masked[i]) continue;
    const ch = code.charAt(i);
    if (OPENERS.includes(ch)) depth += 1;
    else if (CLOSERS.includes(ch)) {
      if (depth === 0) return i;
      depth -= 1;
    } else if (depth === 0 && (ch === ',' || ch === ';')) return i;
  }
  return code.length;
}

const STRING_LITERAL = /'([^'\\\n]*)'|"([^"\\\n]*)"/g;
const CONSTANT_NAME = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;

/**
 * Every literal, and every known constant, inside one expression. A ternary
 * yields both arms; `input.event_type ?? 'edge-recorded'` yields the fallback;
 * `flags.type ?? readType()` yields nothing, which is the point.
 */
function literalsIn(expression: string, constants: Map<string, string>): string[] {
  const found: string[] = [];
  for (const match of expression.matchAll(STRING_LITERAL)) {
    // Two alternated quote styles, so exactly one group fires per match.
    const literal = match[1] ?? match[2];
    if (literal !== undefined) found.push(literal);
  }
  for (const match of expression.matchAll(CONSTANT_NAME)) {
    const name = match[1];
    const value = name === undefined ? undefined : constants.get(name);
    if (value !== undefined) found.push(value);
  }
  return found;
}

interface ParsedFile {
  file: string;
  tokens: Tokenized;
  starts: number[];
}

/** Module-level `const NAME = 'literal'`, keyed by name. Rule C's source. */
function collectConstants(files: ParsedFile[]): Map<string, string> {
  const constants = new Map<string, string>();
  const declaration = /\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=;]+?)?=\s*'([^'\\\n]*)'/g;
  for (const { tokens } of files) {
    for (const match of tokens.code.matchAll(declaration)) {
      if (tokens.masked[match.index]) continue;
      const [, name, value] = match;
      if (name === undefined || value === undefined) continue;
      constants.set(name, value);
    }
  }
  return constants;
}

interface Writers {
  /** Per file: every helper defined there, `null` when it takes no eventType. */
  byFile: Map<string, Map<string, number | null>>;
  /** Exported helpers, visible to the files that import them. */
  exported: Map<string, number>;
  /** `file:offset` of each definition's own parameter list. */
  sites: Set<string>;
}

/**
 * Helpers that take the event type positionally, derived from the source being
 * scanned rather than hand-listed here — a hand-listed set of writers is the
 * same drift this lint exists to catch, one level down.
 *
 * Scoped per file, because names collide: events.ts's private
 * `checkTag(taxonomy, eventType, dimension, value)` and lessons.ts's local
 * `checkTag(dimension, value)` are different functions, and reading the second
 * through the first's signature reports `checkTag('lesson_level', 'principle')`
 * as an event type named `principle`. A local definition shadows an imported
 * one even when it has no eventType parameter at all.
 */
function collectWriters(files: ParsedFile[]): Writers {
  const byFile = new Map<string, Map<string, number | null>>();
  const exported = new Map<string, number>();
  const sites = new Set<string>();
  const heads =
    /(?:\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>\s*)?\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+?)?=\s*(?:async\s+)?(?:<[^>()]*>\s*)?\()/g;

  for (const { file, tokens } of files) {
    const local = new Map<string, number | null>();
    byFile.set(file, local);
    for (const match of tokens.code.matchAll(heads)) {
      if (tokens.masked[match.index]) continue;
      const name = match[1] ?? match[2];
      if (name === undefined) continue;
      const open = match.index + match[0].length - 1;
      const close = matchDelimiter(tokens, open);
      if (close === -1) continue;
      sites.add(`${file}:${open}`);
      const params = splitTopLevel(tokens, open + 1, close);
      const found = params.findIndex((param) =>
        /^\s*(?:readonly\s+)?eventType\s*[?:,)]?/.test(param.text.replace(/^\s*\.\.\./, '')),
      );
      const index = found >= 0 ? found : null;
      local.set(name, index);
      if (
        index !== null &&
        /\bexport\s+$/.test(tokens.code.slice(Math.max(0, match.index - 16), match.index))
      ) {
        exported.set(name, index);
      }
    }
  }
  return { byFile, exported, sites };
}

/** The helpers a single file can reach: its own, then whatever it imports. */
function writersFor(file: string, { byFile, exported }: Writers): Map<string, number> {
  const local = byFile.get(file) ?? new Map<string, number | null>();
  const visible = new Map<string, number>();
  for (const [name, index] of exported) if (!local.has(name)) visible.set(name, index);
  for (const [name, index] of local) if (index !== null) visible.set(name, index);
  return visible;
}

/**
 * Every literal event type written under `rootDir`, sorted by file and line.
 */
export function scanEventTypeLiterals(rootDir: string): EventTypeUse[] {
  const files: ParsedFile[] = listTsFiles(rootDir).map((absolute) => {
    const text = readFileSync(absolute, 'utf8');
    return {
      file: path.relative(rootDir, absolute),
      tokens: tokenize(text),
      starts: lineStarts(text),
    };
  });

  const constants = collectConstants(files);
  const writers = collectWriters(files);
  const uses: EventTypeUse[] = [];

  for (const { file, tokens, starts } of files) {
    const { code, masked } = tokens;

    // Rule A + C — `event_type: <expression>`.
    for (const match of code.matchAll(/\bevent_type\s*:/g)) {
      if (masked[match.index]) continue;
      const from = match.index + match[0].length;
      const expression = code.slice(from, expressionEnd(tokens, from));
      for (const eventType of literalsIn(expression, constants)) {
        uses.push({ eventType, file, line: lineAt(starts, match.index), via: 'event_type' });
      }
    }

    // Rule B + C — a derived writer, at its own parameter position.
    for (const [name, index] of writersFor(file, writers)) {
      for (const match of code.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
        if (masked[match.index]) continue;
        const open = match.index + match[0].length - 1;
        if (writers.sites.has(`${file}:${open}`)) continue;
        const close = matchDelimiter(tokens, open);
        if (close === -1) continue;
        const args = splitTopLevel(tokens, open + 1, close);
        const argument = args[index];
        if (argument === undefined) continue;
        for (const eventType of literalsIn(argument.text, constants)) {
          uses.push({ eventType, file, line: lineAt(starts, argument.start), via: name });
        }
      }
    }
  }

  const seen = new Set<string>();
  return uses
    .filter((use) => {
      const key = `${use.file}:${use.line}:${use.via}:${use.eventType}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        a.file.localeCompare(b.file) || a.line - b.line || a.eventType.localeCompare(b.eventType),
    );
}
