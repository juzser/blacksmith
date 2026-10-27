import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertExited, runProcess } from './helpers/process.js';

// `bs stats effectiveness` and `bs report export`, driven as the built binary
// against fixture logs and fixture transcripts in a temp directory. Every run
// passes `--claude-config-dir` (or sets the variable on purpose in the two
// tests that exercise the default) and a placeholder HOME, so nothing here
// reads the real configuration directory.
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'cli.js');

const HOME = '/opt/example-home';
const SESSION = 'sess-a';
const CLI_SESSION = 'cli-session-a';
const TRANSCRIPT_SENTINEL = 'example-transcript-sentinel';

// A summary that carries every path form the redactor is specified to hide,
// plus a path it is specified to keep.
const PATHS_SUMMARY = [
  '/Users/example-sentinel/repo/a.ts',
  'C:\\Users\\example-sentinel\\repo',
  '/home/example-user/c.ts',
  '/root/d.ts',
  `${HOME}/e.ts`,
  '/tmp/f.log',
  '/private/tmp/g.log',
  '/var/folders/xx/h.log',
  '/private/var/folders/xx/i.log',
  '-Users-example-user-proj',
  '-home-example-user-proj',
  'kept: /usr/bin/git and /api/tasks',
].join(' ; ');

// One independent pattern per form the redactor hides. Written here on
// purpose: it is not the redactor's own detector.
const FORBIDDEN: Record<string, RegExp> = {
  'mac home': /\/Users\/[^\s<]/,
  'windows home': /[A-Za-z]:\\{1,4}Users/,
  'linux home': /\/home\/[A-Za-z]/,
  'root home': /\/root\b/,
  'injected home': /\/opt\/example-home/,
  tmp: /(^|[^A-Za-z0-9._<-])\/tmp\//,
  'private tmp': /\/private\/tmp\//,
  'var folders': /\/var\/folders\//,
  'private var folders': /\/private\/var\/folders\//,
  'mac slug': /-Users-[A-Za-z]/,
  'linux slug': /-home-[A-Za-z]/,
  'user name': /example-(user|sentinel)/,
};

interface Fixture {
  root: string;
  stateDir: string;
  configDir: string;
  digest: string;
}

function jsonl(file: string, lines: unknown[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

function assistant(id: string, tokens: { input: number; output: number }, text = 'plain') {
  return {
    type: 'assistant',
    requestId: `req-${id}`,
    message: {
      id: `msg-${id}`,
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: tokens.input,
        cache_creation_input_tokens: 0,
        output_tokens: tokens.output,
      },
    },
  };
}

let seq = 0;
function event(
  event_type: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  seq += 1;
  return {
    session_id: SESSION,
    actor: 'orchestrator',
    event_type,
    plan_version: 1,
    causal_parent: null,
    payload,
    ts: `2026-10-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
    ...extra,
  };
}

function makeFixture(root: string, opts: { incomplete: boolean }): Fixture {
  const stateDir = path.join(root, 'events');
  const configDir = path.join(root, 'claude-config');
  seq = 0;
  jsonl(path.join(stateDir, `${SESSION}.jsonl`), [
    event('session-start', {}),
    event(
      'task-added',
      { title: 'Add the thing in /Users/example-sentinel/work' },
      {
        task_id: 'proj-a/task-1',
      },
    ),
    event('task-added', { title: 'Second task' }, { task_id: 'proj-a/task-2' }),
    event(
      'dispatch_decision',
      { agent_role: 'coder' },
      { task_id: 'proj-a/task-1', agent_id: 'a1', cli_session_id: CLI_SESSION },
    ),
    event('testgate-result', { pass: true, results: [] }, { task_id: 'proj-a/task-1' }),
    event('grader-verdict', { verdict: 'met', overall: 'pass' }, { task_id: 'proj-a/task-1' }),
    event('gate-outcome', { outcome: 'pass', reason: null }, { task_id: 'proj-a/task-1' }),
    event('testgate-result', { pass: false, results: [] }, { task_id: 'proj-a/task-2' }),
    event('gate-outcome', { outcome: 42 }, { task_id: 'proj-a/task-2' }),
    event('wave-merged', { task_ids: ['proj-a/task-1'] }, { task_id: 'proj-a/task-1' }),
    event(
      'finding-raised',
      {
        finding_id: 'f-1',
        task_id: 'proj-a/task-1',
        found_by: 'reviewer',
        finding_status: 'confirmed',
        severity: 'high',
        finding_category: 'correctness',
        summary: PATHS_SUMMARY,
        failure_scenario: { inputs: 'x', expected: 'y', actual: 'z' },
      },
      { task_id: 'proj-a/task-1' },
    ),
  ]);

  const projectDir = path.join(configDir, 'projects', 'project-a');
  jsonl(path.join(projectDir, `${CLI_SESSION}.jsonl`), [
    assistant('m1', { input: 100, output: 50 }, TRANSCRIPT_SENTINEL),
  ]);
  const subDir = path.join(projectDir, CLI_SESSION, 'subagents');
  jsonl(path.join(subDir, 'agent-a1.jsonl'), [assistant('s1', { input: 150, output: 50 })]);
  writeFileSync(path.join(subDir, 'agent-a1.meta.json'), JSON.stringify({ toolUseId: 'tu-1' }));
  // An unparseable transcript line makes the sub-agent total a floor.
  if (opts.incomplete)
    writeFileSync(path.join(subDir, 'agent-a1.jsonl'), 'not json\n', { flag: 'a' });

  const digest = path.join(root, 'digest.md');
  writeFileSync(
    digest,
    `Shipped task-1. See /Users/example-sentinel/repo/a.ts and C:\\Users\\example-sentinel\\repo.\nKept: /usr/bin/git\n`,
  );
  return { root, stateDir, configDir, digest };
}

function run(args: string[], env: Record<string, string> = {}) {
  const r = runProcess('node', [CLI_PATH, ...args], {
    env: { ...process.env, HOME, CLAUDE_CONFIG_DIR: '', ...env },
  });
  assertExited(r, `bs ${args.join(' ')}`);
  return r;
}

function listAll(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort();
}

describe('bs stats effectiveness and bs report export (built binary)', () => {
  let scratch: string;
  let complete: Fixture;
  let partial: Fixture;

  beforeAll(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'bs-effcli-'));
    complete = makeFixture(path.join(scratch, 'complete'), { incomplete: false });
    partial = makeFixture(path.join(scratch, 'partial'), { incomplete: true });
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const dirs = (stateDir: string, configDir: string) => [
    '--state-dir',
    stateDir,
    '--claude-config-dir',
    configDir,
  ];
  const effArgs = (f: Fixture, more: string[] = []) => [
    'stats',
    'effectiveness',
    '--session',
    SESSION,
    ...dirs(f.stateDir, f.configDir),
    ...more,
  ];
  const exportArgs = (f: Fixture, more: string[] = []) => [
    'report',
    'export',
    '--session',
    SESSION,
    ...dirs(f.stateDir, f.configDir),
    ...more,
  ];

  it('prints the effectiveness shape as JSON', () => {
    const r = run(effArgs(complete, ['--json']));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.tokens.byTask['proj-a/task-1']).toMatchObject({ used: 200, complete: true });
    expect(out.tokens.byRole.coder.used).toBe(200);
    expect(out.tokens.unattributed.used).toBe(150);
    expect(out.escapedDefects.count).toBe(1);
    expect(out.precision.reviewer.value).toBe(1);
  });

  it('prints the same numbers in plain words', () => {
    const r = run(effArgs(complete));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('proj-a/task-1: 200 tokens');
    expect(r.stdout).toContain('reviewer: 100%');
    expect(r.stdout).not.toContain('at least');
  });

  it('says NOT MEASURED where a precision is null', () => {
    const root = path.join(scratch, 'nulls');
    const stateDir = path.join(root, 'events');
    seq = 0;
    jsonl(path.join(stateDir, `${SESSION}.jsonl`), [
      event('session-start', {}),
      event('finding-raised', {
        finding_id: 'f-9',
        task_id: 'proj-a/task-9',
        found_by: 'reviewer',
        finding_status: 'raised',
        summary: 'open',
      }),
    ]);
    const r = run([
      'stats',
      'effectiveness',
      '--session',
      SESSION,
      ...dirs(stateDir, path.join(root, 'none')),
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('reviewer: NOT MEASURED');
  });

  it('accepts --lineage <id> in place of --session and refuses both or neither', () => {
    const lineage = run([
      'stats',
      'effectiveness',
      '--lineage',
      SESSION,
      ...dirs(complete.stateDir, complete.configDir),
      '--json',
    ]);
    expect(lineage.status).toBe(0);
    expect(JSON.parse(lineage.stdout).tokens.byRole.coder.used).toBe(200);
    const neither = run(['stats', 'effectiveness', '--state-dir', complete.stateDir, '--json']);
    expect(neither.status).toBe(1);
    const both = run([...effArgs(complete, ['--lineage', SESSION])]);
    expect(both.status).toBe(1);
  });

  it('uses the same "at least <n>" label in the human form, the Markdown and the JSON export', () => {
    const human = run(effArgs(partial)).stdout;
    const md = run(exportArgs(partial)).stdout;
    const json = JSON.parse(run(exportArgs(partial, ['--json'])).stdout);
    // Task 1 spent 200 measured tokens on a floor: the label is "at least 200".
    expect(human).toContain('proj-a/task-1: at least 200 tokens');
    expect(md).toContain('at least 200');
    const entry = json.tokens.byTask.find((t: { id: string }) => t.id === 'proj-a/task-1');
    expect(entry).toMatchObject({ used: 200, complete: false, label: 'at least 200' });
    expect(json.tokens.complete).toBe(false);
    expect(human).toContain(entry.label);
    expect(md).toContain(entry.label);
  });

  it('prints a complete total without the floor wording', () => {
    const md = run(exportArgs(complete)).stdout;
    expect(md).not.toContain('at least');
    const json = JSON.parse(run(exportArgs(complete, ['--json'])).stdout);
    const entry = json.tokens.byTask.find((t: { id: string }) => t.id === 'proj-a/task-1');
    expect(entry).toMatchObject({ used: 200, complete: true, label: '200' });
  });

  it('opens both export forms with the review notice, the JSON key first', () => {
    const md = run(exportArgs(complete)).stdout;
    expect(md.split('\n')[0]).toBe('> Review this export before you share it.');
    const parsed = JSON.parse(run(exportArgs(complete, ['--json'])).stdout);
    expect(Object.keys(parsed)[0]).toBe('notice');
    expect(parsed.notice).toBe('Review this export before you share it.');
  });

  it('writes the export only to the named file and prints it to stdout otherwise', () => {
    const out = path.join(complete.root, 'export.md');
    const before = listAll(scratch);
    const written = run(exportArgs(complete, ['--out', out]));
    expect(written.status).toBe(0);
    const after = listAll(scratch);
    expect(after.filter((f) => !before.includes(f))).toEqual(['complete/export.md']);
    const stdout = run(exportArgs(complete)).stdout;
    expect(readFileSync(out, 'utf8')).toBe(stdout);
    // The same holds for the JSON form.
    const outJson = path.join(complete.root, 'export.json');
    run(exportArgs(complete, ['--json', '--out', outJson]));
    expect(JSON.parse(readFileSync(outJson, 'utf8')).notice).toBe(
      'Review this export before you share it.',
    );
  });

  it('carries no home, temp path or user name in either form, and no transcript text', () => {
    const md = run(exportArgs(complete, ['--digest', complete.digest])).stdout;
    const json = run(exportArgs(complete, ['--digest', complete.digest, '--json'])).stdout;
    for (const [form, text] of [
      ['markdown', md],
      ['json', json],
    ] as const) {
      for (const [name, pattern] of Object.entries(FORBIDDEN)) {
        expect(pattern.test(text), `${form} export matches the ${name} pattern`).toBe(false);
      }
      expect(text).not.toContain(TRANSCRIPT_SENTINEL);
      // Other absolute paths name no user and stay as written.
      expect(text).toContain('/usr/bin/git');
      expect(text).toContain('/api/tasks');
    }
  });

  it('redacts rather than drops free text: <home> stands where each home prefix stood', () => {
    const md = run(exportArgs(complete, ['--digest', complete.digest])).stdout;
    const json = JSON.parse(
      run(exportArgs(complete, ['--digest', complete.digest, '--json'])).stdout,
    );
    for (const text of [md, JSON.stringify(json)]) {
      expect(text).not.toContain('example-sentinel');
    }
    const summary = json.findings.find((f: { id: string }) => f.id === 'f-1').summary as string;
    expect(summary).toContain('<home>/repo/a.ts');
    expect(summary).toContain('<home>\\repo');
    expect(json.digest).toContain('<home>/repo/a.ts');
    expect(json.digest).toContain('<home>\\repo');
    expect(md).toContain('<home>/repo/a.ts');
    expect(md).toContain('<home>\\repo');
  });

  it('distinguishes passed, failed, not run and unknown per task', () => {
    const json = JSON.parse(run(exportArgs(complete, ['--json'])).stdout);
    const state = (task: string, check: string): string =>
      json.checks.find((c: { task: string; check: string }) => c.task === task && c.check === check)
        .state;
    expect(state('proj-a/task-1', 'tests')).toBe('passed');
    expect(state('proj-a/task-2', 'tests')).toBe('failed');
    expect(state('proj-a/task-2', 'grader')).toBe('not-run');
    expect(state('proj-a/task-2', 'gate')).toBe('unknown');
    const md = run(exportArgs(complete)).stdout;
    expect(md).toMatch(/proj-a\/task-1[^\n]*\| tests \| passed \|/);
    expect(md).toMatch(/proj-a\/task-2[^\n]*\| tests \| failed \|/);
    expect(md).toMatch(/proj-a\/task-2[^\n]*\| grader \| not run \|/);
    expect(md).toMatch(/proj-a\/task-2[^\n]*\| gate \| unknown \|/);
  });

  it('reads the latest event per check and maps not-met, blocked and waiver-pending verdicts', () => {
    const root = path.join(scratch, 'verdicts');
    const stateDir = path.join(root, 'events');
    seq = 0;
    const t = (n: number) => ({ task_id: `proj-a/task-${n}` });
    jsonl(path.join(stateDir, `${SESSION}.jsonl`), [
      event('session-start', {}),
      event('task-added', { title: 'Three' }, t(3)),
      event('task-added', { title: 'Four' }, t(4)),
      event('testgate-result', { pass: false, results: [] }, t(3)),
      event('testgate-result', { pass: true, results: [] }, t(3)),
      event('grader-verdict', { verdict: 'not-met' }, t(3)),
      event('gate-outcome', { outcome: 'blocked' }, t(3)),
      event('grader-verdict', { verdict: 'sideways' }, t(4)),
      event('gate-outcome', { outcome: 'pass-with-waivers-pending' }, t(4)),
    ]);
    const args = [
      'report',
      'export',
      '--session',
      SESSION,
      ...dirs(stateDir, path.join(root, 'c')),
    ];
    const json = JSON.parse(run([...args, '--json']).stdout);
    const state = (task: string, check: string): string =>
      json.checks.find((c: { task: string; check: string }) => c.task === task && c.check === check)
        .state;
    expect(state('proj-a/task-3', 'tests')).toBe('passed');
    expect(state('proj-a/task-3', 'grader')).toBe('failed');
    expect(state('proj-a/task-3', 'gate')).toBe('failed');
    expect(state('proj-a/task-4', 'grader')).toBe('unknown');
    expect(state('proj-a/task-4', 'gate')).toBe('passed');
    expect(state('proj-a/task-4', 'tests')).toBe('not-run');
  });

  describe('task ids written bare and epic-qualified', () => {
    const exportFor = (name: string, lines: unknown[]) => {
      const root = path.join(scratch, name);
      const stateDir = path.join(root, 'events');
      jsonl(path.join(stateDir, `${SESSION}.jsonl`), lines);
      const args = [
        'report',
        'export',
        '--session',
        SESSION,
        ...dirs(stateDir, path.join(root, 'c')),
      ];
      return {
        json: JSON.parse(run([...args, '--json']).stdout),
        md: run(args).stdout,
      };
    };
    type Row = { task: string; title: string | null; check: string; state: string };

    it('lists a bare id and its qualified form as one task with the title and the check states', () => {
      seq = 0;
      const { json, md } = exportFor('mixed-ids', [
        event('session-start', {}),
        event('task-added', { title: 'One' }, { task_id: 'task-1' }),
        event('testgate-result', { pass: false, results: [] }, { task_id: 'epic-a/task-1' }),
        event('testgate-result', { pass: true, results: [] }, { task_id: 'task-1' }),
        event('gate-outcome', { outcome: 'blocked' }, { task_id: 'epic-a/task-1' }),
      ]);
      const rows: Row[] = json.checks;
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r) => r.task))).toEqual(new Set(['task-1']));
      expect(rows.every((r) => r.title === 'One')).toBe(true);
      const state = (check: string) => rows.find((r) => r.check === check)?.state;
      expect(state('tests')).toBe('passed');
      expect(state('grader')).toBe('not-run');
      expect(state('gate')).toBe('failed');
      expect(md).toMatch(/task-1[^\n]*\| tests \| passed \|/);
      expect(md).toMatch(/task-1[^\n]*\| gate \| failed \|/);
      expect(md).not.toContain('epic-a/task-1');
    });

    it('keeps two qualified ids from different epics as two tasks', () => {
      seq = 0;
      const { json, md } = exportFor('two-epics', [
        event('session-start', {}),
        event('task-added', { title: 'A' }, { task_id: 'epic-a/task-1' }),
        event('task-added', { title: 'B' }, { task_id: 'epic-b/task-1' }),
        event('testgate-result', { pass: true, results: [] }, { task_id: 'epic-a/task-1' }),
        event('testgate-result', { pass: false, results: [] }, { task_id: 'epic-b/task-1' }),
      ]);
      const rows: Row[] = json.checks;
      expect(new Set(rows.map((r) => r.task))).toEqual(new Set(['epic-a/task-1', 'epic-b/task-1']));
      const state = (task: string) =>
        rows.find((r) => r.task === task && r.check === 'tests')?.state;
      expect(state('epic-a/task-1')).toBe('passed');
      expect(state('epic-b/task-1')).toBe('failed');
      expect(md).toMatch(/epic-a\/task-1[^\n]*\| tests \| passed \|/);
      expect(md).toMatch(/epic-b\/task-1[^\n]*\| tests \| failed \|/);
    });
  });

  it('marks the lineage scope and refuses an unreadable --digest file', () => {
    const lineage = JSON.parse(run(exportArgs(complete, ['--lineage', '--json'])).stdout);
    expect(lineage.lineage).toBe(true);
    expect(JSON.parse(run(exportArgs(complete, ['--json'])).stdout).lineage).toBe(false);
    const missing = run(exportArgs(complete, ['--digest', path.join(complete.root, 'absent.md')]));
    expect(missing.status).toBe(1);
    expect(missing.stdout).not.toContain('Review this export');
  });

  it('resolves the default config directory from CLAUDE_CONFIG_DIR, then the home directory', () => {
    const viaEnv = run(
      ['stats', 'effectiveness', '--session', SESSION, '--json', '--state-dir', complete.stateDir],
      {
        CLAUDE_CONFIG_DIR: complete.configDir,
      },
    );
    expect(JSON.parse(viaEnv.stdout).tokens.byRole.coder.used).toBe(200);
    const fakeHome = path.join(scratch, 'fake-home');
    mkdirSync(fakeHome, { recursive: true });
    const viaHome = run(
      ['stats', 'effectiveness', '--session', SESSION, '--json', '--state-dir', complete.stateDir],
      {
        HOME: fakeHome,
      },
    );
    // No transcripts under <home>/.claude: nothing measured, and said so.
    expect(JSON.parse(viaHome.stdout).tokens.complete).toBe(false);
  });
});
