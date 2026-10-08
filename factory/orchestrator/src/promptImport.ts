/**
 * `bs prompt import`: replay a Claude Code transcript into the home prompt
 * log, writing what the UserPromptSubmit and AskUserQuestion hooks would have
 * written had they been installed (design/prompt-capture.md §2.7, §2.8).
 */
import { readFileSync } from 'node:fs';
import {
  appendWithin,
  type EventInput,
  ROOT_EVENT_TYPE,
  readEvents,
  type StoredEvent,
} from './events.js';
import {
  type CaptureContext,
  CLI_ID,
  commandOf,
  newestMain,
  resolveCaptureStore,
} from './promptCapture.js';
import { isHarnessText, PromptError } from './prompts.js';

export interface ImportSummary {
  session_id: string;
  imported: number;
  skipped: { duplicate: number; older: number; harness: number; afk: number };
}

interface Candidate {
  ts: string;
  ms: number;
  cwd: string | undefined;
  payload: Record<string, unknown>;
  /** The payload key that dedupes this line, and its value. */
  key: 'prompt_id' | 'transcript_uuid';
  keyValue: string;
  command: string | undefined;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The text an AskUserQuestion result puts on the timeline; null when no one answered. */
function answerOf(result: Obj): { prompt: string; answers: Obj[]; response?: string } | null {
  const answers = isObj(result.answers) ? result.answers : {};
  const annotations = isObj(result.annotations) ? result.annotations : {};
  const questions = Array.isArray(result.questions) ? result.questions.filter(isObj) : [];
  const rows: Obj[] = [];
  for (const q of questions) {
    const question = str(q.question);
    const answer = question === undefined ? undefined : str(answers[question]);
    if (question === undefined || answer === undefined || answer === '') continue;
    const notes = isObj(annotations[question])
      ? str((annotations[question] as Obj).notes)
      : undefined;
    rows.push({
      question,
      header: str(q.header) ?? question,
      answer,
      ...(notes === undefined || notes === '' ? {} : { notes }),
    });
  }
  const response = str(result.response);
  const free = response === undefined || response === '' ? undefined : response;
  if (rows.length === 0 && free === undefined) return null;
  const prompt =
    rows.length > 0 ? rows.map((r) => `${r.header}: ${r.answer}`).join('\n') : (free as string);
  return { prompt, answers: rows, ...(free === undefined ? {} : { response: free }) };
}

/** `/name args` (or just `/name`) from a command echo; null without a command name. */
function commandText(content: string): string | null {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(content)?.[1]?.trim();
  if (name === undefined || name === '') return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(content)?.[1]?.trim() ?? '';
  return args === '' ? name : `${name} ${args}`;
}

type Classified = Candidate | 'harness' | 'afk' | null;

function classify(l: Obj): Classified {
  const ts = str(l.timestamp);
  const ms = Date.parse(ts ?? '');
  if (ts === undefined || Number.isNaN(ms)) return null;
  const uuid = str(l.uuid);
  const cwd = str(l.cwd);
  const base = { ts, ms, cwd };
  const origin = isObj(l.origin) ? str(l.origin.kind) : undefined;
  const flagged = l.isMeta === true || l.isCompactSummary === true || l.isSidechain === true;

  const result = isObj(l.toolUseResult) ? l.toolUseResult : undefined;
  if (l.type === 'user' && result !== undefined && 'questions' in result && 'answers' in result) {
    const message = isObj(l.message) ? l.message : {};
    const first = Array.isArray(message.content) ? message.content[0] : undefined;
    const toolUseId = isObj(first) ? str(first.tool_use_id) : undefined;
    if (toolUseId === undefined || l.isSidechain === true) return null;
    if (result.afkTimeoutMs !== undefined && result.afkTimeoutMs !== null) return 'afk';
    const got = answerOf(result);
    if (got === null) return null;
    if (isHarnessText(got.prompt)) return 'harness';
    return {
      ...base,
      key: 'prompt_id',
      keyValue: toolUseId,
      command: undefined,
      payload: {
        prompt: got.prompt,
        source: 'backfill',
        kind: 'answer',
        prompt_id: toolUseId,
        answers: got.answers,
        ...(got.response === undefined ? {} : { response: got.response }),
      },
    };
  }

  const text = (
    key: 'prompt_id' | 'transcript_uuid',
    keyValue: string | undefined,
    t: string,
  ): Classified => {
    if (keyValue === undefined) return null;
    if (isHarnessText(t)) return 'harness';
    const command = commandOf(t);
    return {
      ...base,
      key,
      keyValue,
      command,
      payload: {
        prompt: t,
        source: 'backfill',
        [key]: keyValue,
        ...(command === undefined ? {} : { command }),
      },
    };
  };

  if (l.type === 'user') {
    const message = isObj(l.message) ? l.message : {};
    if (origin !== 'human' || flagged || typeof message.content !== 'string') return null;
    const opening = message.content.trimStart();
    const typedCommand =
      opening.startsWith('<command-message') || opening.startsWith('<command-name')
        ? commandText(message.content)
        : null;
    return text('prompt_id', str(l.promptId) ?? uuid, typedCommand ?? message.content);
  }
  if (l.type === 'attachment') {
    const a = isObj(l.attachment) ? l.attachment : {};
    const aOrigin = isObj(a.origin) ? str(a.origin.kind) : undefined;
    if (a.type !== 'queued_command' || a.commandMode !== 'prompt' || aOrigin !== 'human')
      return null;
    if (flagged || typeof a.prompt !== 'string') return null;
    return text('transcript_uuid', uuid, a.prompt);
  }
  if (l.type === 'system' && l.subtype === 'local_command') {
    const content = str(l.content) ?? '';
    const t = commandText(content);
    if (t === null || uuid === undefined) return null;
    const command = commandOf(t);
    return {
      ...base,
      key: 'transcript_uuid',
      keyValue: uuid,
      command,
      payload: {
        prompt: t,
        source: 'backfill',
        transcript_uuid: uuid,
        ...(command === undefined ? {} : { command }),
      },
    };
  }
  return null;
}

function parseTranscript(file: string): {
  cli: string;
  candidates: Candidate[];
  harness: number;
  afk: number;
} {
  const lines: Obj[] = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isObj(parsed)) lines.push(parsed);
    } catch {
      // A torn line (a transcript still being written) is not a prompt.
    }
  }
  const ids = [...new Set(lines.map((l) => str(l.sessionId)).filter((v) => v !== undefined))];
  const cli = ids[0];
  if (ids.length !== 1 || cli === undefined || !CLI_ID.test(cli)) {
    throw new PromptError(
      'prompts.import-session-id',
      `A transcript must carry exactly one valid sessionId; "${file}" has ${ids.length === 0 ? 'none' : `${ids.length} (${ids.join(', ')})`}. Nothing was written.`,
      { transcript: file, session_ids: ids },
    );
  }
  const candidates: Candidate[] = [];
  let harness = 0;
  let afk = 0;
  for (const l of lines) {
    const c = classify(l);
    if (c === 'harness') harness++;
    else if (c === 'afk') afk++;
    else if (c !== null) candidates.push(c);
  }
  candidates.sort((a, b) => a.ms - b.ms);
  return { cli, candidates, harness, afk };
}

/**
 * Import one transcript. With `dryRun` nothing is written; either way `events`
 * is what is (or would be) appended, root included.
 */
export async function importTranscript(
  file: string,
  ctx: CaptureContext,
  opts: { dryRun?: boolean } = {},
): Promise<{ events: EventInput[]; summary: ImportSummary }> {
  const { cli, candidates, harness, afk } = parseTranscript(file);
  const home = `prompts-${cli}`;
  const summary: ImportSummary = {
    session_id: home,
    imported: 0,
    skipped: { duplicate: 0, older: 0, harness, afk },
  };
  const first = candidates[0];
  if (first === undefined) return { events: [], summary };

  const store = resolveCaptureStore({
    ...ctx,
    cwd: first.cwd ?? ctx.cwd,
    command: candidates.some((c) => c.command === 'bs') ? 'bs' : undefined,
  });
  if (store === null) {
    throw new PromptError(
      'prompts.import-unmanaged',
      `The first prompt of "${file}" ran in ${first.cwd ?? ctx.cwd}, which belongs to no Blacksmith store. Nothing was written.`,
      { transcript: file, cwd: first.cwd ?? ctx.cwd },
    );
  }

  const plan = (existing: readonly StoredEvent[]): EventInput[] => {
    summary.imported = 0;
    summary.skipped.duplicate = 0;
    summary.skipped.older = 0;
    const seen = new Set<string>();
    for (const e of existing) {
      for (const k of ['prompt_id', 'transcript_uuid'] as const) {
        const v = e.record.payload[k];
        if (typeof v === 'string') seen.add(v);
      }
    }
    const newest = existing.reduce((m, e) => Math.max(m, Date.parse(e.record.ts)), -Infinity);
    const fresh: Candidate[] = [];
    for (const c of candidates) {
      if (seen.has(c.keyValue)) summary.skipped.duplicate++;
      else if (c.ms < newest) summary.skipped.older++;
      else {
        seen.add(c.keyValue);
        fresh.push(c);
      }
    }
    summary.imported = fresh.length;
    if (fresh.length === 0) return [];

    const out: EventInput[] = [];
    const head = fresh[0] as Candidate;
    if (existing.length === 0) {
      out.push({
        session_id: home,
        actor: 'system',
        event_type: ROOT_EVENT_TYPE,
        plan_version: 1,
        causal_parent: null,
        payload: { kind: 'prompt-log' },
        cli_session_id: cli,
        ts: head.ts,
        ...(store.project === undefined ? {} : { project: store.project }),
      });
    }
    const anchor = newestMain(existing, cli) ?? existing[0];
    const project = anchor?.record.project ?? store.project;
    let parent = anchor?.event_id ?? `${home}#0`;
    for (const c of fresh) {
      out.push({
        session_id: home,
        actor: 'user',
        event_type: 'user_prompt',
        plan_version: anchor?.record.plan_version ?? 1,
        causal_parent: parent,
        payload: c.payload,
        cli_session_id: cli,
        ts: c.ts,
        ...(project === undefined ? {} : { project }),
      });
      parent = `${home}#${existing.length + out.length - 1}`;
    }
    return out;
  };

  const stateDir = store.eventsDir;
  if (opts.dryRun) return { events: plan(await readEvents(home, { stateDir })), summary };
  let events: EventInput[] = [];
  await appendWithin(
    home,
    (existing) => {
      events = plan(existing);
      return events;
    },
    { stateDir, cliSessionId: cli, keepTs: true },
  );
  return { events, summary };
}
