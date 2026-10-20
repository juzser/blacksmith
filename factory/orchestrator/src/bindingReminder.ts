/**
 * The binding reminder a bound session sees on every prompt turn (epic bs-use).
 *
 * It runs in the hook process beside the capture and is independent of it: a
 * duplicate prompt, a harness-text prompt or a capture that fails still gets
 * its reminder, and a failing reminder never costs the capture its line. It
 * reads and writes nothing but the policy file and the tail of the session's
 * home log; it refuses and holds nothing.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import type { EventRecord } from './events.js';
import { normalizeProjectName } from './projectName.js';
import {
  type CaptureContext,
  CLI_ID,
  capturePrompt,
  commandOf,
  isObj,
  resolveCaptureStore,
  str,
} from './promptCapture.js';
import {
  BINDING_TAIL_BYTES,
  bindingFromTail,
  loadBindingPolicy,
  notRecordedLines,
  parseUseCommand,
  reminderLines,
  resolveUseProject,
  unknownProjectLines,
} from './sessionBinding.js';

/** The records in the last BINDING_TAIL_BYTES of a log; a line that is not JSON throws. */
function readTail(file: string): EventRecord[] {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - BINDING_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    let window = buf.subarray(0, got);
    if (start > 0) window = window.subarray(window.indexOf(0x0a) + 1 || window.length);
    return window
      .toString('utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as EventRecord);
  } finally {
    closeSync(fd);
  }
}

/** The reminder lines for one prompt payload; [] for anything that is not a main-thread prompt. */
export async function bindingReminder(raw: string, ctx: CaptureContext): Promise<string[]> {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isObj(input) || input.agent_id !== undefined) return [];
  const cli = str(input.session_id);
  const prompt = str(input.prompt);
  if (cli === undefined || !CLI_ID.test(cli) || prompt === undefined) return [];

  const cwd = str(input.cwd) ?? ctx.cwd;
  const store = resolveCaptureStore({ ...ctx, cwd, command: commandOf(prompt) });
  const use = parseUseCommand(prompt);
  if (use === null && (store === null || store.rule === 'M3')) return [];
  if (store === null || store.rule === 'M3') return notRecordedLines();

  const binding = bindingFromTail(
    readTail(path.join(store.eventsDir, `prompts-${cli}.jsonl`)),
    cli,
  );
  const standing = binding === undefined ? [] : reminderLines(binding.project, loadBindingPolicy());
  if (use === null) return standing;

  let known: string[] = [];
  let matched: string | undefined;
  try {
    ({ known, matched } = resolveUseProject(use.name, {
      repoRoot: ctx.repoRoot,
      cwd,
      env: ctx.env,
      isClone: ctx.isClone,
      roadmapPath: ctx.roadmapPath,
    }));
  } catch {
    // A failing resolver reads as an unknown name.
  }
  if (matched === undefined) return [...unknownProjectLines(known), ...standing];
  if (
    binding !== undefined &&
    normalizeProjectName(binding.project) === normalizeProjectName(matched)
  ) {
    return standing;
  }
  return [...notRecordedLines(), ...standing];
}

export interface TurnSteps {
  capture: (raw: string, ctx: CaptureContext) => Promise<string | null>;
  reminder: (raw: string, ctx: CaptureContext) => Promise<string[]>;
}

/** The capture line (when one was written) then the reminder lines; each step fails alone. */
export async function promptTurnLines(
  raw: string,
  ctx: CaptureContext,
  steps: TurnSteps = {
    capture: (r, c) => capturePrompt(r, c, 'prompt'),
    reminder: bindingReminder,
  },
): Promise<string[]> {
  const out: string[] = [];
  try {
    const line = await steps.capture(raw, ctx);
    if (typeof line === 'string') out.push(line);
  } catch {
    // A capture that fails loses one record; the reminder still runs.
  }
  try {
    out.push(...(await steps.reminder(raw, ctx)));
  } catch {
    // A reminder that fails loses one reminder; the capture line stands.
  }
  return out;
}
const _m = matchProject('x', []);
// matchProject(x)
