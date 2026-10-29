import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GateInput } from '../src/gate.js';
import { recordJudgeDispatch, recordJudgeReport } from '../src/judges.js';
import { runCli } from './helpers/cliHarness.js';
import {
  buildLadder,
  createWorld,
  type FixtureBuilder,
  graderDead,
  graderFailed,
  graderFile,
  graderMet,
  graderVerdictBody,
  PARITY_CASES,
  recordTester,
  screenshotComboMissing,
  screenshotMisnamed,
  screenshotsStale,
  stampedResult,
  testerResult,
  uiuxSpecMissing,
  uiuxVisualMissing,
  type World,
  withSpecTurn,
} from './helpers/paperworkFixtures.js';
import { git } from './helpers/process.js';

// `bs results check` against `bs gate run`, both through the built CLI from the
// worktree as cwd, on the paperwork fixtures task-1 built.

const GATE_ONLY = [
  ['--checks', 'x.json'],
  ['--run-all'],
  ['--evidence', 'x.json'],
  ['--found-by', 'reviewer'],
  ['--found-by-provider', 'claude'],
  ['--findings', 'x.json'],
  ['--no-findings', 'reviewer'],
  ['--uiux-visual', 'x.json'],
  ['--lessons', 'x.md'],
];

interface Parsed {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: parsed CLI output is probed by path in assertions
  json: Record<string, any>;
}

function parse(run: { stdout: string; status: number }): Parsed {
  const lines = run.stdout.trim().split('\n');
  expect(lines, run.stdout).toHaveLength(1);
  return { status: run.status, json: JSON.parse(lines[0] as string) };
}

describe('bs results check (built binary)', () => {
  let w: World;
  let scratch: string;

  beforeEach(async () => {
    w = await createWorld();
    scratch = await mkdtemp(path.join(tmpdir(), 'bs-rc-scratch-'));
  });

  afterEach(async () => {
    await w.dispose();
    await rm(scratch, { recursive: true, force: true });
  });

  const write = async (name: string, value: unknown): Promise<string> => {
    const file = path.join(scratch, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };

  const sessionFlags = () => [
    '--session',
    w.sessionId,
    '--causal-parent',
    `${w.sessionId}#0`,
    '--state-dir',
    w.stateDir,
  ];

  const planFile = (uiAffecting: boolean) =>
    write('plan.json', {
      epic_id: 'epic-1',
      version: 1,
      status: 'active',
      tasks: [
        {
          task_id: w.taskId,
          epic_id: 'epic-1',
          plan_version: 1,
          objective: 'Do the thing.',
          output_schema_ref: 'result.schema.json',
          acceptance_criteria: ['it works'],
          claims: ['src.ts'],
          budget: { tokens: 1000, diff_lines: 100 },
          contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
          ui_affecting: uiAffecting,
        },
      ],
    });

  /** The `gate run` line a fixture implies, minus the positional and the verb. */
  async function gateLine(input: GateInput, extra: string[] = []): Promise<string[]> {
    return [
      '--worktree',
      w.worktreeDir,
      '--checks',
      await write('checks.json', [{ name: 'noop', cmd: 'true' }]),
      '--result',
      await write('result.json', input.result),
      '--base',
      'main',
      ...(input.graderVerdict === undefined
        ? []
        : ['--grader', await write('grader.json', input.graderVerdict)]),
      ...(input.uiAffecting === undefined ? [] : ['--plan', await planFile(input.uiAffecting)]),
      '--artifacts-dir',
      w.artifactsDir,
      ...sessionFlags(),
      ...extra,
    ];
  }

  const gate = (line: string[]) =>
    parse(runCli(['gate', 'run', w.taskId, ...line], {}, undefined, w.worktreeDir));
  const check = (as: string, line: string[], taskId = w.taskId) =>
    parse(runCli(['results', 'check', taskId, '--as', as, ...line], {}, undefined, w.worktreeDir));
  const checkGate = (line: string[]) => check('gate', line);

  describe('gate mode parity with gate run', () => {
    it.each(PARITY_CASES)('$name: same blocking reason', async ({ build, reason }) => {
      const line = await gateLine(await build(w));
      const preflight = checkGate(line);
      const real = gate(line);
      expect(real.json.reason ?? null).toBe(reason);
      expect(preflight.json.reason ?? null).toBe(reason);
      expect(preflight.status).toBe(reason === null ? 0 : 1);
      expect(real.status).toBe(reason === null ? 0 : 1);
      expect(preflight.json.outcome).toBe(reason === null ? 'pass' : 'blocked');
      expect(preflight.json.as).toBe('gate');
      expect(preflight.json.task_id).toBe(w.taskId);
      expect(preflight.json.not_run).toEqual(['tests', 'coverage-evidence', 'findings', 'budget']);
    });

    it.each([
      ['fail', graderFailed],
      ['not-graded', graderDead],
    ] as [string, FixtureBuilder][])(
      'a %s grader verdict blocks gate run as grader-fail and passes the preflight with the verdict',
      async (verdict, build) => {
        const line = await gateLine(await build(w));
        const preflight = checkGate(line);
        expect(gate(line).json.reason).toBe('grader-fail');
        expect(preflight.status).toBe(0);
        expect(preflight.json.outcome).toBe('pass');
        expect(preflight.json.verdicts).toEqual({ grader: verdict });
      },
    );

    it('reports a met grader verdict', async () => {
      const preflight = checkGate(await gateLine(await graderMet(w)));
      expect(preflight.json.verdicts).toEqual({ grader: 'met' });
    });

    it('follows the gate stage ladder one defect at a time', async () => {
      const ladder = await buildLadder(w);
      for (const step of ladder.steps) {
        const line = await gateLine(ladder.input());
        expect(checkGate(line).json.reason).toBe(step.reason);
        await step.fix();
      }
      expect(checkGate(await gateLine(ladder.input())).json.outcome).toBe('pass');
    });
  });

  describe('judge-close dry run', () => {
    const futureStamp = () => new Date(Date.now() + 60_000);

    async function dispatchWithArtifact(role: string, file: string, kind?: 'spec' | 'visual') {
      await recordJudgeDispatch(
        {
          taskId: w.taskId,
          role,
          round: 1,
          artifactPath: file,
          model: 'claude-opus-5',
          ...(kind ? { kind } : {}),
        },
        w.ctx(),
        w.opts(),
      );
    }

    it('passes the judges stage for a grader turn the line hands in, writing nothing', async () => {
      const input = await graderMet(w);
      const graderPath = path.join(scratch, 'grader.json');
      await dispatchWithArtifact('grader', graderPath);
      const line = await gateLine(input);
      await utimes(graderPath, futureStamp(), futureStamp());
      const before = snapshot(w.stateDir);

      const preflight = checkGate(line);
      expect(preflight.json.reason).toBeUndefined();
      expect(preflight.status).toBe(0);
      expect(snapshot(w.stateDir)).toEqual(before);

      const real = gate(line);
      expect(real.json.reason).toBeUndefined();
      expect(real.status).toBe(0);
    });

    it('blocks judges-outstanding when the same turn is not handed in', async () => {
      await dispatchWithArtifact('grader', path.join(scratch, 'grader.json'));
      const line = await gateLine(await clean(w));
      expect(checkGate(line).json.reason).toBe('judges-outstanding');
    });

    it('passes the uiux stage for a visual turn the line hands in, writing nothing', async () => {
      await withSpecTurn(w);
      await recordTester(w);
      const visual = path.join(scratch, 'visual.json');
      await dispatchWithArtifact('uiux', visual, 'visual');
      const line = await gateLine({ ...(await uiuxSpecMissing(w)), uiAffecting: true }, [
        '--uiux-visual',
        await write('visual.json', visualResult()),
      ]);
      await utimes(visual, futureStamp(), futureStamp());
      const before = snapshot(w.stateDir);

      const preflight = checkGate(line);
      expect(preflight.json.reason).toBeUndefined();
      expect(preflight.status).toBe(0);
      expect(snapshot(w.stateDir)).toEqual(before);
      expect(gate(line).status).toBe(0);
    });

    it('blocks under the code gate run fails with for a stale, missing or invalid file', async () => {
      const graderPath = path.join(scratch, 'grader.json');
      const input = await graderMet(w);
      await write('grader.json', graderFile(graderVerdictBody()));
      await dispatchWithArtifact('grader', graderPath);
      const line = await gateLine(input);

      // Stale: written before the dispatch.
      const old = new Date(Date.now() - 3_600_000);
      await utimes(graderPath, old, old);
      const stale = checkGate(line);
      expect(stale.status).toBe(1);
      expect(stale.json.reason).toBe('judges.artifact-stale');
      expect(gate(line).json.error.code).toBe('judges.artifact-stale');

      // Invalid evidence: fresh, but neither a list nor a grader document.
      await write('grader.json', '42');
      await utimes(graderPath, futureStamp(), futureStamp());
      const invalid = checkGate(line);
      expect(invalid.json.reason).toBe('judges.artifact-not-a-list');
      expect(gate(line).json.error.code).toBe('judges.artifact-not-a-list');
    });

    it('names a missing handed-in file', async () => {
      const graderPath = path.join(scratch, 'grader.json');
      const line = await gateLine(await graderMet(w));
      await dispatchWithArtifact('grader', graderPath);
      await rm(graderPath);
      const preflight = checkGate(line);
      expect(preflight.status).toBe(1);
      expect(preflight.json.reason).toMatch(/^judges\.artifact/);
      expect(gate(line).json.error.code).toBe(preflight.json.reason);
    });

    it('dry-runs a --no-findings attestation and blocks one with no dispatch', async () => {
      const line = await gateLine(await clean(w), ['--no-findings', 'reviewer']);
      const noDispatch = checkGate(line);
      expect(noDispatch.json.reason).toBe('judges.not-dispatched');
      expect(gate(line).json.error.code).toBe('judges.not-dispatched');

      await dispatchWithArtifact('reviewer', path.join(scratch, 'reviewer.json'));
      const before = snapshot(w.stateDir);
      const ok = checkGate(line);
      expect(ok.json.outcome).toBe('pass');
      expect(snapshot(w.stateDir)).toEqual(before);
    });

    // A bare --no-findings is refused upstream by the generic missing-value check
    // in both verbs; the form that reaches gate run's own guard is a role named "true".
    it.each([
      ['a role named "true"', ['--no-findings', 'true'], 'cli.no-findings-needs-role'],
      ['an inline "true"', ['--no-findings=true'], 'cli.no-findings-needs-role'],
      ['a bare flag', ['--no-findings'], 'cli.missing-flag-value'],
    ])('refuses %s with the code and exit status gate run fails with', async (_name, extra, code) => {
      const line = [...extra, ...(await gateLine(await clean(w)))];
      const real = gate(line);
      const preflight = checkGate(line);
      expect(real.json.error.code).toBe(code);
      expect(preflight.json.error.code).toBe(code);
      expect(preflight.status).toBe(real.status);
      expect(preflight.json.error.message).toBe(real.json.error.message);
    });

    it('does not close a turn that is already reported, so a stale file on the line cannot block', async () => {
      const graderPath = path.join(scratch, 'grader.json');
      await dispatchWithArtifact('grader', graderPath);
      await recordJudgeReport(
        { taskId: w.taskId, role: 'grader', noFindings: true },
        w.ctx(),
        w.opts(),
      );
      const line = await gateLine(await graderMet(w));
      const old = new Date(Date.now() - 3_600_000);
      await utimes(graderPath, old, old);
      expect(gate(line).status).toBe(0);
      expect(checkGate(line).json.outcome).toBe('pass');
    });

    it('counts an earlier close when it dry-runs the later attestation for the same role', async () => {
      await dispatchWithArtifact('uiux', path.join(scratch, 'spec.json'), 'spec');
      await dispatchWithArtifact('uiux', path.join(scratch, 'visual.json'), 'visual');
      const line = await gateLine(await clean(w), [
        '--uiux-visual',
        await write('visual.json', visualResult()),
        '--no-findings',
        'uiux',
      ]);
      await utimes(path.join(scratch, 'visual.json'), futureStamp(), futureStamp());
      expect(checkGate(line).json.outcome).toBe('pass');
      expect(gate(line).status).toBe(0);
    });
  });

  describe('role modes', () => {
    const coderCases = PARITY_CASES.filter(
      (c) =>
        c.reason === null ||
        ['schema-invalid', 'artifacts-missing', 'not-committed', 'deps-missing'].includes(c.reason),
    ).filter((c) => !c.name.startsWith('ui'));

    it.each(coderCases)(
      '--as coder, $name: the reason gate run returns',
      async ({ build, reason }) => {
        const input = await build(w);
        const line = [
          '--worktree',
          w.worktreeDir,
          '--result',
          await write('result.json', input.result),
          '--base',
          'main',
          '--artifacts-dir',
          w.artifactsDir,
        ];
        const preflight = check('coder', line);
        expect(preflight.json.reason ?? null).toBe(reason);
        expect(preflight.status).toBe(reason === null ? 0 : 1);
        expect(preflight.json.as).toBe('coder');
      },
    );

    const testerLine = async (result: unknown, ui = true) => [
      '--result',
      await write('tester.json', result),
      '--plan',
      await planFile(ui),
      '--artifacts-dir',
      w.artifactsDir,
    ];

    it.each([
      ['misnamed', ['home.png'], undefined],
      [
        'missing a combination',
        ['home-desktop-light.png', 'home-desktop-dark.png', 'home-mobile-light.png'],
        undefined,
      ],
      [
        'not on disk',
        [
          'home-desktop-light.png',
          'home-desktop-dark.png',
          'home-mobile-light.png',
          'home-mobile-dark.png',
        ],
        ['home-desktop-light.png'],
      ],
    ] as [string, string[], string[] | undefined][])(
      '--as tester returns screenshots-missing for screenshots %s',
      async (_name, names, onDisk) => {
        const result = await testerResult(w, names, onDisk);
        const preflight = check('tester', await testerLine(result));
        expect(preflight.json.reason).toBe('screenshots-missing');
        expect(preflight.status).toBe(1);
      },
    );

    it('--as tester passes a clean result on a ui-affecting task with no uiux turns or record yet', async () => {
      const names = [
        'home-desktop-light.png',
        'home-desktop-dark.png',
        'home-mobile-light.png',
        'home-mobile-dark.png',
      ];
      const result = await testerResult(w, names);
      const preflight = check('tester', await testerLine(result));
      expect(preflight.json.outcome).toBe('pass');
      expect(preflight.status).toBe(0);
    });

    it.each([
      ['an outline-less shape', 'graderOutside'],
      ['missing criteria fields', 'graderMissing'],
      ['a round past the cap', 'graderRound'],
    ])('--as grader returns grader-invalid for %s', async (_name, which) => {
      const doc =
        which === 'graderOutside'
          ? { task_id: w.taskId, round: 1, verdict: 'pass', criteria: [], notes: 'ok' }
          : which === 'graderMissing'
            ? graderFile(graderVerdictBody({ criteria: [{ criterion: 'no evidence or status' }] }))
            : graderFile(graderVerdictBody({ round: 3 }));
      const preflight = check('grader', ['--grader', await write('grader.json', doc)]);
      expect(preflight.json.reason).toBe('grader-invalid');
      expect(preflight.status).toBe(1);
    });

    it.each([
      ['fail', graderFailed],
      ['not-graded', graderDead],
    ] as [string, FixtureBuilder][])(
      '--as grader exits 0 with verdict %s',
      async (verdict, build) => {
        const input = await build(w);
        const preflight = check('grader', [
          '--grader',
          await write('grader.json', input.graderVerdict),
        ]);
        expect(preflight.status).toBe(0);
        expect(preflight.json.verdicts).toEqual({ grader: verdict });
      },
    );

    it.each(['coder', 'tester', 'grader'])(
      '--as %s refuses every gate-only flag naming --as gate',
      async (as) => {
        const base =
          as === 'coder'
            ? ['--worktree', w.worktreeDir, '--result', 'r.json']
            : as === 'tester'
              ? ['--result', 'r.json', '--plan', 'p.json']
              : ['--grader', 'g.json'];
        for (const flag of GATE_ONLY) {
          const run = runCli(
            ['results', 'check', w.taskId, '--as', as, ...base, ...flag],
            {},
            undefined,
            w.worktreeDir,
          );
          const out = JSON.parse(run.stdout.trim());
          expect(run.status, flag.join(' ')).toBe(1);
          expect(out.error.message, flag.join(' ')).toContain('--as gate');
        }
      },
    );

    it('refuses a flag the mode does not take', async () => {
      const run = runCli(
        [
          'results',
          'check',
          w.taskId,
          '--as',
          'grader',
          '--grader',
          'g.json',
          '--worktree',
          w.worktreeDir,
        ],
        {},
        undefined,
        w.worktreeDir,
      );
      expect(run.status).toBe(1);
      expect(JSON.parse(run.stdout.trim()).error.code).toBe('cli.flag-not-for-mode');
    });

    it('is a usage error to run --as coder without --worktree and --as tester without --plan', async () => {
      const coder = parse(
        runCli(['results', 'check', w.taskId, '--as', 'coder', '--result', 'r.json']),
      );
      expect(coder.status).toBe(1);
      expect(coder.json.error.code).toBe('cli.missing-flag');
      const tester = parse(
        runCli(['results', 'check', w.taskId, '--as', 'tester', '--result', 'r.json']),
      );
      expect(tester.status).toBe(1);
      expect(tester.json.error.code).toBe('cli.missing-flag');
    });

    it('refuses an unknown --as', async () => {
      const run = parse(runCli(['results', 'check', w.taskId, '--as', 'judge']));
      expect(run.status).toBe(1);
      expect(run.json.error.code).toBe('cli.invalid-flag');
    });
  });

  describe('envelope', () => {
    const half = { run_status: 'done', structured_output: {}, artifacts: [] };
    const stamp = ['--agent', 'coder', '--provider', 'claude', '--model-tier', 'mid'];

    it('blocks a worker half schema-invalid in both verbs without the envelope flags', async () => {
      const result = await write('half.json', half);
      const line = (as: string) => [
        '--worktree',
        w.worktreeDir,
        '--result',
        result,
        '--base',
        'main',
        '--artifacts-dir',
        w.artifactsDir,
        ...(as === 'gate' ? ['--checks', path.join(scratch, 'c.json'), ...sessionFlags()] : []),
      ];
      await write('c.json', []);
      expect(check('coder', line('coder')).json.reason).toBe('schema-invalid');
      expect(gate(line('gate')).json.reason).toBe('schema-invalid');
    });

    it('passes the same half with the envelope flags', async () => {
      const result = await write('half.json', half);
      const line = [
        '--worktree',
        w.worktreeDir,
        '--result',
        result,
        '--base',
        'main',
        '--artifacts-dir',
        w.artifactsDir,
        ...stamp,
      ];
      const preflight = check('coder', line);
      expect(preflight.json.outcome).toBe('pass');
      expect(preflight.status).toBe(0);
    });

    it('blocks a half that sets a dispatcher-owned field with the code gate run fails with', async () => {
      const result = await write('half.json', {
        ...half,
        token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
      await write('c.json', []);
      const preflight = check('coder', [
        '--worktree',
        w.worktreeDir,
        '--result',
        result,
        '--artifacts-dir',
        w.artifactsDir,
        ...stamp,
      ]);
      expect(preflight.status).toBe(1);
      expect(preflight.json.reason).toBe('results.agent-wrote-owned-field');
      const real = gate([
        '--worktree',
        w.worktreeDir,
        '--checks',
        path.join(scratch, 'c.json'),
        '--result',
        result,
        '--artifacts-dir',
        w.artifactsDir,
        ...stamp,
        ...sessionFlags(),
      ]);
      expect(real.json.error.code).toBe('results.agent-wrote-owned-field');
    });

    it('blocks a partial token count and an invalid one', async () => {
      const result = await write('half.json', half);
      const base = ['--worktree', w.worktreeDir, '--result', result, ...stamp];
      expect(check('coder', [...base, '--input-tokens', '5']).json.reason).toBe(
        'results.partial-token-count',
      );
    });
  });

  describe('malformed and hostile input', () => {
    const base = () => ['--worktree', w.worktreeDir, '--artifacts-dir', w.artifactsDir];

    it('blocks a missing result file as result-unreadable', async () => {
      const run = check('coder', [...base(), '--result', path.join(scratch, 'absent.json')]);
      expect(run.status).toBe(1);
      expect(run.json.reason).toBe('result-unreadable');
      expect(run.json.problems).toHaveLength(1);
      expect(run.json.skipped.map((s: { why: string }) => s.why)).toEqual(
        Array(run.json.skipped.length).fill('unreadable-input'),
      );
    });

    it('blocks invalid JSON as result-unreadable', async () => {
      const run = check('coder', [...base(), '--result', await write('bad.json', '{nope')]);
      expect(run.status).toBe(1);
      expect(run.json.reason).toBe('result-unreadable');
    });

    it('blocks a JSON array, with and without the envelope flags', async () => {
      const file = await write('array.json', '[]');
      const bare = check('coder', [...base(), '--result', file]);
      expect(bare.status).toBe(1);
      expect(bare.json.outcome).toBe('blocked');
      const stamped = check('coder', [
        ...base(),
        '--result',
        file,
        '--agent',
        'coder',
        '--provider',
        'claude',
        '--model-tier',
        'mid',
      ]);
      expect(stamped.json.reason).toBe('results.not-an-object');
    });

    it('blocks a result whose artifacts is not an array', async () => {
      const run = check('coder', [
        ...base(),
        '--result',
        await write('r.json', stampedResult({ artifacts: 'none' })),
      ]);
      expect(run.status).toBe(1);
      expect(run.json.outcome).toBe('blocked');
    });

    it('blocks an unsafe positional task id', async () => {
      const run = check(
        'coder',
        [...base(), '--result', await write('r.json', stampedResult())],
        '../x',
      );
      expect(run.status).toBe(1);
      expect(run.json.reason).toBe('artifacts.unsafe-task-id');
    });

    it('answers a blank positional task id with the CLI error document', async () => {
      const run = parse(
        runCli(
          ['results', 'check', '', '--as', 'coder', ...base(), '--result', 'r.json'],
          {},
          undefined,
          w.worktreeDir,
        ),
      );
      expect(run.status).toBe(1);
      expect(run.json.error.code).toBe('cli.missing-positional');
    });

    it('blocks a whitespace task id as artifacts.missing-task-id', async () => {
      const run = check(
        'coder',
        [...base(), '--result', await write('r.json', stampedResult())],
        ' ',
      );
      expect(run.status).toBe(1);
      expect(run.json.reason).toBe('artifacts.missing-task-id');
    });

    it('warns, without blocking, when a complete result names another task, and checks the positional home', async () => {
      await mkdir(w.home(), { recursive: true });
      await writeFile(path.join(w.home(), 'evidence.txt'), 'x');
      const result = stampedResult({
        task_id: 'other/task',
        artifacts: [{ type: 'log', path: 'evidence.txt' }],
      });
      const run = check('coder', [
        ...base(),
        '--base',
        'main',
        '--result',
        await write('r.json', result),
      ]);
      expect(run.json.outcome).toBe('pass');
      expect(run.json.warnings).toHaveLength(1);
      expect(run.json.warnings[0]).toContain('other/task');
      expect(run.json.artifact_home).toBe(w.home());
    });
  });

  describe('artifact home', () => {
    it('prints the directory the gate resolved, with and without --artifacts-dir', async () => {
      const input = await build(w, 'artifactMissing');
      const line = await gateLine(input);
      const preflight = checkGate(line);
      const real = gate(line);
      expect(real.json.artifactIssues[0].resolved).toBe(
        path.join(preflight.json.artifact_home, 'never-written.txt'),
      );
      expect(preflight.json.artifact_home).toBe(w.home());

      const homeDir = await mkdtemp(path.join(tmpdir(), 'bs-rc-home-'));
      try {
        const noDir = line.filter(
          (_, i, all) => all[i] !== '--artifacts-dir' && all[i - 1] !== '--artifacts-dir',
        );
        const env = { BS_HOME: homeDir };
        const a = parse(
          runCli(
            ['results', 'check', w.taskId, '--as', 'gate', ...noDir],
            env,
            undefined,
            w.worktreeDir,
          ),
        );
        const b = parse(runCli(['gate', 'run', w.taskId, ...noDir], env, undefined, w.worktreeDir));
        expect(b.json.artifactIssues[0].resolved).toBe(
          path.join(a.json.artifact_home, 'never-written.txt'),
        );
        expect(a.json.artifact_home).toBe(path.join(homeDir, 'state', 'artifacts', w.taskId));
      } finally {
        await rm(homeDir, { recursive: true, force: true });
      }
    });
  });

  describe('read-only', () => {
    function porcelain(): string {
      return git(w.worktreeDir, ['--no-optional-locks', 'status', '--porcelain']);
    }
    const indexPath = () =>
      path.resolve(w.worktreeDir, git(w.worktreeDir, ['rev-parse', '--git-path', 'index']).trim());

    it('leaves events, results, the working tree and the git index untouched in every mode', async () => {
      const input = await graderMet(w);
      const gateArgs = await gateLine(input);
      const resultFile = path.join(scratch, 'result.json');
      const graderPath = path.join(scratch, 'grader.json');
      const plan = await planFile(true);
      const runs: string[][] = [
        ['gate', ...gateArgs],
        [
          'coder',
          '--worktree',
          w.worktreeDir,
          '--result',
          resultFile,
          '--base',
          'main',
          '--artifacts-dir',
          w.artifactsDir,
        ],
        ['tester', '--result', resultFile, '--plan', plan, '--artifacts-dir', w.artifactsDir],
        ['grader', '--grader', graderPath],
      ];
      // A stat-dirty index: a plain `git status` would refresh and rewrite it.
      await utimes(path.join(w.worktreeDir, 'src.ts'), new Date(), new Date(Date.now() + 5_000));
      for (const [as, ...rest] of runs) {
        const events = snapshot(w.stateDir);
        const results = snapshot(scratch);
        const status = porcelain();
        const index = readFileSync(indexPath());
        check(as as string, rest);
        expect(snapshot(w.stateDir)).toEqual(events);
        expect(snapshot(scratch)).toEqual(results);
        expect(porcelain()).toBe(status);
        expect(readFileSync(indexPath()).equals(index)).toBe(true);
        expect(existsSync(`${indexPath()}.lock`)).toBe(false);
      }
    });

    it('runs no test command', async () => {
      const marker = path.join(scratch, 'marker');
      const checks = await write('checks.json', [{ name: 'mark', cmd: `touch ${marker}-check` }]);
      await writeFile(
        path.join(w.worktreeDir, 'package.json'),
        JSON.stringify({ name: 'p', scripts: { test: `touch ${marker}-script` } }),
      );
      w.git(['add', 'package.json']);
      w.git(['commit', '-q', '-m', 'script']);
      const input = await build(w, 'clean');
      const line = (await gateLine(input)).map((v, i, all) =>
        all[i - 1] === '--checks' ? checks : v,
      );
      const run = checkGate(line);
      expect(run.json.outcome).toBe('pass');
      expect(run.json.not_run).toContain('tests');
      expect(existsSync(`${marker}-check`)).toBe(false);
      expect(existsSync(`${marker}-script`)).toBe(false);
    });
  });

  describe('uiux relationship', () => {
    it.each([
      ['uiux spec missing', uiuxSpecMissing, 'uiux-spec-missing'],
      ['screenshots misnamed', screenshotMisnamed, 'screenshots-missing'],
      ['screenshot combo missing', screenshotComboMissing, 'screenshots-missing'],
      ['screenshots stale', screenshotsStale, 'screenshots-stale'],
      ['uiux visual missing', uiuxVisualMissing, 'uiux-visual-missing'],
    ] as [string, FixtureBuilder, string][])(
      '%s: uiux check and results check agree',
      async (_n, builder, reason) => {
        const input = await builder(w);
        const line = await gateLine(input);
        const planPath = line[line.indexOf('--plan') + 1] as string;
        const uiux = parse(
          runCli(
            [
              'uiux',
              'check',
              '--task',
              w.taskId,
              '--plan',
              planPath,
              '--worktree',
              w.worktreeDir,
              '--artifacts-dir',
              w.artifactsDir,
              ...sessionFlags(),
            ],
            {},
            undefined,
            w.worktreeDir,
          ),
        );
        expect(uiux.json.reason).toBe(reason);
        expect(checkGate(line).json.reason).toBe(reason);
      },
    );
  });

  describe('output shape', () => {
    it('prints one document with the documented keys, and verdicts only when a grader file was read', async () => {
      const clean = checkGate(await gateLine(await build(w, 'clean')));
      expect(Object.keys(clean.json).sort()).toEqual(
        [
          'artifact_home',
          'as',
          'not_run',
          'outcome',
          'problems',
          'skipped',
          'task_id',
          'warnings',
        ].sort(),
      );
      const withGrader = checkGate(await gateLine(await graderMet(w)));
      expect(withGrader.json.verdicts).toEqual({ grader: 'met' });
    });
  });
});

import {
  artifactMissing as artifactMissingBuilder,
  clean as cleanBuilder,
} from './helpers/paperworkFixtures.js';

function clean(w: World): Promise<GateInput> {
  return cleanBuilder(w);
}

function build(w: World, which: 'clean' | 'artifactMissing'): Promise<GateInput> {
  return which === 'clean' ? cleanBuilder(w) : artifactMissingBuilder(w);
}

/** A uiux visual-pass result document with no deviations. */
function visualResult(): Record<string, unknown> {
  return { run_status: 'done', structured_output: { deviations: [] }, artifacts: [] };
}

/** Every file under a directory with its bytes, for before/after comparison. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current).sort()) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out[path.relative(dir, full)] = readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}
