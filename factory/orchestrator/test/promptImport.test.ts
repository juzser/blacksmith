import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEvents } from '../src/events.js';
import { importTranscript } from '../src/promptImport.js';

// Every transcript, session id and prompt below is invented. Every store is a
// temp dir reached through BS_HOME, never a real one.
const CLI = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const HOME_LOG = `prompts-${CLI}`;

let base: string;
let eventsDir: string;
let file: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'bs-import-')));
  eventsDir = path.join(base, 'home', 'state', 'events');
  mkdirSync(eventsDir, { recursive: true });
  file = path.join(base, 'transcript.jsonl');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const ctx = (over: { env?: Record<string, string>; isClone?: boolean } = {}) => ({
  cwd: base,
  env: over.env ?? { BS_HOME: path.join(base, 'home') },
  repoRoot: path.join(base, 'pkg'),
  isClone: over.isClone ?? false,
  roadmapPath: path.join(base, 'pkg', 'roadmap.md'),
});

const at = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

const line = (n: number, extra: Record<string, unknown>) => ({
  sessionId: CLI,
  cwd: path.join(base, 'acme'),
  uuid: `uuid-${n}`,
  timestamp: at(n),
  ...extra,
});

const typed = (n: number, text: string, extra: Record<string, unknown> = {}) =>
  line(n, {
    type: 'user',
    origin: { kind: 'human' },
    promptId: `prompt-${n}`,
    message: { role: 'user', content: text },
    ...extra,
  });

const queued = (n: number, text: string, extra: Record<string, unknown> = {}) =>
  line(n, {
    type: 'attachment',
    attachment: {
      type: 'queued_command',
      commandMode: 'prompt',
      prompt: text,
      origin: { kind: 'human' },
    },
    ...extra,
  });

const slash = (n: number, name: string, args: string) =>
  line(n, {
    type: 'system',
    subtype: 'local_command',
    content: `<command-name>${name}</command-name>\n<command-message>x</command-message>\n<command-args>${args}</command-args>`,
  });

const echo = (name: string, args?: string): string =>
  `<command-message>${name.slice(1)}</command-message>\n<command-name>${name}</command-name>${
    args === undefined ? '' : `\n<command-args>${args}</command-args>`
  }`;

const answer = (n: number, extra: Record<string, unknown> = {}) =>
  line(n, {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${n}` }] },
    toolUseResult: {
      questions: [
        { question: 'Which store?', header: 'Store', options: [] },
        { question: 'Skipped one?', header: 'Other', options: [] },
      ],
      answers: { 'Which store?': 'Home log' },
      ...extra,
    },
  });

const write = (...lines: unknown[]): void =>
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

const run = (dryRun = false, c = ctx()) => importTranscript(file, c, { dryRun });

const stored = async () =>
  (await readEvents(HOME_LOG, { stateDir: eventsDir })).map((e) => e.record);

describe('importTranscript: what counts as a prompt', () => {
  it('turns each source into one event with its key', async () => {
    write(
      typed(1, 'Add the beta-app export.'),
      queued(2, 'Also rename the flag.'),
      slash(3, '/bs-mod', 'off'),
      slash(4, '/clear', ''),
      answer(5),
    );
    const { summary } = await run();
    expect(summary).toEqual({
      session_id: HOME_LOG,
      imported: 5,
      skipped: { duplicate: 0, older: 0, harness: 0, afk: 0 },
    });
    const events = (await stored()).slice(1);
    expect(events.map((e) => e.payload)).toEqual([
      { prompt: 'Add the beta-app export.', source: 'backfill', prompt_id: 'prompt-1' },
      { prompt: 'Also rename the flag.', source: 'backfill', transcript_uuid: 'uuid-2' },
      { prompt: '/bs-mod off', source: 'backfill', transcript_uuid: 'uuid-3', command: 'bs-mod' },
      { prompt: '/clear', source: 'backfill', transcript_uuid: 'uuid-4', command: 'clear' },
      {
        prompt: 'Store: Home log',
        source: 'backfill',
        kind: 'answer',
        prompt_id: 'toolu_5',
        answers: [{ question: 'Which store?', header: 'Store', answer: 'Home log' }],
      },
    ]);
    for (const e of events) {
      expect(e.cli_session_id).toBe(CLI);
      expect(e.actor).toBe('user');
      expect(e.event_type).toBe('user_prompt');
    }
  });

  it('writes the home log root with the transcript session id', async () => {
    write(typed(1, 'Add the beta-app export.'));
    await run();
    const [root] = await stored();
    expect(root).toMatchObject({
      actor: 'system',
      event_type: 'session-start',
      payload: { kind: 'prompt-log' },
      cli_session_id: CLI,
      ts: at(1),
    });
  });

  it('skips peer, task-notification, meta, compact-summary and sidechain lines', async () => {
    write(
      typed(1, 'from a peer', { origin: { kind: 'peer' } }),
      typed(2, 'a notification', { origin: { kind: 'task-notification' } }),
      typed(3, 'meta text', { isMeta: true }),
      typed(4, 'This session is being continued from a previous one.', { isCompactSummary: true }),
      typed(5, 'a subagent turn', { isSidechain: true }),
      queued(6, 'queued from a peer', {
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          prompt: 'x',
          origin: { kind: 'peer' },
        },
      }),
      queued(7, 'queued meta', { isMeta: true }),
      line(8, {
        type: 'system',
        subtype: 'local_command',
        content: '<local-command-stdout>done</local-command-stdout>',
      }),
    );
    const { summary } = await run();
    expect(summary.imported).toBe(0);
    expect(readdirSync(eventsDir)).toEqual([]);
  });

  it('counts harness text and afk answers instead of importing them', async () => {
    write(
      typed(1, '<system-reminder>noise</system-reminder>'),
      answer(2, { afkTimeoutMs: 60000 }),
      typed(3, 'A real one.'),
    );
    const { summary } = await run();
    expect(summary.imported).toBe(1);
    expect(summary.skipped).toEqual({ duplicate: 0, older: 0, harness: 1, afk: 1 });
  });
});

describe('importTranscript: typed slash commands', () => {
  it('imports a typed /bs command as one backfill prompt', async () => {
    write(typed(1, echo('/bs', 'run acme-1'), { promptId: 'p-cmd' }));
    const { summary } = await run();
    expect(summary.imported).toBe(1);
    expect(summary.skipped.harness).toBe(0);
    const [, ev] = await stored();
    expect(ev?.payload).toMatchObject({
      prompt: '/bs run acme-1',
      command: 'bs',
      prompt_id: 'p-cmd',
      source: 'backfill',
    });
  });

  it('drops the trailing space when args are empty or the tag is missing', async () => {
    write(typed(1, echo('/insights', '')), typed(2, echo('/insights')));
    const { summary } = await run();
    expect(summary.imported).toBe(2);
    const events = (await stored()).slice(1);
    expect(events.map((e) => (e.payload as { prompt: string }).prompt)).toEqual([
      '/insights',
      '/insights',
    ]);
  });

  it('a second run counts the typed command as duplicate', async () => {
    write(typed(1, echo('/bs', 'run acme-1')));
    await run();
    const second = await run();
    expect(second.summary.imported).toBe(0);
    expect(second.summary.skipped.duplicate).toBe(1);
  });

  it('M3: a typed /bs line alone makes a bare work root count', async () => {
    const root = path.join(base, 'pkg');
    mkdirSync(path.join(root, '.git'), { recursive: true });
    mkdirSync(path.join(root, 'state', 'events'), { recursive: true });
    write(typed(1, echo('/bs', 'status')));
    const { summary } = await run(true, ctx({ env: {}, isClone: true }));
    expect(summary.imported).toBe(1);
  });

  it('ignores the echo on a line that is not human, and does not count it', async () => {
    write(typed(1, echo('/bs', 'status'), { origin: undefined }), typed(2, 'Real.'));
    const { summary } = await run();
    expect(summary.imported).toBe(1);
    expect(summary.skipped.harness).toBe(0);
  });

  it('keeps a command-message without a command-name as harness', async () => {
    write(typed(1, '<command-message>bs</command-message>'));
    const { summary } = await run();
    expect(summary.imported).toBe(0);
    expect(summary.skipped.harness).toBe(1);
  });
});

describe('importTranscript: dedupe, order and timestamps', () => {
  it('a second run imports nothing and counts every line as duplicate', async () => {
    write(typed(1, 'One.'), queued(2, 'Two.'), slash(3, '/x', ''), answer(4));
    await run();
    const second = await run();
    expect(second.summary).toEqual({
      session_id: HOME_LOG,
      imported: 0,
      skipped: { duplicate: 4, older: 0, harness: 0, afk: 0 },
    });
    expect(await stored()).toHaveLength(5);
  });

  it('keeps the transcript timestamps, sorted', async () => {
    write(typed(3, 'Third.'), typed(1, 'First.'), typed(2, 'Second.'));
    await run();
    const events = await stored();
    expect(events.map((e) => e.ts)).toEqual([at(1), at(1), at(2), at(3)]);
    expect(events.slice(1).map((e) => e.payload.prompt)).toEqual(['First.', 'Second.', 'Third.']);
  });

  it('chains each event to the one before it', async () => {
    write(typed(1, 'First.'), typed(2, 'Second.'));
    await run();
    const stored2 = await readEvents(HOME_LOG, { stateDir: eventsDir });
    expect(stored2.map((e) => e.record.causal_parent)).toEqual([
      null,
      `${HOME_LOG}#0`,
      `${HOME_LOG}#1`,
    ]);
  });

  it('drops lines older than the newest event in the home log', async () => {
    write(typed(1, 'One.'), typed(2, 'Two.'));
    await run();
    write(typed(1, 'One.'), typed(2, 'Two.'), typed(0, 'Before it all.'), typed(3, 'Three.'));
    const { summary } = await run();
    expect(summary.imported).toBe(1);
    expect(summary.skipped).toMatchObject({ duplicate: 2, older: 1 });
    expect((await stored()).at(-1)?.payload.prompt).toBe('Three.');
  });
});

describe('importTranscript: --dry-run', () => {
  it('writes nothing and returns the events it would append', async () => {
    write(typed(1, 'One.'), typed(2, 'Two.'));
    const dry = await run(true);
    expect(readdirSync(eventsDir)).toEqual([]);
    expect(dry.events).toHaveLength(3);
    const live = await run();
    expect(dry.summary).toEqual(live.summary);
    expect(dry.events.map((e) => [e.event_type, e.ts, e.payload])).toEqual(
      (await stored()).map((e) => [e.event_type, e.ts, e.payload]),
    );
  });
});

describe('importTranscript: refusals', () => {
  it('refuses two session ids, and none', async () => {
    write(typed(1, 'One.'), {
      ...typed(2, 'Two.'),
      sessionId: '1111aaaa-0000-4000-8000-000000000000',
    });
    await expect(run()).rejects.toMatchObject({ code: 'prompts.import-session-id' });
    write({ type: 'summary' });
    await expect(run()).rejects.toMatchObject({ code: 'prompts.import-session-id' });
    expect(readdirSync(eventsDir)).toEqual([]);
  });

  it('exits with prompts.import-unmanaged when the cwd resolves to no store', async () => {
    write(typed(1, 'One.'));
    await expect(run(false, ctx({ env: {} }))).rejects.toMatchObject({
      code: 'prompts.import-unmanaged',
    });
  });

  it('M3: a bs command makes a bare work root count', async () => {
    const root = path.join(base, 'pkg');
    mkdirSync(path.join(root, '.git'), { recursive: true });
    mkdirSync(path.join(root, 'state', 'events'), { recursive: true });
    write(slash(1, '/bs', 'status'));
    const { summary } = await run(true, ctx({ env: {}, isClone: true }));
    expect(summary.imported).toBe(1);
  });
});
