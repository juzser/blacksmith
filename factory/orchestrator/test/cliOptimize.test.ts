import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lintDispatchPrompt } from '../src/dispatchLint.js';
import { lessonsForDispatch } from '../src/lessons.js';
import { git, runProcess } from './helpers/process.js';

// Epic bs-optimize, CLI halves of criteria 4, 5, 7, 9, 10 and 14: every new
// verb is driven as the built binary. Every run gets its own BS_HOME (the
// event store) and BS_HEAVY_LOCK_DIR (the machine lock), so nothing here reads
// or writes the real ~/.blacksmith, state/ or another session's lock.
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'cli.js');
const FIXTURE_PLAN = path.join(import.meta.dirname, 'fixtures', 'brief-compose-plan.json');

let scratch: string;
let counter = 0;

interface Sandbox {
  home: string; // BS_HOME: the work root, so the store is <home>/state/events
  locks: string; // BS_HEAVY_LOCK_DIR
  eventsDir: string;
}

function sandbox(): Sandbox {
  const root = path.join(scratch, `sb-${counter++}`);
  const home = path.join(root, 'bs-home');
  const locks = path.join(root, 'locks');
  mkdirSync(home, { recursive: true });
  mkdirSync(locks, { recursive: true });
  return { home, locks, eventsDir: path.join(home, 'state', 'events') };
}

function cli(args: string[], sb: Sandbox, extraEnv: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BS_HOME: sb.home,
    BS_HEAVY_LOCK_DIR: sb.locks,
    ...extraEnv,
  };
  // An inherited token would make a test re-enter someone else's lock.
  if (!('BS_HEAVY_LOCK_TOKEN' in extraEnv)) delete env.BS_HEAVY_LOCK_TOKEN;
  const run = runProcess('node', [CLI_PATH, ...args], { env });
  expect(run.signal, `bs ${args.join(' ')}`).toBeNull();
  return { stdout: run.stdout, stderr: run.stderr, status: run.status as number };
}

function appendEvent(sb: Sandbox, event: Record<string, unknown>): void {
  const run = cli(['event', 'append', JSON.stringify(event)], sb);
  expect(run.status, run.stdout + run.stderr).toBe(0);
}

function startSession(sb: Sandbox, sessionId: string): void {
  appendEvent(sb, {
    session_id: sessionId,
    actor: 'user',
    event_type: 'session-start',
    plan_version: 1,
    causal_parent: null,
    payload: {},
  });
}

function errorLogged(sb: Sandbox, sessionId: string, taskId: string, errorClass: string): void {
  appendEvent(sb, {
    session_id: sessionId,
    actor: 'orchestrator',
    event_type: 'error-logged',
    task_id: taskId,
    plan_version: 1,
    causal_parent: `${sessionId}#0`,
    payload: { error: errorClass, severity: 'S3-minor', task_ref: taskId },
  });
}

const errorOf = (stdout: string): string => JSON.parse(stdout).error.code;

beforeAll(async () => {
  scratch = realpathSync(await mkdtemp(path.join(tmpdir(), 'bs-cli-optimize-')));
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

// ---- criterion 4: lessons for-dispatch --------------------------------------

describe('lessons for-dispatch (criterion 4, CLI half)', () => {
  const PLAN = {
    epic_id: 'epic-1',
    version: 1,
    status: 'active',
    tasks: [
      {
        task_id: 'epic-1/task-1',
        epic_id: 'epic-1',
        plan_version: 1,
        objective: 'Touch the orchestrator.',
        output_schema_ref: 'result.schema.json',
        acceptance_criteria: ['it works'],
        claims: ['factory/orchestrator/src/**'],
        budget: { tokens: 1000, diff_lines: 100 },
        contract: { functional_clauses: ['do it'], nonfunctional_clauses: [] },
        case: 'feature',
        origin: 'user',
        task_status: 'todo',
      },
    ],
    edges: [],
  };
  let planPath: string;
  const dispatch = (sb: Sandbox, more: string[] = []) =>
    cli(['lessons', 'for-dispatch', 'coder', '--plan', planPath, '--task', 'task-1', ...more], sb);

  beforeAll(() => {
    planPath = path.join(scratch, 'lessons-plan.json');
    writeFileSync(planPath, JSON.stringify(PLAN));
  });

  it('drops the lessons array unless --full, and keeps it with --full', () => {
    const sb = sandbox();
    const plain = dispatch(sb);
    expect(plain.status, plain.stdout + plain.stderr).toBe(0);
    expect(JSON.parse(plain.stdout)).not.toHaveProperty('lessons');
    const full = JSON.parse(dispatch(sb, ['--full']).stdout);
    expect(Array.isArray(full.lessons)).toBe(true);
  });

  it('splices at most half the bytes of the every-class-recurring block on an empty store', () => {
    const sb = sandbox();
    const filtered = JSON.parse(dispatch(sb).stdout) as { text: string };
    const everyClass = lessonsForDispatch('coder', ['factory/orchestrator/src/**'], {
      caseType: 'feature',
    }).text;
    expect(Buffer.byteLength(filtered.text)).toBeLessThanOrEqual(Buffer.byteLength(everyClass) / 2);
  });

  it('splices a class logged on 3 distinct tasks across two sessions', () => {
    const empty = sandbox();
    const withheld = JSON.parse(dispatch(empty).stdout).withheld as {
      lesson_id: string;
      error_class: string;
    }[];
    expect(withheld.length).toBeGreaterThan(0);
    const target = withheld[0] as { lesson_id: string; error_class: string };

    const sb = sandbox();
    startSession(sb, 'sess-a');
    startSession(sb, 'sess-b');
    errorLogged(sb, 'sess-a', 'p-a/task-1', target.error_class);
    errorLogged(sb, 'sess-a', 'p-b/task-2', target.error_class);
    errorLogged(sb, 'sess-b', 'p-c/task-3', target.error_class);
    const after = JSON.parse(dispatch(sb, ['--full']).stdout);
    expect(after.withheld.map((w: { lesson_id: string }) => w.lesson_id)).not.toContain(
      target.lesson_id,
    );
    expect(after.lessons.map((l: { lessonId: string }) => l.lessonId)).toContain(target.lesson_id);
  });

  it('--epic splices a class that one event of that epic repeats, which is withheld without it', () => {
    const empty = sandbox();
    const target = (
      JSON.parse(dispatch(empty).stdout).withheld as { lesson_id: string; error_class: string }[]
    )[0] as { lesson_id: string; error_class: string };

    const sb = sandbox();
    startSession(sb, 'sess-e');
    errorLogged(sb, 'sess-e', 'epic-1/task-9', target.error_class);
    const idsOf = (out: string) =>
      (JSON.parse(out).withheld as { lesson_id: string }[]).map((w) => w.lesson_id);
    expect(idsOf(dispatch(sb).stdout)).toContain(target.lesson_id);
    expect(idsOf(dispatch(sb, ['--epic', 'epic-1']).stdout)).not.toContain(target.lesson_id);
  });

  it("--class returns that class's approved lessons", () => {
    const sb = sandbox();
    const target = (
      JSON.parse(dispatch(sb).stdout).withheld as { lesson_id: string; error_class: string }[]
    )[0] as { lesson_id: string; error_class: string };
    const out = JSON.parse(dispatch(sb, ['--class', target.error_class]).stdout);
    expect(out.lessons.map((l: { lessonId: string }) => l.lessonId)).toContain(target.lesson_id);
  });

  it('lessons raise accepts --error-class', () => {
    const sb = sandbox();
    const run = cli(['lessons', 'raise', '--error-class', 'no.such-class', '--help'], sb);
    // The flag is known to the parser: `--help` prints usage, it is not refused.
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('--error-class');
  });
});

// ---- criterion 5: brief compose ----------------------------------------------

describe('brief compose (criterion 5, CLI half)', () => {
  it('writes a brief that passes lintDispatchPrompt, and its manifest', async () => {
    const sb = sandbox();
    startSession(sb, 'sess-brief');
    const worktree = path.join(scratch, 'wt', 'task-1-widget');
    const out = path.join(scratch, 'brief-out', 'coder.md');
    const run = cli(
      [
        'brief',
        'compose',
        '--role',
        'coder',
        '--session',
        'sess-brief',
        '--plan',
        FIXTURE_PLAN,
        '--task',
        'project-a/task-1-widget',
        '--worktree',
        worktree,
        '--out',
        out,
      ],
      sb,
    );
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const text = readFileSync(out, 'utf8');
    const report = await lintDispatchPrompt({
      prompt: text,
      role: 'coder',
      taskId: 'project-a/task-1-widget',
      sessionId: 'sess-brief',
      eventOpts: { stateDir: sb.eventsDir },
    });
    expect(report.exitCode).toBe(0);
    expect(text).toContain(worktree);
    const manifest = JSON.parse(readFileSync(`${out}.manifest.json`, 'utf8'));
    expect(manifest.role).toBe('coder');
    expect(manifest.total_bytes).toBe(Buffer.byteLength(text));
  });

  it('prints the brief on stdout without --out', () => {
    const sb = sandbox();
    startSession(sb, 'sess-brief2');
    const run = cli(
      [
        'brief',
        'compose',
        '--role',
        'coder',
        '--session',
        'sess-brief2',
        '--plan',
        FIXTURE_PLAN,
        '--task',
        'project-a/task-1-widget',
        '--worktree',
        path.join(scratch, 'wt', 'task-1-widget'),
      ],
      sb,
    );
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('<!-- bs-brief ');
  });

  it('refuses a turn budget that differs from the template with brief.turns-mismatch', () => {
    const sb = sandbox();
    startSession(sb, 'sess-brief3');
    const run = cli(
      [
        'brief',
        'compose',
        '--role',
        'coder',
        '--session',
        'sess-brief3',
        '--plan',
        FIXTURE_PLAN,
        '--task',
        'project-a/task-1-widget',
        '--worktree',
        path.join(scratch, 'wt', 'task-1-widget'),
        '--turns',
        '1',
      ],
      sb,
    );
    expect(run.status).toBe(1);
    expect(errorOf(run.stdout)).toBe('brief.turns-mismatch');
  });
});

// ---- criterion 7: playbook slice ---------------------------------------------

describe('playbook slice (criterion 7, CLI half)', () => {
  it('prints one wave step and one dispatch section, and refuses an unknown one', () => {
    const sb = sandbox();
    const step = cli(['playbook', 'slice', 'wave', '--step', '2'], sb);
    expect(step.status, step.stdout + step.stderr).toBe(0);
    expect(step.stdout).toMatch(/^2\. /);
    const section = cli(
      ['playbook', 'slice', 'dispatch', '--section', 'Return discipline (agent-interviews.md M-6)'],
      sb,
    );
    expect(section.status, section.stdout + section.stderr).toBe(0);
    expect(section.stdout).toContain('## Return discipline (agent-interviews.md M-6)');
    const unknown = cli(['playbook', 'slice', 'wave', '--step', '9999'], sb);
    expect(unknown.status).toBe(1);
    expect(errorOf(unknown.stdout)).toBe('playbook.unknown-step');
  });
});

// ---- criterion 9: in-flight admission ----------------------------------------

describe('wave next / wave check after plan ingest (criterion 9, CLI half)', () => {
  const task = (n: number, claim: string) => ({
    task_id: `epic-1/task-${n}`,
    epic_id: 'epic-1',
    plan_version: 1,
    objective: `Task ${n}.`,
    output_schema_ref: 'result.schema.json',
    acceptance_criteria: ['it works'],
    claims: [claim],
    budget: { tokens: 1000, diff_lines: 100 },
    contract: { functional_clauses: ['do it'], nonfunctional_clauses: [] },
    case: 'feature',
    origin: 'user',
    task_status: 'todo',
  });
  const PLAN = {
    epic_id: 'epic-1',
    version: 1,
    status: 'active',
    tasks: [task(1, 'src/foo/*.ts'), task(2, 'src/bar/*.ts')],
    edges: [],
  };

  it('refuses to re-admit a task the log says is running, and does not propose it', () => {
    const sb = sandbox();
    const planPath = path.join(scratch, 'inflight-plan.json');
    writeFileSync(planPath, JSON.stringify(PLAN));
    startSession(sb, 'sess-fl');
    const flags = ['--session', 'sess-fl', '--causal-parent', 'sess-fl#0'];
    const ingest = cli(['plan', 'ingest', planPath, ...flags], sb);
    expect(ingest.status, ingest.stdout + ingest.stderr).toBe(0);

    const first = cli(['wave', 'check', planPath, 'epic-1/task-1', ...flags], sb);
    expect(first.status, first.stdout + first.stderr).toBe(0);

    const again = cli(['wave', 'check', planPath, 'epic-1/task-1', ...flags], sb);
    expect(again.status).toBe(1);
    expect(errorOf(again.stdout)).toBe('wave.in-flight');

    const next = cli(['wave', 'next', planPath, '--repo', scratch, '--session', 'sess-fl'], sb);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    const proposal = JSON.parse(next.stdout);
    expect(proposal.wave).toEqual(['epic-1/task-2']);
    expect(proposal.occupied).toContain('epic-1/task-1');
  });
});

// ---- criterion 10: heavy run / heavy status / gate run -------------------------

describe('heavy run, heavy status and gate run (criterion 10, CLI half)', () => {
  it('passes the child exit code through, with no shell', () => {
    const sb = sandbox();
    const ok = cli(['heavy', 'run', '--label', 't', '--', 'node', '-e', 'process.exit(0)'], sb);
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    const three = cli(['heavy', 'run', '--label', 't', '--', 'node', '-e', 'process.exit(3)'], sb);
    expect(three.status).toBe(3);
    // The marker would be created if the argument went through a shell.
    const marker = path.join(scratch, 'shell-marker');
    const argv = cli(
      ['heavy', 'run', '--label', `x; touch ${marker}`, '--', 'node', '-e', 'process.exit(0)'],
      sb,
    );
    expect(argv.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('exits 75 naming the holder when a live pid holds the lock', () => {
    const sb = sandbox();
    writeFileSync(
      path.join(sb.locks, 'heavy.lock'),
      JSON.stringify({
        pid: process.pid,
        token: 'held-token',
        label: 'someone-else',
        startedAt: '2026-10-24T00:00:00.000Z',
        cwd: '/somewhere',
      }),
    );
    const run = cli(
      [
        'heavy',
        'run',
        '--label',
        't',
        '--max-wait-ms',
        '50',
        '--',
        'node',
        '-e',
        'process.exit(0)',
      ],
      sb,
    );
    expect(run.status).toBe(75);
    const error = JSON.parse(run.stdout).error;
    expect(error.code).toBe('heavy.wait-timeout');
    expect(error.message).toContain(`pid ${process.pid}`);
    expect(error.message).toContain('someone-else');
  });

  it('heavy status prints the holder while a run holds the lock, and {} when free', () => {
    const sb = sandbox();
    expect(JSON.parse(cli(['heavy', 'status'], sb).stdout)).toEqual({});
    const during = cli(
      [
        'heavy',
        'run',
        '--label',
        'status-probe',
        '--',
        process.execPath,
        CLI_PATH,
        'heavy',
        'status',
      ],
      sb,
    );
    // The child is a nested bs under the same lock: it reads the lock heavy run holds.
    expect(during.status, during.stdout + during.stderr).toBe(0);
    const holder = JSON.parse(during.stdout);
    expect(holder.label).toBe('status-probe');
    expect(JSON.parse(cli(['heavy', 'status'], sb).stdout)).toEqual({});
  });

  it('a nested heavy run returns the inner exit code, waits for nothing and writes no default lock', () => {
    const sb = sandbox();
    const fakeHome = path.join(scratch, `home-${counter++}`);
    mkdirSync(fakeHome, { recursive: true });
    const run = cli(
      [
        'heavy',
        'run',
        '--label',
        'outer',
        '--',
        process.execPath,
        CLI_PATH,
        'heavy',
        'run',
        '--label',
        'inner',
        '--max-wait-ms',
        '50',
        '--',
        'node',
        '-e',
        'process.exit(7)',
      ],
      sb,
      { HOME: fakeHome },
    );
    expect(run.status, run.stdout + run.stderr).toBe(7);
    expect(existsSync(path.join(fakeHome, '.blacksmith', 'locks'))).toBe(false);
    expect(readdirSync(sb.locks)).not.toContain('heavy.lock');
  });

  it('gate run refuses a check whose heavy is a string with gate.invalid-check-heavy', () => {
    const sb = sandbox();
    const checks = path.join(scratch, 'checks-bad-heavy.json');
    writeFileSync(checks, JSON.stringify([{ name: 'test', cmd: 'true', heavy: 'false' }]));
    const run = cli(
      [
        'gate',
        'run',
        'epic-1/task-1',
        '--worktree',
        scratch,
        '--checks',
        checks,
        '--result',
        checks,
      ],
      sb,
    );
    expect(run.status).toBe(1);
    expect(errorOf(run.stdout)).toBe('gate.invalid-check-heavy');
  });
});

// ---- criterion 14: cleanup ----------------------------------------------------

describe('cleanup (criterion 14, CLI half)', () => {
  const DAY = 24 * 3600;

  /** Age every file under `dir` (and the worktree's index) so the 24 h activity rule passes. */
  function age(dir: string, when: Date): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) age(full, when);
      utimesSync(full, when, when);
    }
    utimesSync(dir, when, when);
  }

  function fixture(sb: Sandbox) {
    const root = realpathSync(path.join(sb.home, '..'));
    const project = path.join(root, 'project');
    const wt = path.join(root, '.wt', 'project', 't1');
    mkdirSync(project, { recursive: true });
    git(project, ['init', '-q', '-b', 'main']);
    git(project, ['config', 'user.email', 'test@example.com']);
    git(project, ['config', 'user.name', 'Test']);
    writeFileSync(path.join(project, 'README.md'), '# project\n');
    git(project, ['add', 'README.md']);
    git(project, ['commit', '-q', '-m', 'init']);
    git(project, ['worktree', 'add', '-q', '-b', 'bs/e1/t1', wt]);
    git(wt, ['config', 'user.email', 'test@example.com']);
    git(wt, ['config', 'user.name', 'Test']);
    writeFileSync(path.join(wt, 't1.txt'), 't1\n');
    git(wt, ['add', 't1.txt']);
    const old = new Date(Date.now() - 3 * DAY * 1000).toISOString();
    runProcess('git', ['commit', '-q', '-m', 't1'], {
      cwd: wt,
      env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old },
    });
    git(project, ['merge', '-q', '--ff-only', 'bs/e1/t1']);
    const when = new Date(Date.now() - 3 * DAY * 1000);
    // The tree is aged a day further than the git dir: a file as new as the
    // index is "racily clean", and the next `git status` would rewrite the
    // index and make the worktree look active.
    age(wt, new Date(when.getTime() - DAY * 1000));
    git(wt, ['status', '--porcelain']);
    const gitDir = git(wt, ['rev-parse', '--absolute-git-dir']).trim();
    age(gitDir, when);
    startSession(sb, 'sess-clean');
    appendEvent(sb, {
      session_id: 'sess-clean',
      actor: 'orchestrator',
      event_type: 'epic-closed',
      plan_version: 1,
      causal_parent: 'sess-clean#0',
      payload: { epic_id: 'e1' },
    });
    return { project, wt };
  }

  it('reports without changing anything, then removes the worktree and branch with --apply', () => {
    const sb = sandbox();
    const { project, wt } = fixture(sb);
    const branches = () => git(project, ['branch', '--list', 'bs/e1/t1']).trim();

    const dry = cli(['cleanup', '--project', project], sb);
    expect(dry.status, dry.stdout + dry.stderr).toBe(0);
    const dryReport = JSON.parse(dry.stdout);
    expect(dryReport.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ branch: 'bs/e1/t1', action: 'remove' })]),
    );
    expect(existsSync(wt)).toBe(true);
    expect(branches()).not.toBe('');

    const applied = cli(['cleanup', '--project', project, '--epic', 'e1', '--apply'], sb);
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    expect(JSON.stringify(JSON.parse(applied.stdout))).toContain('bs/e1/t1');
    expect(existsSync(wt)).toBe(false);
    expect(branches()).toBe('');
  });

  it('exits non-zero with cleanup.not-a-git-repo for a directory that is not a repository', () => {
    const sb = sandbox();
    const plain = path.join(scratch, 'plain-dir');
    mkdirSync(plain, { recursive: true });
    const run = cli(['cleanup', '--project', plain], sb);
    expect(run.status).not.toBe(0);
    expect(errorOf(run.stdout)).toBe('cleanup.not-a-git-repo');
  });
});
