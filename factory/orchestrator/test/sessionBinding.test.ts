import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, rebuild } from '../src/db/projector.js';
import { timeline } from '../src/db/queries.js';
import type { EventInput, EventRecord, StoredEvent } from '../src/events.js';
import { OVERLAY_ROOT, REPO_ROOT } from '../src/paths.js';
import { FACTORY_PROJECT_NAME, LEGACY_FACTORY_PROJECT } from '../src/projectName.js';
import {
  BINDING_TAIL_BYTES,
  type BindingPolicyRead,
  BYPASS_APPROVED_EVENT_TYPE,
  BYPASS_HEADER,
  BYPASS_YES,
  bindingFromTail,
  bindingInput,
  bindingPolicyReadPath,
  bypassInput,
  bypassRow,
  HOOK_ONLY_EVENT_TYPES,
  knownProjectNames,
  loadBindingPolicy,
  matchProject,
  newestBinding,
  notRecordedLines,
  parseUseCommand,
  REMINDER_PREFIX,
  reminderLines,
  SESSION_BINDING_POLICY_DEFAULT_PATH,
  SESSION_BINDING_POLICY_PATH,
  SESSION_BOUND_EVENT_TYPE,
  unknownProjectLines,
} from '../src/sessionBinding.js';

const CLI = '11111111-2222-4333-8444-555555555555';
const OTHER_CLI = '99999999-2222-4333-8444-555555555555';

let base: string;
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'smith-binding-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const target = 'prompts-session';
const stored = (n: number, input: EventInput, cli: string | undefined = CLI): StoredEvent => ({
  event_id: `${input.session_id}#${n}`,
  record: {
    ...input,
    ...(cli === undefined ? {} : { cli_session_id: cli }),
    ts: `2029-01-01T00:00:${String(n).padStart(2, '0')}.000Z`,
  },
});
const bind = (project: string, extra: Partial<Parameters<typeof bindingInput>[0]> = {}) =>
  bindingInput({
    target,
    project,
    causalParent: `${target}#0`,
    planVersion: 1,
    ...extra,
  });

describe('event builders and the newest binding', () => {
  it('bindingInput carries actor, type, ids and a hook payload', () => {
    expect(bind('project-a')).toEqual({
      session_id: target,
      actor: 'user',
      event_type: 'session-bound',
      plan_version: 1,
      causal_parent: `${target}#0`,
      payload: { project: 'project-a', source: 'hook' },
      project: 'project-a',
    });
    expect(bind('project-a', { promptId: 'p1' }).payload).toEqual({
      project: 'project-a',
      source: 'hook',
      prompt_id: 'p1',
    });
    expect(bind('project-a')).not.toHaveProperty('cli_session_id');
  });

  it('bypassInput carries the project, the question and the yes', () => {
    const input = bypassInput({
      target,
      project: 'project-b',
      causalParent: `${target}#2`,
      planVersion: 3,
      promptId: 'p9',
      question: 'files a.ts, 4 lines?',
    });
    expect(input).toEqual({
      session_id: target,
      actor: 'user',
      event_type: 'pipeline-bypass-approved',
      plan_version: 3,
      causal_parent: `${target}#2`,
      payload: {
        project: 'project-b',
        question: 'files a.ts, 4 lines?',
        answer: BYPASS_YES,
        prompt_id: 'p9',
      },
      project: 'project-b',
    });
  });

  it('exposes the fixed constants and the hook-only list in order', () => {
    expect(SESSION_BOUND_EVENT_TYPE).toBe('session-bound');
    expect(BYPASS_APPROVED_EVENT_TYPE).toBe('pipeline-bypass-approved');
    expect(HOOK_ONLY_EVENT_TYPES).toEqual([SESSION_BOUND_EVENT_TYPE, BYPASS_APPROVED_EVENT_TYPE]);
    expect(BYPASS_HEADER).toBe('Small change');
    expect(BYPASS_YES).toBe('Yes, skip the pipeline');
    expect(REMINDER_PREFIX).toBe('bs use: ');
    expect(BINDING_TAIL_BYTES).toBe(1048576);
  });

  it('newestBinding returns the last binding of the given CLI session only', () => {
    const events = [
      stored(1, bind('project-a')),
      stored(2, bind('project-b'), OTHER_CLI),
      stored(3, { ...bind('project-b'), event_type: 'user_prompt' }),
      stored(4, bind('project-b')),
      stored(5, bind('project-a'), OTHER_CLI),
      stored(6, { ...bind('project-a'), event_type: 'user_prompt' }),
    ];
    expect(newestBinding(events, CLI)).toEqual({ project: 'project-b', eventId: `${target}#4` });
    expect(newestBinding(events, OTHER_CLI)).toEqual({
      project: 'project-a',
      eventId: `${target}#5`,
    });
    expect(newestBinding(events, 'nothing-here')).toBeUndefined();
    expect(newestBinding([], CLI)).toBeUndefined();
  });
});

describe('bindingFromTail', () => {
  const stamp = (n: number, project: string, bound: string | undefined): StoredEvent =>
    stored(n, {
      session_id: target,
      actor: 'user',
      event_type: 'user_prompt',
      plan_version: 1,
      causal_parent: `${target}#0`,
      payload: {
        prompt: 'hello',
        source: 'hook',
        ...(bound === undefined ? {} : { bound_to: bound }),
      },
      project,
    });
  const log = [
    stored(1, bind('project-a')),
    stamp(2, 'project-a', 'project-a'),
    stamp(3, 'project-a', 'project-a'),
    stored(4, bind('project-b')),
    stamp(5, 'project-b', 'project-b'),
    stamp(6, 'project-b', 'project-b'),
  ];

  it('agrees with newestBinding over every suffix holding a binding or a stamped prompt', () => {
    const whole = newestBinding(log, CLI);
    expect(whole?.project).toBe('project-b');
    for (let from = 0; from < log.length; from++) {
      const tail = log.slice(from).map((e) => e.record);
      expect(bindingFromTail(tail, CLI), `suffix from ${from}`).toEqual({ project: 'project-b' });
    }
  });

  it('reads the project of a stamped prompt when no binding is in the tail', () => {
    const tail = [stamp(5, 'project-a', 'project-a').record];
    expect(bindingFromTail(tail, CLI)).toEqual({ project: 'project-a' });
  });

  it('stops at a stamped prompt with no bound_to', () => {
    const tail: EventRecord[] = [bind('project-a'), { ...bind('project-a') }].map(
      (i, n) => stored(n, i).record,
    );
    tail.push(stamp(9, 'project-a', undefined).record);
    expect(bindingFromTail(tail, CLI)).toBeUndefined();
  });

  it('skips other CLI sessions and other types, and runs out to undefined', () => {
    const other = stored(7, bind('project-a'), OTHER_CLI).record;
    const note = stored(8, { ...bind('project-a'), event_type: 'operator-note' }).record;
    const unstampedHuman = stored(9, {
      ...stamp(9, 'project-a', 'project-a').record,
      payload: { prompt: 'typed', bound_to: 'project-a' },
    }).record;
    expect(bindingFromTail([other, note, unstampedHuman], CLI)).toBeUndefined();
    expect(bindingFromTail([], CLI)).toBeUndefined();
    expect(bindingFromTail([stored(1, bind('project-b')).record, other, note], CLI)).toEqual({
      project: 'project-b',
    });
  });
});

describe('names', () => {
  it('parseUseCommand', () => {
    expect(parseUseCommand('/bs use project-a')).toEqual({ name: 'project-a' });
    expect(parseUseCommand('/bs use project-a and then some words')).toEqual({
      name: 'project-a',
    });
    expect(parseUseCommand('/bs use')).toEqual({ name: null });
    expect(parseUseCommand('/bs use   ')).toEqual({ name: null });
    expect(parseUseCommand('/bs used')).toBeNull();
    expect(parseUseCommand('/bs status')).toBeNull();
    expect(parseUseCommand('please /bs use project-a')).toBeNull();
    expect(parseUseCommand('')).toBeNull();
  });

  it('matchProject returns the known list own spelling, through the legacy mapping', () => {
    const known = [FACTORY_PROJECT_NAME, 'project-a'];
    expect(matchProject('project-a', known)).toBe('project-a');
    expect(matchProject(LEGACY_FACTORY_PROJECT, known)).toBe(FACTORY_PROJECT_NAME);
    expect(matchProject(FACTORY_PROJECT_NAME, [LEGACY_FACTORY_PROJECT])).toBe(
      LEGACY_FACTORY_PROJECT,
    );
    expect(matchProject('nothing-here', known)).toBeUndefined();
  });

  describe('knownProjectNames', () => {
    const milestone = (project: string): string =>
      `\n## m-${project}\n- id: m-${project}\n- status: completed\n- project: ${project}\n- epics: []\n- goal: whatever.\n`;

    it('lists declared projects with a checkout, omits the rest, never throws', () => {
      const clone = path.join(base, 'clone');
      mkdirSync(path.join(clone, '.git'), { recursive: true });
      mkdirSync(path.join(base, 'project-a'));
      mkdirSync(path.join(base, 'workspaces-none'));
      mkdirSync(path.join(clone, 'workspaces', 'project-b'), { recursive: true });
      const roadmapPath = path.join(base, 'roadmap.md');
      writeFileSync(
        roadmapPath,
        `# Roadmap\n${['project-a', 'project-b', 'project-c'].map(milestone).join('')}`,
      );
      const input = { repoRoot: clone, cwd: clone, env: {}, isClone: true, roadmapPath };
      const names = knownProjectNames(input);
      expect(names).toContain('project-a');
      expect(names).toContain('project-b');
      expect(names).not.toContain('project-c');
      expect(
        Array.isArray(knownProjectNames({ ...input, roadmapPath: path.join(base, 'no') })),
      ).toBe(true);
    });
  });
});

describe('policy', () => {
  const policyAt = (root: string): string =>
    path.join(root, 'factory', 'policies', 'session-binding.yml');
  const write = (file: string, text: string): string => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  };

  it('bindingPolicyReadPath prefers the overlay copy and falls back to the shipped one', () => {
    const repoRoot = path.join(base, 'repo');
    const overlayRoot = path.join(base, 'overlay');
    expect(bindingPolicyReadPath({ repoRoot, overlayRoot })).toBe(policyAt(repoRoot));
    write(policyAt(overlayRoot), 'max_files: 1\n');
    expect(bindingPolicyReadPath({ repoRoot, overlayRoot })).toBe(policyAt(overlayRoot));
  });

  it('names the two paths from REPO_ROOT and OVERLAY_ROOT, and the default reads the shipped file', () => {
    expect(SESSION_BINDING_POLICY_DEFAULT_PATH).toBe(policyAt(REPO_ROOT));
    expect(SESSION_BINDING_POLICY_PATH).toBe(policyAt(OVERLAY_ROOT));
    expect(loadBindingPolicy()).toEqual(
      loadBindingPolicy(bindingPolicyReadPath({ repoRoot: REPO_ROOT, overlayRoot: OVERLAY_ROOT })),
    );
  });

  it('the shipped file reads to two positive integers', () => {
    const read = loadBindingPolicy(SESSION_BINDING_POLICY_DEFAULT_PATH);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    for (const n of [read.policy.maxFiles, read.policy.maxChangedLines]) {
      expect(Number.isInteger(n) && n > 0).toBe(true);
    }
  });

  it('a temp file yields its numbers and the reminder quotes them', () => {
    const file = write(path.join(base, 'p.yml'), 'max_files: 3\nmax_changed_lines: 25\n');
    const read = loadBindingPolicy(file);
    expect(read).toEqual({ ok: true, policy: { maxFiles: 3, maxChangedLines: 25 } });
    const text = reminderLines('project-a', read).join('\n');
    expect(text).toContain('3');
    expect(text).toContain('25');
  });

  it('a missing file is missing, a bad one is invalid, none throws', () => {
    const missing = path.join(base, 'absent.yml');
    expect(loadBindingPolicy(missing)).toEqual({ ok: false, file: missing, problem: 'missing' });
    const bad = [
      'max_files: [unclosed\n',
      'max_files: 1.5\nmax_changed_lines: 10\n',
      'max_files: "2"\nmax_changed_lines: 10\n',
      'max_files: 0\nmax_changed_lines: 10\n',
      'max_files: 2\nmax_changed_lines: -4\n',
      'max_files: 2\n',
      '- a list\n',
      '',
    ];
    bad.forEach((text, n) => {
      const file = write(path.join(base, `bad-${n}.yml`), text);
      expect(loadBindingPolicy(file), text).toEqual({ ok: false, file, problem: 'invalid' });
    });
  });
});

describe('bypassRow', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    header: BYPASS_HEADER,
    answer: BYPASS_YES,
    question: 'a.ts, 4 lines',
    ...over,
  });

  it('accepts only the exact header and answer with a real question', () => {
    expect(bypassRow([{ header: 'x' }, row()])).toEqual({ question: 'a.ts, 4 lines' });
    expect(bypassRow([row({ header: 'Other' })])).toBeUndefined();
    expect(bypassRow([row({ answer: 'No' })])).toBeUndefined();
    expect(bypassRow([row({ header: BYPASS_HEADER.toLowerCase() })])).toBeUndefined();
    expect(bypassRow([row({ answer: BYPASS_YES.toUpperCase() })])).toBeUndefined();
    expect(bypassRow([row({ question: '' })])).toBeUndefined();
    expect(bypassRow([row({ question: '  \n ' })])).toBeUndefined();
    expect(bypassRow([row({ question: 5 })])).toBeUndefined();
    expect(bypassRow([])).toBeUndefined();
  });
});

describe('reminder text', () => {
  const ok: BindingPolicyRead = { ok: true, policy: { maxFiles: 3, maxChangedLines: 25 } };
  const failed = (file: string, problem: 'missing' | 'invalid'): BindingPolicyRead => ({
    ok: false,
    file,
    problem,
  });
  const joined = (lines: string[]): string => lines.join('\n');

  it('the ok form states the whole contract', () => {
    const lines = reminderLines('project-a', ok);
    for (const line of lines) expect(line.startsWith(REMINDER_PREFIX)).toBe(true);
    const text = joined(lines);
    expect(text).toContain('project-a');
    expect(text).toMatch(/questions are free/i);
    expect(text).toContain('/bs plan');
    expect(text).toContain('/bs run');
    expect(text).toContain('3');
    expect(text).toContain('25');
    expect(text).toContain(BYPASS_HEADER);
    expect(text).toContain(BYPASS_YES);
    expect(text).toMatch(/name the files the change touches and its estimated changed lines/);
    expect(text).toMatch(/one yes covers one change/);
    expect(text).toMatch(/second change asks again/);
    expect(text).toMatch(/yes is recorded/);
    expect(text).toMatch(/nothing is blocked/i);
  });

  it('the failed form names the file and withholds the bypass', () => {
    const file = path.join(base, 'p.yml');
    for (const problem of ['missing', 'invalid'] as const) {
      const lines = reminderLines('project-a', failed(file, problem));
      for (const line of lines) expect(line.startsWith(REMINDER_PREFIX)).toBe(true);
      const text = joined(lines);
      expect(text).toContain('project-a');
      expect(text).toContain(file);
      expect(text).toContain(problem);
      expect(text).toMatch(/no small-change bypass is available this turn/);
      expect(text).toContain('/bs plan');
      expect(text).toContain('/bs run');
    }
  });

  it('is the same text for any project name', () => {
    for (const r of [ok, failed('/x/p.yml', 'missing')]) {
      const a = reminderLines('project-a', r);
      expect(reminderLines('project-b', r)).toEqual(
        a.map((l) => l.replaceAll('project-a', 'project-b')),
      );
    }
  });

  it('stays within 700 characters', () => {
    const name = 'p'.repeat(40);
    expect(joined(reminderLines(name, ok)).length).toBeLessThanOrEqual(700);
    const file = `/${'d'.repeat(119)}`;
    expect(joined(reminderLines(name, failed(file, 'invalid'))).length).toBeLessThanOrEqual(700);
  });

  it('unknownProjectLines lists every known name; notRecordedLines says the binding is unchanged', () => {
    const lines = unknownProjectLines(['project-a', 'project-b']);
    for (const line of lines) expect(line.startsWith(REMINDER_PREFIX)).toBe(true);
    expect(joined(lines)).toContain('project-a');
    expect(joined(lines)).toContain('project-b');
    const rec = notRecordedLines();
    for (const line of rec) expect(line.startsWith(REMINDER_PREFIX)).toBe(true);
    expect(joined(rec)).toMatch(/could not be recorded from this directory/);
    expect(joined(rec)).toMatch(/earlier binding is unchanged/);
  });
});

describe('the operator timeline', () => {
  it('shows both new types as Prompt rows', async () => {
    const stateDir = path.join(base, 'events');
    mkdirSync(stateDir);
    const lines = [
      {
        session_id: target,
        actor: 'system',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: { kind: 'prompt-log' },
      },
      bind('project-a'),
      bypassInput({
        target,
        project: 'project-a',
        causalParent: `${target}#1`,
        planVersion: 1,
        promptId: 'p1',
        question: 'a.ts, 4 lines',
      }),
    ].map((r, n) =>
      JSON.stringify({ ...r, cli_session_id: CLI, ts: `2029-01-01T00:00:0${n}.000Z` }),
    );
    writeFileSync(path.join(stateDir, `${target}.jsonl`), `${lines.join('\n')}\n`);
    const dbPath = path.join(base, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const handle = openDb(dbPath);
    try {
      const rows = timeline(handle.db, { sessionId: target });
      const kinds = Object.fromEntries(rows.map((r) => [r.eventType, r.kind]));
      expect(kinds['session-bound']).toBe('Prompt');
      expect(kinds['pipeline-bypass-approved']).toBe('Prompt');
    } finally {
      handle.sqlite.close();
    }
  });
});
