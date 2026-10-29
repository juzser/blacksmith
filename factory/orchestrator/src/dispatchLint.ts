/**
 * `smith dispatch lint` — check a dispatch prompt against two things a
 * dispatcher can get wrong without any signal until the agent runs:
 *
 *   - the turn budget stated in the prompt vs the role template's
 *     `maxTurns:`, read fresh off disk (dispatch.md "Carry into the
 *     prompt" — a prompt that promises more than the template is a fiction
 *     the agent plans against and gets cut in the middle of).
 *   - a judge prompt's declared-artifact line vs what the ledger recorded
 *     for its `judge dispatch` (dispatch.md "Declare each judge's
 *     artifact" — a judge prompt missing that line is undetectable until
 *     the report never lands).
 *
 * Both parsers and both comparisons live here so the two checks stay one
 * source of truth for "what does a compliant dispatch prompt say", rather
 * than every dispatcher re-deriving it.
 */
import path from 'node:path';
import { readTemplateMaxTurns } from './agentsSync.js';
import { formatDeclaredArtifactLine, parseDeclaredArtifactLine } from './declaredArtifactLine.js';
import type { EventOpts } from './events.js';
import { JUDGE_ROLES } from './judgeRoles.js';
import { readJudgeTurns } from './judges.js';
import { AGENTS_DIR } from './paths.js';
import { taskIdsMatch } from './taskId.js';

export type { JudgeRole } from './judgeRoles.js';
/**
 * Re-exported, not re-declared (judgeRoles.ts is the canonical source, kept
 * dependency-free so both this module and judges.ts can import it without a
 * cycle -- see that file for the full set and why it is these six). This
 * module still does its own, stricter artifact check on top of the shared
 * set: only these six get a `mismatch`/`missing` verdict, so a coder's
 * dispatch (never carries one) reads `not-applicable` rather than a false
 * `undeclared`.
 */
export { formatDeclaredArtifactLine, JUDGE_ROLES, parseDeclaredArtifactLine };

const JUDGE_ROLE_SET: ReadonlySet<string> = new Set(JUDGE_ROLES);

export type TurnsStatus = 'ok' | 'under' | 'over' | 'missing' | 'unverifiable';
export type ArtifactStatus =
  | 'ok'
  | 'missing'
  | 'relative'
  | 'mismatch'
  | 'not-applicable'
  | 'undeclared';

export interface TurnsCheck {
  status: TurnsStatus;
  stated: number | null;
  template: number | null;
}

export interface ArtifactCheck {
  status: ArtifactStatus;
  /** The line the prompt is expected to carry verbatim, or null when there is nothing to check against. */
  expected_line: string | null;
  /** The path the prompt's own line named, or null when it has none. */
  declared_line: string | null;
}

export type PreflightStatus =
  | 'ok'
  | 'missing'
  | 'ambiguous'
  | 'mismatch'
  | 'placeholder'
  | 'no-checks'
  | 'not-applicable';

export interface PreflightCheck {
  status: PreflightStatus;
  /** The one standalone `bs results check` line the prompt carries, or null. */
  line: string | null;
  /** Counted gate checks for a coder or tester prompt, null for any other role. */
  gate_checks: number | null;
}

export interface DispatchLintReport {
  turns: TurnsCheck;
  artifact: ArtifactCheck;
  preflight: PreflightCheck;
  exitCode: 0 | 1;
}

export interface DispatchLintInput {
  prompt: string;
  role: string;
  taskId: string;
  sessionId: string;
  agentsDir?: string;
  eventOpts?: EventOpts;
}

const TURN_BUDGET_LINE = /Turn budget:[ \t]*(\S*)/g;
const TURN_BUDGET_STANDALONE = /^Turn budget:[ \t]*(\S*)[ \t]*$/gm;

/**
 * `Turn budget: <n>` in a dispatch prompt — mid-sentence or on its own
 * line, since a dispatch's leading line names the role and the budget in
 * one breath ("Role: coder. Turn budget: 40 ..."). With exactly one
 * occurrence that occurrence is the statement. With several (spliced plan
 * text, lessons or findings may quote the label), the statement is the one
 * standalone line — the whole line is the label and its value, as the brief
 * composer writes it — and any other count of standalone lines is ambiguous.
 * Null for no occurrence, an ambiguous prompt, or a value that is not a bare
 * non-negative integer — every one of those is "cannot state a turn count",
 * not "states zero".
 */
export function parseStatedTurns(prompt: string): number | null {
  const matches = [...prompt.matchAll(TURN_BUDGET_LINE)];
  const chosen = matches.length > 1 ? [...prompt.matchAll(TURN_BUDGET_STANDALONE)] : matches;
  if (chosen.length !== 1) return null;
  const raw = chosen[0]?.[1] ?? '';
  return /^[0-9]+$/.test(raw) ? Number(raw) : null;
}

/** The heading the composer writes above a coder's or tester's gate check commands. */
export const GATE_CHECKS_HEADING =
  "Gate checks (run each over the whole project before you hand back; run a check marked heavy as your template's heavy-run section says, never bare):";

const PREFLIGHT_ROLES: ReadonlySet<string> = new Set(['coder', 'tester', 'grader']);
const CHECK_LIST_ROLES: ReadonlySet<string> = new Set(['coder', 'tester']);
const BARE_WORD = /^[A-Za-z0-9_./:@%+=,-]+$/;

/**
 * The one quoting rule for every value in a preflight line: a value of only
 * `A-Za-z0-9_./:@%+=,-` is written bare, any other is wrapped in single
 * quotes with each `'` inside it written `'\''`.
 */
export function shellQuote(value: string): string {
  return BARE_WORD.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** Splits a line by `shellQuote`'s rule; null when a quote is left open. */
function splitQuoted(line: string): string[] | null {
  const words: string[] = [];
  let word: string | null = null;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === "'") quoted = false;
      else word += ch;
    } else if (ch === "'") {
      quoted = true;
      word ??= '';
    } else if (ch === '\\' && i + 1 < line.length) {
      word = (word ?? '') + line[++i];
    } else if (/\s/.test(ch)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + ch;
    }
  }
  if (quoted) return null;
  if (word !== null) words.push(word);
  return words;
}

/** Standalone lines (the whole line, optionally in backticks) that start with `bs results check`. */
function standaloneResultsCheckLines(prompt: string): string[] {
  const found: string[] = [];
  for (const raw of prompt.split('\n')) {
    let line = raw.trim();
    if (line.length > 1 && line.startsWith('`') && line.endsWith('`')) line = line.slice(1, -1);
    if (/^bs results check(\s|$)/.test(line)) found.push(line);
  }
  return found;
}

/** Counted checks under the gate-checks heading: a `- ` line with a non-blank command line under it. */
function countGateChecks(prompt: string): number {
  const lines = prompt.split('\n');
  const at = lines.indexOf(GATE_CHECKS_HEADING);
  if (at < 0) return 0;
  let count = 0;
  let open = false;
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith('- ')) {
      open = true;
    } else if (line.startsWith('    ')) {
      if (open && line.trim() !== '') {
        count++;
        open = false;
      }
    } else {
      break;
    }
  }
  return count;
}

/**
 * The preflight check `lintDispatchPrompt` and `composeBrief` both call: a
 * coder, tester or grader prompt carries exactly one filled `bs results check`
 * line for this task and role, and a coder or tester prompt lists at least one
 * gate check. Every other role is not-applicable.
 */
export function checkPreflight(prompt: string, role: string, taskId: string): PreflightCheck {
  if (!PREFLIGHT_ROLES.has(role))
    return { status: 'not-applicable', line: null, gate_checks: null };
  const listed = CHECK_LIST_ROLES.has(role);
  const gateChecks = listed ? countGateChecks(prompt) : null;
  const lines = standaloneResultsCheckLines(prompt);
  if (lines.length !== 1) {
    return {
      status: lines.length === 0 ? 'missing' : 'ambiguous',
      line: null,
      gate_checks: gateChecks,
    };
  }
  const line = lines[0] as string;
  const words = splitQuoted(line);
  const asAt = words?.indexOf('--as') ?? -1;
  if (words === null || !taskIdsMatch(words[3], taskId) || asAt < 0 || words[asAt + 1] !== role) {
    return { status: 'mismatch', line, gate_checks: gateChecks };
  }
  if (words.some((word) => /<[^<>]+>/.test(word))) {
    return { status: 'placeholder', line, gate_checks: gateChecks };
  }
  if (listed && gateChecks === 0) return { status: 'no-checks', line, gate_checks: gateChecks };
  return { status: 'ok', line, gate_checks: gateChecks };
}

function checkTurns(prompt: string, role: string, agentsDir: string): TurnsCheck {
  const stated = parseStatedTurns(prompt);
  const template = readTemplateMaxTurns(agentsDir, role) ?? null;
  if (template === null) return { status: 'unverifiable', stated, template: null };
  if (stated === null) return { status: 'missing', stated: null, template };
  if (stated === template) return { status: 'ok', stated, template };
  return { status: stated < template ? 'under' : 'over', stated, template };
}

async function checkArtifact(
  prompt: string,
  role: string,
  taskId: string,
  sessionId: string,
  eventOpts: EventOpts,
): Promise<ArtifactCheck> {
  if (!JUDGE_ROLE_SET.has(role)) {
    return { status: 'not-applicable', expected_line: null, declared_line: null };
  }

  const declaredLine = parseDeclaredArtifactLine(prompt);
  const turns = await readJudgeTurns(taskId, { sessionId }, eventOpts);
  const turn = turns.find((t) => t.role === role);
  if (turn === undefined) {
    return { status: 'undeclared', expected_line: null, declared_line: declaredLine };
  }

  const expectedLine = formatDeclaredArtifactLine(turn.declaredArtifact);
  if (declaredLine === null) {
    return { status: 'missing', expected_line: expectedLine, declared_line: null };
  }
  if (!path.isAbsolute(declaredLine)) {
    return { status: 'relative', expected_line: expectedLine, declared_line: declaredLine };
  }
  if (declaredLine === turn.declaredArtifact) {
    return { status: 'ok', expected_line: expectedLine, declared_line: declaredLine };
  }
  return { status: 'mismatch', expected_line: expectedLine, declared_line: declaredLine };
}

// Fail closed: every status but "ok" exits non-zero, including "under" (a
// prompt that understates the template's budget still disagrees with it) and
// "unverifiable" (an unreadable template is not a pass, exactly like `dispatch
// check`, `tester check`, `delegation check`, and `escalation check` already
// treat "cannot tell" as a failure, never a maybe).
const TURNS_FAIL: ReadonlySet<TurnsStatus> = new Set(['under', 'over', 'missing', 'unverifiable']);
const ARTIFACT_FAIL: ReadonlySet<ArtifactStatus> = new Set([
  'missing',
  'relative',
  'mismatch',
  'undeclared',
]);

const PREFLIGHT_FAIL: ReadonlySet<PreflightStatus> = new Set([
  'missing',
  'ambiguous',
  'mismatch',
  'placeholder',
  'no-checks',
]);

/**
 * Lint one dispatch prompt. Never throws on a bad prompt — a bad prompt is
 * exactly the finding this reports — only on a missing task/session (the
 * caller's own mistake, same as every other verb that reads the ledger).
 */
export async function lintDispatchPrompt(input: DispatchLintInput): Promise<DispatchLintReport> {
  const agentsDir = input.agentsDir ?? AGENTS_DIR;
  const eventOpts = input.eventOpts ?? {};
  const turns = checkTurns(input.prompt, input.role, agentsDir);
  const artifact = await checkArtifact(
    input.prompt,
    input.role,
    input.taskId,
    input.sessionId,
    eventOpts,
  );
  const preflight = checkPreflight(input.prompt, input.role, input.taskId);
  const exitCode: 0 | 1 =
    TURNS_FAIL.has(turns.status) ||
    ARTIFACT_FAIL.has(artifact.status) ||
    PREFLIGHT_FAIL.has(preflight.status)
      ? 1
      : 0;
  return { turns, artifact, preflight, exitCode };
}
