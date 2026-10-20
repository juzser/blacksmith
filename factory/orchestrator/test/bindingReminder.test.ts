import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindingReminder, promptTurnLines } from '../src/bindingReminder.js';
import { appendWithin, ROOT_EVENT_TYPE } from '../src/events.js';
import { type CaptureContext, capturePrompt } from '../src/promptCapture.js';
import {
  BINDING_TAIL_BYTES,
  bindingInput,
  knownProjectNames,
  loadBindingPolicy,
  notRecordedLines,
  reminderLines,
  unknownProjectLines,
} from '../src/sessionBinding.js';

const CLI = '11111111-2222-4333-8444-555555555555';
const OTHER_CLI = '99999999-2222-4333-8444-555555555555';
const HOME = `prompts-${CLI}`;

let base: string;
let clone: string;
let ctx: CaptureContext;
let eventsDir: string;
let checkout: string;

const milestone = (project: string): string =>
  `\n## m-${project}\n- id: m-${project}\n- status: completed\n- project: ${project}\n- epics: []\n- goal: whatever.\n`;

const git = (dir: string): void => {
  execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'binding-reminder-')));
  clone = path.join(base, 'factory-clone');
  mkdirSync(path.join(clone, '.git'), { recursive: true });
  const roadmapPath = path.join(base, 'roadmap.md');
  writeFileSync(roadmapPath, `# Roadmap\n${['project-a', 'project-b'].map(milestone).join('')}`);
  mkdirSync(path.join(base, 'project-b'));
  checkout = path.join(base, 'project-a');
  eventsDir = path.join(checkout, '.blacksmith', 'state', 'events');
  mkdirSync(eventsDir, { recursive: true });
  git(checkout);
  ctx = { cwd: checkout, env: {}, repoRoot: clone, isClone: true, roadmapPath };
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const payload = (prompt: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: CLI, prompt, cwd: checkout, ...over });

/** A home log holding a session-start and one session-bound record. */
async function bind(project: string, cli = CLI): Promise<void> {
  const target = `prompts-${cli}`;
  await appendWithin(
    target,
    (existing) => [
      ...(existing.length === 0
        ? [
            {
              session_id: target,
              actor: 'system',
              event_type: ROOT_EVENT_TYPE,
              plan_version: 1,
              causal_parent: null,
              payload: { kind: 'prompt-log' },
            },
          ]
        : []),
      bindingInput({
        target,
        project,
        causalParent: `${target}#0`,
        planVersion: 1,
      }),
    ],
    { stateDir: eventsDir, cliSessionId: cli },
  );
}

const known = (): string[] => {
  const names = knownProjectNames({
    repoRoot: clone,
    cwd: checkout,
    env: {},
    isClone: true,
    roadmapPath: ctx.roadmapPath,
  });
  expect(names).toEqual(expect.arrayContaining(['project-a', 'project-b']));
  return names;
};

const standing = (project: string): string[] => reminderLines(project, loadBindingPolicy());

describe('bindingReminder: the standing reminder', () => {
  it('returns the reminder for a session bound to a project', async () => {
    await bind('project-a');
    expect(await bindingReminder(payload('Fix it.'), ctx)).toEqual(standing('project-a'));
  });

  it('returns [] with no binding, and with only another session binding', async () => {
    expect(await bindingReminder(payload('Fix it.'), ctx)).toEqual([]);
    await bind('project-a', OTHER_CLI);
    expect(await bindingReminder(payload('Fix it.'), ctx)).toEqual([]);
  });

  it('returns [] for a payload that is not a main-thread prompt', async () => {
    await bind('project-a');
    for (const raw of [
      'not json',
      '[]',
      payload('Fix it.', { session_id: 'zz' }),
      payload('Fix it.', { agent_id: 'a1' }),
      JSON.stringify({ session_id: CLI, cwd: checkout }),
    ]) {
      expect(await bindingReminder(raw, ctx)).toEqual([]);
    }
  });

  it('returns [] outside any store', async () => {
    const elsewhere = path.join(base, 'elsewhere');
    mkdirSync(elsewhere);
    expect(await bindingReminder(payload('Fix it.', { cwd: elsewhere }), ctx)).toEqual([]);
  });

  it('writes nothing', async () => {
    await bind('project-a');
    const before = readdirSync(checkout, { recursive: true });
    await bindingReminder(payload('Fix it.'), ctx);
    await bindingReminder(payload('/bs use nothing-here'), ctx);
    expect(readdirSync(checkout, { recursive: true })).toEqual(before);
  });
});

describe('bindingReminder: /bs use', () => {
  it('lists the known projects for an unknown name and leaks neither the name nor later words', async () => {
    const lines = await bindingReminder(payload('/bs use nothing-here zebra-marker'), ctx);
    expect(lines.slice(0, 2)).toEqual(unknownProjectLines(known()));
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('nothing-here');
    expect(lines.join('\n')).not.toContain('zebra-marker');
  });

  it('follows the unknown-name lines with the standing binding', async () => {
    await bind('project-b');
    const lines = await bindingReminder(payload('/bs use nothing-here zebra-marker'), ctx);
    expect(lines).toEqual([...unknownProjectLines(known()), ...standing('project-b')]);
    expect(lines.join('\n')).not.toContain('zebra-marker');
  });

  it('treats a bare `/bs use` as an unknown name', async () => {
    const lines = await bindingReminder(payload('/bs use'), ctx);
    expect(lines).toEqual(unknownProjectLines(known()));
  });

  it('gives the reminder of a matched name the binding names', async () => {
    await bind('project-a');
    expect(await bindingReminder(payload('/bs use project-a'), ctx)).toEqual(standing('project-a'));
  });

  it('says not recorded for a matched name the binding does not name', async () => {
    expect(await bindingReminder(payload('/bs use project-a'), ctx)).toEqual(notRecordedLines());
    await bind('project-b');
    expect(await bindingReminder(payload('/bs use project-a'), ctx)).toEqual([
      ...notRecordedLines(),
      ...standing('project-b'),
    ]);
  });

  it('says not recorded in a directory with no store', async () => {
    const bare = path.join(base, 'bare');
    mkdirSync(bare);
    git(bare);
    expect(await bindingReminder(payload('/bs use project-a', { cwd: bare }), ctx)).toEqual(
      notRecordedLines(),
    );
  });

  it('says not recorded where only the work root has a store (M3)', async () => {
    const bare = path.join(base, 'bare');
    mkdirSync(bare);
    git(bare);
    mkdirSync(path.join(clone, 'state', 'events'), { recursive: true });
    expect(await bindingReminder(payload('/bs use project-a', { cwd: bare }), ctx)).toEqual(
      notRecordedLines(),
    );
  });
});

describe('bindingReminder: bounded read', () => {
  it('reads the binding from the tail of a log whose head holds a line that is not JSON', async () => {
    const file = path.join(eventsDir, `${HOME}.jsonl`);
    const rec = (event_type: string, payload: Record<string, unknown>) =>
      `${JSON.stringify({
        session_id: HOME,
        actor: 'user',
        event_type,
        plan_version: 1,
        causal_parent: null,
        cli_session_id: CLI,
        project: 'project-a',
        payload,
        ts: '2026-01-01T00:00:00.000Z',
      })}\n`;
    appendFileSync(file, rec('session-start', {}));
    appendFileSync(file, rec('session-bound', { project: 'project-a', source: 'hook' }));
    appendFileSync(file, 'this line is not json\n');
    const prompt = rec('user_prompt', {
      prompt: 'x'.repeat(2000),
      source: 'hook',
      bound_to: 'project-a',
    });
    const count = Math.ceil((4 * 1024 * 1024 + 4096) / prompt.length);
    appendFileSync(file, prompt.repeat(count));
    expect(count * prompt.length).toBeGreaterThan(4 * BINDING_TAIL_BYTES);

    expect(await bindingReminder(payload('Fix it.'), ctx)).toEqual(standing('project-a'));
  });

  it('throws on a bad line inside the window, for promptTurnLines to catch', async () => {
    writeFileSync(path.join(eventsDir, `${HOME}.jsonl`), 'not json\n');
    await expect(bindingReminder(payload('Fix it.'), ctx)).rejects.toThrow();
    expect(await promptTurnLines(payload('Fix it.'), ctx)).toEqual([]);
  });
});

describe('promptTurnLines: each step alone', () => {
  const boom = async (): Promise<never> => {
    throw new Error('boom');
  };
  const cap = async (): Promise<string | null> => 'bs prompt capture: {}';
  const rem = async (): Promise<string[]> => ['bs use: one', 'bs use: two'];

  it('still returns the reminder when the capture throws', async () => {
    expect(await promptTurnLines('', ctx, { capture: boom, reminder: rem })).toEqual([
      'bs use: one',
      'bs use: two',
    ]);
  });

  it('still returns the capture line when the reminder throws', async () => {
    expect(await promptTurnLines('', ctx, { capture: cap, reminder: boom })).toEqual([
      'bs prompt capture: {}',
    ]);
  });

  it('returns [] when both throw', async () => {
    expect(await promptTurnLines('', ctx, { capture: boom, reminder: boom })).toEqual([]);
  });

  it('returns the capture line then the reminder lines when both succeed', async () => {
    expect(await promptTurnLines('', ctx, { capture: cap, reminder: rem })).toEqual([
      'bs prompt capture: {}',
      'bs use: one',
      'bs use: two',
    ]);
  });

  it('skips a null capture line', async () => {
    expect(await promptTurnLines('', ctx, { capture: async () => null, reminder: rem })).toEqual([
      'bs use: one',
      'bs use: two',
    ]);
  });
});

describe('bindingReminder agrees with the binding write (bs-use-2 criteria 5 and 6)', () => {
  const unknownHead = unknownProjectLines([])[0] as string;

  it('session-bound written equals no unknown-name line, for every prompt', async () => {
    writeFileSync(ctx.roadmapPath, '# Roadmap\n');
    const overlay = path.join(base, 'project-b', '.blacksmith', 'factory', 'specs', 'roadmap.md');
    mkdirSync(path.dirname(overlay), { recursive: true });
    writeFileSync(overlay, `# Roadmap\n${['project-b', 'project-a'].map(milestone).join('')}`);
    const homeCtx = { ...ctx, env: { HOME: base } };
    const rows: [string, boolean][] = [
      ['project-b', true],
      ['../project-b', true],
      [path.join(base, 'project-b'), true],
      ['~/project-b', true],
      ['../nothing-here', false],
      ['project-a', false],
    ];
    for (const [i, [arg, binds]] of rows.entries()) {
      const cli = `${i + 1}1111111-2222-4333-8444-555555555555`;
      const raw = payload(`/bs use ${arg}`, { session_id: cli });
      await capturePrompt(raw, homeCtx, 'prompt');
      const log = readFileSync(path.join(eventsDir, `prompts-${cli}.jsonl`), 'utf8');
      const written = log.includes('"event_type":"session-bound"');
      const lines = await bindingReminder(raw, homeCtx);
      const unknown = lines.some((l) => l.includes(unknownHead));
      expect(written, arg).toBe(binds);
      expect(unknown, arg).toBe(!written);
      if (binds) expect(lines).toEqual(standing('project-b'));
      else expect(lines.join('\n')).toContain('project-b');
    }
  });

  it('a roadmap that cannot be read reads as an unknown name and does not throw', async () => {
    rmSync(ctx.roadmapPath, { force: true });
    mkdirSync(ctx.roadmapPath);
    const lines = await bindingReminder(payload('/bs use project-b'), ctx);
    expect(lines.some((l) => l.includes(unknownHead))).toBe(true);
  });

  it('only the two call sites call resolveUseProject, and neither keeps the old calls', () => {
    const src = path.join(import.meta.dirname, '..', 'src');
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.split(path.sep).join('/'));
    const count = (text: string, needle: string): number => text.split(needle).length - 1;
    for (const f of files) {
      if (f === 'sessionBinding.ts') continue;
      const text = readFileSync(path.join(src, f), 'utf8');
      const sites = f === 'promptCapture.ts' || f === 'bindingReminder.ts';
      expect(count(text, 'resolveUseProject('), `${f}: resolveUseProject(`).toBe(sites ? 1 : 0);
      if (sites) {
        expect(count(text, 'knownProjectNames('), `${f}: knownProjectNames(`).toBe(0);
        expect(count(text, 'matchProject('), `${f}: matchProject(`).toBe(0);
      }
    }
  });
});
