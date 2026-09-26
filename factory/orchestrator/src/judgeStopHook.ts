#!/usr/bin/env node
/**
 * `.claude/hooks/judge-stop.sh` — the SubagentStop decision for a judge-class
 * agent (dispatch.md "Fingerprint the worktree around every judge": reviewer,
 * verifier, grader, spec-reviewer, security-reviewer, uiux).
 *
 * A judge can end its turn without ever writing the artifact its dispatch
 * declared, and today that gap is found only downstream, when `smith judge
 * report` answers `judges.artifact-missing` — after the agent is gone. This
 * hook closes the loop at the one moment it can still act: it blocks the stop
 * while the declared path does not exist, and allows it once it does. A
 * harness `maxTurns` cap is out of scope; this hook cannot override it.
 *
 * The declared-artifact line and its parser are imported from
 * `dispatchLint.ts`, never redefined — that module's `dispatch lint` already
 * refuses, fail-closed and before dispatch, any judge prompt whose line is
 * missing, relative, or different from the ledger's `declared_artifact`, so
 * this hook only has to ask "does the file exist yet", never "is the line
 * well-formed" (that question, and everything about *parse* validity once
 * the file exists, stays `judge report`'s).
 *
 * Fail open on anything this hook cannot read: a non-judge `agent_type`, a
 * prompt with no declared-artifact line, a relative path, unparseable stdin,
 * an unreadable transcript. Blocking on any of those would trap the agent
 * until `maxTurns` with no way out to discharge an obligation the hook could
 * never even state. Every fail-open path prints a stderr note; every one of
 * them is covered upstream by `dispatch lint` (missing/relative line) or
 * downstream by `judge outstanding` / `judge report`'s
 * `judges.artifact-missing` (all four).
 *
 * Fail closed ONLY on a readable absolute declared path that does not exist.
 *
 * SubagentStop stdin fields (session_id, prompt_id, transcript_path, cwd,
 * scratchpad_dir, permission_mode, hook_event_name, agent_id, agent_type):
 * https://code.claude.com/docs/en/hooks
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JUDGE_ROLES, parseDeclaredArtifactLine } from './dispatchLint.js';

const JUDGE_ROLE_SET: ReadonlySet<string> = new Set(JUDGE_ROLES);

/** The SubagentStop payload Claude Code pipes to this hook on stdin. */
export interface SubagentStopHookInput {
  session_id?: string;
  prompt_id?: string;
  transcript_path?: string;
  cwd?: string;
  scratchpad_dir?: string;
  permission_mode?: string;
  hook_event_name?: string;
  agent_id?: string;
  agent_type?: string;
  /** Set on re-entry, once this same hook has already blocked once. */
  stop_hook_active?: boolean;
}

export type JudgeStopDecision =
  | { decision: 'block'; reason: string }
  | { decision: 'allow'; note?: string };

/**
 * The pure decision: given the hook's stdin and the subagent's prompt text
 * (or `null` when it could not be read at all), decide whether the stop is
 * allowed. Touches the filesystem only to check whether the declared path
 * exists -- the one question this hook exists to ask.
 */
export function decideJudgeStop(
  input: SubagentStopHookInput,
  promptText: string | null,
): JudgeStopDecision {
  const agentType = input.agent_type;
  if (agentType === undefined || !JUDGE_ROLE_SET.has(agentType)) {
    // Not one of the six judge roles -- a coder's turn carries no declared
    // artifact at all, so there is nothing for this hook to check.
    return { decision: 'allow' };
  }

  if (promptText === null) {
    return {
      decision: 'allow',
      note:
        "judge-stop: could not read this agent's prompt (transcript missing or " +
        "unreadable); allowing the stop. judge report's judges.artifact-missing " +
        'remains the backstop.',
    };
  }

  const declared = parseDeclaredArtifactLine(promptText);
  if (declared === null) {
    return {
      decision: 'allow',
      note:
        'judge-stop: no "Declared artifact: <path>" line in this prompt; allowing ' +
        "the stop. dispatch lint refuses this before dispatch, and judge report's " +
        'judges.artifact-missing catches it downstream.',
    };
  }

  if (!path.isAbsolute(declared)) {
    return {
      decision: 'allow',
      note:
        `judge-stop: declared artifact "${declared}" is not an absolute path; ` +
        'allowing the stop. dispatch lint refuses this before dispatch, and judge ' +
        "report's judges.artifact-missing catches it downstream.",
    };
  }

  if (!existsSync(declared)) {
    return {
      decision: 'block',
      reason: `Declared artifact ${declared} does not exist yet. Write it before ending this turn.`,
    };
  }

  return { decision: 'allow' };
}

/**
 * The last user-role message's text in a Claude Code JSONL transcript --
 * where a dispatch prompt, and its "Declared artifact:" line, lives. Reads
 * from the end since a subagent's transcript can carry many turns; the
 * dispatch prompt is the first user turn, not necessarily the only one, so
 * this walks backward past assistant turns rather than assuming line 0.
 * Returns `null` on any read or parse failure -- unreadable is unreadable,
 * not a parse error to surface differently.
 */
export function extractLastUserPromptText(transcriptPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const text = userTextOf(entry);
    if (text !== null) return text;
  }
  return null;
}

function userTextOf(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const rec = entry as Record<string, unknown>;
  if (rec.type !== 'user') return null;
  const message = rec.message;
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter(
        (block): block is Record<string, unknown> => typeof block === 'object' && block !== null,
      )
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string);
    if (parts.length > 0) return parts.join('\n');
  }
  return null;
}

export interface JudgeStopHookResult {
  /** JSON to print on stdout for a block, or '' for an allow. */
  stdout: string;
  /** A fail-open explanation, or '' when there is none to print. */
  stderr: string;
}

/**
 * The whole hook, minus process I/O: parse stdin, locate and read the
 * prompt, decide, and format the two output streams Claude Code and an
 * operator each read. Exercised directly by tests (unparseable stdin,
 * unreadable transcript) without spawning a process; `main` below is the
 * only piece that touches fd 0 and process.exit.
 */
export function runJudgeStopHook(rawStdin: string): JudgeStopHookResult {
  let input: SubagentStopHookInput;
  try {
    input = JSON.parse(rawStdin) as SubagentStopHookInput;
  } catch {
    return {
      stdout: '',
      stderr:
        'judge-stop: could not parse stdin as JSON; allowing the stop. ' +
        "judge report's judges.artifact-missing remains the backstop.\n",
    };
  }

  const promptText = input.transcript_path
    ? extractLastUserPromptText(input.transcript_path)
    : null;
  const result = decideJudgeStop(input, promptText);
  if (result.decision === 'block') {
    return {
      stdout: `${JSON.stringify({ decision: 'block', reason: result.reason })}\n`,
      stderr: '',
    };
  }
  return { stdout: '', stderr: result.note ? `${result.note}\n` : '' };
}

function main(): void {
  const { stdout, stderr } = runJudgeStopHook(readFileSync(0, 'utf8'));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

// Runs only when executed directly (judge-stop.sh execs `node
// dist/judgeStopHook.js`) -- importing this module for its exports, as the
// tests do, must never read stdin as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
