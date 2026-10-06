import { mkdir, mkdtemp, open, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rebuild } from '../../../factory/orchestrator/src/db/projector.js';
import { buildFixture, EPIC_ID, SESSION_ID } from '../../../factory/orchestrator/test/db/fixtures.js';
import { openDb } from '../../../factory/orchestrator/dist/db/projector.js';
import { type CliFs, type CliSessionsResponse, createCliSessionsReader } from '../src/cliSessions.js';

const SID_A = '11111111-1111-4111-8111-111111111111';
const SID_B = '22222222-2222-4222-8222-222222222222';
const SID_C = '33333333-3333-4333-8333-333333333333';
const SENTINEL = 'KEY-SENTINEL-DO-NOT-LEAK';
const NOW = '2026-10-06T12:00:00.000Z';

const asst = (...blocks: unknown[]) => ({ type: 'assistant', message: { role: 'assistant', content: blocks } });
const text = (t: string) => ({ type: 'text', text: t });
const user = (t: string) => ({ type: 'user', message: { role: 'user', content: t } });
const toolUse = (name: string, id: string, input: unknown = {}) => ({ type: 'tool_use', name, id, input });
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

  async function transcript(cwd: string, sid: string, content: string, encode = true): Promise<string> {
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

  async function read(over: Partial<Parameters<typeof createCliSessionsReader>[0]> = {}, db?: Parameters<ReturnType<typeof reader>['read']>[0]) {
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
        jsonl([user('fix the bug'), asst(toolUse('Bash', 't1')), toolResult('t1'), asst(text('Done.\n\nShall I open the PR?'))]),
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
      await transcript(root, SID_A, jsonl([user('go'), asst(toolUse('AskUserQuestion', 'q1')), toolResult('q1')]));
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
        open: async (p) => (touched.push(p), open(p, 'r')),
        realpath: async (p) => (touched.push(p), realpath(p)),
      };
      const r = await read({ fs: spy });
      expect(r.sessions).toHaveLength(1);
      expect(touched.filter((p) => p.endsWith('.key'))).toEqual([]);
      expect(JSON.stringify(r)).not.toContain(SENTINEL);
    });

    it('answers absent for a missing dir or no configDir, and unreadable with no list', async () => {
      expect(await read({ configDir: path.join(tmp, 'nope') })).toMatchObject({ state: 'absent', sessions: [] });
      const none = await read({ configDir: undefined, configSource: 'none' });
      expect(none).toMatchObject({ state: 'absent', configSource: 'none', sessions: [] });
      const failing: CliFs = {
        readdir: async () => {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        },
        stat,
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
      const filler = jsonl(Array.from({ length: 60 }, (_, i) => user(`filler ${i} ${'z'.repeat(5000)}`)));
      expect(filler.length).toBeGreaterThan(256 * 1024);
      await transcript(root, SID_A, `${filler}${jsonl([user('the real ask'), asst(text('the answer'))])}`);
      const s = (await read()).sessions[0]!;
      expect(s.transcript).toBe('ok');
      expect(s.doingNow).toMatchObject({ prompt: 'the real ask', assistant: 'the answer' });
    });

    it('retries at 1 MB and then reports tail-empty', async () => {
      await session(121, { status: 'idle' });
      const meta = jsonl(Array.from({ length: 80 }, () => ({ type: 'system', note: 'n'.repeat(5000) })));
      await transcript(root, SID_A, `${jsonl([user('early ask')])}${meta}`);
      expect((await read()).sessions[0]!.doingNow?.prompt).toBe('early ask');
      const big = jsonl(Array.from({ length: 300 }, () => ({ type: 'system', note: 'n'.repeat(5000) })));
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
          user('<command-message>bs</command-message>\n<command-name>/bs</command-name>\n<command-args>run</command-args>'),
          { type: 'user', isMeta: true, message: { role: 'user', content: 'meta text' } },
          user('<system-reminder>ignore me</system-reminder>'),
          toolResult('x'),
        ]),
      );
      expect((await read()).sessions[0]!.doingNow?.prompt).toBe('/bs run');
    });

    it('treats an interrupt as idle', async () => {
      await session(123, { status: 'idle' });
      await transcript(root, SID_A, jsonl([asst(text('working')), user('[Request interrupted by user]')]));
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
      await transcript(outside, SID_A, jsonl([user('<command-name>/bs</command-name>'), asst(text('ok'))]));
      const s = (await read()).sessions[0]!;
      expect(s).toMatchObject({ inScopeBy: 'heuristic', linked: null, cwdLabel: 'elsewhere' });
    });

    it('admits an outside session by a Bash bs command', async () => {
      await session(137, { cwd: outside });
      await transcript(outside, SID_A, jsonl([asst(toolUse('Bash', 'b', { command: 'cd x && bs plan status' }))]));
      expect((await read()).sessions[0]!.inScopeBy).toBe('heuristic');
    });

    it('finds the /bs command in the transcript head of a long session', async () => {
      await session(138, { cwd: outside });
      const filler = jsonl(Array.from({ length: 80 }, (_, i) => user(`talk ${i} ${'y'.repeat(5000)}`)));
      await transcript(outside, SID_A, `${jsonl([user('<command-name>/bs</command-name>')])}${filler}`);
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
        expect(epic?.progress).toMatchObject({ done: expect.any(Number), todo: expect.any(Number) });
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
  });

  it('never logs transcript text', async () => {
    await session(150, { status: 'idle' });
    await transcript(root, SID_A, jsonl([user('private prompt'), asst(text('private answer'))]));
    const spies = (['log', 'info', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    await read();
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });
});
