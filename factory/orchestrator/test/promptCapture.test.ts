import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent } from '../src/events.js';
import { capturePrompt, resolveCaptureStore, resolveLine } from '../src/promptCapture.js';

// Every tree here is a temp dir. The resolver is read-only, but the fixtures
// stand in for a factory clone, so none of them may be the real one.
let base: string;
let clone: string;
let roadmapPath: string;

const milestone = (id: string, project?: string): string =>
  `\n## ${id}\n- id: ${id}\n- status: completed\n${
    project === undefined ? '' : `- project: ${project}\n`
  }- epics: []\n- goal: whatever.\n`;

const writeRoadmap = (file: string, ...projects: string[]): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `# Roadmap\n${projects.map((p) => milestone(`m-${p}`, p)).join('')}`);
};

const git = (cwd: string, ...args: string[]): void => {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdio: 'ignore' },
  );
};

/** A checkout beside the clone, with or without its own store. */
const checkout = (name: string, opts: { store?: 'overlay' | 'plain' } = {}): string => {
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  if (opts.store === 'overlay')
    mkdirSync(path.join(dir, '.blacksmith', 'state', 'events'), { recursive: true });
  if (opts.store === 'plain') mkdirSync(path.join(dir, 'state', 'events'), { recursive: true });
  return dir;
};

const resolve = (cwd: string, over: Partial<Parameters<typeof resolveCaptureStore>[0]> = {}) =>
  resolveCaptureStore({
    cwd,
    env: {},
    repoRoot: clone,
    isClone: true,
    roadmapPath,
    ...over,
  });

const real = (p: string): string => realpathSync(p);

beforeEach(() => {
  base = real(mkdtempSync(path.join(tmpdir(), 'bs-capture-')));
  clone = path.join(base, 'factory-clone');
  mkdirSync(path.join(clone, '.git'), { recursive: true });
  mkdirSync(path.join(clone, 'state', 'events'), { recursive: true });
  roadmapPath = path.join(clone, 'factory', 'specs', 'roadmap.md');
  writeRoadmap(roadmapPath, 'acme');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('resolveCaptureStore: M1, M2, M3', () => {
  it('is a no-op for a cwd that belongs to no store', () => {
    const elsewhere = path.join(base, 'nowhere');
    mkdirSync(elsewhere);
    expect(resolve(elsewhere)).toBeNull();
  });

  it('M1: BS_HOME with a store wins over everything', () => {
    const home = path.join(base, 'home');
    mkdirSync(path.join(home, 'state', 'events'), { recursive: true });
    const acme = checkout('acme', { store: 'overlay' });
    expect(resolve(acme, { env: { BS_HOME: home } })).toEqual({
      eventsDir: path.join(home, 'state', 'events'),
      rule: 'M1',
    });
  });

  it('M2: a checkout with its own store resolves to it', () => {
    const beta = checkout('beta-app', { store: 'overlay' });
    expect(resolve(beta)).toEqual({
      eventsDir: path.join(beta, '.blacksmith', 'state', 'events'),
      rule: 'M2',
    });
  });

  it('M2: a plain state/events at the top counts too', () => {
    const beta = checkout('beta-app', { store: 'plain' });
    expect(resolve(path.join(beta))?.eventsDir).toBe(path.join(beta, 'state', 'events'));
  });

  it('M2: a linked worktree resolves to its main clone store', () => {
    const beta = checkout('beta-app', { store: 'overlay' });
    const wt = path.join(base, 'elsewhere-wt');
    git(beta, 'worktree', 'add', '-q', '-b', 'wt-branch', wt);
    expect(resolve(wt)).toEqual({
      eventsDir: path.join(beta, '.blacksmith', 'state', 'events'),
      rule: 'M2',
    });
  });

  it('M3: `bs` with a store under the work root resolves, anything else does not', () => {
    const elsewhere = path.join(base, 'nowhere');
    mkdirSync(elsewhere);
    expect(resolve(elsewhere, { command: 'bs' })).toEqual({
      eventsDir: path.join(clone, 'state', 'events'),
      rule: 'M3',
    });
    expect(resolve(elsewhere, { command: 'bs-mod' })).toBeNull();
    expect(resolve(elsewhere, { command: undefined })).toBeNull();
  });

  it('M3: a work root with no store is a no-op even for `bs`', () => {
    const elsewhere = path.join(base, 'nowhere');
    mkdirSync(elsewhere);
    expect(resolve(elsewhere, { command: 'bs', isClone: false })).toBeNull();
  });
});

describe('resolveCaptureStore: M4', () => {
  it('a declared checkout with no store resolves to the clone store, with its project', () => {
    const acme = checkout('acme');
    expect(resolve(acme)).toEqual({
      eventsDir: path.join(clone, 'state', 'events'),
      project: 'acme',
      rule: 'M4',
    });
  });

  it('a subdirectory of the declared checkout matches too', () => {
    const acme = checkout('acme');
    mkdirSync(path.join(acme, 'src'));
    expect(resolve(path.join(acme, 'src'))?.rule).toBe('M4');
  });

  it('a linked worktree of it, outside the projects dir, resolves the same', () => {
    const acme = checkout('acme');
    const outside = real(mkdtempSync(path.join(tmpdir(), 'bs-capture-wt-')));
    try {
      const wt = path.join(outside, 'acme-wt');
      git(acme, 'worktree', 'add', '-q', '-b', 'wt-branch', wt);
      expect(resolve(wt)).toEqual({
        eventsDir: path.join(clone, 'state', 'events'),
        project: 'acme',
        rule: 'M4',
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a symlinked checkout path matches after realpath', () => {
    const acme = checkout('acme');
    const link = path.join(base, 'acme-link');
    symlinkSync(acme, link);
    expect(resolve(link)?.rule).toBe('M4');
  });

  it('an undeclared checkout is a no-op', () => {
    expect(resolve(checkout('beta-app'))).toBeNull();
  });

  it('a declared checkout with its own store keeps M2 and carries no project', () => {
    const acme = checkout('acme', { store: 'overlay' });
    const got = resolve(acme);
    expect(got?.rule).toBe('M2');
    expect(got).not.toHaveProperty('project');
  });

  it('BS_HOME set with no store under it is a no-op, not M4', () => {
    const acme = checkout('acme');
    expect(resolve(acme, { env: { BS_HOME: path.join(base, 'missing-home') } })).toBeNull();
  });

  it('isClone false (a packed install) is never M4', () => {
    expect(resolve(checkout('acme'), { isClone: false })).toBeNull();
  });

  it('an unreadable or invalid roadmap is a no-op', () => {
    const acme = checkout('acme');
    expect(resolve(acme, { roadmapPath: path.join(base, 'no-such-roadmap.md') })).toBeNull();
    writeFileSync(roadmapPath, '## not a roadmap\n- project: acme\n');
    expect(resolve(acme)).toBeNull();
  });

  it('M4 needs the clone to hold a store already', () => {
    rmSync(path.join(clone, 'state'), { recursive: true });
    expect(resolve(checkout('acme'))).toBeNull();
  });

  it('M3 loses to M4 when both apply, so only M4 knows the project', () => {
    expect(resolve(checkout('acme'), { command: 'bs' })?.rule).toBe('M4');
  });
});

describe('resolveCaptureStore: M4 and the checkout overlay roadmap (Q5b)', () => {
  const overlay = (dir: string): string =>
    path.join(dir, '.blacksmith', 'factory', 'specs', 'roadmap.md');

  it('a project declared only in its own overlay roadmap resolves to the clone store', () => {
    const gamma = checkout('gamma');
    writeRoadmap(overlay(gamma), 'gamma');
    expect(resolve(gamma)).toEqual({
      eventsDir: path.join(clone, 'state', 'events'),
      project: 'gamma',
      rule: 'M4',
    });
  });

  it('an overlay roadmap declaring another project is a no-op', () => {
    const gamma = checkout('gamma');
    writeRoadmap(overlay(gamma), 'beta-app');
    expect(resolve(gamma)).toBeNull();
  });

  it('...unless the clone roadmap declares the checkout', () => {
    const acme = checkout('acme');
    writeRoadmap(overlay(acme), 'beta-app');
    expect(resolve(acme)?.project).toBe('acme');
  });

  it('an invalid overlay roadmap does not break M4 from the clone roadmap', () => {
    const acme = checkout('acme');
    mkdirSync(path.dirname(overlay(acme)), { recursive: true });
    writeFileSync(overlay(acme), '\u0000 not a roadmap');
    expect(resolve(acme)?.project).toBe('acme');
  });

  it('with no overlay file the result is the clone roadmap result alone', () => {
    expect(resolve(checkout('gamma'))).toBeNull();
    expect(resolve(checkout('acme'))?.project).toBe('acme');
  });
});

// ---------------------------------------------------------------------------
// capturePrompt: the write path both entries share.
// ---------------------------------------------------------------------------

const CLI = '11111111-2222-4333-8444-555555555555';
const OTHER_CLI = '99999999-2222-4333-8444-555555555555';

/** A store that M1 finds through BS_HOME, so the capture tests need no git. */
function homeStore(): { env: Record<string, string>; dir: string; cwd: string } {
  const home = path.join(base, 'bs-home');
  const dir = path.join(home, 'state', 'events');
  mkdirSync(dir, { recursive: true });
  const cwd = path.join(base, 'anywhere');
  mkdirSync(cwd, { recursive: true });
  return { env: { BS_HOME: home }, dir, cwd };
}

const ctxFor = (env: Record<string, string>, cwd: string) => ({
  env,
  cwd,
  repoRoot: clone,
  isClone: true,
  roadmapPath,
});

const hookInput = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    session_id: CLI,
    prompt: 'Fix the flaky import.',
    hook_event_name: 'UserPromptSubmit',
    ...over,
  });

// biome-ignore lint/suspicious/noExplicitAny: parsed fixture rows are read by key
const readLog = (dir: string, session: string): any[] =>
  readFileSync(path.join(dir, `${session}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

const seed = (
  dir: string,
  session: string,
  actor: string,
  type: string,
  parent: string | null,
  extra: { cli?: string; plan?: number; project?: string } = {},
) =>
  appendEvent(
    {
      session_id: session,
      actor,
      event_type: type,
      plan_version: extra.plan ?? 1,
      causal_parent: parent,
      payload: {},
      ...(extra.project === undefined ? {} : { project: extra.project }),
    },
    { stateDir: dir, cliSessionId: extra.cli ?? CLI },
  );

describe('capturePrompt', () => {
  it('is a no-op in a cwd that is not managed', async () => {
    const nowhere = path.join(base, 'nowhere');
    mkdirSync(nowhere);
    expect(await capturePrompt(hookInput(), ctxFor({}, nowhere))).toBeNull();
    expect(existsSync(path.join(clone, 'state', 'events', `prompts-${CLI}.jsonl`))).toBe(false);
  });

  it.each([
    ['an agent_id', { agent_id: 'sub-1', agent_type: 'coder' }],
    ['whitespace-only text', { prompt: '  \n\t ' }],
    ['harness text', { prompt: '<system-reminder>x</system-reminder>' }],
    ['a task notification', { prompt: '<task-notification>done</task-notification>' }],
    ['a session id that is not one path segment', { session_id: '../escape' }],
    ['a missing prompt', { prompt: undefined }],
  ])('skips %s', async (_n, over) => {
    const { env, dir, cwd } = homeStore();
    expect(await capturePrompt(hookInput(over), ctxFor(env, cwd))).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([['not json'], [''], ['[]'], ['null'], ['{"prompt":"x"}']])(
    'prints nothing for stdin %j',
    async (raw) => {
      const { env, dir, cwd } = homeStore();
      expect(await capturePrompt(raw, ctxFor(env, cwd))).toBeNull();
      expect(readdirSync(dir)).toEqual([]);
    },
  );

  it('creates a home log whose root is a system event with no parent, then the prompt', async () => {
    const { env, dir, cwd } = homeStore();
    const out = await capturePrompt(hookInput({ prompt: 'Fix it.\n' }), ctxFor(env, cwd));

    const home = `prompts-${CLI}`;
    const [root, prompt] = readLog(dir, home);
    expect(root).toMatchObject({
      session_id: home,
      actor: 'system',
      event_type: 'session-start',
      causal_parent: null,
      plan_version: 1,
      payload: { kind: 'prompt-log' },
    });
    expect(root).not.toHaveProperty('project');
    expect(prompt).toMatchObject({
      actor: 'user',
      event_type: 'user_prompt',
      causal_parent: `${home}#0`,
      plan_version: 1,
      cli_session_id: CLI,
      payload: { prompt: 'Fix it.\n', source: 'hook' },
    });
    expect(prompt.payload).not.toHaveProperty('command');
    expect(prompt.payload).not.toHaveProperty('prompt_id');
    expect(out).toBe(
      `bs prompt capture: ${JSON.stringify({ event_id: `${home}#1`, session_id: home })}`,
    );
  });

  it('chains the next prompt off the previous one and never continues another log', async () => {
    const { env, dir, cwd } = homeStore();
    await capturePrompt(hookInput({ prompt: 'one' }), ctxFor(env, cwd));
    const out = await capturePrompt(hookInput({ prompt: 'two' }), ctxFor(env, cwd));
    const log = readLog(dir, `prompts-${CLI}`);
    expect(log).toHaveLength(3);
    expect(log[0].causal_parent).toBeNull();
    expect(log[2].causal_parent).toBe(`prompts-${CLI}#1`);
    expect(out).toContain(`prompts-${CLI}#2`);
    expect(log.filter((e) => e.event_type === 'session-start')).toHaveLength(1);
  });

  it('records prompt_id and the slash command, and keeps the full text', async () => {
    const { env, dir, cwd } = homeStore();
    await capturePrompt(
      hookInput({ prompt: '/bs run acme-1', prompt_id: 'p-1' }),
      ctxFor(env, cwd),
    );
    const p = readLog(dir, `prompts-${CLI}`)[1];
    expect(p.payload).toEqual({
      prompt: '/bs run acme-1',
      source: 'hook',
      prompt_id: 'p-1',
      command: 'bs',
    });
  });

  it.each([
    ['/bs-mod off', 'bs-mod'],
    ['/bs run acme-1', 'bs'],
    ['/plug:cmd x', 'plug:cmd'],
    ['/tmp/x.log is broken', undefined],
    ['/', undefined],
    ['/ x', undefined],
    ['plain text', undefined],
  ])('payload.command for %j is %j', async (prompt, command) => {
    const { env, dir, cwd } = homeStore();
    await capturePrompt(hookInput({ prompt }), ctxFor(env, cwd));
    const p = readLog(dir, `prompts-${CLI}`)[1];
    expect(p.payload.prompt).toBe(prompt);
    if (command === undefined) expect(p.payload).not.toHaveProperty('command');
    else expect(p.payload.command).toBe(command);
  });

  it('M3 holds for /bs only: /bs-mod in a cwd with no store is a no-op', async () => {
    const nowhere = path.join(base, 'nowhere');
    mkdirSync(nowhere);
    const ctx = ctxFor({}, nowhere);
    expect(await capturePrompt(hookInput({ prompt: '/bs-mod off' }), ctx)).toBeNull();
    const out = await capturePrompt(hookInput({ prompt: '/bs new gamma' }), ctx);
    expect(out).toContain(`prompts-${CLI}#1`);
    expect(existsSync(path.join(clone, 'state', 'events', `prompts-${CLI}.jsonl`))).toBe(true);
  });

  describe('target log', () => {
    it('goes to the epic main log, with its parent and plan_version read from it', async () => {
      const { env, dir, cwd } = homeStore();
      const root = await seed(dir, 'acme-1-main', 'operator', 'session-start', null, { plan: 3 });
      const note = await seed(dir, 'acme-1-main', 'orchestrator', 'progress', root.event_id, {
        plan: 3,
      });
      const out = await capturePrompt(hookInput(), ctxFor(env, cwd));

      const log = readLog(dir, 'acme-1-main');
      expect(log).toHaveLength(3);
      expect(log[2]).toMatchObject({
        causal_parent: note.event_id,
        plan_version: 3,
        actor: 'user',
      });
      expect(out).toContain('acme-1-main#2');
      expect(existsSync(path.join(dir, `prompts-${CLI}.jsonl`))).toBe(false);
    });

    it('the epic main log wins over a wave log stamped with the same CLI id', async () => {
      const { env, dir, cwd } = homeStore();
      const root = await seed(dir, 'acme-1-main', 'operator', 'session-start', null);
      await seed(dir, 'acme-1-main', 'orchestrator', 'progress', root.event_id);
      const wroot = await seed(dir, 'acme-1-w1', 'wave-runner', 'session-start', null);
      await seed(dir, 'acme-1-w1', 'orchestrator', 'progress', wroot.event_id);
      await capturePrompt(hookInput(), ctxFor(env, cwd));
      expect(readLog(dir, 'acme-1-w1')).toHaveLength(2);
      expect(readLog(dir, 'acme-1-main')).toHaveLength(3);
    });

    it('skips a log holding epic-closed', async () => {
      const { env, dir, cwd } = homeStore();
      const root = await seed(dir, 'acme-1-main', 'operator', 'session-start', null);
      await seed(dir, 'acme-1-main', 'operator', 'epic-closed', root.event_id);
      await capturePrompt(hookInput(), ctxFor(env, cwd));
      expect(readLog(dir, 'acme-1-main')).toHaveLength(2);
      expect(readLog(dir, `prompts-${CLI}`)).toHaveLength(2);
    });

    it('ignores a log stamped with another CLI id', async () => {
      const { env, dir, cwd } = homeStore();
      await seed(dir, 'beta-main', 'operator', 'session-start', null, { cli: OTHER_CLI });
      await capturePrompt(hookInput(), ctxFor(env, cwd));
      expect(readLog(dir, 'beta-main')).toHaveLength(1);
      expect(existsSync(path.join(dir, `prompts-${CLI}.jsonl`))).toBe(true);
    });

    it('ignores a log older than the transcript', async () => {
      const { env, dir, cwd } = homeStore();
      await seed(dir, 'acme-1-main', 'operator', 'session-start', null);
      const old = new Date('2020-01-01T00:00:00Z');
      utimesSync(path.join(dir, 'acme-1-main.jsonl'), old, old);
      const transcript = path.join(base, 't.jsonl');
      writeFileSync(transcript, '');
      await capturePrompt(hookInput({ transcript_path: transcript }), ctxFor(env, cwd));
      expect(readLog(dir, 'acme-1-main')).toHaveLength(1);
      expect(existsSync(path.join(dir, `prompts-${CLI}.jsonl`))).toBe(true);
    });

    it('finds this CLI id past 20 newer logs that lack it', async () => {
      const { env, dir, cwd } = homeStore();
      const root = await seed(dir, 'acme-1-main', 'operator', 'session-start', null);
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(path.join(dir, 'acme-1-main.jsonl'), old, old);
      for (let i = 0; i < 21; i++) {
        await seed(dir, `beta-app-${i}-main`, 'operator', 'session-start', null, {
          cli: OTHER_CLI,
        });
      }
      await capturePrompt(hookInput(), ctxFor(env, cwd));
      const log = readLog(dir, 'acme-1-main');
      expect(log).toHaveLength(2);
      expect(log[1].causal_parent).toBe(root.event_id);
      expect(existsSync(path.join(dir, `prompts-${CLI}.jsonl`))).toBe(false);
    });

    it('falls back to the home log when the epic log cannot be appended', async () => {
      const { env, dir, cwd } = homeStore();
      await seed(dir, 'acme-1-main', 'operator', 'session-start', null, { project: 'acme' });
      const epic = path.join(dir, 'acme-1-main.jsonl');
      chmodSync(epic, 0o444);
      try {
        const out = await capturePrompt(hookInput(), ctxFor(env, cwd));
        expect(out).toContain(`prompts-${CLI}#1`);
      } finally {
        chmodSync(epic, 0o644);
      }
      expect(readLog(dir, 'acme-1-main')).toHaveLength(1);
      const home = readLog(dir, `prompts-${CLI}`);
      expect(home).toHaveLength(2);
      expect(home[0].event_type).toBe('session-start');
      expect(home[1]).toMatchObject({ event_type: 'user_prompt', session_id: `prompts-${CLI}` });
    });

    it('a failing home log still throws, with no second retry', async () => {
      const { env, dir, cwd } = homeStore();
      await capturePrompt(hookInput({ prompt: 'first' }), ctxFor(env, cwd));
      const home = path.join(dir, `prompts-${CLI}.jsonl`);
      chmodSync(home, 0o444);
      try {
        await expect(
          capturePrompt(hookInput({ prompt: 'second' }), ctxFor(env, cwd)),
        ).rejects.toThrow();
      } finally {
        chmodSync(home, 0o644);
      }
    });

    it('two concurrent captures each see the other as parent, inside the lock', async () => {
      const { env, dir, cwd } = homeStore();
      const root = await seed(dir, 'acme-1-main', 'operator', 'session-start', null, { plan: 2 });
      const ctx = ctxFor(env, cwd);
      const [a, b] = await Promise.all([
        capturePrompt(hookInput({ prompt: 'a' }), ctx),
        capturePrompt(hookInput({ prompt: 'b' }), ctx),
      ]);
      expect(a).not.toBe(b);
      const log = readLog(dir, 'acme-1-main');
      expect(log).toHaveLength(3);
      expect(log[1].causal_parent).toBe(root.event_id);
      expect(log[2].causal_parent).toBe('acme-1-main#1');
      expect(log.map((e) => e.plan_version)).toEqual([2, 2, 2]);
    });
  });

  describe('dedupe', () => {
    it('a repeated prompt_id writes and prints nothing', async () => {
      const { env, dir, cwd } = homeStore();
      const ctx = ctxFor(env, cwd);
      expect(await capturePrompt(hookInput({ prompt_id: 'p-1', prompt: 'a' }), ctx)).not.toBeNull();
      expect(await capturePrompt(hookInput({ prompt_id: 'p-1', prompt: 'b' }), ctx)).toBeNull();
      expect(readLog(dir, `prompts-${CLI}`)).toHaveLength(2);
    });

    it('the same text from the same CLI id within 10 s writes nothing; other text does', async () => {
      const { env, dir, cwd } = homeStore();
      const ctx = ctxFor(env, cwd);
      await capturePrompt(hookInput({ prompt: 'same' }), ctx);
      expect(await capturePrompt(hookInput({ prompt: 'same' }), ctx)).toBeNull();
      expect(await capturePrompt(hookInput({ prompt: 'other' }), ctx)).not.toBeNull();
      expect(readLog(dir, `prompts-${CLI}`)).toHaveLength(3);
    });

    it('the same text from another CLI id is not a duplicate', async () => {
      const { env, dir, cwd } = homeStore();
      const ctx = ctxFor(env, cwd);
      await capturePrompt(hookInput({ prompt: 'same' }), ctx);
      expect(
        await capturePrompt(hookInput({ prompt: 'same', session_id: OTHER_CLI }), ctx),
      ).not.toBeNull();
      expect(existsSync(path.join(dir, `prompts-${OTHER_CLI}.jsonl`))).toBe(true);
    });
  });

  describe('M4 project', () => {
    it('a home log created under M4 carries project on its root and its prompts', async () => {
      const acme = checkout('acme');
      const out = await capturePrompt(hookInput(), ctxFor({}, acme));
      const dir = path.join(clone, 'state', 'events');
      const [root, prompt] = readLog(dir, `prompts-${CLI}`);
      expect(root.project).toBe('acme');
      expect(prompt.project).toBe('acme');
      expect(out).toContain(`prompts-${CLI}#1`);
    });

    it('an epic main log parent with no project gives way to the declared name; one with a project keeps it', async () => {
      const acme = checkout('acme');
      const dir = path.join(clone, 'state', 'events');
      await seed(dir, 'acme-1-main', 'operator', 'session-start', null);
      await capturePrompt(hookInput({ prompt: 'one' }), ctxFor({}, acme));
      const log = readLog(dir, 'acme-1-main');
      expect(log[1].project).toBe('acme');
      // The prompt now carries a project, so a later one copies it from the parent.
      await capturePrompt(hookInput({ prompt: 'two' }), ctxFor({}, acme));
      expect(readLog(dir, 'acme-1-main')[2].project).toBe('acme');

      await seed(dir, 'beta-main', 'operator', 'session-start', null, {
        cli: OTHER_CLI,
        project: 'beta-app',
      });
      await capturePrompt(hookInput({ session_id: OTHER_CLI, prompt: 'three' }), ctxFor({}, acme));
      expect(readLog(dir, 'beta-main')[1].project).toBe('beta-app');
    });
  });
});

describe('resolveLine (--resolve)', () => {
  it('prints one JSON line for an M4 checkout and nothing for an undeclared one', () => {
    const line = resolveLine(checkout('acme'), ctxFor({}, base));
    expect(JSON.parse(line as string)).toEqual({
      events_dir: path.join(clone, 'state', 'events'),
      project: 'acme',
      rule: 'M4',
    });
    expect(resolveLine(checkout('beta-app'), ctxFor({}, base))).toBeNull();
  });

  it('omits project for M2 and writes nothing', () => {
    const beta = checkout('beta-app', { store: 'overlay' });
    const before = readdirSync(beta);
    expect(JSON.parse(resolveLine(beta, ctxFor({}, base)) as string)).toEqual({
      events_dir: path.join(beta, '.blacksmith', 'state', 'events'),
      rule: 'M2',
    });
    expect(readdirSync(beta)).toEqual(before);
  });
});

describe('capturePrompt in answer mode', () => {
  const answerInput = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      session_id: CLI,
      hook_event_name: 'PostToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_01',
      tool_input: {},
      tool_response: {
        questions: [
          {
            question: 'Which store?',
            header: 'Store',
            options: [{ label: 'A' }],
            multiSelect: false,
          },
          {
            question: 'Which flags?',
            header: 'Flags',
            options: [{ label: 'x' }],
            multiSelect: true,
          },
        ],
        answers: { 'Which store?': 'A', 'Which flags?': 'x, y' },
        annotations: { 'Which store?': { notes: 'the old one' } },
      },
      ...over,
    });
  const respond = (over: Record<string, unknown>): string =>
    answerInput({
      tool_response: {
        questions: [{ question: 'Q1', header: 'H1', options: [], multiSelect: false }],
        answers: {},
        ...over,
      },
    });

  it('records an answer as a user_prompt with kind answer and prompt_id = tool_use_id', async () => {
    const { env, dir, cwd } = homeStore();
    const out = await capturePrompt(answerInput(), ctxFor(env, cwd), 'answer');
    const home = `prompts-${CLI}`;
    const [, row] = readLog(dir, home);
    expect(row).toMatchObject({ actor: 'user', event_type: 'user_prompt' });
    expect(row.payload).toEqual({
      prompt: 'Store: A\nFlags: x, y',
      source: 'hook',
      kind: 'answer',
      prompt_id: 'toolu_01',
      answers: [
        { question: 'Which store?', header: 'Store', answer: 'A', notes: 'the old one' },
        { question: 'Which flags?', header: 'Flags', answer: 'x, y' },
      ],
    });
    expect(out).toBe(
      `bs prompt capture: ${JSON.stringify({ event_id: `${home}#1`, session_id: home })}`,
    );
  });

  it('leaves an unanswered question out', async () => {
    const { env, dir, cwd } = homeStore();
    await capturePrompt(
      answerInput({
        tool_response: {
          questions: [
            { question: 'Q1', header: 'H1', options: [], multiSelect: false },
            { question: 'Q2', header: 'H2', options: [], multiSelect: false },
          ],
          answers: { Q2: 'yes' },
        },
      }),
      ctxFor(env, cwd),
      'answer',
    );
    const [, row] = readLog(dir, `prompts-${CLI}`);
    expect(row.payload.prompt).toBe('H2: yes');
    expect(row.payload.answers).toHaveLength(1);
  });

  it('records a free-text response when no question is answered', async () => {
    const { env, dir, cwd } = homeStore();
    await capturePrompt(respond({ response: 'neither, do C' }), ctxFor(env, cwd), 'answer');
    const [, row] = readLog(dir, `prompts-${CLI}`);
    expect(row.payload).toMatchObject({ prompt: 'neither, do C', response: 'neither, do C' });
  });

  it('writes nothing when afkTimeoutMs is set', async () => {
    const { env, dir, cwd } = homeStore();
    const raw = respond({ answers: { Q1: 'yes' }, afkTimeoutMs: 30000 });
    expect(await capturePrompt(raw, ctxFor(env, cwd), 'answer')).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes nothing when no question is answered and there is no response', async () => {
    const { env, dir, cwd } = homeStore();
    expect(await capturePrompt(respond({}), ctxFor(env, cwd), 'answer')).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('skips an agent_id, a missing tool_use_id and a non-AskUserQuestion tool', async () => {
    const { env, dir, cwd } = homeStore();
    for (const over of [{ agent_id: 'sub-1' }, { tool_use_id: undefined }, { tool_name: 'Bash' }]) {
      expect(await capturePrompt(answerInput(over), ctxFor(env, cwd), 'answer')).toBeNull();
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('keeps two identical answers within 10 s, but dedupes a repeated tool_use_id', async () => {
    const { env, dir, cwd } = homeStore();
    const ctx = ctxFor(env, cwd);
    await capturePrompt(answerInput({ tool_use_id: 'toolu_a' }), ctx, 'answer');
    await capturePrompt(answerInput({ tool_use_id: 'toolu_b' }), ctx, 'answer');
    expect(await capturePrompt(answerInput({ tool_use_id: 'toolu_b' }), ctx, 'answer')).toBeNull();
    const rows = readLog(dir, `prompts-${CLI}`).filter((e) => e.event_type === 'user_prompt');
    expect(rows.map((r) => r.payload.prompt_id)).toEqual(['toolu_a', 'toolu_b']);
  });
});
