import { execFileSync } from 'node:child_process';
import {
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
import { appendEvent, type StoredEvent } from '../src/events.js';
import { capturePrompt } from '../src/promptCapture.js';
import { BYPASS_HEADER, BYPASS_YES, bindingInput, newestBinding } from '../src/sessionBinding.js';

const CLI = '11111111-2222-4333-8444-555555555555';
const QUESTION = 'Touch src/a.ts, about 12 changed lines?';

let base: string;
let clone: string;
let roadmapPath: string;

const milestone = (project: string): string =>
  `\n## m-${project}\n- id: m-${project}\n- status: completed\n- project: ${project}\n- epics: []\n- goal: whatever.\n`;

const git = (cwd: string, ...args: string[]): void => {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdio: 'ignore' },
  );
};

/** A git checkout beside the clone; `store` gives it its own state/events (rule M2). */
const checkout = (name: string, store = false): string => {
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  if (store) mkdirSync(path.join(dir, 'state', 'events'), { recursive: true });
  return dir;
};

const ctxFor = (env: Record<string, string>, cwd: string) => ({
  env,
  cwd,
  repoRoot: clone,
  isClone: true,
  roadmapPath,
});

const prompt = (text: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: CLI, prompt: text, hook_event_name: 'UserPromptSubmit', ...over });

const answer = (
  id: string,
  over: { header?: string; label?: string; question?: string } = {},
): string => {
  const question = over.question ?? QUESTION;
  return JSON.stringify({
    session_id: CLI,
    hook_event_name: 'PostToolUse',
    tool_name: 'AskUserQuestion',
    tool_use_id: id,
    tool_response: {
      questions: [{ question, header: over.header ?? BYPASS_HEADER }],
      answers: { [question]: over.label ?? BYPASS_YES },
    },
  });
};

// biome-ignore lint/suspicious/noExplicitAny: parsed fixture rows are read by key
type Row = any;
const readLog = (dir: string, session: string): Row[] => {
  try {
    return readFileSync(path.join(dir, `${session}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const stored = (rows: Row[], session: string): StoredEvent[] =>
  rows.map((record, i) => ({ event_id: `${session}#${i}`, record }));
const ofType = (rows: Row[], type: string): Row[] => rows.filter((r) => r.event_type === type);

const seedEpicLog = (dir: string, project: string) =>
  appendEvent(
    {
      session_id: 'epic-b-main',
      actor: 'operator',
      event_type: 'session-start',
      plan_version: 1,
      causal_parent: null,
      payload: {},
      project,
    },
    { stateDir: dir, cliSessionId: CLI },
  );

interface Setup {
  name: string;
  env: Record<string, string>;
  cwd: string;
  dir: string;
}
let m2: Setup;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'bs-capture-binding-')));
  clone = path.join(base, 'factory-clone');
  mkdirSync(path.join(clone, '.git'), { recursive: true });
  mkdirSync(path.join(clone, 'state', 'events'), { recursive: true });
  roadmapPath = path.join(clone, 'factory', 'specs', 'roadmap.md');
  mkdirSync(path.dirname(roadmapPath), { recursive: true });
  writeFileSync(roadmapPath, `# Roadmap\n${milestone('project-a')}${milestone('project-b')}`);
  const own = checkout('project-a', true);
  checkout('project-b');
  m2 = { name: 'M2', env: {}, cwd: own, dir: path.join(own, 'state', 'events') };
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const home = `prompts-${CLI}`;
const use = (s: Setup, name: string) =>
  capturePrompt(prompt(`/bs use ${name}`), ctxFor(s.env, s.cwd));
const say = (s: Setup, text: string, over: Record<string, unknown> = {}) =>
  capturePrompt(prompt(text, over), ctxFor(s.env, s.cwd));

describe('`/bs use` writes the binding (epic criterion 1)', () => {
  it('rule M2: exactly one session-bound event, none for a repeat, one more for another project', async () => {
    await use(m2, 'project-a');
    let rows = readLog(m2.dir, home);
    const bound = ofType(rows, 'session-bound');
    expect(bound).toHaveLength(1);
    expect(bound[0]).toMatchObject({ actor: 'user', project: 'project-a', cli_session_id: CLI });
    const ids = stored(rows, home).map((e) => e.event_id);
    expect(ids).toContain(bound[0].causal_parent);

    await use(m2, 'project-a');
    expect(ofType(readLog(m2.dir, home), 'session-bound')).toHaveLength(1);

    await use(m2, 'project-b');
    rows = readLog(m2.dir, home);
    expect(ofType(rows, 'session-bound')).toHaveLength(2);
    expect(newestBinding(stored(rows, home), CLI)?.project).toBe('project-b');
  });

  it('rule M1 through a temp BS_HOME writes the same event', async () => {
    const bsHome = path.join(base, 'bs-home');
    const dir = path.join(bsHome, 'state', 'events');
    mkdirSync(dir, { recursive: true });
    await use({ name: 'M1', env: { BS_HOME: bsHome }, cwd: base, dir }, 'project-a');
    const bound = ofType(readLog(dir, home), 'session-bound');
    expect(bound).toHaveLength(1);
    expect(bound[0]).toMatchObject({ project: 'project-a', cli_session_id: CLI });
  });

  it('rule M4 writes into the clone store', async () => {
    const dir = path.join(clone, 'state', 'events');
    const cwd = path.join(base, 'project-b');
    await use({ name: 'M4', env: {}, cwd, dir }, 'project-a');
    expect(ofType(readLog(dir, home), 'session-bound')).toHaveLength(1);
  });
});

describe('the binding decides the project of home-log prompts (epic criterion 2)', () => {
  it('files the `/bs use` prompt and the next prompt under the bound project, and re-binds', async () => {
    await use(m2, 'project-a');
    await say(m2, 'next thing');
    let rows = readLog(m2.dir, home);
    const prompts = ofType(rows, 'user_prompt');
    expect(prompts.map((p) => p.project)).toEqual(['project-a', 'project-a']);

    await use(m2, 'project-b');
    await say(m2, 'after the switch');
    rows = readLog(m2.dir, home);
    // The `/bs use` prompt's parent is a project-a prompt, yet the binding wins.
    expect(ofType(rows, 'user_prompt').map((p) => p.project)).toEqual([
      'project-a',
      'project-a',
      'project-b',
      'project-b',
    ]);
  });

  it('the binding wins over a parent that carries another project', async () => {
    await use(m2, 'project-a');
    await say(m2, 'typed');
    // A binding written by a non-main actor leaves the project-a prompt as the newest main event.
    await appendEvent(
      {
        ...bindingInput({
          target: home,
          project: 'project-b',
          causalParent: `${home}#1`,
          planVersion: 1,
        }),
        actor: 'system',
      },
      { stateDir: m2.dir, cliSessionId: CLI },
    );
    await say(m2, 'after the switch');
    const rows = readLog(m2.dir, home);
    const last = ofType(rows, 'user_prompt').at(-1);
    expect(rows[Number(String(last.causal_parent).split('#')[1])].project).toBe('project-a');
    expect(last.project).toBe('project-b');
  });

  it('an answer-mode prompt in the home log carries the bound project', async () => {
    await use(m2, 'project-a');
    await capturePrompt(answer('toolu_1', { label: 'No' }), ctxFor(m2.env, m2.cwd), 'answer');
    const last = ofType(readLog(m2.dir, home), 'user_prompt').at(-1);
    expect(last.payload.kind).toBe('answer');
    expect(last.project).toBe('project-a');
  });

  it('guard (passes before and after): a prompt in an existing epic log keeps that log project', async () => {
    await use(m2, 'project-a');
    await seedEpicLog(m2.dir, 'project-b');
    await say(m2, 'into the epic');
    const rows = readLog(m2.dir, 'epic-b-main');
    expect(ofType(rows, 'user_prompt').at(-1).project).toBe('project-b');
  });

  it('guard (passes before and after): an unbound session is filed as before', async () => {
    await say(m2, 'plain');
    const [root, p] = readLog(m2.dir, home);
    expect(root.project).toBeUndefined();
    expect(p.project).toBeUndefined();
    expect(p.payload.bound_to).toBeUndefined();
  });
});

describe('what `/bs use` does not bind (epic criterion 3)', () => {
  it('an unknown name or a bare `/bs use` binds nothing and keeps the old binding', async () => {
    await use(m2, 'project-a');
    const before = ofType(readLog(m2.dir, home), 'user_prompt').length;
    await use(m2, 'nothing-here');
    await capturePrompt(prompt('/bs use'), ctxFor(m2.env, m2.cwd));
    const rows = readLog(m2.dir, home);
    expect(ofType(rows, 'user_prompt').length).toBe(before + 2);
    expect(ofType(rows, 'session-bound')).toHaveLength(1);
    expect(newestBinding(stored(rows, home), CLI)?.project).toBe('project-a');
  });

  it('guard (passes before and after): a directory that resolves only by rule M3 binds nothing', async () => {
    const dir = path.join(clone, 'state', 'events');
    await appendEvent(
      {
        session_id: 'seed-log',
        actor: 'operator',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir: dir, cliSessionId: '99999999-2222-4333-8444-555555555555' },
    );
    const cwd = path.join(base, 'plain-dir');
    mkdirSync(cwd, { recursive: true });
    const out = await use({ name: 'M3', env: {}, cwd, dir }, 'project-a');
    expect(out).not.toBeNull();
    expect(ofType(readLog(dir, home), 'session-bound')).toHaveLength(0);
  });
});

describe('the bypass record (epic criterion 7)', () => {
  const ask = (id: string, over: Parameters<typeof answer>[1] = {}) =>
    capturePrompt(answer(id, over), ctxFor(m2.env, m2.cwd), 'answer');

  it('a yes in a bound session leaves one pipeline-bypass-approved event linked to the answer', async () => {
    await use(m2, 'project-a');
    await ask('toolu_9');
    const rows = readLog(m2.dir, home);
    const approved = ofType(rows, 'pipeline-bypass-approved');
    expect(approved).toHaveLength(1);
    const answerIdx = rows.findIndex(
      (r) => r.event_type === 'user_prompt' && r.payload.prompt_id === 'toolu_9',
    );
    expect(approved[0].causal_parent).toBe(`${home}#${answerIdx}`);
    expect(approved[0].payload).toMatchObject({ prompt_id: 'toolu_9', question: QUESTION });
    expect(approved[0].project).toBe(rows[answerIdx].project);
    expect(approved[0].payload.project).toBe(rows[answerIdx].project);
  });

  it('a repeat, another label, an empty question and an unbound session add none', async () => {
    await use(m2, 'project-a');
    await ask('toolu_9');
    await ask('toolu_9');
    await ask('toolu_10', { label: 'No' });
    await ask('toolu_11', { question: '   ' });
    expect(ofType(readLog(m2.dir, home), 'pipeline-bypass-approved')).toHaveLength(1);

    const other = { ...m2, cwd: checkout('project-c', true) };
    other.dir = path.join(other.cwd, 'state', 'events');
    await capturePrompt(answer('toolu_12'), ctxFor(other.env, other.cwd), 'answer');
    expect(ofType(readLog(other.dir, home), 'pipeline-bypass-approved')).toHaveLength(0);
  });

  it('the event follows the answer into an epic log and takes that log project', async () => {
    await use(m2, 'project-a');
    await seedEpicLog(m2.dir, 'project-b');
    await ask('toolu_9');
    const rows = readLog(m2.dir, 'epic-b-main');
    const approved = ofType(rows, 'pipeline-bypass-approved');
    expect(approved).toHaveLength(1);
    expect(approved[0].project).toBe('project-b');
    expect(approved[0].payload.project).toBe('project-b');
    expect(ofType(readLog(m2.dir, home), 'pipeline-bypass-approved')).toHaveLength(0);
  });
});

describe('the bound_to stamp (epic criterion 4)', () => {
  it('stamps every home-log prompt of a bound session with the newest binding', async () => {
    await use(m2, 'project-a');
    await say(m2, 'typed');
    await capturePrompt(answer('toolu_2', { label: 'No' }), ctxFor(m2.env, m2.cwd), 'answer');
    let rows = readLog(m2.dir, home);
    let bindingId = newestBinding(stored(rows, home), CLI)?.eventId;
    const prompts = ofType(rows, 'user_prompt');
    expect(bindingId).toBeDefined();
    expect(prompts).toHaveLength(3);
    for (const p of prompts) expect(p.payload.bound_to).toBe(bindingId);

    await use(m2, 'project-b');
    rows = readLog(m2.dir, home);
    bindingId = newestBinding(stored(rows, home), CLI)?.eventId;
    expect(bindingId).toBeDefined();
    expect(ofType(rows, 'user_prompt').at(-1).payload.bound_to).toBe(bindingId);
  });

  it('guard (passes before and after): an epic-log prompt carries no stamp', async () => {
    await use(m2, 'project-a');
    await seedEpicLog(m2.dir, 'project-b');
    await say(m2, 'into the epic');
    expect(ofType(readLog(m2.dir, 'epic-b-main'), 'user_prompt').at(-1).payload.bound_to).toBe(
      undefined,
    );
  });
});

describe('a home log that cannot be read', () => {
  const homePath = () => path.join(m2.dir, `${home}.jsonl`);
  const allLogs = (): Row[] =>
    readdirSync(m2.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => readLog(m2.dir, f.replace(/\.jsonl$/, '')));
  const malformed = (): string => {
    writeFileSync(homePath(), 'this line is not json\n');
    return readFileSync(homePath(), 'utf8');
  };
  const unreadable = (): void => mkdirSync(homePath());
  const breakers: [string, () => void][] = [
    ['malformed', () => void malformed()],
    ['a directory', unreadable],
  ];

  for (const [label, breakHome] of breakers) {
    it(`a malformed home log does not stop a prompt reaching its epic log (${label})`, async () => {
      breakHome();
      await seedEpicLog(m2.dir, 'project-b');
      const line = await say(m2, 'into the epic');
      expect(line).toContain('bs prompt capture:');
      expect(JSON.parse(line?.slice(line.indexOf('{')) ?? '{}').session_id).toBe('epic-b-main');
      const prompts = ofType(readLog(m2.dir, 'epic-b-main'), 'user_prompt');
      expect(prompts).toHaveLength(1);
      expect(prompts[0].payload.prompt).toBe('into the epic');
      expect(prompts[0].project).toBe('project-b');
      expect(prompts[0].payload.bound_to).toBeUndefined();
      expect(ofType(allLogs(), 'pipeline-bypass-approved')).toHaveLength(0);
    });

    it(`a /bs use <project> turn with a malformed home log files the prompt and binds nothing (${label})`, async () => {
      breakHome();
      await seedEpicLog(m2.dir, 'project-b');
      const line = await use(m2, 'project-a');
      expect(JSON.parse(line?.slice(line.indexOf('{')) ?? '{}').session_id).toBe('epic-b-main');
      const prompts = ofType(readLog(m2.dir, 'epic-b-main'), 'user_prompt');
      expect(prompts).toHaveLength(1);
      expect(prompts[0].payload.prompt).toBe('/bs use project-a');
      expect(prompts[0].project).toBe('project-b');
      expect(prompts[0].payload.bound_to).toBeUndefined();
      expect(ofType(allLogs(), 'session-bound')).toHaveLength(0);
    });
  }

  it('a malformed home log keeps its bytes when the prompt goes to an epic log', async () => {
    const before = malformed();
    await seedEpicLog(m2.dir, 'project-b');
    await say(m2, 'into the epic');
    await use(m2, 'project-a');
    expect(readFileSync(homePath(), 'utf8')).toBe(before);
  });

  it('guard (passes before and after): a malformed home log that is itself the target refuses the prompt as before task-2', async () => {
    const before = malformed();
    await expect(say(m2, 'here')).rejects.toMatchObject({ code: 'events.unreadable-session-log' });
    await expect(use(m2, 'project-a')).rejects.toMatchObject({
      code: 'events.unreadable-session-log',
    });
    expect(readFileSync(homePath(), 'utf8')).toBe(before);
    expect(readdirSync(m2.dir).filter((f) => f.endsWith('.jsonl'))).toEqual([`${home}.jsonl`]);
  });

  it('guard (passes before and after): a well-formed home log binding is still read', async () => {
    await use(m2, 'project-a');
    await say(m2, 'here');
    const rows = readLog(m2.dir, home);
    const bindingId = newestBinding(stored(rows, home), CLI)?.eventId;
    const last = ofType(rows, 'user_prompt').at(-1);
    expect(last.project).toBe('project-a');
    expect(last.payload.bound_to).toBe(bindingId);

    await seedEpicLog(m2.dir, 'project-b');
    await capturePrompt(answer('toolu_9'), ctxFor(m2.env, m2.cwd), 'answer');
    expect(ofType(readLog(m2.dir, 'epic-b-main'), 'pipeline-bypass-approved')).toHaveLength(1);
  });
});

describe('`/bs use` binds an overlay-declared project by name or path (bs-use-2 criterion 4)', () => {
  const overlayAt = (dir: string, names: string[]): void => {
    const file = path.join(dir, '.blacksmith', 'factory', 'specs', 'roadmap.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `# Roadmap\n${names.map(milestone).join('')}`);
  };
  const boundFor = async (text: string, cli: string): Promise<Row[]> => {
    await capturePrompt(prompt(text, { session_id: cli }), ctxFor({ HOME: base }, m2.cwd));
    return ofType(readLog(m2.dir, `prompts-${cli}`), 'session-bound');
  };

  beforeEach(() => {
    writeFileSync(roadmapPath, '# Roadmap\n');
    overlayAt(path.join(base, 'project-b'), ['project-b', 'project-a']);
  });

  it.each([
    ['a bare name', () => 'project-b'],
    ['a relative path', () => '../project-b'],
    ['an absolute path', () => path.join(base, 'project-b')],
    ['a home path', () => '~/project-b'],
  ])('%s binds project-b exactly once', async (_label, arg) => {
    const rows = await boundFor(`/bs use ${arg()}`, '21111111-2222-4333-8444-555555555555');
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.project).toBe('project-b');
  });

  it('a repeat through another spelling of the same project adds no second event', async () => {
    const cli = '51111111-2222-4333-8444-555555555555';
    await boundFor('/bs use project-b', cli);
    const rows = await boundFor('/bs use ../project-b', cli);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.project).toBe('project-b');
  });

  it('a prompt that is not `/bs use` binds nothing even when it names a project', async () => {
    expect(
      await boundFor('please use project-b for this', '61111111-2222-4333-8444-555555555555'),
    ).toHaveLength(0);
  });

  it('a resolver that cannot read its roadmap degrades to no binding and does not throw', async () => {
    rmSync(roadmapPath, { force: true });
    mkdirSync(roadmapPath);
    rmSync(path.join(base, 'project-b'), { recursive: true, force: true });
    expect(
      await boundFor('/bs use project-b', '71111111-2222-4333-8444-555555555555'),
    ).toHaveLength(0);
  });

  it('a path to nothing and the overlay foreign bullet bind nothing', async () => {
    expect(
      await boundFor('/bs use ../nothing-here', '31111111-2222-4333-8444-555555555555'),
    ).toHaveLength(0);
    expect(
      await boundFor('/bs use project-a', '41111111-2222-4333-8444-555555555555'),
    ).toHaveLength(0);
  });
});
