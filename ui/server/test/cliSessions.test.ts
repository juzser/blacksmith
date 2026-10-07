import { execFileSync } from 'node:child_process';
import { closeSync, constants as fsConstants, openSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../../factory/orchestrator/dist/db/projector.js';
import { rebuild } from '../../../factory/orchestrator/src/db/projector.js';
import { appendEvent, readEvents, startSession } from '../../../factory/orchestrator/src/events.js';
import {
  buildFixture,
  EPIC_ID,
  SESSION_ID,
} from '../../../factory/orchestrator/test/db/fixtures.js';
import {
  type CliFs,
  type CliSessionsResponse,
  createCliSessionsReader,
  liveSessionCwds,
  parsePsStarts,
} from '../src/cliSessions.js';

const SID_A = '11111111-1111-4111-8111-111111111111';
const SID_B = '22222222-2222-4222-8222-222222222222';
const SID_C = '33333333-3333-4333-8333-333333333333';
const SENTINEL = 'KEY-SENTINEL-DO-NOT-LEAK';
const NOW = '2026-10-06T12:00:00.000Z';

const asst = (...blocks: unknown[]) => ({
  type: 'assistant',
  message: { role: 'assistant', content: blocks },
});
const text = (t: string) => ({ type: 'text', text: t });
const user = (t: string) => ({ type: 'user', message: { role: 'user', content: t } });
const toolUse = (name: string, id: string, input: unknown = {}) => ({
  type: 'tool_use',
  name,
  id,
  input,
});
const toolResult = (id: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
const launchRec = (agentId: string, timestamp = '2026-10-06T11:00:00.000Z') => ({
  type: 'user',
  timestamp,
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: `tu-${agentId}`,
        content: `Async agent launched successfully.\nagentId: ${agentId}`,
      },
    ],
  },
  toolUseResult: { isAsync: true, status: 'async_launched', agentId },
});
const notifyRec = (agentId: string, status: string | null, asBlock = false) => {
  const body = `<task-notification>\n<task-id>${agentId}</task-id>\n${
    status === null ? '' : `<status>${status}</status>\n`
  }</task-notification>`;
  return {
    type: 'user',
    timestamp: '2026-10-06T11:20:00.000Z',
    origin: { kind: 'task-notification' },
    message: { role: 'user', content: asBlock ? [{ type: 'text', text: body }] : body },
  };
};
/** Narrows a value a test needs; fails loudly instead of asserting with `!`. */
function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error('expected a value');
  return x;
}
/** The CLI's name for a cwd's transcript directory. */
const slug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-');
const jsonl = (entries: unknown[]) => `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;

describe('cliSessions reader', () => {
  let tmp: string;
  let config: string;
  let root: string;
  let outside: string;
  const alive = new Set<number>();

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(path.join(tmpdir(), 'smith-cli-')));
    config = path.join(tmp, 'config');
    root = path.join(tmp, 'proj', 'repo');
    outside = path.join(tmp, 'elsewhere');
    await mkdir(path.join(config, 'sessions'), { recursive: true });
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    alive.clear();
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function session(
    pid: number,
    over: Record<string, unknown> = {},
    opts: { alive?: boolean; raw?: string; filename?: string } = {},
  ): Promise<void> {
    const body = {
      pid,
      sessionId: SID_A,
      cwd: root,
      kind: 'interactive',
      entrypoint: 'cli',
      status: 'busy',
      name: 'one',
      nameSource: 'user',
      version: '2.1.290',
      startedAt: Date.parse('2026-10-06T10:00:00Z'),
      statusUpdatedAt: Date.parse('2026-10-06T11:30:00Z'),
      messagingSocketPath: '/secret/socket',
      procStart: 'Mon Oct 6 10:00:00 2026',
      ...over,
    };
    await writeFile(
      path.join(config, 'sessions', opts.filename ?? `${pid}.json`),
      opts.raw ?? JSON.stringify(body),
    );
    if (opts.alive !== false) alive.add(pid);
  }

  async function transcript(
    cwd: string,
    sid: string,
    content: string,
    encode = true,
  ): Promise<string> {
    const dir = path.join(config, 'projects', encode ? slug(cwd) : '-wrong-dir');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${sid}.jsonl`);
    await writeFile(file, content);
    return file;
  }

  function reader(over: Partial<Parameters<typeof createCliSessionsReader>[0]> = {}) {
    return createCliSessionsReader({
      configDir: config,
      configSource: 'flag',
      roots: [root],
      nowIso: () => NOW,
      isAlive: (pid) => alive.has(pid),
      procStartOf: async () => new Map(),
      listWorktrees: async () => [],
      cacheMs: 0,
      ...over,
    });
  }

  async function read(
    over: Partial<Parameters<typeof createCliSessionsReader>[0]> = {},
    db?: Parameters<ReturnType<typeof reader>['read']>[0],
  ) {
    return reader(over).read(db);
  }

  describe('session files', () => {
    it('reports a busy session as working with name, statusSince and no absolute path', async () => {
      await session(101);
      await transcript(root, SID_A, jsonl([user('do it'), asst(text('on it'))]));
      const r = await read();
      expect(r.state).toBe('ok');
      expect(r.configSource).toBe('flag');
      expect(r.sessions).toHaveLength(1);
      const s = must(r.sessions[0]);
      expect(s).toMatchObject({
        cliSessionId: SID_A,
        pid: 101,
        name: 'one',
        nameSource: 'user',
        status: 'working',
        statusSince: '2026-10-06T11:30:00.000Z',
        startedAt: '2026-10-06T10:00:00.000Z',
        inScopeBy: 'cwd',
        cwdLabel: 'repo',
        transcript: 'ok',
        linked: null,
      });
      const wire = JSON.stringify(r);
      expect(wire).not.toContain(tmp);
      expect(wire).not.toContain('/secret/socket');
      expect(wire).not.toContain('Mon Oct 6');
    });

    it('maps idle + assistant text to waiting_operator and carries doing-now and next', async () => {
      await session(102, { status: 'idle' });
      await transcript(
        root,
        SID_A,
        jsonl([
          user('fix the bug'),
          asst(toolUse('Bash', 't1')),
          toolResult('t1'),
          asst(text('Done.\n\nShall I open the PR?')),
        ]),
      );
      const s = must((await read()).sessions[0]);
      expect(s.status).toBe('waiting_operator');
      expect(s.doingNow).toEqual({
        prompt: 'fix the bug',
        promptAt: null,
        assistant: 'Done. Shall I open the PR?',
        lastTool: 'Bash',
      });
      expect(s.next).toBe('Shall I open the PR?');
    });

    it('maps idle + pending AskUserQuestion to waiting_answer, answered one to idle', async () => {
      await session(103, { status: 'idle' });
      await transcript(root, SID_A, jsonl([user('go'), asst(toolUse('AskUserQuestion', 'q1'))]));
      expect(must((await read()).sessions[0]).status).toBe('waiting_answer');
      await transcript(
        root,
        SID_A,
        jsonl([user('go'), asst(toolUse('AskUserQuestion', 'q1')), toolResult('q1')]),
      );
      expect(must((await read()).sessions[0]).status).toBe('idle');
    });

    it('maps registry waiting + pending AskUserQuestion to waiting_answer with waitingFor', async () => {
      await session(140, { status: 'waiting', waitingFor: 'input needed' });
      await transcript(root, SID_A, jsonl([user('go'), asst(toolUse('AskUserQuestion', 'q1'))]));
      const s = must((await read()).sessions[0]);
      expect(s.status).toBe('waiting_answer');
      expect(s.waitingFor).toBe('input needed');
      expect(s.parseIssues).toEqual([]);
    });

    it('maps registry waiting without a pending ask to waiting_operator', async () => {
      await session(141, { status: 'waiting', waitingFor: 'dialog open' });
      await transcript(root, SID_A, jsonl([user('go'), asst(toolUse('Bash', 't1'))]));
      const s = must((await read()).sessions[0]);
      expect(s.status).toBe('waiting_operator');
      expect(s.waitingFor).toBe('dialog open');
      expect(s.parseIssues).toEqual([]);
    });

    it('keeps registry waiting a waiting status when waitingFor is absent or not a string', async () => {
      await session(142, { status: 'waiting' });
      let s = must((await read()).sessions[0]);
      expect(s.status).toBe('waiting_operator');
      expect(s.waitingFor).toBeNull();
      expect(s.parseIssues).toEqual([]);
      await session(142, { status: 'waiting', waitingFor: 7 });
      s = must((await read()).sessions[0]);
      expect(s.status).toBe('waiting_operator');
      expect(s.waitingFor).toBeNull();
      expect(s.parseIssues).toEqual([]);
      await session(142, { status: 'waiting', waitingFor: ' \n ' });
      expect(must((await read()).sessions[0]).waitingFor).toBeNull();
    });

    it('cleans and bounds waitingFor', async () => {
      await session(143, { status: 'waiting', waitingFor: `a\nb${'x'.repeat(500)}` });
      const w = must(must((await read()).sessions[0]).waitingFor);
      expect(w.startsWith('a b')).toBe(true);
      expect(w.length).toBeLessThanOrEqual(64);
    });

    it('carries no waitingFor on busy or idle sessions, even with a stray one', async () => {
      await session(144, { status: 'busy', waitingFor: 'input needed' });
      expect(must((await read()).sessions[0]).waitingFor).toBeNull();
      await session(144, { status: 'idle', waitingFor: 'input needed' });
      expect(must((await read()).sessions[0]).waitingFor).toBeNull();
    });

    it('maps idle with no transcript to idle and transcript missing', async () => {
      await session(104, { status: 'idle' });
      const s = must((await read()).sessions[0]);
      expect(s.status).toBe('idle');
      expect(s.transcript).toBe('missing');
      expect(s.doingNow).toBeNull();
    });

    it('treats a missing status as unknown, never coerced', async () => {
      await session(105, { status: undefined });
      expect(must((await read()).sessions[0]).status).toBe('unknown');
      await session(105, { status: 'sleeping' });
      const s = must((await read()).sessions[0]);
      expect(s.status).toBe('unknown');
      expect(s.statusSince).toBe('2026-10-06T11:30:00.000Z');
    });

    it('counts malformed JSON, a pid/filename mismatch and a bad sessionId as unparsed', async () => {
      await session(106, {}, { raw: '{not json' });
      await session(107, { pid: 999 });
      await session(108, { sessionId: 'x' });
      await session(109, { cwd: 'relative/dir' });
      const r = await read();
      expect(r.sessions).toEqual([]);
      expect(r.hidden.unparsed).toBe(4);
    });

    it('ignores extra fields and counts dead pids and non-interactive kinds', async () => {
      await session(110, { surprise: { nested: true } });
      await session(111, { sessionId: SID_B }, { alive: false });
      await session(112, { sessionId: SID_C, kind: 'sdk' });
      const r = await read();
      expect(r.sessions.map((s) => s.pid)).toEqual([110]);
      expect(r.hidden).toMatchObject({ dead: 1, nonInteractive: 1, unparsed: 0 });
    });

    it('caps text at 280 chars and strips control characters', async () => {
      await session(113, { status: 'idle' });
      const long = `${'x'.repeat(400)}\u0007bell`;
      await transcript(root, SID_A, jsonl([user(long), asst(text(long))]));
      const s = must((await read()).sessions[0]);
      expect(s.doingNow?.prompt?.length).toBeLessThanOrEqual(280);
      expect(s.doingNow?.assistant?.length).toBeLessThanOrEqual(280);
      expect(JSON.stringify(s)).not.toContain('\\u0007');
      expect(s.next?.length).toBeLessThanOrEqual(280);
    });

    describe('reused pids', () => {
      const START = 'Mon Oct  6 10:00:00 2026';
      const reg = { procStart: START, pidDomain: process.platform };
      const starts = (m: [number, string][]) => async () => new Map(m);

      it('keeps a session whose process start matches, ignoring whitespace', async () => {
        await session(130, reg);
        await transcript(root, SID_A, jsonl([user('go')]));
        const r = await read({ procStartOf: starts([[130, 'Mon Oct 6   10:00:00 2026']]) });
        expect(r.sessions).toHaveLength(1);
        expect(r.hidden.dead).toBe(0);
      });

      it('counts a live pid with another process start as dead', async () => {
        await session(131, reg);
        const r = await read({ procStartOf: starts([[131, 'Wed Oct  7 01:00:00 2026']]) });
        expect(r.sessions).toHaveLength(0);
        expect(r.hidden.dead).toBe(1);
      });

      it('asks ps once for every comparable pid together', async () => {
        await session(132, reg);
        await session(133, { ...reg, sessionId: SID_B });
        const procStartOf = vi.fn(async (_pids: number[]) => new Map<number, string>());
        await read({ procStartOf });
        expect(procStartOf).toHaveBeenCalledTimes(1);
        expect(procStartOf.mock.calls[0]?.[0]?.slice().sort()).toEqual([132, 133]);
      });

      it('lets kill(0) decide without a procStart', async () => {
        await session(134, { procStart: undefined, pidDomain: process.platform });
        const r = await read({ procStartOf: starts([[134, 'Wed Oct  7 01:00:00 2026']]) });
        expect(r.sessions).toHaveLength(1);
      });

      it('lets kill(0) decide for another pid domain', async () => {
        await session(135, { procStart: START, pidDomain: 'other-os' });
        const r = await read({ procStartOf: starts([[135, 'Wed Oct  7 01:00:00 2026']]) });
        expect(r.sessions).toHaveLength(1);
      });

      it('lets kill(0) decide when ps fails', async () => {
        await session(136, reg);
        const r = await read({
          procStartOf: async () => {
            throw new Error('ps timed out');
          },
        });
        expect(r.sessions).toHaveLength(1);
      });

      it('lets kill(0) decide when ps has no line for the pid', async () => {
        await session(137, reg);
        const r = await read({ procStartOf: starts([[999, 'Wed Oct  7 01:00:00 2026']]) });
        expect(r.sessions).toHaveLength(1);
      });

      it('does not follow a reused pid in liveSessionCwds', async () => {
        await session(138, reg);
        await session(139, { ...reg, sessionId: SID_B, cwd: outside });
        const alivePid = (pid: number) => alive.has(pid);
        const cwds = await liveSessionCwds(
          config,
          alivePid,
          starts([
            [138, START],
            [139, 'Wed Oct  7 01:00:00 2026'],
          ]),
        );
        expect(cwds).toEqual([root]);
      });

      it('parses ps pid and lstart lines', () => {
        const out = '  101 Tue Oct  6 02:44:00 2026\n12345 Mon Oct  5 23:01:09 2026\n\nnoise\n';
        expect([...parsePsStarts(out)]).toEqual([
          [101, 'Tue Oct  6 02:44:00 2026'],
          [12345, 'Mon Oct  5 23:01:09 2026'],
        ]);
      });
    });

    describe('background subagents', () => {
      const tail = (...extra: unknown[]) =>
        jsonl([user('go'), launchRec('ag1'), asst(text('Launched, waiting.')), ...extra]);

      it('is working, not waiting, while a launched subagent is pending', async () => {
        await session(120, { status: 'idle' });
        await transcript(root, SID_A, tail());
        expect(must((await read()).sessions[0]).status).toBe('working');
      });

      it.each([
        ['completed', false],
        ['failed', false],
        ['killed', true],
        ['stopped', true],
      ])('a %s notification ends the pending subagent', async (status, asBlock) => {
        await session(121, { status: 'idle' });
        await transcript(root, SID_A, tail(notifyRec('ag1', status, asBlock)));
        expect(must((await read()).sessions[0]).status).toBe('waiting_operator');
      });

      it('a notification with no status does not end the subagent', async () => {
        await session(122, { status: 'idle' });
        await transcript(root, SID_A, tail(notifyRec('ag1', null)));
        expect(must((await read()).sessions[0]).status).toBe('working');
      });

      it('a notification with a status ends it even on a meta record', async () => {
        await session(123, { status: 'idle' });
        await transcript(root, SID_A, tail({ ...notifyRec('ag1', 'completed'), isMeta: true }));
        expect(must((await read()).sessions[0]).status).toBe('waiting_operator');
      });

      it('ignores a launch made before the registry startedAt', async () => {
        await session(124, { status: 'idle' });
        await transcript(
          root,
          SID_A,
          jsonl([
            user('go'),
            launchRec('ag1', '2026-10-06T09:00:00.000Z'),
            asst(text('Launched, waiting.')),
          ]),
        );
        expect(must((await read()).sessions[0]).status).toBe('waiting_operator');
      });

      it('falls back to the agentId line when toolUseResult is absent', async () => {
        await session(125, { status: 'idle' });
        const { toolUseResult: _drop, ...bare } = launchRec('ag1');
        await transcript(root, SID_A, jsonl([user('go'), bare, asst(text('Waiting.'))]));
        expect(must((await read()).sessions[0]).status).toBe('working');
      });

      it('a pending AskUserQuestion still wins', async () => {
        await session(126, { status: 'idle' });
        await transcript(
          root,
          SID_A,
          jsonl([user('go'), launchRec('ag1'), asst(toolUse('AskUserQuestion', 'q1'))]),
        );
        expect(must((await read()).sessions[0]).status).toBe('waiting_answer');
      });

      it('registry waiting still gives waiting_operator', async () => {
        await session(127, { status: 'waiting', waitingFor: 'input needed' });
        await transcript(root, SID_A, tail());
        expect(must((await read()).sessions[0]).status).toBe('waiting_operator');
      });
    });

    it('keeps text of exactly 280 code points and marks a 281-point text as cut', async () => {
      await session(114, { status: 'idle' });
      await transcript(root, SID_A, jsonl([user('go'), asst(text('y'.repeat(280)))]));
      expect(must((await read()).sessions[0]).doingNow?.assistant).toBe('y'.repeat(280));
      await transcript(root, SID_A, jsonl([user('go'), asst(text('y'.repeat(281)))]));
      expect(must((await read()).sessions[0]).doingNow?.assistant).toBe(`${'y'.repeat(279)}…`);
    });

    it('trims whitespace before the ellipsis and never leaves a lone surrogate', async () => {
      await session(115, { status: 'idle' });
      await transcript(
        root,
        SID_A,
        jsonl([user('go'), asst(text(`${'y'.repeat(278)} ${'z'.repeat(10)}`))]),
      );
      expect(must((await read()).sessions[0]).doingNow?.assistant).toBe(`${'y'.repeat(278)}…`);
      const emoji = '\u{1F600}';
      await transcript(root, SID_A, jsonl([user('go'), asst(text(emoji.repeat(300)))]));
      const out = must(must((await read()).sessions[0]).doingNow?.assistant);
      expect(out).toBe(`${emoji.repeat(279)}…`);
      expect(out).not.toMatch(
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
      );
    });

    it('sets formatWarning for an unseen version and null for a known one', async () => {
      await session(114);
      expect((await read()).formatWarning).toBeNull();
      await session(114, { version: '3.0.1' });
      expect((await read()).formatWarning).toMatch(/3\.0/);
    });

    it('never opens, stats or echoes a .key decoy', async () => {
      await session(115);
      const decoy = path.join(config, 'sessions', `115.deadbeef.key`);
      await writeFile(decoy, SENTINEL);
      const touched: string[] = [];
      const spy: CliFs = {
        readdir: async (p) => {
          touched.push(p);
          return readdir(p);
        },
        stat: async (p) => {
          touched.push(p);
          return stat(p);
        },
        lstat: async (p) => {
          touched.push(p);
          return lstat(p);
        },
        open: async (p) => {
          touched.push(p);
          return open(p, 'r');
        },
        realpath: async (p) => {
          touched.push(p);
          return realpath(p);
        },
      };
      const r = await read({ fs: spy });
      expect(r.sessions).toHaveLength(1);
      expect(touched.filter((p) => p.endsWith('.key'))).toEqual([]);
      expect(JSON.stringify(r)).not.toContain(SENTINEL);
    });

    it('answers absent for a missing dir or no configDir, and unreadable with no list', async () => {
      expect(await read({ configDir: path.join(tmp, 'nope') })).toMatchObject({
        state: 'absent',
        sessions: [],
      });
      const none = await read({ configDir: undefined, configSource: 'none' });
      expect(none).toMatchObject({ state: 'absent', configSource: 'none', sessions: [] });
      const failing: CliFs = {
        readdir: async () => {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        },
        stat,
        lstat,
        open: (p) => open(p, 'r'),
        realpath,
      };
      const r = await read({ fs: failing });
      expect(r.state).toBe('unreadable');
      expect(r.sessions).toEqual([]);
    });
  });

  describe('transcripts', () => {
    it('drops a tail cut mid-line and finds the entry at the end of a >256 KB file', async () => {
      await session(120, { status: 'idle' });
      const filler = jsonl(
        Array.from({ length: 60 }, (_, i) => user(`filler ${i} ${'z'.repeat(5000)}`)),
      );
      expect(filler.length).toBeGreaterThan(256 * 1024);
      await transcript(
        root,
        SID_A,
        `${filler}${jsonl([user('the real ask'), asst(text('the answer'))])}`,
      );
      const s = must((await read()).sessions[0]);
      expect(s.transcript).toBe('ok');
      expect(s.doingNow).toMatchObject({ prompt: 'the real ask', assistant: 'the answer' });
    });

    it('retries at 1 MB and then reports tail-empty', async () => {
      await session(121, { status: 'idle' });
      const meta = jsonl(
        Array.from({ length: 80 }, () => ({ type: 'system', note: 'n'.repeat(5000) })),
      );
      await transcript(root, SID_A, `${jsonl([user('early ask')])}${meta}`);
      expect(must((await read()).sessions[0]).doingNow?.prompt).toBe('early ask');
      const big = jsonl(
        Array.from({ length: 300 }, () => ({ type: 'system', note: 'n'.repeat(5000) })),
      );
      await transcript(root, SID_A, `${jsonl([user('lost ask')])}${big}`);
      const s = must((await read()).sessions[0]);
      expect(s.transcript).toBe('tail-empty');
      expect(s.doingNow).toBeNull();
    });

    it('collapses a command-name prompt and skips tool results, meta and reminders', async () => {
      await session(122, { status: 'idle' });
      await transcript(
        root,
        SID_A,
        jsonl([
          user(
            '<command-message>bs</command-message>\n<command-name>/bs</command-name>\n<command-args>run</command-args>',
          ),
          { type: 'user', isMeta: true, message: { role: 'user', content: 'meta text' } },
          user('<system-reminder>ignore me</system-reminder>'),
          toolResult('x'),
        ]),
      );
      expect(must((await read()).sessions[0]).doingNow?.prompt).toBe('/bs run');
    });

    it('treats an interrupt as idle', async () => {
      await session(123, { status: 'idle' });
      await transcript(
        root,
        SID_A,
        jsonl([asst(text('working')), user('[Request interrupted by user]')]),
      );
      expect(must((await read()).sessions[0]).status).toBe('idle');
    });

    it('finds a transcript under a differently encoded project dir via the sessionId fallback', async () => {
      await session(124, { status: 'idle' });
      await transcript(root, SID_A, jsonl([user('hi'), asst(text('hello'))]), false);
      const s = must((await read()).sessions[0]);
      expect(s.transcript).toBe('ok');
      expect(s.doingNow?.assistant).toBe('hello');
    });

    it('serves an unchanged transcript from the cache (one stat, no re-read)', async () => {
      await session(125, { status: 'idle' });
      const file = await transcript(root, SID_A, jsonl([user('hi'), asst(text('hello'))]));
      const opened: string[] = [];
      const spy: CliFs = {
        readdir,
        stat,
        lstat,
        open: async (p) => {
          opened.push(p);
          return open(p, 'r');
        },
        realpath,
      };
      const r = reader({ fs: spy });
      await r.read();
      const first = opened.filter((p) => p === file).length;
      await r.read();
      expect(first).toBeGreaterThan(0);
      expect(opened.filter((p) => p === file).length).toBe(first);
    });

    it('re-reads the transcript of a session that left the registry and came back', async () => {
      await session(126, { status: 'idle' });
      const file = await transcript(root, SID_A, jsonl([user('hi'), asst(text('hello'))]));
      const opened: string[] = [];
      const spy: CliFs = {
        readdir,
        stat,
        lstat,
        open: async (p) => {
          opened.push(p);
          return open(p, 'r');
        },
        realpath,
      };
      const r = reader({ fs: spy });
      await r.read();
      const first = opened.filter((p) => p === file).length;
      await rm(path.join(config, 'sessions', '126.json'));
      expect((await r.read()).sessions).toHaveLength(0);
      await session(126, { status: 'idle' });
      const back = await r.read();
      expect(back.sessions[0]?.doingNow?.assistant).toBe('hello');
      expect(opened.filter((p) => p === file).length).toBeGreaterThan(first);
    });

    it('caches a transcript miss for a short time before scanning again', async () => {
      await session(127, { status: 'idle' });
      await mkdir(path.join(config, 'projects', '-other'), { recursive: true });
      const projects = path.join(config, 'projects');
      let scans = 0;
      let clock = 1_000;
      const spy: CliFs = {
        readdir: async (p) => {
          if (p === projects) scans += 1;
          return readdir(p);
        },
        stat,
        lstat,
        open: (p) => open(p, 'r'),
        realpath,
      };
      const r = reader({ fs: spy, missTtlMs: 30_000, clock: () => clock });
      expect((await r.read()).sessions[0]?.transcript).toBe('missing');
      await r.read();
      expect(scans).toBe(1);
      clock += 30_001;
      expect((await r.read()).sessions[0]?.transcript).toBe('missing');
      expect(scans).toBe(2);
    });
  });

  describe('scope', () => {
    it('admits the root, a .wt worktree, a symlinked root; refuses <root>-other and unrelated', async () => {
      const wt = path.join(tmp, 'proj', '.wt', 'repo', 'task-1');
      const sibling = `${root}-other`;
      const link = path.join(tmp, 'link');
      await mkdir(wt, { recursive: true });
      await mkdir(sibling, { recursive: true });
      await symlink(root, link);
      await session(130, { sessionId: SID_A, cwd: root });
      await session(131, { sessionId: SID_B, cwd: wt });
      await session(132, { sessionId: SID_C, cwd: link });
      await session(133, { sessionId: '44444444-4444-4444-8444-444444444444', cwd: sibling });
      await session(134, { sessionId: '55555555-5555-4555-8555-555555555555', cwd: outside });
      const r = await read();
      expect(r.sessions.map((s) => [s.pid, s.inScopeBy, s.cwdLabel])).toEqual([
        [130, 'cwd', 'repo'],
        [131, 'cwd', 'task-1'],
        [132, 'cwd', 'repo'],
      ]);
      expect(r.hidden.outOfScope).toBe(2);
    });

    it('admits a hand-made worktree reported by git', async () => {
      const hand = path.join(tmp, 'handmade');
      await mkdir(hand, { recursive: true });
      await session(135, { cwd: path.join(hand, 'sub') });
      expect((await read()).sessions).toHaveLength(0);
      await mkdir(path.join(hand, 'sub'), { recursive: true });
      const r = await read({ listWorktrees: async () => [hand] });
      expect(r.sessions[0]).toMatchObject({ inScopeBy: 'cwd', cwdLabel: 'sub' });
    });

    it('admits an outside session by a /bs command in the transcript tail, linked null', async () => {
      await session(136, { cwd: outside });
      await transcript(
        outside,
        SID_A,
        jsonl([user('<command-name>/bs</command-name>'), asst(text('ok'))]),
      );
      const s = must((await read()).sessions[0]);
      expect(s).toMatchObject({ inScopeBy: 'heuristic', linked: null, cwdLabel: 'elsewhere' });
    });

    it('admits an outside session by a Bash bs command', async () => {
      await session(137, { cwd: outside });
      await transcript(
        outside,
        SID_A,
        jsonl([asst(toolUse('Bash', 'b', { command: 'cd x && bs plan status' }))]),
      );
      expect(must((await read()).sessions[0]).inScopeBy).toBe('heuristic');
    });

    it('finds the /bs command in the transcript head of a long session', async () => {
      await session(138, { cwd: outside });
      const filler = jsonl(
        Array.from({ length: 80 }, (_, i) => user(`talk ${i} ${'y'.repeat(5000)}`)),
      );
      await transcript(
        outside,
        SID_A,
        `${jsonl([user('<command-name>/bs</command-name>')])}${filler}`,
      );
      expect(must((await read()).sessions[0]).inScopeBy).toBe('heuristic');
    });

    it('keeps a session in scope once admitted (sticky), even after the evidence scrolls away', async () => {
      await session(139, { cwd: outside });
      await transcript(outside, SID_A, jsonl([user('<command-name>/bs</command-name>')]));
      const r = reader();
      expect((await r.read()).sessions).toHaveLength(1);
      await transcript(outside, SID_A, jsonl([user('just chatting')]));
      const again = await r.read();
      expect(again.sessions).toHaveLength(1);
      expect(must(again.sessions[0]).inScopeBy).toBe('heuristic');
      expect(again.hidden.outOfScope).toBe(0);
      // A fresh reader has no memory of it.
      expect((await reader().read()).sessions).toHaveLength(0);
    });

    it('forgets the scope and transcript of a session that left the registry', async () => {
      await session(129, { cwd: outside, status: 'idle' });
      await transcript(
        outside,
        SID_A,
        jsonl([user('<command-name>/bs</command-name>'), asst(text('old'))]),
        false,
      );
      const r = reader();
      expect((await r.read()).sessions[0]).toMatchObject({ inScopeBy: 'heuristic' });
      await rm(path.join(config, 'sessions', '129.json'));
      expect((await r.read()).sessions).toHaveLength(0);
      // It comes back with a transcript of its own and no /bs evidence: judged
      // afresh, not admitted on what the earlier session showed.
      await transcript(outside, SID_A, jsonl([user('just chatting'), asst(text('new'))]));
      await session(129, { cwd: outside, status: 'idle' });
      const back = await r.read();
      expect(back.sessions).toHaveLength(0);
      expect(back.hidden.outOfScope).toBe(1);
    });

    it('keeps what it remembered when a listed registry file is unreadable for one poll', async () => {
      await session(131, { cwd: outside });
      await transcript(outside, SID_A, jsonl([user('<command-name>/bs</command-name>')]));
      const r = reader();
      expect((await r.read()).sessions).toHaveLength(1);
      // The evidence scrolls away, then the file is caught half-written.
      await transcript(outside, SID_A, jsonl([user('just chatting')]));
      await session(131, {}, { raw: '{"pid":131,"sessionId":' });
      const torn = await r.read();
      expect(torn.sessions).toHaveLength(0);
      expect(torn.hidden.unparsed).toBe(1);
      await session(131, { cwd: outside });
      const back = await r.read();
      expect(back.sessions).toHaveLength(1);
      expect(must(back.sessions[0]).inScopeBy).toBe('heuristic');
    });

    it('forgets a session whose pid died while its file stays listed', async () => {
      await session(132, { cwd: outside });
      await transcript(outside, SID_A, jsonl([user('<command-name>/bs</command-name>')]));
      const r = reader();
      expect((await r.read()).sessions).toHaveLength(1);
      await transcript(outside, SID_A, jsonl([user('just chatting')]));
      alive.delete(132);
      expect((await r.read()).hidden.dead).toBe(1);
      alive.add(132);
      const back = await r.read();
      expect(back.sessions).toHaveLength(0);
      expect(back.hidden.outOfScope).toBe(1);
    });
  });

  describe('hardening', () => {
    const LEAK = 'LEAK-SENTINEL-NOT-OPERATOR';
    const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    it.each([
      ['shell input', user(`<bash-input>echo ${LEAK}</bash-input>`)],
      ['shell stdout', user(`<bash-stdout>${LEAK}</bash-stdout><bash-stderr></bash-stderr>`)],
      ['shell stderr', user(`<bash-stderr>${LEAK}</bash-stderr>`)],
      ['a task notification', user(`<task-notification>${LEAK}</task-notification>`)],
      ['a memory input', user(`<user-memory-input>${LEAK}</user-memory-input>`)],
      [
        'a compact summary',
        {
          type: 'user',
          isCompactSummary: true,
          message: { role: 'user', content: `${LEAK} summary` },
        },
      ],
    ])('does not take %s as the operator prompt', async (_kind, record) => {
      await session(155, { status: 'idle' });
      await transcript(root, SID_A, jsonl([user('the real ask'), asst(text('ok')), record]));
      const r = await read();
      expect(must(r.sessions[0]).doingNow?.prompt).toBe('the real ask');
      expect(JSON.stringify(r)).not.toContain(LEAK);
    });

    it('nulls an out-of-range registry timestamp and still lists every session', async () => {
      await session(160, { sessionId: SID_A, startedAt: 1e16 });
      await session(161, { sessionId: SID_B, statusUpdatedAt: 1e16 });
      await session(162, { sessionId: SID_C });
      const r = await read();
      const by = new Map(r.sessions.map((s) => [s.pid, s]));
      expect([...by.keys()].sort()).toEqual([160, 161, 162]);
      expect(must(by.get(160)).startedAt).toBeNull();
      expect(must(by.get(160)).statusSince).toBe('2026-10-06T11:30:00.000Z');
      expect(must(by.get(161)).statusSince).toBeNull();
      expect(must(by.get(161)).startedAt).toBe('2026-10-06T10:00:00.000Z');
    });

    it.skipIf(process.platform === 'win32')(
      'skips a registry entry or transcript that is not a regular file without blocking',
      async () => {
        const regFifo = path.join(config, 'sessions', '170.json');
        execFileSync('mkfifo', [regFifo]);
        alive.add(170);
        await session(171, { sessionId: SID_B, status: 'idle' });
        const dir = path.join(config, 'projects', slug(root));
        await mkdir(dir, { recursive: true });
        const tFifo = path.join(dir, `${SID_B}.jsonl`);
        execFileSync('mkfifo', [tFifo]);

        let settled = false;
        const pending = read().finally(() => {
          settled = true;
        });
        const timeout = new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), 2000),
        );
        const r = await Promise.race([pending, timeout]);
        // A reader stuck in open() on a FIFO is released by opening its write end.
        for (let i = 0; i < 40 && !settled; i += 1) {
          for (const f of [regFifo, tFifo]) {
            try {
              closeSync(openSync(f, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
            } catch {
              // no reader waiting on it
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(r).not.toBe('timeout');
        const res = r as CliSessionsResponse;
        expect(res.hidden.unparsed).toBe(1);
        expect(res.sessions.map((s) => [s.pid, s.transcript])).toEqual([[171, 'unreadable']]);
      },
      10_000,
    );

    it('skips a registry entry or transcript that is a symlink and never opens its target', async () => {
      const decoy = path.join(tmp, 'decoy.json');
      await writeFile(
        decoy,
        JSON.stringify({
          pid: 172,
          sessionId: SID_A,
          cwd: root,
          kind: 'interactive',
          status: 'busy',
          name: LEAK,
        }),
      );
      await symlink(decoy, path.join(config, 'sessions', '172.json'));
      alive.add(172);
      await session(173, { sessionId: SID_B, status: 'idle' });
      const decoyTranscript = path.join(tmp, 'decoy.jsonl');
      await writeFile(decoyTranscript, jsonl([user(LEAK), asst(text(LEAK))]));
      const dir = path.join(config, 'projects', slug(root));
      await mkdir(dir, { recursive: true });
      await symlink(decoyTranscript, path.join(dir, `${SID_B}.jsonl`));

      const plain = await read();
      expect(plain.hidden.unparsed).toBe(1);
      expect(plain.sessions.map((s) => [s.pid, s.transcript])).toEqual([[173, 'unreadable']]);
      expect(JSON.stringify(plain)).not.toContain(LEAK);

      const opened: string[] = [];
      const spy: CliFs = {
        readdir,
        stat,
        lstat,
        open: async (p) => {
          opened.push(await realpath(p).catch(() => p));
          return open(p, 'r');
        },
        realpath,
      };
      const spied = await read({ fs: spy });
      expect(JSON.stringify(spied)).not.toContain(LEAK);
      expect(opened).not.toContain(decoy);
      expect(opened).not.toContain(decoyTranscript);
    });

    it('truncates on code points, never leaving a lone surrogate', async () => {
      await session(174, { status: 'idle' });
      const body = `${'a'.repeat(279)}\u{1F600}${'b'.repeat(10)}`;
      await transcript(root, SID_A, jsonl([user(body), asst(text(body))]));
      const s = must((await read()).sessions[0]);
      for (const v of [s.doingNow?.prompt, s.doingNow?.assistant, s.next]) {
        expect(typeof v).toBe('string');
        expect(LONE_SURROGATE.test(must(v))).toBe(false);
        expect(Array.from(must(v)).length).toBeLessThanOrEqual(280);
      }
    });

    it('strips control characters from the version and keeps the warning short', async () => {
      await session(175, { version: `3.0\u0000\n${'v'.repeat(10 * 1024)}` });
      const w = (await read()).formatWarning;
      expect(w).toMatch(/3\.0/);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting they are gone
      expect(w).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(must(w).length).toBeLessThan(200);
    });

    it('labels a cwd that matches its root only by case with a plain name', async () => {
      await session(176, { cwd: path.join(tmp, 'proj', 'REPO', 'gone') });
      const s = must((await read({ foldCase: true })).sessions[0]);
      expect(s.inScopeBy).toBe('cwd');
      expect(s.cwdLabel.split(/[\\/]/)).not.toContain('..');
      expect(s.cwdLabel.startsWith('/')).toBe(false);
      expect(s.cwdLabel).toBe('gone');
    });

    it('lists each registry field that failed validation, by name only', async () => {
      await session(177, { startedAt: 'RAWVALUE-ONE', status: 'RAWVALUE-TWO' });
      const r = await read();
      const s = must(r.sessions[0]);
      expect(s.parseIssues).toEqual(
        expect.arrayContaining(['startedAt: invalid', 'status: invalid']),
      );
      expect(s.parseIssues).toHaveLength(2);
      expect(JSON.stringify(r)).not.toContain('RAWVALUE');
    });
  });

  describe('linking via the cli_session_id stamp', () => {
    let stateDir: string;
    let dbPath: string;
    beforeEach(async () => {
      stateDir = path.join(tmp, 'events');
      await mkdir(stateDir, { recursive: true });
      dbPath = path.join(tmp, 'smith.db');
      await buildFixture({ stateDir, cliSessionId: SID_A });
      await rebuild(dbPath, 'all', { stateDir, roadmapPath: path.join(tmp, 'none.md') });
    });

    it('admits an outside-cwd stamped session and links it to its epic, wave and progress', async () => {
      await session(140, { cwd: outside });
      const handle = openDb(dbPath, {});
      try {
        const r: CliSessionsResponse = await reader().read(handle);
        const s = must(r.sessions[0]);
        expect(s.inScopeBy).toBe('stamped');
        const epic = s.linked?.epics[0];
        expect(epic).toMatchObject({ epicId: EPIC_ID, factorySessionIds: [SESSION_ID] });
        const wave = epic?.openWaves[0];
        expect(wave?.sessionId).toBe(SESSION_ID);
        expect(wave?.taskIds).toHaveLength(4);
        expect(wave?.counts.done).toBeGreaterThanOrEqual(1);
        expect(epic?.progress).toMatchObject({
          done: expect.any(Number),
          todo: expect.any(Number),
        });
        const total = Object.values(must(must(epic).progress)).reduce((a, b) => a + b, 0);
        expect(total).toBeGreaterThanOrEqual(4);
        expect(JSON.stringify(r)).not.toContain(tmp);
      } finally {
        handle.sqlite.close();
      }
    });

    it('leaves an unstamped session unlinked', async () => {
      await session(141, { sessionId: SID_B });
      const handle = openDb(dbPath, {});
      try {
        const s = must((await reader().read(handle)).sessions[0]);
        expect(s.linked).toBeNull();
      } finally {
        handle.sqlite.close();
      }
    });

    it('never takes the epic name from the root session prompt', async () => {
      await session(142, { cwd: outside });
      const handle = openDb(dbPath, {});
      try {
        const card = must((await reader().read(handle)).sessions[0]);
        expect(card.focus?.epicId).toBe(EPIC_ID);
        expect(card.focus?.epicTitle).toBeNull();
        expect(JSON.stringify(card.focus)).not.toContain('Build the widget');
      } finally {
        handle.sqlite.close();
      }
    });
  });

  describe('linking across factory sessions', () => {
    let stateDir: string;
    let dbPath: string;
    beforeEach(async () => {
      stateDir = path.join(tmp, 'events');
      await mkdir(stateDir, { recursive: true });
      dbPath = path.join(tmp, 'smith.db');
    });

    /** Opens a factory session stamped by `cli` (null: unstamped) and chains its events. */
    async function factorySession(sid: string, cli: string | null, continues?: string) {
      const opts = { stateDir, cliSessionId: cli };
      let parent = (await startSession(sid, { ...opts, ...(continues ? { continues } : {}) }))
        .event_id;
      const add = async (
        eventType: string,
        payload: Record<string, unknown>,
        extra: { taskId?: string; actor?: string; project?: string } = {},
      ): Promise<void> => {
        parent = (
          await appendEvent(
            {
              session_id: sid,
              actor: extra.actor ?? 'system',
              event_type: eventType,
              plan_version: 1,
              causal_parent: parent,
              payload,
              ...(extra.taskId ? { task_id: extra.taskId } : {}),
              ...(extra.project ? { project: extra.project } : {}),
            },
            opts,
          )
        ).event_id;
      };
      return {
        add,
        last: () => parent,
        addTask: (
          epicId: string,
          taskId: string,
          over: Record<string, unknown> = {},
          project?: string,
        ) =>
          add(
            'task-added',
            {
              epic_id: epicId,
              case: 'feature',
              origin: 'user',
              task_status: 'todo',
              plan_version: 1,
              objective: 'Do the thing.',
              title: 'Thing',
              summary: 'Does the thing.',
              claims: ['src/thing.ts'],
              budget_tokens: 1000,
              ...over,
            },
            { taskId, actor: 'planner', ...(project ? { project } : {}) },
          ),
        dispatch: (taskId: string | null, over: Record<string, unknown> = {}) =>
          add(
            'dispatch_decision',
            {
              agent_role: 'coder',
              provider: 'claude',
              model_tier: 'mid',
              model: 'claude-sonnet-5',
              spec_ref: 'specs/thing.json',
              reason: 'implement the thing',
              ...over,
            },
            { actor: 'planner', ...(taskId ? { taskId } : {}) },
          ),
      };
    }

    async function linkedEpics(pid: number, cli: string, nowIso?: () => string) {
      await rebuild(dbPath, 'all', { stateDir, roadmapPath: path.join(tmp, 'none.md') });
      await session(pid, { sessionId: cli, cwd: outside });
      const handle = openDb(dbPath, {});
      try {
        // Events are stamped with the real clock, so the read clock is real too
        // unless a test asks for another.
        const over = { nowIso: nowIso ?? (() => new Date().toISOString()) };
        return (await reader(over).read(handle)).sessions[0]?.linked?.epics ?? [];
      } finally {
        handle.sqlite.close();
      }
    }

    const total = (c: object | undefined): number =>
      Object.values(c ?? {}).reduce((a: number, b: number) => a + b, 0);

    it('reads every wave of the epic when a wave session sorts before its epic session', async () => {
      const root = await factorySession('sess-root', SID_B);
      await root.addTask('epic-9', 'epic-9/task-1');
      await root.addTask('epic-9', 'epic-9/task-2');
      const first = await factorySession('sess-a-wave1', SID_B, root.last());
      await first.add('wave-admitted', { epic_id: 'epic-9', task_ids: ['epic-9/task-1'] });
      await first.add('wave-merged', { epic_id: 'epic-9', task_ids: ['epic-9/task-1'] });
      const second = await factorySession('sess-a-wave2', null, root.last());
      await second.add('wave-admitted', { epic_id: 'epic-9', task_ids: ['epic-9/task-2'] });
      await second.dispatch('epic-9/task-2');

      const epics = await linkedEpics(160, SID_B);
      expect(epics).toHaveLength(1);
      const epic = epics[0];
      expect(epic).toMatchObject({
        rootSessionId: 'sess-root',
        epicId: 'epic-9',
        factorySessionIds: ['sess-a-wave1', 'sess-root'],
      });
      expect(epic?.openWaves).toHaveLength(1);
      expect(epic?.openWaves[0]).toMatchObject({
        sessionId: 'sess-a-wave2',
        taskIds: ['epic-9/task-2'],
      });
      expect(total(epic?.openWaves[0]?.counts)).toBe(1);
      expect(epic?.workingAgents).toEqual([
        { role: 'coder', taskId: 'epic-9/task-2', since: expect.any(String) },
      ]);
    });

    it('orders the epics one CLI session drove newest first, each with its last event time', async () => {
      const older = await factorySession('sess-e1', SID_B);
      await older.addTask('epic-7', 'epic-7/task-1');
      await new Promise((r) => setTimeout(r, 5));
      const newer = await factorySession('sess-e2', SID_B);
      await newer.addTask('epic-8', 'epic-8/task-1');
      const lastTs = async (sid: string) => (await readEvents(sid, { stateDir })).at(-1)?.record.ts;

      const epics = await linkedEpics(161, SID_B);
      expect(epics.map((e) => e.rootSessionId)).toEqual(['sess-e2', 'sess-e1']);
      expect(epics[0]?.lastEventAt).toBe(await lastTs('sess-e2'));
      expect(epics[1]?.lastEventAt).toBe(await lastTs('sess-e1'));
    });

    it('does not report a wave merged under bare task ids as open', async () => {
      const root = await factorySession('sess-q', SID_B);
      await root.addTask('epic-6', 'epic-6/task-1');
      await root.add('wave-admitted', { epic_id: 'epic-6', task_ids: ['epic-6/task-1'] });
      await root.add('wave-merged', { epic_id: 'epic-6', task_ids: ['task-1'] });

      const [epic] = await linkedEpics(162, SID_B);
      expect(epic?.epicId).toBe('epic-6');
      expect(epic?.openWaves).toEqual([]);
    });

    it('counts a wave admitted under bare task ids against its qualified tasks', async () => {
      const root = await factorySession('sess-b', SID_B);
      await root.addTask('epic-5', 'epic-5/task-1');
      await root.addTask('epic-5', 'epic-5/task-2');
      await root.add('wave-admitted', { epic_id: 'epic-5', task_ids: ['task-1', 'task-2'] });

      const [epic] = await linkedEpics(163, SID_B);
      expect(epic?.openWaves[0]?.taskIds).toEqual(['task-1', 'task-2']);
      expect(total(epic?.openWaves[0]?.counts)).toBe(2);
    });

    it('lists every open wave newest first, closing a wave only when all its tasks are closed', async () => {
      const root = await factorySession('sess-ow', SID_B);
      for (const n of [1, 2, 3, 4]) await root.addTask('epic-4', `epic-4/task-${n}`);
      await root.add('wave-admitted', {
        epic_id: 'epic-4',
        task_ids: ['epic-4/task-1', 'epic-4/task-2'],
      });
      await new Promise((r) => setTimeout(r, 5));
      await root.add('wave-admitted', { epic_id: 'epic-4', task_ids: ['epic-4/task-3'] });
      await new Promise((r) => setTimeout(r, 5));
      // A re-run wave re-admits task-3 and takes it over from the wave before.
      await root.add('wave-admitted', {
        epic_id: 'epic-4',
        task_ids: ['epic-4/task-3', 'epic-4/task-4'],
      });
      await root.add('wave-merged', { epic_id: 'epic-4', task_ids: ['epic-4/task-1'] });

      const [epic] = await linkedEpics(164, SID_B);
      // wave 1 still owns task-2 (open); wave 2 owns nothing, task-3 moved to wave 3.
      expect(epic?.openWaves.map((w) => w.taskIds)).toEqual([
        ['epic-4/task-3', 'epic-4/task-4'],
        ['epic-4/task-1', 'epic-4/task-2'],
      ]);
      const [newest, older] = epic?.openWaves ?? [];
      expect(must(newest).admittedAt > must(older).admittedAt).toBe(true);
      expect(total(older?.counts)).toBe(2);
    });

    it('closes a task whose row is done or superseded even without a wave-merged', async () => {
      const root = await factorySession('sess-cl', SID_B);
      await root.addTask('epic-3', 'epic-3/task-1', { task_status: 'completed' });
      await root.addTask('epic-3', 'epic-3/task-2', { task_status: 'superseded' });
      await root.addTask('epic-3', 'epic-3/task-3');
      await root.add('wave-admitted', {
        epic_id: 'epic-3',
        task_ids: ['epic-3/task-1', 'epic-3/task-2'],
      });
      await root.add('wave-admitted', {
        epic_id: 'epic-3',
        task_ids: ['epic-3/task-3', 'epic-3/ghost'],
      });

      const [epic] = await linkedEpics(165, SID_B);
      expect(epic?.openWaves.map((w) => w.taskIds)).toEqual([['epic-3/task-3', 'epic-3/ghost']]);
    });

    it('counts progress over plan tasks only and reports escalation follow-ups apart', async () => {
      const root = await factorySession('sess-pg', SID_B);
      await root.addTask('epic-2', 'epic-2/old-todo', { plan_version: 1 });
      await root.addTask('epic-2', 'epic-2/old-done', {
        plan_version: 1,
        task_status: 'completed',
      });
      await root.addTask('epic-2', 'epic-2/new-a', { plan_version: 2 });
      await root.addTask('epic-2', 'epic-2/new-b', { plan_version: 2, task_status: 'in-progress' });
      await root.addTask('epic-2', 'epic-2/follow-1', { plan_version: 2, origin: 'escalation' });
      await root.addTask('epic-2', 'epic-2/follow-2', {
        plan_version: 2,
        origin: 'escalation',
        task_status: 'completed',
      });

      const [epic] = await linkedEpics(166, SID_B);
      expect(total(epic?.progress ?? undefined)).toBe(3);
      expect(epic?.progress).toMatchObject({ done: 1, todo: 1, inProgress: 1 });
      expect(epic?.followUps).toBe(1);
    });

    it('keeps only agents really working now: live, fresh, on this epic, on an open task, one per role and task', async () => {
      const prev = await factorySession('sess-prev', SID_B);
      await prev.addTask('epic-1', 'epic-1/task-1');
      await prev.dispatch('epic-1/task-1');
      const root = await factorySession('sess-cur', SID_B, prev.last());
      await root.addTask('epic-0', 'epic-0/task-1');
      await root.addTask('epic-0', 'epic-0/task-2', { task_status: 'completed' });
      await root.addTask('epic-0', 'epic-0/task-3');
      await root.add('wave-admitted', {
        epic_id: 'epic-0',
        task_ids: ['epic-0/task-1', 'epic-0/task-3'],
      });
      await root.dispatch('epic-0/task-1');
      await root.dispatch('epic-0/task-2');
      await root.dispatch('epic-0/task-3', { agent_role: 'reviewer' });
      await root.dispatch(null, { agent_role: 'planner', epic_id: 'epic-0' });
      await new Promise((r) => setTimeout(r, 5));
      await root.dispatch(null, { agent_role: 'planner', epic_id: 'epic-0' });

      const [epic] = await linkedEpics(167, SID_B);
      expect(epic?.epicId).toBe('epic-0');
      const mine = (epic?.workingAgents ?? []).map((a) => [a.role, a.taskId]);
      expect(mine).toHaveLength(3);
      expect(mine).toEqual(
        expect.arrayContaining([
          ['coder', 'epic-0/task-1'],
          ['reviewer', 'epic-0/task-3'],
          ['planner', null],
        ]),
      );
      const since = (epic?.workingAgents ?? []).map((a) => a.since);
      expect(since).toEqual([...since].sort().reverse());

      // Past the stale window nothing counts as working.
      const later = await linkedEpics(167, SID_B, () =>
        new Date(Date.now() + 5 * 3.6e6).toISOString(),
      );
      expect(later[0]?.workingAgents).toEqual([]);
    });

    it('drops an agent a later dispatch on its task took over, keeping fan-out and task-less agents', async () => {
      const t0 = Date.now() - 30 * 60_000;
      const at = (ms: number) => vi.setSystemTime(t0 + ms);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        at(0);
        const root = await factorySession('sess-sup', SID_B);
        for (const n of [1, 2, 3]) await root.addTask('epic-s', `epic-s/task-${n}`);
        await root.add('wave-admitted', {
          epic_id: 'epic-s',
          task_ids: ['epic-s/task-1', 'epic-s/task-2', 'epic-s/task-3'],
        });
        await root.dispatch(null, { agent_role: 'wave-runner', epic_id: 'epic-s' });
        // task-1: the coder never reported back.
        await root.dispatch('epic-s/task-1');
        // task-2: a reviewer and a security reviewer fanned out together.
        await root.dispatch('epic-s/task-2', { agent_role: 'reviewer' });
        // task-3: a tester first.
        await root.dispatch('epic-s/task-3', { agent_role: 'tester' });
        at(30_000);
        await root.dispatch('epic-s/task-2', { agent_role: 'security-reviewer' });
        at(120_000);
        // task-1: a tester came later and has already finished.
        await root.dispatch('epic-s/task-1', { agent_role: 'tester' });
        await root.add(
          'task-result-recorded',
          { task_id: 'task-1', agent: 'tester', run_status: 'done', structured_output: {} },
          { taskId: 'epic-s/task-1' },
        );
        // task-3: the coder re-dispatched after the tester is the later one.
        await root.dispatch('epic-s/task-3');
      } finally {
        vi.useRealTimers();
      }

      const [epic] = await linkedEpics(171, SID_B, () => new Date(t0 + 5 * 60_000).toISOString());
      const mine = (epic?.workingAgents ?? []).map((a) => [a.role, a.taskId]);
      expect(mine).toHaveLength(4);
      expect(mine).toEqual(
        expect.arrayContaining([
          ['wave-runner', null],
          ['reviewer', 'epic-s/task-2'],
          ['security-reviewer', 'epic-s/task-2'],
          ['coder', 'epic-s/task-3'],
        ]),
      );
    });

    it('never lets a later dispatch on an epic-level id take over the live agent there', async () => {
      const t0 = Date.now() - 30 * 60_000;
      const at = (ms: number) => vi.setSystemTime(t0 + ms);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        at(0);
        const root = await factorySession('sess-int', SID_B);
        await root.addTask('epic-w', 'epic-w/task-1');
        await root.dispatch('epic-w/integration', { agent_role: 'wave-runner', epic_id: 'epic-w' });
        at(3 * 60_000);
        // A planner on the same pseudo id, minutes later, already finished.
        await root.dispatch('epic-w/integration', { agent_role: 'planner', epic_id: 'epic-w' });
        await root.add(
          'task-result-recorded',
          { task_id: 'integration', agent: 'planner', run_status: 'done', structured_output: {} },
          { taskId: 'epic-w/integration' },
        );
      } finally {
        vi.useRealTimers();
      }

      const [epic] = await linkedEpics(181, SID_B, () => new Date(t0 + 5 * 60_000).toISOString());
      expect(epic?.epicId).toBe('epic-w');
      expect(epic?.workingAgents.map((a) => [a.role, a.taskId])).toEqual([
        ['wave-runner', 'epic-w/integration'],
      ]);
    });

    it('lets a judge of another role run beside a live judge, while a same-role judge or a worker takes over', async () => {
      const t0 = Date.now() - 30 * 60_000;
      const at = (ms: number) => vi.setSystemTime(t0 + ms);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        at(0);
        const root = await factorySession('sess-judge', SID_B);
        for (const n of [1, 2, 3]) await root.addTask('epic-j', `epic-j/task-${n}`);
        await root.add('wave-admitted', {
          epic_id: 'epic-j',
          task_ids: ['epic-j/task-1', 'epic-j/task-2', 'epic-j/task-3'],
        });
        for (const n of [1, 2, 3])
          await root.dispatch(`epic-j/task-${n}`, { agent_role: 'grader' });
        at(10 * 60_000);
        // task-1: a reviewer joins while the grader still runs.
        await root.dispatch('epic-j/task-1', { agent_role: 'reviewer' });
        // task-2: the grader's next round, on the bare id so the fold's own
        // same-role supersede misses it and take-over has to, already done.
        await root.dispatch('task-2', { agent_role: 'grader', epic_id: 'epic-j' });
        await root.add(
          'task-result-recorded',
          { task_id: 'task-2', agent: 'grader', run_status: 'done', structured_output: {} },
          { taskId: 'task-2' },
        );
        // task-3: the coder is back on it.
        await root.dispatch('epic-j/task-3');
      } finally {
        vi.useRealTimers();
      }

      const [epic] = await linkedEpics(182, SID_B, () => new Date(t0 + 12 * 60_000).toISOString());
      const mine = (epic?.workingAgents ?? []).map((a) => [a.role, a.taskId]);
      expect(mine).toHaveLength(3);
      expect(mine).toEqual(
        expect.arrayContaining([
          ['grader', 'epic-j/task-1'],
          ['reviewer', 'epic-j/task-1'],
          ['coder', 'epic-j/task-3'],
        ]),
      );
    });

    it('keeps a take-over inside the agent epic', async () => {
      const t0 = Date.now() - 30 * 60_000;
      const at = (ms: number) => vi.setSystemTime(t0 + ms);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        at(0);
        const root = await factorySession('sess-cross', SID_B);
        await root.addTask('epic-a', 'epic-a/task-1');
        await root.add('wave-admitted', { epic_id: 'epic-a', task_ids: ['epic-a/task-1'] });
        await root.dispatch('epic-a/task-1');
        at(10 * 60_000);
        // Another epic's task-1, recorded with the bare id it shares.
        await root.dispatch('task-1', { agent_role: 'tester', epic_id: 'epic-b' });
      } finally {
        vi.useRealTimers();
      }

      const epics = await linkedEpics(183, SID_B, () => new Date(t0 + 12 * 60_000).toISOString());
      const epic = epics.find((e) => e.epicId === 'epic-a');
      expect(epic?.workingAgents.map((a) => [a.role, a.taskId])).toEqual([
        ['coder', 'epic-a/task-1'],
      ]);
    });

    it('tells open waves of one session apart by their admission event', async () => {
      const root = await factorySession('sess-id', SID_B);
      await root.addTask('epic-i', 'epic-i/task-1');
      await root.addTask('epic-i', 'epic-i/task-2');
      await root.add('wave-admitted', { epic_id: 'epic-i', task_ids: ['epic-i/task-1'] });
      const first = root.last();
      await new Promise((r) => setTimeout(r, 5));
      await root.add('wave-admitted', { epic_id: 'epic-i', task_ids: ['epic-i/task-2'] });
      const second = root.last();

      const [epic] = await linkedEpics(172, SID_B);
      expect(epic?.openWaves.map((w) => [w.sessionId, w.admittedEventId])).toEqual([
        ['sess-id', second],
        ['sess-id', first],
      ]);
    });

    it('keeps only done work from an older plan version and counts a task with no version as current', async () => {
      const root = await factorySession('sess-pv', SID_B);
      await root.addTask('epic-v', 'epic-v/old-dropped', {
        plan_version: 1,
        task_status: 'superseded',
      });
      await root.addTask('epic-v', 'epic-v/old-done', {
        plan_version: 1,
        task_status: 'completed',
      });
      await root.addTask('epic-v', 'epic-v/old-todo', { plan_version: 1 });
      await root.addTask('epic-v', 'epic-v/new-a', { plan_version: 2 });
      await root.addTask('epic-v', 'epic-v/unversioned', { plan_version: undefined });

      const [epic] = await linkedEpics(173, SID_B);
      expect(epic?.progress).toEqual({ done: 1, review: 0, inProgress: 0, todo: 2, superseded: 0 });
    });

    it('lets a wave that re-admits a task reopen it over a merge that came before', async () => {
      const root = await factorySession('sess-re', SID_B);
      for (const n of [1, 2, 3, 4]) await root.addTask('epic-r', `epic-r/task-${n}`);
      await root.add('wave-admitted', {
        epic_id: 'epic-r',
        task_ids: ['epic-r/task-1', 'epic-r/task-2'],
      });
      await root.add('wave-merged', {
        epic_id: 'epic-r',
        task_ids: ['epic-r/task-1', 'epic-r/task-2', 'epic-r/task-3'],
      });
      await new Promise((r) => setTimeout(r, 5));
      // A re-run wave admits task-1 again; task-2 stays merged; task-3 was
      // merged without ever being admitted. The projector keeps every merged
      // row completed with terminal_at at the merge, re-admitted or not.
      await root.add('wave-admitted', {
        epic_id: 'epic-r',
        task_ids: ['epic-r/task-1', 'epic-r/task-4'],
      });
      await new Promise((r) => setTimeout(r, 5));
      // task-4 merges after its admission, in a session outside this lineage,
      // so only its row can close it.
      const other = await factorySession('sess-elsewhere', null);
      await other.add('wave-merged', { epic_id: 'epic-r', task_ids: ['epic-r/task-4'] });
      await root.dispatch('epic-r/task-1');
      await root.dispatch('epic-r/task-2', { agent_role: 'reviewer' });
      await root.dispatch('epic-r/task-3', { agent_role: 'tester' });
      await root.dispatch('epic-r/task-4', { agent_role: 'reviewer' });

      const epics = await linkedEpics(174, SID_B);
      const epic = epics[0];
      expect(epic?.openWaves.map((w) => w.taskIds)).toEqual([['epic-r/task-1', 'epic-r/task-4']]);
      expect(epic?.workingAgents.map((a) => [a.role, a.taskId])).toEqual([
        ['coder', 'epic-r/task-1'],
      ]);
    });

    it('keeps a shipped task closed when a later wave only re-admits it', async () => {
      const root = await factorySession('sess-ship', SID_B);
      await root.addTask('epic-s', 'epic-s/task-1');
      await root.addTask('epic-s', 'epic-s/task-2');
      await root.add('wave-admitted', { epic_id: 'epic-s', task_ids: ['epic-s/task-1'] });
      // A coder whose terminal event was never logged stays live past the merge.
      await root.dispatch('epic-s/task-1');
      await root.add('wave-merged', { epic_id: 'epic-s', task_ids: ['epic-s/task-1'] });
      await new Promise((r) => setTimeout(r, 5));
      // A re-planned wave admits the shipped task again beside a new one, and
      // nothing is dispatched on the shipped task after that admission.
      await root.add('wave-admitted', {
        epic_id: 'epic-s',
        task_ids: ['epic-s/task-1', 'epic-s/task-2'],
      });
      await root.dispatch('epic-s/task-2');

      const [epic] = await linkedEpics(184, SID_B);
      expect(epic?.openWaves.map((w) => w.taskIds)).toEqual([['epic-s/task-1', 'epic-s/task-2']]);
      expect(epic?.openWaves[0]?.counts).toMatchObject({ done: 1, inProgress: 1 });
      expect(epic?.workingAgents.map((a) => [a.role, a.taskId])).toEqual([
        ['coder', 'epic-s/task-2'],
      ]);

      // Once the new task merges, the wave holds nothing open.
      await root.add('wave-merged', { epic_id: 'epic-s', task_ids: ['epic-s/task-2'] });
      const [after] = await linkedEpics(184, SID_B);
      expect(after?.openWaves).toEqual([]);
      expect(after?.workingAgents).toEqual([]);
    });

    it('puts the plan tasks project on the card and leaves it null when unlinked', async () => {
      const wave = await factorySession('sess-pj', SID_B);
      await wave.addTask('epic-p', 'epic-p/dropped', { plan_version: 1 }, 'stale-project');
      await wave.addTask('epic-p', 'epic-p/kept', { plan_version: 2 }, 'app-a');
      await rebuild(dbPath, 'all', { stateDir, roadmapPath: path.join(tmp, 'none.md') });
      await session(169, { sessionId: SID_B, cwd: outside });
      await session(170, { sessionId: SID_C, cwd: root });
      const handle = openDb(dbPath, {});
      try {
        const by = new Map((await reader().read(handle)).sessions.map((s) => [s.pid, s]));
        expect(by.get(169)?.project).toBe('app-a');
        expect(by.get(169)?.linked?.epics[0]?.project).toBe('app-a');
        expect(by.get(170)?.project).toBeNull();
      } finally {
        handle.sqlite.close();
      }
    });

    it('titles and roots a continued lineage at the first session of this epic', async () => {
      const prev = await factorySession('sess-first', SID_B);
      await prev.addTask('epic-old', 'epic-old/task-1');
      const next = await factorySession('sess-second', SID_B, prev.last());
      await next.addTask('epic-new', 'epic-new/task-1');
      await next.add('wave-admitted', { epic_id: 'epic-new', task_ids: ['epic-new/task-1'] });

      const epics = await linkedEpics(168, SID_B);
      const current = epics.find((e) => e.epicId === 'epic-new');
      expect(current?.rootSessionId).toBe('sess-second');
    });
    describe('focus (Now / Next)', () => {
      const pause = () => new Promise((r) => setTimeout(r, 3));
      const none = () => path.join(tmp, 'none.md');

      async function cardOf(
        pid: number,
        over: Record<string, unknown> = {},
        transcriptFor = false,
      ) {
        await rebuild(dbPath, 'all', { stateDir, roadmapPath: none() });
        await session(pid, { sessionId: SID_B, cwd: outside, ...over });
        if (transcriptFor) await transcript(outside, SID_B, jsonl([user('go')]));
        const handle = openDb(dbPath, {});
        try {
          const nowIso = () => new Date().toISOString();
          return must((await reader({ nowIso }).read(handle)).sessions[0]);
        } finally {
          handle.sqlite.close();
        }
      }

      /**
       * One epic whose admissions are made by the root session. After each
       * admission the next id of `waveSessions` (full factory session ids)
       * starts, as a wave runner does; the first `merged` waves are merged.
       */
      async function epicWithWaves(
        admissions: number,
        waveSessions: string[],
        merged: number,
        project?: string,
      ) {
        const root = await factorySession('sess-root', SID_B);
        for (let k = 1; k <= admissions; k++)
          await root.addTask('epic-a', `epic-a/task-${k}`, { title: `Task ${k}` }, project);
        for (let k = 1; k <= admissions; k++) {
          await root.add('wave-admitted', { epic_id: 'epic-a', task_ids: [`epic-a/task-${k}`] });
          const sid = waveSessions[k - 1];
          if (sid) {
            await pause();
            await factorySession(sid, null, root.last());
            await pause();
          }
          if (k <= merged)
            await root.add('wave-merged', { epic_id: 'epic-a', task_ids: [`epic-a/task-${k}`] });
        }
        return root;
      }

      it('is null for a session that links to no epic', async () => {
        const card = await cardOf(190, { sessionId: SID_C, cwd: root });
        expect(card.focus).toBeNull();
      });

      it('names the epic, its project and the store it came from', async () => {
        await epicWithWaves(1, [], 0, 'app-a');
        const card = await cardOf(191);
        expect(card.focus).toMatchObject({
          store: { id: 'home', label: 'home' },
          project: 'app-a',
          epicId: 'epic-a',
          wave: 1,
        });
      });

      it('reads wave 6 from the newest wave session among w1, w1r and w2..w6 with 7 admissions', async () => {
        const ids = ['w1', 'w1r', 'w2', 'w3', 'w4', 'w5', 'w6'].map((w) => `epic-a-${w}-d`);
        await epicWithWaves(7, ids, 6);
        expect((await cardOf(192)).focus?.wave).toBe(6);
      });

      it('keeps the wave number of a newest re-run', async () => {
        const ids = ['w1', 'w2', 'w3', 'w3r'].map((w) => `epic-a-${w}-d`);
        await epicWithWaves(4, ids, 3);
        expect((await cardOf(193)).focus?.wave).toBe(3);
      });

      it('does not read a wave number out of a session that only contains the epic id', async () => {
        await epicWithWaves(1, ['my-epic-a-w9-d'], 0);
        expect((await cardOf(194)).focus?.wave).toBe(1);
      });

      it('has no wave number when no wave session exists and the epic has two admissions', async () => {
        await epicWithWaves(2, [], 1);
        expect((await cardOf(195)).focus?.wave).toBeNull();
      });

      it('is wave 1 when no wave session exists and the epic has a single admission', async () => {
        await epicWithWaves(1, [], 0);
        expect((await cardOf(195)).focus?.wave).toBe(1);
      });

      it('has no wave number without an admission', async () => {
        const root = await factorySession('sess-root', SID_B);
        await root.addTask('epic-a', 'epic-a/task-1');
        const card = await cardOf(196);
        expect(card.focus).toMatchObject({ epicId: 'epic-a', wave: null });
      });

      it('lists each working agent with its task title, newest first, never a task id', async () => {
        const root = await epicWithWaves(1, [], 0);
        await root.addTask('epic-a', 'epic-a/task-x', {
          title: undefined,
          objective: `${'Wire the retry button to the queue and '.repeat(5)}\nsecond line`,
        });
        await root.dispatch('epic-a/task-1', { agent_role: 'coder' });
        await pause();
        await root.dispatch('epic-a/task-x', { agent_role: 'tester' });
        const now = (await cardOf(197)).focus?.now ?? [];
        expect(now.map((n) => n.role)).toEqual(['tester', 'coder']);
        expect(now[1]).toMatchObject({ taskId: 'epic-a/task-1', taskTitle: 'Task 1' });
        const long = now[0]?.taskTitle ?? '';
        expect(long.startsWith('Wire the retry button')).toBe(true);
        expect(long.length).toBeLessThanOrEqual(90);
        expect(long.endsWith('…')).toBe(true);
        expect(long).not.toContain('second line');
      });

      it('gives an agent with no task a null title', async () => {
        const root = await epicWithWaves(1, [], 0);
        await root.dispatch(null, { agent_role: 'planner', epic_id: 'epic-a' });
        const now = (await cardOf(198)).focus?.now ?? [];
        expect(now).toEqual([
          { role: 'planner', taskId: null, taskTitle: null, since: expect.any(String) },
        ]);
      });

      it('says waiting on you while the session waits for the operator', async () => {
        await epicWithWaves(2, [], 0);
        const card = await cardOf(199, { status: 'waiting', waitingFor: 'input needed' });
        expect(card.status).toBe('waiting_operator');
        expect(card.focus?.next).toEqual({ kind: 'waiting_on_you' });
      });

      it('does not say waiting on you while the session waits on its own subagents', async () => {
        await epicWithWaves(2, [], 0);
        await transcript(
          outside,
          SID_B,
          jsonl([user('go'), launchRec('ag1'), asst(text('Launched, waiting.'))]),
        );
        const card = await cardOf(202, { status: 'idle' });
        expect(card.status).toBe('working');
        expect(card.focus?.next).not.toEqual({ kind: 'waiting_on_you' });
      });

      it('says waiting on you for an idle session with nothing working', async () => {
        await epicWithWaves(2, [], 0);
        const card = await cardOf(200, { status: 'idle' }, true);
        expect(card.focus?.now).toEqual([]);
        expect(card.focus?.next).toEqual({ kind: 'waiting_on_you' });
      });

      it('picks the first open task of the newest open wave that no agent works on', async () => {
        const root = await factorySession('sess-root', SID_B);
        for (const n of [1, 2, 3, 4])
          await root.addTask('epic-a', `epic-a/task-${n}`, { title: `Task ${n}` });
        const all = [1, 2, 3, 4].map((n) => `epic-a/task-${n}`);
        await root.add('wave-admitted', { epic_id: 'epic-a', task_ids: all });
        await root.add('wave-merged', { epic_id: 'epic-a', task_ids: [all[0]] });
        await root.dispatch('epic-a/task-2', { agent_role: 'coder' });
        const card = await cardOf(201);
        expect(card.focus?.next).toEqual({
          kind: 'task',
          taskId: 'epic-a/task-3',
          taskTitle: 'Task 3',
        });
      });

      it('keeps Next on a task while the idle CLI waits for a working agent', async () => {
        const root = await epicWithWaves(2, [], 0);
        await root.dispatch('epic-a/task-1', { agent_role: 'coder' });
        await transcript(outside, SID_B, jsonl([user('go'), asst(text('Dispatched the coder.'))]));
        const card = await cardOf(204, { status: 'idle' });
        expect(card.status).toBe('waiting_operator');
        expect(card.focus?.now).toHaveLength(1);
        expect(card.focus?.next).toMatchObject({ kind: 'task', taskId: 'epic-a/task-2' });
      });

      it('says waiting on you when the registry waits even with an agent working', async () => {
        const root = await epicWithWaves(2, [], 0);
        await root.dispatch('epic-a/task-1', { agent_role: 'coder' });
        const card = await cardOf(205, { status: 'waiting', waitingFor: 'permission' });
        expect(card.focus?.now).toHaveLength(1);
        expect(card.focus?.next).toEqual({ kind: 'waiting_on_you' });
      });

      it('says waiting on you for a pending ask even with an agent working', async () => {
        const root = await epicWithWaves(2, [], 0);
        await root.dispatch('epic-a/task-1', { agent_role: 'coder' });
        await transcript(
          outside,
          SID_B,
          jsonl([user('go'), asst(toolUse('AskUserQuestion', 'q1'))]),
        );
        const card = await cardOf(206, { status: 'idle' });
        expect(card.status).toBe('waiting_answer');
        expect(card.focus?.next).toEqual({ kind: 'waiting_on_you' });
      });

      it('leaves Next unknown when the first open task has no label, never a later one', async () => {
        const root = await factorySession('sess-root', SID_B);
        await root.addTask('epic-a', 'epic-a/task-1', { title: undefined, objective: undefined });
        await root.addTask('epic-a', 'epic-a/task-2', { title: 'Task 2' });
        await root.add('wave-admitted', {
          epic_id: 'epic-a',
          task_ids: ['epic-a/task-1', 'epic-a/task-2'],
        });
        const card = await cardOf(207);
        expect(card.focus?.next).toBeNull();
      });

      it('skips closed and busy tasks to the first labelled open one', async () => {
        const root = await factorySession('sess-root', SID_B);
        for (const n of [1, 2, 3])
          await root.addTask('epic-a', `epic-a/task-${n}`, { title: `Task ${n}` });
        const all = [1, 2, 3].map((n) => `epic-a/task-${n}`);
        await root.add('wave-admitted', { epic_id: 'epic-a', task_ids: all });
        await root.add('wave-merged', { epic_id: 'epic-a', task_ids: [all[0]] });
        await root.dispatch('epic-a/task-2', { agent_role: 'coder' });
        const card = await cardOf(208);
        expect(card.focus?.next).toMatchObject({ kind: 'task', taskId: 'epic-a/task-3' });
      });

      it('says none when no task is left to do or in flight on the newest plan', async () => {
        await epicWithWaves(2, [], 2);
        const card = await cardOf(202);
        expect(card.status).toBe('working');
        expect(card.focus?.next).toEqual({ kind: 'none' });
      });

      it('leaves next unknown when tasks remain but no open wave names one', async () => {
        const root = await factorySession('sess-root', SID_B);
        await root.addTask('epic-a', 'epic-a/task-1');
        const card = await cardOf(203);
        expect(card.focus?.next).toBeNull();
      });

      describe('read cache', () => {
        it('serves two alternating store sets from the cache inside the TTL', async () => {
          await session(220, { sessionId: SID_B, cwd: outside });
          await rebuild(dbPath, 'all', { stateDir, roadmapPath: path.join(tmp, 'none.md') });
          const handle = openDb(dbPath, {});
          try {
            let computes = 0;
            const r = reader({
              cacheMs: 60_000,
              isAlive: (pid) => {
                computes++;
                return alive.has(pid);
              },
            });
            const a = [{ id: 'a', label: 'a', handle }];
            const b = [{ id: 'b', label: 'b', handle }];
            await r.read(a);
            await r.read(b);
            await r.read(a);
            await r.read(b);
            expect(computes).toBe(2);
          } finally {
            handle.sqlite.close();
          }
        });
      });

      describe('closed epics', () => {
        const closeEpic = (
          f: { add: (t: string, p: Record<string, unknown>) => Promise<void> },
          epic: string,
        ) =>
          f.add('epic-closed', {
            epic_id: epic,
            epic_status: 'closed',
            closed_by: 'operator-override',
            override_rationale: 'abandoned',
          });

        it('skips a newer closed epic and focuses the older open one', async () => {
          const a = await factorySession('sess-a', SID_B);
          await a.addTask('epic-a', 'epic-a/task-1', {}, 'app-a');
          await pause();
          const b = await factorySession('sess-b', SID_B);
          await b.addTask('epic-b', 'epic-b/task-1', {}, 'app-b');
          await closeEpic(b, 'epic-b');
          const card = await cardOf(220);
          expect(card.focus).toMatchObject({ epicId: 'epic-a', project: 'app-a' });
          expect(card.project).toBe('app-a');
          expect(card.linked?.epics.map((e) => [e.epicId, e.closed])).toEqual([
            ['epic-b', true],
            ['epic-a', false],
          ]);
        });

        it('takes the card project from the focus epic when the newest group has no epic', async () => {
          const a = await factorySession('sess-a', SID_B);
          await a.addTask('epic-a', 'epic-a/task-1', {}, 'app-a');
          await pause();
          await factorySession('sess-b', SID_B);
          const card = await cardOf(222);
          expect(card.focus?.epicId).toBe('epic-a');
          expect(card.project).toBe('app-a');
        });

        it('is not linked when its only epic is closed', async () => {
          const b = await factorySession('sess-b', SID_B);
          await b.addTask('epic-b', 'epic-b/task-1', {}, 'app-b');
          await closeEpic(b, 'epic-b');
          const card = await cardOf(221);
          expect(card.focus).toBeNull();
          expect(card.project).toBeNull();
          expect(card.linked?.epics.map((e) => [e.epicId, e.closed])).toEqual([['epic-b', true]]);
        });
      });

      describe('across stores', () => {
        let foreignDir: string;
        let foreignDb: string;

        /** A foreign project's epic, written to its own event dir and projection. */
        async function foreignEpic(epic: string, project?: string, closed = false) {
          const homeDir = stateDir;
          stateDir = foreignDir;
          try {
            const f = await factorySession('sess-foreign', SID_B);
            await f.addTask(epic, `${epic}/task-1`, { title: 'Foreign task' }, project);
            await f.add('wave-admitted', { epic_id: epic, task_ids: [`${epic}/task-1`] });
            await f.dispatch(`${epic}/task-1`, { agent_role: 'coder' });
            if (closed)
              await f.add('epic-closed', {
                epic_id: epic,
                epic_status: 'closed',
                closed_by: 'operator-override',
                override_rationale: 'abandoned',
              });
          } finally {
            stateDir = homeDir;
          }
          await rebuild(foreignDb, 'all', { stateDir: foreignDir, roadmapPath: none() });
        }
        async function homeEpic(epic: string) {
          const h = await factorySession('sess-home', SID_B);
          await h.addTask(epic, `${epic}/task-1`, { title: 'Home task' });
          await rebuild(dbPath, 'all', { stateDir, roadmapPath: none() });
        }
        async function readStores(closeForeign = false) {
          await session(210, { sessionId: SID_B, cwd: outside });
          const home = openDb(dbPath, {});
          const foreign = openDb(foreignDb, {});
          if (closeForeign) foreign.sqlite.close();
          try {
            const stores = [
              { id: 'home', label: 'home', handle: home },
              { id: 'abcd1234', label: 'project-b', handle: foreign },
            ];
            const res = await reader({ nowIso: () => new Date().toISOString() }).read(stores);
            return must(res.sessions[0]);
          } finally {
            home.sqlite.close();
            if (!closeForeign) foreign.sqlite.close();
          }
        }

        beforeEach(async () => {
          foreignDir = path.join(tmp, 'events-b');
          foreignDb = path.join(tmp, 'smith-b.db');
          await mkdir(foreignDir, { recursive: true });
        });

        it('links a session that only wrote into a foreign store, labelled by that store', async () => {
          await foreignEpic('epic-f');
          await rebuild(dbPath, 'all', { stateDir, roadmapPath: none() });
          const card = await readStores();
          expect(card.focus).toMatchObject({
            store: { id: 'abcd1234', label: 'project-b' },
            project: 'project-b',
            epicId: 'epic-f',
          });
          expect(card.focus?.now[0]).toMatchObject({ role: 'coder', taskTitle: 'Foreign task' });
        });

        it('takes the newer epic when the session wrote into both stores', async () => {
          await homeEpic('epic-h');
          await pause();
          await foreignEpic('epic-f', 'app-f');
          const card = await readStores();
          expect(card.focus).toMatchObject({
            store: { id: 'abcd1234' },
            project: 'app-f',
            epicId: 'epic-f',
          });
          expect(card.linked?.epics.map((e) => [e.store.id, e.epicId])).toEqual([
            ['abcd1234', 'epic-f'],
            ['home', 'epic-h'],
          ]);
          expect(card.project).toBe('app-f');
        });

        it('skips a newer closed epic of one store for an older open epic of another', async () => {
          await homeEpic('epic-h');
          await pause();
          await foreignEpic('epic-f', 'app-f', true);
          const card = await readStores();
          expect(card.focus).toMatchObject({ store: { id: 'home' }, epicId: 'epic-h' });
          expect(card.linked?.epics.map((e) => [e.epicId, e.closed])).toEqual([
            ['epic-f', true],
            ['epic-h', false],
          ]);
        });

        it('keeps the other stores when one store cannot be read', async () => {
          await homeEpic('epic-h');
          await foreignEpic('epic-f');
          const card = await readStores(true);
          expect(card.focus).toMatchObject({ store: { id: 'home' }, epicId: 'epic-h' });
        });
      });
    });
  });

  describe('next', () => {
    const nextOf = async (body: string) => {
      await session(180, { status: 'idle' });
      await transcript(root, SID_A, jsonl([user('go'), asst(text(body))]));
      return must((await read()).sessions[0]).next;
    };

    it('skips a trailing list, heading, table, quote and bold-only label', async () => {
      const body = [
        'Merged the fix and the suite is green.',
        '- one\n- two',
        '## Technical details',
        '| a | b |\n| - | - |',
        '> quoted',
        '**Files changed**',
        '**Notes:**',
        '__Tail__:',
        '1. first',
        '2) second',
      ].join('\n\n');
      expect(await nextOf(body)).toBe('Merged the fix and the suite is green.');
    });

    it('prefers plain prose over a later paragraph that starts bold', async () => {
      const body = [
        'Merged the fix; the suite is green.',
        '1. first\n2. second',
        '**Technical details:** id x, event y',
      ].join('\n\n');
      expect(await nextOf(body)).toBe('Merged the fix; the suite is green.');
      expect(await nextOf('Shall I ship it?\n\n  __Note__ the tail')).toBe('Shall I ship it?');
    });

    it('falls back to the last paragraph that starts bold when none is plain prose', async () => {
      expect(await nextOf('- a\n\n**Status:** working on x\n\n## Heading')).toBe(
        '**Status:** working on x',
      );
      expect(await nextOf('**a** and **b**')).toBe('**a** and **b**');
      expect(await nextOf('**One:** first\n\n**Two:** second')).toBe('**Two:** second');
    });

    it('reads a line that starts with # but no space as prose, not a heading', async () => {
      expect(await nextOf('Intro.\n\n#123 is fixed')).toBe('#123 is fixed');
      expect(await nextOf('Intro.\n\n#\n\n###\tTabbed')).toBe('Intro.');
    });

    it('never takes text from a fenced code block, blank lines inside included', async () => {
      expect(await nextOf('Shall I ship it?\n\n```\nconst x = 1;\n\nconst y = 2;\n```')).toBe(
        'Shall I ship it?',
      );
      expect(await nextOf('Shall I ship it?\n\n~~~\ncode\n\nmore code\n~~~')).toBe(
        'Shall I ship it?',
      );
    });

    it('closes a fence only on the marker that opened it', async () => {
      expect(await nextOf('Shall I ship it?\n\n```\ncode\n~~~\nleak\n```')).toBe(
        'Shall I ship it?',
      );
      expect(await nextOf('Shall I ship it?\n\n~~~\ncode\n```\nleak\n~~~')).toBe(
        'Shall I ship it?',
      );
    });

    it('closes a fence only on a bare run of its marker at least as long as the opener', async () => {
      expect(await nextOf('Shall I ship it?\n\n````md\n```js\ncode\n```\n````')).toBe(
        'Shall I ship it?',
      );
      expect(await nextOf('Shall I ship it?\n\n```\ncode\n```js\nleak\n```')).toBe(
        'Shall I ship it?',
      );
      expect(await nextOf('```\ncode\n`````  \n\nShipped it.')).toBe('Shipped it.');
    });

    it('treats a fence indented inside a list item as a fence', async () => {
      expect(
        await nextOf(
          'Shall I ship it?\n\n1. Run:\n   - build:\n\n     ```sh\n     pnpm build\n\n     pnpm test\n     ```',
        ),
      ).toBe('Shall I ship it?');
    });

    it('does not open a backtick fence whose info string holds a backtick', async () => {
      expect(await nextOf('Shall I ship it?\n\n```inline``` is how a span opens.\n\nDone?')).toBe(
        'Done?',
      );
      // Tildes are unaffected: a backtick after a tilde run still opens.
      expect(await nextOf('Shall I ship it?\n\n~~~ a `b`\ncode\n~~~')).toBe('Shall I ship it?');
    });

    it('is null when no paragraph is prose', async () => {
      expect(await nextOf('- a\n- b\n\n## Heading')).toBeNull();
    });
  });

  describe('operator prompt from the prompt history', () => {
    const history = (...entries: Record<string, unknown>[]) =>
      writeFile(path.join(config, 'history.jsonl'), jsonl(entries));
    const entry = (sessionId: string, display: string, timestamp: number) => ({
      display,
      timestamp,
      sessionId,
      project: '/secret/project',
      pastedContents: { 1: { content: 'PASTED-SENTINEL' } },
    });

    it('serves the last history entry for the session, with its time, and nothing else from it', async () => {
      await session(190, { status: 'idle' });
      await transcript(root, SID_A, jsonl([user('tail prompt'), asst(text('ok'))]));
      await history(
        entry(SID_A, 'first ask', Date.parse('2026-10-06T08:00:00Z')),
        entry(SID_B, 'other session', Date.parse('2026-10-06T08:30:00Z')),
        entry(SID_A, 'latest ask', Date.parse('2026-10-06T09:00:00Z')),
      );
      const r = await read();
      expect(must(r.sessions[0]).doingNow).toMatchObject({
        prompt: 'latest ask',
        promptAt: '2026-10-06T09:00:00.000Z',
        assistant: 'ok',
      });
      const wire = JSON.stringify(r);
      expect(wire).not.toContain('PASTED-SENTINEL');
      expect(wire).not.toContain('/secret/project');
    });

    it('is enough for a non-null doingNow when the transcript is missing', async () => {
      await session(191, { status: 'idle' });
      await history(entry(SID_A, 'only in history', Date.parse('2026-10-06T09:00:00Z')));
      const s = must((await read()).sessions[0]);
      expect(s.transcript).toBe('missing');
      expect(s.doingNow).toEqual({
        prompt: 'only in history',
        promptAt: '2026-10-06T09:00:00.000Z',
        assistant: null,
        lastTool: null,
      });
    });

    it('drops the partial first line of a tail read and reads at most the last 1 MB', async () => {
      await session(192, { status: 'idle' });
      const filler = Array.from({ length: 300 }, () =>
        entry(SID_B, 'x'.repeat(5000), Date.parse('2026-10-06T07:00:00Z')),
      );
      await history(
        entry(SID_A, 'scrolled away', 1_000_000),
        ...filler,
        entry(SID_A, 'near the end', 2_000_000),
      );
      expect(must((await read()).sessions[0]).doingNow?.prompt).toBe('near the end');
      await history(entry(SID_A, 'scrolled away', 1_000_000), ...filler);
      expect(must((await read()).sessions[0]).doingNow).toBeNull();
    });

    it('reads nothing from a tail read that holds no complete line', async () => {
      await session(196, { status: 'idle' });
      // One line longer than the 1 MB tail, no newline anywhere: the tail
      // starts mid-line, so even a slice that happens to parse is not read.
      const shell = JSON.stringify({ display: '', timestamp: 1_000_000, sessionId: SID_A });
      const tail = JSON.stringify({
        display: 'p'.repeat(1024 * 1024 - Buffer.byteLength(shell)),
        timestamp: 1_000_000,
        sessionId: SID_A,
      });
      expect(Buffer.byteLength(tail)).toBe(1024 * 1024);
      await writeFile(path.join(config, 'history.jsonl'), `{"display":"head ${tail}`);
      expect(must((await read()).sessions[0]).doingNow).toBeNull();
    });

    it('falls back to the transcript prompt, then to the last prompt seen, and forgets it with the session', async () => {
      await session(193, { status: 'idle' });
      await transcript(root, SID_A, jsonl([user('tail prompt'), asst(text('ok'))]));
      const r = reader();
      expect(must((await r.read()).sessions[0]).doingNow).toMatchObject({
        prompt: 'tail prompt',
        promptAt: null,
      });
      // The prompt scrolls out of the tail: the server still remembers it.
      await transcript(root, SID_A, jsonl([asst(text('still going'))]));
      expect(must((await r.read()).sessions[0]).doingNow).toMatchObject({
        prompt: 'tail prompt',
        assistant: 'still going',
      });
      await rm(path.join(config, 'sessions', '193.json'));
      await r.read();
      await session(193, { status: 'idle' });
      expect(must((await r.read()).sessions[0]).doingNow?.prompt).toBeNull();
    });

    it('treats a missing or unreadable history as no history', async () => {
      await session(194, { status: 'idle' });
      await transcript(root, SID_A, jsonl([user('tail prompt'), asst(text('ok'))]));
      expect(must((await read()).sessions[0]).doingNow?.prompt).toBe('tail prompt');
      await mkdir(path.join(config, 'history.jsonl'));
      expect(must((await read()).sessions[0]).doingNow?.prompt).toBe('tail prompt');
    });
  });

  describe('transcript directory name', () => {
    it('finds a transcript of a cwd with dots and underscores without scanning every project dir', async () => {
      const cwd = path.join(root, '.wt', 'task_one');
      await mkdir(cwd, { recursive: true });
      await session(195, { cwd, status: 'idle' });
      await transcript(cwd, SID_A, jsonl([user('hi'), asst(text('hello'))]));
      const projects = path.join(config, 'projects');
      let scans = 0;
      const spy: CliFs = {
        readdir: async (p) => {
          if (p === projects) scans += 1;
          return readdir(p);
        },
        stat,
        lstat,
        open: (p) => open(p, 'r'),
        realpath,
      };
      expect((await read({ fs: spy })).sessions[0]?.transcript).toBe('ok');
      expect(scans).toBe(0);
    });
  });

  it('never logs transcript text', async () => {
    await session(150, { status: 'idle' });
    await transcript(root, SID_A, jsonl([user('private prompt'), asst(text('private answer'))]));
    const spies = (['log', 'info', 'warn', 'error'] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => {}),
    );
    await read();
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });
});
