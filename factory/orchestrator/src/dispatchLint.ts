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
import type { EventOpts } from './events.js';
import { readJudgeTurns } from './judges.js';
import { AGENTS_DIR } from './paths.js';

/**
 * The six roles dispatch.md's "Fingerprint the worktree around every judge"
 * names as judges. Kept as its own list rather than read out of judges.ts:
 * `foldJudgeTurns` folds any role with a `declared_artifact` on its dispatch
 * into a turn, but this module is stricter on purpose — only these six get
 * an artifact check, so a coder's dispatch (never carries one) reads
 * `not-applicable` rather than a false `undeclared`.
 */
export const JUDGE_ROLES = [
  'reviewer',
  'verifier',
  'grader',
  'spec-reviewer',
  'security-reviewer',
  'uiux',
] as const;
export type JudgeRole = (typeof JUDGE_ROLES)[number];
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

export interface DispatchLintReport {
  turns: TurnsCheck;
  artifact: ArtifactCheck;
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

/**
 * `Turn budget: <n>` in a dispatch prompt — mid-sentence or on its own
 * line, since a dispatch's leading line names the role and the budget in
 * one breath ("Role: coder. Turn budget: 40 ..."). Null for no occurrence,
 * more than one (two numbers is no number), or a value that is not a bare
 * non-negative integer — every one of those is "cannot state a turn count",
 * not "states zero".
 */
export function parseStatedTurns(prompt: string): number | null {
  const matches = [...prompt.matchAll(TURN_BUDGET_LINE)];
  if (matches.length !== 1) return null;
  const raw = matches[0]?.[1] ?? '';
  return /^[0-9]+$/.test(raw) ? Number(raw) : null;
}

const DECLARED_ARTIFACT_LINE = /^Declared artifact:[ \t]*(\S+)[ \t]*$/m;

/** `Declared artifact: <path>` in a dispatch prompt, or null when the line is not there. */
export function parseDeclaredArtifactLine(prompt: string): string | null {
  const match = DECLARED_ARTIFACT_LINE.exec(prompt);
  return match?.[1] ?? null;
}

/** The line a dispatch is expected to carry verbatim, given the ledger's declared path. */
export function formatDeclaredArtifactLine(artifactPath: string): string {
  return `Declared artifact: ${artifactPath}`;
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
  if (declaredLine === turn.declaredArtifact) {
    return { status: 'ok', expected_line: expectedLine, declared_line: declaredLine };
  }
  if (!path.isAbsolute(declaredLine)) {
    return { status: 'relative', expected_line: expectedLine, declared_line: declaredLine };
  }
  return { status: 'mismatch', expected_line: expectedLine, declared_line: declaredLine };
}

const TURNS_FAIL: ReadonlySet<TurnsStatus> = new Set(['over', 'missing']);
const ARTIFACT_FAIL: ReadonlySet<ArtifactStatus> = new Set([
  'missing',
  'relative',
  'mismatch',
  'undeclared',
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
  const exitCode: 0 | 1 =
    TURNS_FAIL.has(turns.status) || ARTIFACT_FAIL.has(artifact.status) ? 1 : 0;
  return { turns, artifact, exitCode };
}
