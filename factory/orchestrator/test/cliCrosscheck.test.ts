import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from './helpers/cliHarness.js';

// `bs crosscheck run|reproduce` as a built binary, against the fake CLI judge.
describe('cli.ts crosscheck run / reproduce (built binary)', () => {
  const JUDGE_CLI = path.join(import.meta.dirname, 'fixtures', 'fake-judge-cli.mjs');
  let scratch: string;
  let repo: string;
  let base: string;
  let head: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  beforeAll(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'smith-cli-crosscheck-'));
    repo = path.join(scratch, 'repo');
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    writeFileSync(path.join(repo, 'src/a.ts'), 'export const x = 0;\n');
    git('add', 'src/a.ts');
    git('commit', '-q', '-m', 'base');
    base = git('rev-parse', 'HEAD');
    writeFileSync(path.join(repo, 'src/a.ts'), 'export const x = 1;\n');
    git('add', 'src/a.ts');
    git('commit', '-q', '-m', 'head');
    head = git('rev-parse', 'HEAD');
  });

  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  function policyFile(answerPath: string): string {
    const file = path.join(scratch, 'policy.yml');
    writeFileSync(
      file,
      [
        'providers:',
        '  claude: { kind: native, enabled: true }',
        '  codex:',
        '    kind: api',
        '    transport: cli',
        '    command: node',
        `    args: ${JSON.stringify([JUDGE_CLI, 'echo-prompt', answerPath])}`,
        '    model_tier: mid',
        '    enabled: true',
        '    mode: active',
        'independent_finder:',
        '  enabled: false',
        '  mode: shadow',
        '  providers: [codex]',
        '  send_diff: true',
        '',
      ].join('\n'),
    );
    return file;
  }

  function startSession(eventsDir: string, sessionId: string) {
    const start = runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      }),
      '--state-dir',
      eventsDir,
    ]);
    expect(start.status).toBe(0);
  }

  it('runs once, exits 0 with advisory findings, and reproduce confirms one for real', () => {
    const eventsDir = path.join(scratch, 'events');
    const sessionId = `cli-crosscheck-${Date.now()}`;
    startSession(eventsDir, sessionId);
    const answer = path.join(scratch, 'answer.json');
    writeFileSync(
      answer,
      JSON.stringify([
        {
          file_path: 'src/a.ts',
          finding_category: 'correctness',
          severity: 'S2-major',
          summary: 'x is off by one',
          failure_scenario: { inputs: 'none', expected: '2', actual: '1' },
        },
      ]),
    );
    const common = ['--session', sessionId, '--state-dir', eventsDir];
    const run = runCli(
      [
        'crosscheck',
        'run',
        '--task',
        'lean-1/part-1',
        '--base',
        base,
        '--head',
        head,
        '--project',
        repo,
        '--criterion',
        'x is one',
        '--policy',
        policyFile(answer),
        ...common,
      ],
      { SMITH_CROSSCHECK_OFFLINE: '' },
    );
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe('ok');
    expect(parsed.findings[0]).toMatchObject({ advisory: true });

    const before = runCli(['findings', 'list', ...common]);
    expect(JSON.parse(before.stdout)).toEqual([]);

    const id = parsed.findings[0].finding_id as string;
    const reproduced = runCli([
      'crosscheck',
      'reproduce',
      id,
      '--evidence',
      'probe: got 1',
      ...common,
    ]);
    expect(reproduced.status).toBe(0);
    expect(JSON.parse(reproduced.stdout).finding.finding_status).toBe('confirmed');
    const after = runCli(['findings', 'list', ...common]);
    expect(JSON.parse(after.stdout)).toHaveLength(1);
  });

  it('collects criteria from --criterion, --criteria-file and --plan, and honours --test-file', () => {
    const eventsDir = path.join(scratch, 'events-criteria');
    const sessionId = `cli-crosscheck-crit-${Date.now()}`;
    startSession(eventsDir, sessionId);
    const answer = path.join(scratch, 'answer-empty.json');
    writeFileSync(answer, '[]');
    const criteriaFile = path.join(scratch, 'criteria.md');
    writeFileSync(criteriaFile, '- first from file\n2. second from file\n\n');
    const planFile = path.join(scratch, 'plan.json');
    writeFileSync(
      planFile,
      JSON.stringify({
        epic_id: 'lean-1',
        version: 1,
        status: 'approved',
        tasks: [
          { task_id: 'a', acceptance_criteria: ['plan one', 'plan two'] },
          { task_id: 'b', acceptance_criteria: ['plan three'] },
        ],
        edges: [],
      }),
    );
    const run = runCli(
      [
        'crosscheck',
        'run',
        '--task',
        'lean-1/part-1',
        '--base',
        base,
        '--head',
        head,
        '--project',
        repo,
        '--criterion',
        'inline one',
        '--criteria-file',
        criteriaFile,
        '--plan',
        planFile,
        '--test-file',
        'src/a.ts',
        '--policy',
        policyFile(answer),
        '--session',
        sessionId,
        '--state-dir',
        eventsDir,
      ],
      { SMITH_CROSSCHECK_OFFLINE: '' },
    );
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe('ok');
    expect(parsed.criteria_count).toBe(1 + 2 + 3);
    expect(parsed.test_files).toEqual(['src/a.ts']);
    expect(parsed.test_files_dropped).toEqual([]);
  });

  it('exits 0 with status skipped under the offline switch', () => {
    const eventsDir = path.join(scratch, 'events-offline');
    const sessionId = `cli-crosscheck-off-${Date.now()}`;
    startSession(eventsDir, sessionId);
    const run = runCli([
      'crosscheck',
      'run',
      '--task',
      'lean-1/part-1',
      '--base',
      base,
      '--head',
      head,
      '--project',
      repo,
      '--policy',
      policyFile('/dev/null'),
      '--session',
      sessionId,
      '--state-dir',
      eventsDir,
    ]);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).status).toBe('skipped');
  });
});
