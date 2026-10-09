#!/usr/bin/env node
/**
 * `.claude/hooks/judge-stop.sh` — the SubagentStop decision for a judge-class
 * agent (reviewer, verifier, grader, spec-reviewer, security-reviewer,
 * auditor; `JUDGE_ROLES` in dispatchLint.ts is the authoritative set).
 *
 * A judge can end its turn without ever writing the artifact its dispatch
 * declared, and today that gap is found only downstream, when `smith judge
 * report` answers `judges.artifact-missing` — after the agent is gone. This
 * hook closes the loop at the one moment it can still act: block the stop
 * while the declared path does not exist, allow it once it does. A harness
 * `maxTurns` cap is out of scope; this hook cannot override it.
 *
 * The declared-artifact line and its parser come from `dispatchLint.ts`,
 * never redefined — `dispatch lint` already refuses, before dispatch, any
 * judge prompt whose line is missing, relative, or mismatched, so this hook
 * only asks "does the file exist yet", never "is the line well-formed".
 *
 * Fail open on anything this hook cannot read: a non-judge `agent_type`, a
 * prompt with no declared-artifact line, a relative path, unparseable stdin,
 * an unreadable transcript — blocking on those would trap the agent until
 * `maxTurns` for an obligation the hook could never state. Every fail-open
 * path prints a stderr note and is covered upstream by `dispatch lint` or
 * downstream by `judge report`'s `judges.artifact-missing`.
 *
 * Fail closed ONLY on a readable absolute declared path that does not exist.
 *
 * The dispatch prompt is read from `agent_transcript_path`. Per
 * https://code.claude.com/docs/en/hooks#subagentstop: "The `transcript_path`
 * is the main session's transcript, while `agent_transcript_path` is the
 * subagent's own transcript stored in a nested `subagents/` folder." Only an
 * older CLI that sends no `agent_transcript_path` falls back to
 * `transcript_path`, which fails open (its last user turn is not the dispatch).
 *
 * SubagentStop stdin fields: https://code.claude.com/docs/en/hooks
 */
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { JUDGE_ROLES, parseDeclaredArtifactLine } from './dispatchLint.js';

const JUDGE_ROLE_SET: ReadonlySet<string> = new Set(JUDGE_ROLES);

/** The SubagentStop payload Claude Code pipes to this hook on stdin. */
export interface SubagentStopHookInput {
  session_id?: string;
  prompt_id?: string;
  /** The MAIN session's transcript, not the subagent's. */
  transcript_path?: string;
  /** The subagent's own transcript (nested `subagents/` folder). */
  agent_transcript_path?: string;
  /** Documented on SubagentStop; this hook does not read it. */
  last_assistant_message?: string;
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

  // Existence is this hook's whole question -- an empty or unparseable file
  // is `judge report`'s to refuse (`judges.artifact-unparseable`, `judges.
  // artifact-not-a-list`), not this hook's to trap the agent over.
  return { decision: 'allow' };
}

/**
 * The last user-role message's text in a Claude Code JSONL transcript --
 * where a dispatch prompt and its "Declared artifact:" line live. Streams
 * the file in fixed-size chunks (a transcript can pass 512 MB, where a
 * whole-file read throws), splitting on `\n` only and keeping the last
 * user-role text seen; work is linear in file size because only the newly
 * read chunk is scanned for line breaks. A torn or unparseable line is
 * skipped. Returns `null` on any read failure or when no user text exists.
 */
export function extractLastUserPromptText(
  transcriptPath: string,
  chunkSize = 64 * 1024,
): string | null {
  let fd: number;
  try {
    fd = openSync(transcriptPath, 'r');
  } catch {
    return null;
  }
  let last: string | null = null;
  const consume = (line: string): void => {
    if (line.trim() === '') return;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const text = userTextOf(entry);
    if (text !== null) last = text;
  };
  try {
    const buf = Buffer.alloc(chunkSize);
    const decoder = new StringDecoder('utf8');
    let carry: string[] = [];
    for (;;) {
      const n = readSync(fd, buf, 0, chunkSize, null);
      if (n === 0) break;
      const chunk = decoder.write(buf.subarray(0, n));
      let start = 0;
      for (let nl = chunk.indexOf('\n'); nl !== -1; nl = chunk.indexOf('\n', start)) {
        carry.push(chunk.slice(start, nl));
        consume(carry.join(''));
        carry = [];
        start = nl + 1;
      }
      if (start < chunk.length) carry.push(chunk.slice(start));
    }
    carry.push(decoder.end());
    consume(carry.join(''));
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // nothing to do about a failed close
    }
  }
  return last;
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
 * The whole hook, minus process I/O: parse stdin, read the prompt, decide,
 * and format the two output streams Claude Code and an operator each read.
 * Exercised directly by tests without spawning a process; `main` below is
 * the only piece that touches fd 0 and process.exit.
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

  // Older CLIs send no agent_transcript_path; the fallback then reads the
  // main transcript, whose last user turn carries no declared line, so the
  // hook fails open there exactly as before.
  const promptPath =
    typeof input.agent_transcript_path === 'string' && input.agent_transcript_path !== ''
      ? input.agent_transcript_path
      : input.transcript_path;
  const promptText = promptPath ? extractLastUserPromptText(promptPath) : null;
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
