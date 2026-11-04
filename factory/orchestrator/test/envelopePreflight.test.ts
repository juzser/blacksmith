import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditManifestPath, auditWorktreeDir } from '../src/audit.js';
import { runCli } from './helpers/cliHarness.js';
import { git } from './helpers/process.js';

// A verb that writes outside the log (a worktree, a plan version) and only then
// appends must refuse an ambiguous defaulted --causal-parent BEFORE the first
// write: a refusal after it leaves an unexplained worktree / plan version and
// the retry hits `audit.worktree-exists` / `plan.version-exists` (D-42's class).

const SESSION = 'preflight';

function seedTwoLiveDispatches(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  const dispatch = (task: string, i: number) => ({
    session_id: SESSION,
    actor: 'orchestrator',
    event_type: 'dispatch_decision',
    task_id: task,
    plan_version: 1,
    causal_parent: `${SESSION}#0`,
    ts: `2026-11-04T00:00:0${i}.000Z`,
    payload: {
      agent_role: 'coder',
      provider: 'claude',
      model_tier: 'mid',
      model: 'claude-sonnet-5',
    },
  });
  const root = {
    session_id: SESSION,
    actor: 'operator',
    event_type: 'session-start',
    plan_version: 1,
    causal_parent: null,
    ts: '2026-11-04T00:00:00.000Z',
    payload: {},
  };
  const lines = [root, dispatch('e/t1', 1), dispatch('e/t2', 2)];
  writeFileSync(
    path.join(stateDir, `${SESSION}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
  );
}

describe('verbs that write outside the log refuse an ambiguous default first', () => {
  let scratch: string;
  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'smith-preflight-'));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('audit open leaves no worktree and no manifest', () => {
    const project = path.join(scratch, 'project');
    const stateDir = path.join(scratch, 'audit-state');
    mkdirSync(project);
    git(project, ['init', '-q', '-b', 'main']);
    git(project, ['config', 'user.email', 'test@example.com']);
    git(project, ['config', 'user.name', 'Test']);
    writeFileSync(path.join(project, 'README.md'), '# project\n');
    git(project, ['add', '.']);
    git(project, ['commit', '-q', '-m', 'init']);
    seedTwoLiveDispatches(stateDir);

    const run = runCli(['audit', 'open', project, '--session', SESSION, '--state-dir', stateDir], {
      CLAUDE_CODE_SESSION_ID: '',
    });
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout).error.code).toBe('cli.envelope-parent-ambiguous');
    expect(existsSync(auditWorktreeDir(project))).toBe(false);
    expect(existsSync(auditManifestPath(project))).toBe(false);
  });

  it('plan amend writes no plan version', () => {
    const stateDir = path.join(scratch, 'plan-state');
    const specsDir = path.join(scratch, 'specs');
    mkdirSync(specsDir, { recursive: true });
    seedTwoLiveDispatches(stateDir);
    const planPath = path.join(specsDir, 'epic-1-plan-v1.json');
    writeFileSync(
      planPath,
      JSON.stringify({ epic_id: 'epic-1', version: 1, status: 'active', tasks: [], edges: [] }),
    );
    const before = readFileSync(planPath, 'utf8');

    const run = runCli(
      [
        'plan',
        'amend',
        '--plan',
        planPath,
        '--findings',
        'f-1',
        '--sites',
        'src/a.ts',
        '--rationale',
        'x',
        '--session',
        SESSION,
        '--state-dir',
        stateDir,
        '--specs-dir',
        specsDir,
      ],
      { CLAUDE_CODE_SESSION_ID: '' },
    );
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout).error.code).toBe('cli.envelope-parent-ambiguous');
    expect(readFileSync(planPath, 'utf8')).toBe(before);
    expect(existsSync(path.join(specsDir, 'epic-1-plan-v2.json'))).toBe(false);
  });
});
