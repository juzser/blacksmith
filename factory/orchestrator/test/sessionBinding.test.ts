import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, rebuild } from '../src/db/projector.js';
import { timeline } from '../src/db/queries.js';
import type { EventInput, StoredEvent } from '../src/events.js';
import {
  OVERLAY_ROOT,
  SESSION_BINDING_POLICY_DEFAULT_PATH as PATHS_DEFAULT,
  SESSION_BINDING_POLICY_PATH as PATHS_OVERLAY,
  REPO_ROOT,
} from '../src/paths.js';
import { FACTORY_PROJECT_NAME, LEGACY_FACTORY_PROJECT } from '../src/projectName.js';
import {
  BINDING_TAIL_BYTES,
  type BindingPolicy,
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
  resolveUseProject,
  SESSION_BINDING_POLICY_DEFAULT_PATH,
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
    expect(bind('project-a', { promptId: 'p1' }).payload).toMatchObject({ prompt_id: 'p1' });
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
    expect(input).toMatchObject({
      session_id: target,
      actor: 'user',
      event_type: 'pipeline-bypass-approved',
      plan_version: 3,
      causal_parent: `${target}#2`,
      payload: { project: 'project-b', question: 'files a.ts, 4 lines?', answer: BYPASS_YES },
      project: 'project-b',
    });
    expect(input.payload.prompt_id).toBe('p9');
  });

  it('exposes the fixed constants and the hook-only list in order', () => {
    expect(SESSION_BOUND_EVENT_TYPE).toBe('session-bound');
    expect(BYPASS_APPROVED_EVENT_TYPE).toBe('pipeline-bypass-approved');
    expect(HOOK_ONLY_EVENT_TYPES).toEqual([SESSION_BOUND_EVENT_TYPE, BYPASS_APPROVED_EVENT_TYPE]);
    expect(BINDING_TAIL_BYTES).toBe(1048576);
  });

  it('newestBinding returns the last binding of the given CLI session only', () => {
    const events = [
      stored(1, bind('project-a')),
      stored(3, { ...bind('project-b'), event_type: 'user_prompt' }),
      stored(4, bind('project-b')),
      stored(5, bind('project-a'), OTHER_CLI),
    ];
    expect(newestBinding(events, CLI)).toEqual({ project: 'project-b', eventId: `${target}#4` });
    expect(newestBinding(events, 'nothing-here')).toBeUndefined();
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
    stored(3, bind('project-b')),
    stamp(4, 'project-b', 'project-b'),
    stamp(5, 'project-b', 'project-b'),
  ];

  it('agrees with newestBinding over every suffix holding a binding or a stamped prompt', () => {
    const whole = newestBinding(log, CLI);
    expect(whole?.project).toBe('project-b');
    for (let from = 0; from < log.length; from++) {
      const tail = log.slice(from).map((e) => e.record);
      expect(bindingFromTail(tail, CLI), `suffix from ${from}`).toEqual({ project: 'project-b' });
    }
  });

  it('stops at a stamped prompt with no bound_to', () => {
    const tail = [stored(1, bind('project-a')).record, stamp(9, 'project-a', undefined).record];
    expect(bindingFromTail(tail, CLI)).toBeUndefined();
  });

  it('skips other CLI sessions, other types and unstamped prompts', () => {
    const other = stored(7, bind('project-a'), OTHER_CLI).record;
    const note = stored(8, { ...bind('project-a'), event_type: 'operator-note' }).record;
    expect(bindingFromTail([other, note], CLI)).toBeUndefined();
  });
});

describe('names', () => {
  it('parseUseCommand', () => {
    expect(parseUseCommand('/bs use project-a')).toEqual({ name: 'project-a' });
    expect(parseUseCommand('/bs use project-a and then some words')).toEqual({
      name: 'project-a',
    });
    expect(parseUseCommand('/bs use')).toEqual({ name: null });
    expect(parseUseCommand('/bs used')).toBeNull();
    expect(parseUseCommand('/bs status')).toBeNull();
    expect(parseUseCommand('please /bs use project-a')).toBeNull();
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
      expect(knownProjectNames({ ...input, roadmapPath: path.join(base, 'no') })).toBeInstanceOf(
        Array,
      );
    });

    describe('overlay-declared projects', () => {
      const overlayFile = (dir: string): string =>
        path.join(dir, '.blacksmith', 'factory', 'specs', 'roadmap.md');
      const writeOverlay = (dir: string, names: string[]): void => {
        mkdirSync(path.dirname(overlayFile(dir)), { recursive: true });
        writeFileSync(overlayFile(dir), `# Roadmap\n${names.map(milestone).join('')}`);
      };
      const checkout = (name: string, declares: string[] = [name]): string => {
        const dir = path.join(base, name);
        mkdirSync(dir, { recursive: true });
        writeOverlay(dir, declares);
        return dir;
      };
      const setup = (cloneDeclares: string[] = []) => {
        const clone = path.join(base, 'clone');
        mkdirSync(path.join(clone, '.git'), { recursive: true });
        const roadmapPath = path.join(base, 'clone-roadmap.md');
        writeFileSync(roadmapPath, `# Roadmap\n${cloneDeclares.map(milestone).join('')}`);
        return { repoRoot: clone, cwd: clone, env: {}, isClone: true, roadmapPath };
      };

      it('a project declared only in its own overlay is known, a foreign bullet is not', () => {
        const input = setup();
        const before = knownProjectNames(input);
        mkdirSync(path.join(base, 'project-a'));
        checkout('project-b', ['project-b', 'project-a']);
        const names = knownProjectNames(input);
        expect(names).toEqual(expect.arrayContaining(before));
        expect(names).toContain('project-b');
        expect(names).not.toContain('project-a');
      });

      it('a name declared in the clone roadmap and its own overlay appears once', () => {
        const input = setup(['project-b']);
        checkout('project-b');
        expect(knownProjectNames(input).filter((n) => n === 'project-b')).toHaveLength(1);
      });

      it('the legacy factory spelling adds nothing', () => {
        const input = setup();
        checkout(LEGACY_FACTORY_PROJECT);
        const names = knownProjectNames(input);
        expect(names.filter((n) => n === FACTORY_PROJECT_NAME)).toHaveLength(1);
        expect(names).not.toContain(LEGACY_FACTORY_PROJECT);
      });

      it('the context repoRoot carrying an overlay adds nothing', () => {
        const input = setup();
        writeOverlay(input.repoRoot, [path.basename(input.repoRoot)]);
        expect(knownProjectNames(input)).not.toContain(path.basename(input.repoRoot));
      });

      it('missing roots, files, bare dirs and bad overlays add nothing and never throw', () => {
        const input = setup();
        const before = knownProjectNames(input);
        writeFileSync(path.join(base, 'plain-file'), 'x');
        mkdirSync(path.join(base, 'bare-dir'));
        const broken = path.join(base, 'broken');
        mkdirSync(path.dirname(overlayFile(broken)), { recursive: true });
        writeFileSync(overlayFile(broken), '\0\0 not: [a roadmap');
        checkout('only-others', ['project-a']);
        expect(() => knownProjectNames(input)).not.toThrow();
        expect(knownProjectNames(input)).toEqual(before);
      });

      it('a symlink under a root to an overlay checkout elsewhere is known once', () => {
        const input = setup();
        const real = path.join(base, 'elsewhere', 'real-b');
        mkdirSync(real, { recursive: true });
        writeOverlay(real, ['project-b']);
        symlinkSync(real, path.join(base, 'project-b'));
        expect(knownProjectNames(input).filter((n) => n === 'project-b')).toHaveLength(1);
      });

      it('plain segment: path-like spellings of the entry name add nothing', () => {
        const input = setup();
        const before = knownProjectNames(input);
        for (const spelling of ['./project-b', 'project-b/../project-b', 'project-b/']) {
          checkout('project-b', [spelling]);
          expect(knownProjectNames(input), spelling).toEqual(before);
          expect(resolveUseProject('../project-b', input).matched, spelling).toBeUndefined();
        }
      });

      it('out of scope: a differently named checkout stays unknown by name and path', () => {
        const input = setup();
        const before = knownProjectNames(input);
        for (const withProjectA of [false, true]) {
          if (withProjectA) mkdirSync(path.join(base, 'project-a'));
          checkout('dir-x', ['project-a']);
          const names = knownProjectNames(input);
          expect(names).toEqual(before);
          expect(resolveUseProject('dir-x', input).matched).toBeUndefined();
          expect(resolveUseProject('../dir-x', input).matched).toBeUndefined();
        }
      });

      it('lists overlay checkouts in sorted order, not creation order', () => {
        const input = setup();
        checkout('project-b');
        checkout('project-a');
        const names = knownProjectNames(input);
        expect(names.indexOf('project-a')).toBeGreaterThanOrEqual(0);
        expect(names.indexOf('project-a')).toBeLessThan(names.indexOf('project-b'));
      });
    });
  });

  describe('resolveUseProject', () => {
    const milestone = (project: string): string =>
      `\n## m-${project}\n- id: m-${project}\n- status: completed\n- project: ${project}\n- epics: []\n- goal: whatever.\n`;
    const build = () => {
      const clone = path.join(base, 'clone');
      mkdirSync(path.join(clone, '.git'), { recursive: true });
      const roadmapPath = path.join(base, 'clone-roadmap.md');
      writeFileSync(roadmapPath, '# Roadmap\n');
      const real = path.join(base, 'project-b');
      mkdirSync(path.join(real, '.blacksmith', 'factory', 'specs'), { recursive: true });
      writeFileSync(
        path.join(real, '.blacksmith', 'factory', 'specs', 'roadmap.md'),
        `# Roadmap\n${milestone('project-b')}`,
      );
      const input = {
        repoRoot: clone,
        cwd: clone,
        env: {} as Record<string, string | undefined>,
        isClone: true,
        roadmapPath,
      };
      return { input, real };
    };
    const at = (input: ReturnType<typeof build>['input'], env: Record<string, string>) => ({
      ...input,
      env,
    });

    it('a path to the checkout gives its name', () => {
      const { input, real } = build();
      const link = path.join(base, 'elsewhere-link');
      symlinkSync(real, link);
      const rows: [string, Record<string, string>][] = [
        ['../project-b', {}],
        [real, {}],
        ['~/project-b', { HOME: base }],
        ['../project-b/', {}],
        [link, {}],
      ];
      for (const [arg, env] of rows) {
        expect(resolveUseProject(arg, at(input, env)).matched, arg).toBe('project-b');
      }
    });

    it('the factory checkout resolves to the factory name', () => {
      const { input } = build();
      expect(resolveUseProject(REPO_ROOT, input).matched).toBe(FACTORY_PROJECT_NAME);
    });

    it('unknown directories, missing paths and an unusable HOME match nothing', () => {
      const { input } = build();
      mkdirSync(path.join(base, 'unknown-dir'));
      const rows: [string, Record<string, string>][] = [
        ['../unknown-dir', {}],
        ['../does-not-exist', {}],
        ['~/project-b', {}],
        ['~/../project-b', { HOME: '' }],
        ['~/project-b', { HOME: '..' }],
      ];
      for (const [arg, env] of rows) {
        expect(
          resolveUseProject(arg, at(input, env)).matched,
          `${arg} ${JSON.stringify(env)}`,
        ).toBe(undefined);
      }
    });

    it('a bare name matches as matchProject does, known mirrors knownProjectNames, null matches nothing', () => {
      const { input } = build();
      const known = knownProjectNames(input);
      for (const name of ['project-b', 'nothing-here', LEGACY_FACTORY_PROJECT]) {
        const r = resolveUseProject(name, input);
        expect(r.matched).toBe(matchProject(name, known));
        expect(r.known).toEqual(known);
      }
      expect(resolveUseProject(null, input).matched).toBeUndefined();
    });
  });

  describe('hook-light imports', () => {
    it('sessionBinding.ts imports no db, cli, usage, promptCapture or bindingReminder module', () => {
      const text = readFileSync(
        path.join(REPO_ROOT, 'factory', 'orchestrator', 'src', 'sessionBinding.ts'),
        'utf8',
      );
      const specifiers = [
        ...text.matchAll(/\bfrom\s+'([^']+)'/g),
        ...text.matchAll(/\bimport\s*\(\s*'([^']+)'\s*\)/g),
        ...text.matchAll(/\bimport\s+'([^']+)'/g),
      ].map((m) => m[1] as string);
      const heavy = new Set(['db', 'cli', 'usage', 'promptCapture', 'bindingReminder']);
      const bad = specifiers.filter((s) =>
        s.split('/').some((seg) => heavy.has(seg.replace(/\.js$/, ''))),
      );
      expect(bad).toEqual([]);
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

  it('paths.ts declares the overlay pair that bindingPolicyReadPath resolves between', () => {
    const roots = { repoRoot: REPO_ROOT, overlayRoot: OVERLAY_ROOT };
    expect(PATHS_DEFAULT).toBe(path.join(REPO_ROOT, 'factory', 'policies', 'session-binding.yml'));
    expect(PATHS_OVERLAY).toBe(
      path.join(OVERLAY_ROOT, 'factory', 'policies', 'session-binding.yml'),
    );
    expect(bindingPolicyReadPath(roots, () => true)).toBe(PATHS_OVERLAY);
    expect(bindingPolicyReadPath(roots, () => false)).toBe(PATHS_DEFAULT);
  });

  it('the default reads the file bindingPolicyReadPath names', () => {
    const roots = { repoRoot: REPO_ROOT, overlayRoot: OVERLAY_ROOT };
    expect(loadBindingPolicy()).toEqual(loadBindingPolicy(bindingPolicyReadPath(roots)));
  });

  it('the shipped file reads to two positive integers', () => {
    const read = loadBindingPolicy(SESSION_BINDING_POLICY_DEFAULT_PATH);
    expect(read).toMatchObject({ ok: true });
    const { maxFiles, maxChangedLines } = (read as { policy: BindingPolicy }).policy;
    expect([maxFiles, maxChangedLines].every((n) => Number.isInteger(n) && n > 0)).toBe(true);
  });

  it('a temp file yields its numbers and the reminder quotes them', () => {
    const file = write(path.join(base, 'p.yml'), 'max_files: 3\nmax_changed_lines: 25\n');
    const read = loadBindingPolicy(file);
    expect(read).toEqual({ ok: true, policy: { maxFiles: 3, maxChangedLines: 25 } });
    expect(reminderLines('project-a', read).join(' ')).toMatch(/3 files and 25 changed lines/);
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
    const no = [
      { header: 'Other' },
      { answer: 'No' },
      { header: BYPASS_HEADER.toLowerCase() },
      { answer: BYPASS_YES.toUpperCase() },
      { question: '' },
      { question: '  \n ' },
    ];
    for (const over of no) expect(bypassRow([row(over)])).toBeUndefined();
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
    for (const part of ['project-a', '/bs plan', '/bs run', '3', '25', BYPASS_HEADER, BYPASS_YES]) {
      expect(text).toContain(part);
    }
    expect(text).toMatch(/questions are free/i);
    expect(text).toMatch(/name the files the change touches and its estimated changed lines/);
    expect(text).toMatch(/one yes covers one change and a second change asks again/);
    expect(text).toMatch(/yes is recorded/);
    expect(text).toMatch(/nothing is blocked/i);
  });

  it('the failed form names the file and withholds the bypass', () => {
    for (const problem of ['missing', 'invalid'] as const) {
      const lines = reminderLines('project-a', failed('/x/p.yml', problem));
      for (const line of lines) expect(line.startsWith(REMINDER_PREFIX)).toBe(true);
      const text = joined(lines);
      for (const part of ['project-a', '/x/p.yml', problem, '/bs plan', '/bs run']) {
        expect(text).toContain(part);
      }
      expect(text).toMatch(/no small-change bypass is available this turn/);
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
    expect(joined(lines)).toMatch(/project-a.*project-b/);
    const rec = joined(notRecordedLines());
    expect(rec).toMatch(
      /^bs use: .*could not be recorded from this directory.*earlier binding is unchanged/,
    );
  });
});

describe('the operator timeline', () => {
  it('shows both new types as Prompt rows', async () => {
    const stateDir = path.join(base, 'events');
    mkdirSync(stateDir);
    const lines = [
      bind('project-a'),
      bypassInput({
        target,
        project: 'project-a',
        causalParent: `${target}#0`,
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
    const rows = timeline(handle.db, { sessionId: target });
    handle.sqlite.close();
    const kinds = Object.fromEntries(rows.map((r) => [r.eventType, r.kind]));
    expect(kinds['session-bound']).toBe('Prompt');
    expect(kinds['pipeline-bypass-approved']).toBe('Prompt');
  });
});
