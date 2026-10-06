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
    const dir = path.join(config, 'projects', encode ? cwd.replace(/\//g, '-') : '-wrong-dir');
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
      const s = r.sessions[0]!;
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
      const s = (await read()).sessions[0]!;
      expect(s.status).toBe('waiting_operator');
      expect(s.doingNow).toEqual({
        prompt: 'fix the bug',
        assistant: 'Done. Shall I open the PR?',
        lastTool: 'Bash',
      });
      expect(s.next).toBe('Shall I open the PR?');
    });

    it('maps idle + pending AskUserQuestion to waiting_answer, answered one to idle', async () => {
      await session(103, { status: 'idle' });
      await transcript(root, SID_A, jsonl([user('go'), asst(toolUse('AskUserQuestion', 'q1'))]));
      expect((await read()).sessions[0]!.status).toBe('waiting_answer');
      await transcript(
        root,
        SID_A,
        jsonl([user('go'), asst(toolUse('AskUserQuestion', 'q1')), toolResult('q1')]),
      );
      expect((await read()).sessions[0]!.status).toBe('idle');
    });

    it('maps idle with no transcript to idle and transcript missing', async () => {
      await session(104, { status: 'idle' });
      const s = (await read()).sessions[0]!;
      expect(s.status).toBe('idle');
      expect(s.transcript).toBe('missing');
      expect(s.doingNow).toBeNull();
    });

    it('treats a missing status as unknown, never coerced', async () => {
      await session(105, { status: undefined });
      expect((await read()).sessions[0]!.status).toBe('unknown');
      await session(105, { status: 'sleeping' });
      const s = (await read()).sessions[0]!;
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
      const s = (await read()).sessions[0]!;
      expect(s.doingNow?.prompt?.length).toBeLessThanOrEqual(280);
      expect(s.doingNow?.assistant?.length).toBeLessThanOrEqual(280);
      expect(JSON.stringify(s)).not.toContain('\\u0007');
      expect(s.next?.length).toBeLessThanOrEqual(280);
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
        readdir: async (p) => (touched.push(p), readdir(p)),
        stat: async (p) => (touched.push(p), stat(p)),
        lstat: async (p) => (touched.push(p), lstat(p)),
        open: async (p) => (touched.push(p), open(p, 'r')),
        realpath: async (p) => (touched.push(p), realpath(p)),
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
      const s = (await read()).sessions[0]!;
      expect(s.transcript).toBe('ok');
      expect(s.doingNow).toMatchObject({ prompt: 'the real ask', assistant: 'the answer' });
    });

    it('retries at 1 MB and then reports tail-empty', async () => {
      await session(121, { status: 'idle' });
      const meta = jsonl(
        Array.from({ length: 80 }, () => ({ type: 'system', note: 'n'.repeat(5000) })),
      );
      await transcript(root, SID_A, `${jsonl([user('early ask')])}${meta}`);
      expect((await read()).sessions[0]!.doingNow?.prompt).toBe('early ask');
      const big = jsonl(
        Array.from({ length: 300 }, () => ({ type: 'system', note: 'n'.repeat(5000) })),
      );
      await transcript(root, SID_A, `${jsonl([user('lost ask')])}${big}`);
      const s = (await read()).sessions[0]!;
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
      expect((await read()).sessions[0]!.doingNow?.prompt).toBe('/bs run');
    });

    it('treats an interrupt as idle', async () => {
      await session(123, { status: 'idle' });
      await transcript(
        root,
        SID_A,
        jsonl([asst(text('working')), user('[Request interrupted by user]')]),
      );
      expect((await read()).sessions[0]!.status).toBe('idle');
    });

    it('finds a transcript under a differently encoded project dir via the sessionId fallback', async () => {
      await session(124, { status: 'idle' });
      await transcript(root, SID_A, jsonl([user('hi'), asst(text('hello'))]), false);
      const s = (await read()).sessions[0]!;
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
        open: async (p) => (opened.push(p), open(p, 'r')),
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
        open: async (p) => (opened.push(p), open(p, 'r')),
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
      const s = (await read()).sessions[0]!;
      expect(s).toMatchObject({ inScopeBy: 'heuristic', linked: null, cwdLabel: 'elsewhere' });
    });

    it('admits an outside session by a Bash bs command', async () => {
      await session(137, { cwd: outside });
      await transcript(
        outside,
        SID_A,
        jsonl([asst(toolUse('Bash', 'b', { command: 'cd x && bs plan status' }))]),
      );
      expect((await read()).sessions[0]!.inScopeBy).toBe('heuristic');
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
      expect((await read()).sessions[0]!.inScopeBy).toBe('heuristic');
    });

    it('keeps a session in scope once admitted (sticky), even after the evidence scrolls away', async () => {
      await session(139, { cwd: outside });
      await transcript(outside, SID_A, jsonl([user('<command-name>/bs</command-name>')]));
      const r = reader();
      expect((await r.read()).sessions).toHaveLength(1);
      await transcript(outside, SID_A, jsonl([user('just chatting')]));
      const again = await r.read();
      expect(again.sessions).toHaveLength(1);
      expect(again.sessions[0]!.inScopeBy).toBe('heuristic');
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
      expect(r.sessions[0]!.doingNow?.prompt).toBe('the real ask');
      expect(JSON.stringify(r)).not.toContain(LEAK);
    });

    it('nulls an out-of-range registry timestamp and still lists every session', async () => {
      await session(160, { sessionId: SID_A, startedAt: 1e16 });
      await session(161, { sessionId: SID_B, statusUpdatedAt: 1e16 });
      await session(162, { sessionId: SID_C });
      const r = await read();
      const by = new Map(r.sessions.map((s) => [s.pid, s]));
      expect([...by.keys()].sort()).toEqual([160, 161, 162]);
      expect(by.get(160)!.startedAt).toBeNull();
      expect(by.get(160)!.statusSince).toBe('2026-10-06T11:30:00.000Z');
      expect(by.get(161)!.statusSince).toBeNull();
      expect(by.get(161)!.startedAt).toBe('2026-10-06T10:00:00.000Z');
    });

    it.skipIf(process.platform === 'win32')(
      'skips a registry entry or transcript that is not a regular file without blocking',
      async () => {
        const regFifo = path.join(config, 'sessions', '170.json');
        execFileSync('mkfifo', [regFifo]);
        alive.add(170);
        await session(171, { sessionId: SID_B, status: 'idle' });
        const dir = path.join(config, 'projects', root.replace(/\//g, '-'));
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
      const dir = path.join(config, 'projects', root.replace(/\//g, '-'));
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
      const s = (await read()).sessions[0]!;
      for (const v of [s.doingNow?.prompt, s.doingNow?.assistant, s.next]) {
        expect(typeof v).toBe('string');
        expect(LONE_SURROGATE.test(v!)).toBe(false);
        expect(Array.from(v!).length).toBeLessThanOrEqual(280);
      }
    });

    it('strips control characters from the version and keeps the warning short', async () => {
      await session(175, { version: `3.0\u0000\n${'v'.repeat(10 * 1024)}` });
      const w = (await read()).formatWarning;
      expect(w).toMatch(/3\.0/);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting they are gone
      expect(w).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(w!.length).toBeLessThan(200);
    });

    it('labels a cwd that matches its root only by case with a plain name', async () => {
      await session(176, { cwd: path.join(tmp, 'proj', 'REPO', 'gone') });
      const s = (await read({ foldCase: true })).sessions[0]!;
      expect(s.inScopeBy).toBe('cwd');
      expect(s.cwdLabel.split(/[\\/]/)).not.toContain('..');
      expect(s.cwdLabel.startsWith('/')).toBe(false);
      expect(s.cwdLabel).toBe('gone');
    });

    it('lists each registry field that failed validation, by name only', async () => {
      await session(177, { startedAt: 'RAWVALUE-ONE', status: 'RAWVALUE-TWO' });
      const r = await read();
      const s = r.sessions[0]!;
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
        const s = r.sessions[0]!;
        expect(s.inScopeBy).toBe('stamped');
        const epic = s.linked?.epics[0];
        expect(epic).toMatchObject({ epicId: EPIC_ID, factorySessionIds: [SESSION_ID] });
        expect(epic?.currentWave?.sessionId).toBe(SESSION_ID);
        expect(epic?.currentWave?.taskIds).toHaveLength(4);
        expect(epic?.currentWave?.counts.done).toBeGreaterThanOrEqual(1);
        expect(epic?.progress).toMatchObject({
          done: expect.any(Number),
          todo: expect.any(Number),
        });
        const total = Object.values(epic!.progress!).reduce((a, b) => a + b, 0);
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
        const s = (await reader().read(handle)).sessions[0]!;
        expect(s.linked).toBeNull();
      } finally {
        handle.sqlite.close();
      }
    });

    it('titles a linked epic with its root session title', async () => {
      await session(142, { cwd: outside });
      const handle = openDb(dbPath, {});
      try {
        const epic = (await reader().read(handle)).sessions[0]?.linked?.epics[0];
        expect(epic?.title).toBe('Build the widget and fix the flaky import.');
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
        extra: { taskId?: string; actor?: string } = {},
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
            },
            opts,
          )
        ).event_id;
      };
      return {
        add,
        last: () => parent,
        addTask: (epicId: string, taskId: string) =>
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
            },
            { taskId, actor: 'planner' },
          ),
        dispatch: (taskId: string) =>
          add(
            'dispatch_decision',
            {
              agent_role: 'coder',
              provider: 'claude',
              model_tier: 'mid',
              model: 'claude-sonnet-5',
              spec_ref: 'specs/thing.json',
              reason: 'implement the thing',
            },
            { taskId, actor: 'planner' },
          ),
      };
    }

    async function linkedEpics(pid: number, cli: string) {
      await rebuild(dbPath, 'all', { stateDir, roadmapPath: path.join(tmp, 'none.md') });
      await session(pid, { sessionId: cli, cwd: outside });
      const handle = openDb(dbPath, {});
      try {
        return (await reader().read(handle)).sessions[0]?.linked?.epics ?? [];
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
      expect(epic?.currentWave).toMatchObject({
        sessionId: 'sess-a-wave2',
        taskIds: ['epic-9/task-2'],
      });
      expect(total(epic?.currentWave?.counts)).toBe(1);
      expect(epic?.workingAgents).toEqual([{ role: 'coder', taskId: 'epic-9/task-2' }]);
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

    it('does not report a wave merged under bare task ids as the current wave', async () => {
      const root = await factorySession('sess-q', SID_B);
      await root.addTask('epic-6', 'epic-6/task-1');
      await root.add('wave-admitted', { epic_id: 'epic-6', task_ids: ['epic-6/task-1'] });
      await root.add('wave-merged', { epic_id: 'epic-6', task_ids: ['task-1'] });

      const [epic] = await linkedEpics(162, SID_B);
      expect(epic?.epicId).toBe('epic-6');
      expect(epic?.currentWave).toBeNull();
    });

    it('counts a wave admitted under bare task ids against its qualified tasks', async () => {
      const root = await factorySession('sess-b', SID_B);
      await root.addTask('epic-5', 'epic-5/task-1');
      await root.addTask('epic-5', 'epic-5/task-2');
      await root.add('wave-admitted', { epic_id: 'epic-5', task_ids: ['task-1', 'task-2'] });

      const [epic] = await linkedEpics(163, SID_B);
      expect(epic?.currentWave?.taskIds).toEqual(['task-1', 'task-2']);
      expect(total(epic?.currentWave?.counts)).toBe(2);
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
