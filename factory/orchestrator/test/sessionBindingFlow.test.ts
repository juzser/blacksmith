import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindingReminder } from '../src/bindingReminder.js';
import { openDb, rebuild } from '../src/db/projector.js';
import { cliSessionBindings, timeline } from '../src/db/queries.js';
import type { EventRecord } from '../src/events.js';
import { FACTORY_PROJECT_NAME } from '../src/projectName.js';
import { capturePrompt } from '../src/promptCapture.js';
import {
  BYPASS_APPROVED_EVENT_TYPE,
  BYPASS_HEADER,
  BYPASS_YES,
  bindingFromTail,
  SESSION_BOUND_EVENT_TYPE,
} from '../src/sessionBinding.js';
import { runProcess } from './helpers/process.js';

const CLI = '11111111-2222-4333-8444-555555555555';
const HOME = `prompts-${CLI}`;
const QUESTION = 'Touch src/a.ts, about 12 changed lines?';
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'promptHook.js');

let base: string;

const git = (cwd: string, ...args: string[]): void => {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdio: 'ignore' },
  );
};

/** A git checkout with its own state/events, so rule M2 answers without any env. */
const checkout = (name: string, store: boolean): string => {
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  if (store) mkdirSync(path.join(dir, 'state', 'events'), { recursive: true });
  return dir;
};

const milestone = (project: string): string =>
  `\n## m-${project}\n- id: m-${project}\n- status: completed\n- project: ${project}\n- epics: []\n- goal: whatever.\n`;

const rawPrompt = (cwd: string, text: string): string =>
  JSON.stringify({ session_id: CLI, prompt: text, cwd, hook_event_name: 'UserPromptSubmit' });

const rawAnswer = (cwd: string): string =>
  JSON.stringify({
    session_id: CLI,
    cwd,
    hook_event_name: 'PostToolUse',
    tool_name: 'AskUserQuestion',
    tool_use_id: 'toolu_flow_1',
    tool_response: {
      questions: [{ question: QUESTION, header: BYPASS_HEADER }],
      answers: { [QUESTION]: BYPASS_YES },
    },
  });

const readLog = (dir: string): EventRecord[] =>
  readFileSync(path.join(dir, `${HOME}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as EventRecord);

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'bs-binding-flow-')));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('the whole `/bs use` flow in one temp store (epic criteria 1, 2, 4, 7, 9)', () => {
  it('binds, reminds, stamps the log, records one bypass and projects both events', async () => {
    const clone = path.join(base, 'factory-clone');
    mkdirSync(path.join(clone, '.git'), { recursive: true });
    mkdirSync(path.join(clone, 'state', 'events'), { recursive: true });
    const roadmapPath = path.join(clone, 'factory', 'specs', 'roadmap.md');
    mkdirSync(path.dirname(roadmapPath), { recursive: true });
    writeFileSync(roadmapPath, `# Roadmap\n${milestone('project-a')}${milestone('project-b')}`);
    const cwd = checkout('project-a', true);
    checkout('project-b', false);
    const dir = path.join(cwd, 'state', 'events');
    const ctx = { env: {}, cwd, repoRoot: clone, isClone: true, roadmapPath };

    await capturePrompt(rawPrompt(cwd, '/bs use project-a'), ctx);
    const follow = rawPrompt(cwd, 'rename a helper');
    await capturePrompt(follow, ctx);
    const reminder = await bindingReminder(follow, ctx);
    expect(reminder.length).toBeGreaterThan(0);
    expect(reminder[0]).toContain('project-a');

    await capturePrompt(rawAnswer(cwd), ctx, 'answer');
    await capturePrompt(rawPrompt(cwd, 'and one more'), ctx);

    const rows = readLog(dir);
    const boundAt = rows.findIndex((r) => r.event_type === SESSION_BOUND_EVENT_TYPE);
    expect(boundAt).toBeGreaterThanOrEqual(0);
    expect(rows.filter((r) => r.event_type === SESSION_BOUND_EVENT_TYPE)).toHaveLength(1);
    const boundId = `${HOME}#${boundAt}`;

    const after = rows.slice(boundAt + 1).filter((r) => r.event_type === 'user_prompt');
    const followUp = after.find((r) => r.payload.prompt === 'rename a helper');
    expect(followUp?.project).toBe('project-a');
    expect(after.length).toBeGreaterThanOrEqual(3);
    for (const p of after) expect(p.payload.bound_to).toBe(boundId);

    const bypass = rows.filter((r) => r.event_type === BYPASS_APPROVED_EVENT_TYPE);
    expect(bypass).toHaveLength(1);
    expect(bypass[0]?.payload.question).toBe(QUESTION);

    const withoutBound = rows.filter((r) => r.event_type !== SESSION_BOUND_EVENT_TYPE);
    expect(bindingFromTail(withoutBound, CLI)).toEqual({ project: 'project-a' });

    const dbDir = path.join(base, 'db');
    mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir: dir });
    const handle = openDb(dbPath);
    try {
      expect(cliSessionBindings(handle.db, [CLI]).map((b) => b.project)).toEqual(['project-a']);
      const types = timeline(handle.db, {}).map((e) => e.eventType);
      expect(types).toContain(SESSION_BOUND_EVENT_TYPE);
      expect(types).toContain(BYPASS_APPROVED_EVENT_TYPE);
    } finally {
      handle.sqlite.close();
    }
  });
});

describe('dist/promptHook.js binding the factory itself (epic criteria 1, 5, 11)', () => {
  const run = (cwd: string, text: string) =>
    runProcess('node', [HOOK_PATH], {
      input: rawPrompt(cwd, text),
      cwd: base,
      env: { PATH: process.env.PATH },
    });

  it('prints plain lines naming the project and records one binding', () => {
    const cwd = checkout('own-checkout', true);
    const dir = path.join(cwd, 'state', 'events');
    const first = run(cwd, `/bs use ${FACTORY_PROJECT_NAME}`);
    expect(first.status).toBe(0);
    const lines = first.stdout.split('\n').filter((l) => l !== '');
    expect(lines.some((l) => l.startsWith('bs prompt capture: '))).toBe(true);
    const reminder = lines.filter((l) => l.startsWith('bs use: '));
    expect(reminder.length).toBeGreaterThan(0);
    expect(reminder[0]).toContain(FACTORY_PROJECT_NAME);
    expect(lines.length).toBe(1 + reminder.length);
    for (const l of lines) expect(() => JSON.parse(l)).toThrow();
    const bound = readLog(dir).filter((r) => r.event_type === SESSION_BOUND_EVENT_TYPE);
    expect(bound).toHaveLength(1);

    const second = run(cwd, 'a follow-up');
    expect(second.status).toBe(0);
    expect(second.stdout).toContain(`bs use: this session is bound to ${FACTORY_PROJECT_NAME}.`);
    const prompts = readLog(dir).filter((r) => r.event_type === 'user_prompt');
    expect(prompts.at(-1)?.project).toBe(FACTORY_PROJECT_NAME);
    expect(readLog(dir).filter((r) => r.event_type === SESSION_BOUND_EVENT_TYPE)).toHaveLength(1);
  });
});
