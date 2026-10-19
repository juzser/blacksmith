import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countRecordTokens,
  dedupeKey,
  readSessionTokens,
  type TranscriptFs,
} from '../src/transcriptTokens.js';

const SID = '11111111-2222-4333-8444-555555555555';
const SENTINEL = 'example-sentinel-7f3a';

function asst(id: string, req: string, usage: Record<string, number>, extra: object[] = []) {
  return {
    type: 'assistant',
    requestId: req,
    message: { id, usage, content: [{ type: 'text', text: SENTINEL }, ...extra] },
  };
}
const U = (i: number, c: number, o: number, r = 0) => ({
  input_tokens: i,
  cache_creation_input_tokens: c,
  output_tokens: o,
  cache_read_input_tokens: r,
});
const jl = (recs: unknown[]) => `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`;

describe('countRecordTokens / dedupeKey', () => {
  it('counts input + cache creation + output and never cache reads', () => {
    expect(countRecordTokens(asst('m1', 'r1', U(1, 2, 4, 1000)))).toBe(7);
  });
  it('ignores non-assistant lines', () => {
    expect(countRecordTokens({ type: 'user', message: { id: 'm', usage: U(5, 5, 5) } })).toBe(0);
    expect(dedupeKey({ type: 'user', message: { id: 'm', usage: U(5, 5, 5) } })).toBeNull();
    expect(countRecordTokens(null)).toBe(0);
    expect(countRecordTokens('x')).toBe(0);
  });
  it('keys on message id plus request id', () => {
    expect(dedupeKey(asst('m1', 'r1', U(1, 1, 1)))).toBe(dedupeKey(asst('m1', 'r1', U(1, 1, 1))));
    expect(dedupeKey(asst('m1', 'r1', U(1, 1, 1)))).not.toBe(
      dedupeKey(asst('m1', 'r2', U(1, 1, 1))),
    );
  });
  it('never carries message text', () => {
    const r = asst('m1', 'r1', U(1, 1, 1));
    expect(JSON.stringify([countRecordTokens(r), dedupeKey(r)])).not.toContain(SENTINEL);
  });
});

describe('readSessionTokens', () => {
  let cfg: string;
  let sessDir: string;
  let main: string;
  beforeEach(() => {
    cfg = mkdtempSync(path.join(tmpdir(), 'tt-'));
    sessDir = path.join(cfg, 'projects', 'project-a');
    mkdirSync(sessDir, { recursive: true });
    main = path.join(sessDir, `${SID}.jsonl`);
  });
  afterEach(() => rmSync(cfg, { recursive: true, force: true }));

  function sub(id: string, recs: unknown[] | string, meta: object | null) {
    const d = path.join(sessDir, SID, 'subagents');
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, `agent-${id}.jsonl`), typeof recs === 'string' ? recs : jl(recs));
    if (meta) writeFileSync(path.join(d, `agent-${id}.meta.json`), JSON.stringify(meta));
  }
  const launch = (toolId: string, type: string) => ({
    type: 'assistant',
    requestId: `q-${toolId}`,
    message: {
      id: `l-${toolId}`,
      usage: U(1, 0, 1),
      content: [
        {
          type: 'tool_use',
          id: toolId,
          name: 'Agent',
          input: { subagent_type: type, prompt: SENTINEL },
        },
      ],
    },
  });

  it('dedupes repeats, counts distinct requestIds, skips cache reads and non-assistant lines', async () => {
    writeFileSync(
      main,
      jl([
        asst('m1', 'r1', U(1, 2, 3, 999)),
        asst('m1', 'r1', U(1, 2, 3, 999)),
        asst('m1', 'r2', U(10, 0, 0)),
        { type: 'user', message: { content: SENTINEL } },
      ]),
    );
    const res = await readSessionTokens({ configDir: cfg, cliSessionId: SID });
    expect(res).toEqual({ used: 16, complete: true, subagents: [] });
  });

  it('returns a per-sub-agent breakdown with role from the launching call', async () => {
    writeFileSync(
      main,
      jl([
        asst('m1', 'r1', U(1, 0, 1)),
        launch('tu1', 'bs-coder'),
        launch('tu2', 'general-purpose'),
        launch('tu3', 'bs-nonrole'),
      ]),
    );
    sub('a1', [asst('s1', 'q1', U(5, 0, 5))], { toolUseId: 'tu1' });
    sub('a2', [asst('s2', 'q2', U(1, 0, 1))], { toolUseId: 'tu2' });
    sub('a3', [asst('s3', 'q3', U(2, 0, 0))], { toolUseId: 'tu3' });
    const res = await readSessionTokens({ configDir: cfg, cliSessionId: SID });
    expect(res.complete).toBe(true);
    expect(res.used).toBe(8 + 14);
    const byId = Object.fromEntries(res.subagents.map((s) => [s.agentId, s]));
    expect(byId.a1).toEqual({ agentId: 'a1', role: 'coder', used: 10, complete: true });
    expect(byId.a2?.role).toBeNull();
    expect(byId.a3?.role).toBeNull();
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
  });

  it('is complete:false when a meta file is missing or a line is unparseable', async () => {
    writeFileSync(main, jl([asst('m1', 'r1', U(1, 0, 1))]));
    sub('a1', [asst('s1', 'q1', U(5, 0, 5))], null);
    let res = await readSessionTokens({ configDir: cfg, cliSessionId: SID });
    expect(res.complete).toBe(false);
    expect(res.subagents[0]).toMatchObject({
      agentId: 'a1',
      role: null,
      used: 10,
      complete: false,
    });
    sub('a1', `${JSON.stringify(asst('s1', 'q1', U(5, 0, 5)))}\n${SENTINEL} {not json\n`, {
      toolUseId: 'x',
    });
    res = await readSessionTokens({ configDir: cfg, cliSessionId: SID });
    expect(res.complete).toBe(false);
    expect(res.subagents[0]?.complete).toBe(false);
    expect(res.subagents[0]?.used).toBe(10);
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
  });

  it('marks a main transcript with an unparseable line incomplete', async () => {
    writeFileSync(main, `${JSON.stringify(asst('m1', 'r1', U(1, 0, 1)))}\n${SENTINEL} {bad\n`);
    const res = await readSessionTokens({ configDir: cfg, cliSessionId: SID });
    expect(res).toEqual({ used: 2, complete: false, subagents: [] });
  });

  it('never throws on a missing directory', async () => {
    const res = await readSessionTokens({ configDir: path.join(cfg, 'nope'), cliSessionId: SID });
    expect(res).toEqual({ used: 0, complete: false, subagents: [] });
  });

  it('opens nothing for hostile ids and nothing outside configDir', async () => {
    writeFileSync(main, jl([asst('m1', 'r1', U(1, 0, 1))]));
    const opened: string[] = [];
    const fs: TranscriptFs = {
      readFile: async (p) => {
        opened.push(p);
        return readFileSync(p, 'utf8');
      },
      readdir: async (p) => {
        opened.push(p);
        return readdirSync(p);
      },
    };
    for (const bad of ['../x', 'a/b', 'a\\b', '/abs/x', '', '..', 'a..b']) {
      opened.length = 0;
      const res = await readSessionTokens({ configDir: cfg, cliSessionId: bad, fs });
      expect(res).toEqual({ used: 0, complete: false, subagents: [] });
      expect(opened.filter((p) => p.endsWith(`${bad}.jsonl`) && bad !== '')).toEqual([]);
      for (const p of opened) expect(path.resolve(p).startsWith(`${cfg}${path.sep}`)).toBe(true);
    }
    // injected hostile sub-agent listing
    opened.length = 0;
    const fs2: TranscriptFs = {
      ...fs,
      readdir: async (p) => {
        opened.push(p);
        return p.endsWith('subagents') ? ['agent-../x.jsonl', 'agent-ok.jsonl'] : readdirSync(p);
      },
    };
    sub('ok', [asst('s1', 'q1', U(1, 0, 1))], { toolUseId: 't' });
    const res = await readSessionTokens({ configDir: cfg, cliSessionId: SID, fs: fs2 });
    expect(res.complete).toBe(false);
    expect(res.subagents.map((s) => s.agentId)).toEqual(['ok']);
    expect(opened.some((p) => p.includes('..'))).toBe(false);
    for (const p of opened) expect(path.resolve(p).startsWith(`${cfg}${path.sep}`)).toBe(true);
  });

  it('skips a path that escapes configDir via a relative configDir', async () => {
    const opened: string[] = [];
    const fs: TranscriptFs = {
      readFile: async (p) => {
        opened.push(p);
        return readFileSync(p, 'utf8');
      },
      readdir: async (p) => {
        opened.push(p);
        return readdirSync(p);
      },
    };
    writeFileSync(main, jl([asst('m1', 'r1', U(1, 0, 1))]));
    sub('a1', [asst('s1', 'q1', U(5, 0, 5))], { toolUseId: 'tu1' });
    const res = await readSessionTokens({ configDir: cfg, cliSessionId: SID, fs });
    expect(res.complete).toBe(true);
    expect(opened.length).toBeGreaterThan(0);
    for (const p of opened) {
      const r = path.resolve(p);
      expect(r === cfg || r.startsWith(`${cfg}${path.sep}`)).toBe(true);
    }
  });

  it('is complete:false when a listed sub-agent file is unreadable, and when the listing fails', async () => {
    writeFileSync(main, jl([asst('m1', 'r1', U(1, 0, 1))]));
    const real: TranscriptFs = {
      readFile: async (p) => readFileSync(p, 'utf8'),
      readdir: async (p) => readdirSync(p),
    };
    const ghost: TranscriptFs = {
      ...real,
      readdir: async (p) => (p.endsWith('subagents') ? ['agent-ghost.jsonl'] : readdirSync(p)),
    };
    sub('other', [asst('s1', 'q1', U(1, 0, 1))], { toolUseId: 't' });
    let res = await readSessionTokens({ configDir: cfg, cliSessionId: SID, fs: ghost });
    expect(res.complete).toBe(false);
    expect(res.subagents).toEqual([{ agentId: 'ghost', role: null, used: 0, complete: false }]);
    const broken: TranscriptFs = {
      ...real,
      readdir: async (p) => {
        if (p.endsWith('subagents')) throw Object.assign(new Error('x'), { code: 'EACCES' });
        return readdirSync(p);
      },
    };
    res = await readSessionTokens({ configDir: cfg, cliSessionId: SID, fs: broken });
    expect(res).toEqual({ used: 2, complete: false, subagents: [] });
  });

  it('treats a missing subagents directory as a complete session and honours injected roles', async () => {
    writeFileSync(main, jl([asst('m1', 'r1', U(1, 0, 1)), launch('tu1', 'bs-coder')]));
    expect(await readSessionTokens({ configDir: cfg, cliSessionId: SID })).toMatchObject({
      complete: true,
      subagents: [],
    });
    sub('a1', [asst('s1', 'q1', U(1, 0, 1))], { toolUseId: 'tu1' });
    const res = await readSessionTokens({ configDir: cfg, cliSessionId: SID, roles: ['tester'] });
    expect(res.subagents[0]?.role).toBeNull();
  });
});
