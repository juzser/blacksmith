import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// TDD red step, observed and recorded verbatim before this module existed:
//   Error: Cannot find module '.../factory/orchestrator/src/dispatchLint.js'
//   imported from '.../factory/orchestrator/test/dispatchLint.test.ts'
// Everything below is the green step, against the module written to satisfy it.
import {
  JUDGE_ROLES,
  lintDispatchPrompt,
  parseDeclaredArtifactLine,
  parseStatedTurns,
} from '../src/dispatchLint.js';
import { appendEvent } from '../src/events.js';
import { recordJudgeDispatch } from '../src/judges.js';
import { REPO_ROOT } from '../src/paths.js';

function template(role: string, maxTurns: number | null): string {
  return [
    '---',
    `name: ${role}`,
    'model: sonnet',
    'effort: medium',
    'tools: Read, Grep',
    ...(maxTurns === null ? [] : [`maxTurns: ${maxTurns}`]),
    '---',
    '',
    '# Body',
    '',
  ].join('\n');
}

let agentsDir: string;
let stateDir: string;
const sessionId = 'sess-dispatch-lint';

beforeEach(async () => {
  agentsDir = await mkdtemp(path.join(tmpdir(), 'smith-dispatch-lint-agents-'));
  stateDir = await mkdtemp(path.join(tmpdir(), 'smith-dispatch-lint-state-'));
  await writeFile(path.join(agentsDir, 'planner.md'), template('planner', 20));
  await writeFile(path.join(agentsDir, 'coder.md'), template('coder', 40));
  await writeFile(path.join(agentsDir, 'reviewer.md'), template('reviewer', 15));
  await writeFile(path.join(agentsDir, 'no-max-turns.md'), template('no-max-turns', null));
  await appendEvent(
    {
      session_id: sessionId,
      actor: 'user',
      event_type: 'session-start',
      plan_version: 1,
      causal_parent: null,
      payload: {},
    },
    { stateDir },
  );
});

afterEach(async () => {
  await rm(agentsDir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

const eventCtx = () => ({ sessionId, planVersion: 1, causalParent: `${sessionId}#0` });
const eventOpts = () => ({ stateDir });

async function dispatchJudge(overrides: Record<string, unknown> = {}) {
  return recordJudgeDispatch(
    {
      taskId: 'epic-1/task-1',
      role: 'reviewer',
      round: 1,
      artifactPath: '/abs/task-1.reviewer.json',
      model: 'claude-opus-5',
      ...overrides,
    } as Parameters<typeof recordJudgeDispatch>[0],
    eventCtx(),
    eventOpts(),
  );
}

describe('parseStatedTurns', () => {
  it('reads a single "Turn budget: <n>" line', () => {
    expect(parseStatedTurns('Role: coder. Turn budget: 40\n\nOther text.')).toBe(40);
  });

  it('is null with no line, or two conflicting lines', () => {
    expect(parseStatedTurns('No budget mentioned here.')).toBeNull();
    expect(parseStatedTurns('Turn budget: 40\nTurn budget: 20\n')).toBeNull();
  });
});

describe('parseDeclaredArtifactLine', () => {
  it('reads a "Declared artifact: <path>" line', () => {
    expect(parseDeclaredArtifactLine('Declared artifact: /abs/T.reviewer.json\n')).toBe(
      '/abs/T.reviewer.json',
    );
  });

  it('is null with no line', () => {
    expect(parseDeclaredArtifactLine('No such line.')).toBeNull();
  });
});

describe('JUDGE_ROLES', () => {
  it('equals the epic criterion’s six judge roles exactly', () => {
    expect([...JUDGE_ROLES].sort()).toEqual(
      [
        'reviewer',
        'verifier',
        'grader',
        'spec-reviewer',
        'security-reviewer',
        'uiux',
      ].sort(),
    );
  });
});

describe('lintDispatchPrompt — turn budget', () => {
  it('is "over" and exits 1 when the prompt states more than the template', async () => {
    const report = await lintDispatchPrompt({
      prompt: 'Role: planner. Turn budget: 40 (see template).',
      role: 'planner',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(report.turns).toEqual({ status: 'over', stated: 40, template: 20 });
    expect(report.exitCode).toBe(1);
  });

  it('is "ok" when the prompt states exactly the template', async () => {
    const report = await lintDispatchPrompt({
      prompt: 'Turn budget: 20',
      role: 'planner',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(report.turns).toEqual({ status: 'ok', stated: 20, template: 20 });
    expect(report.exitCode).toBe(0);
  });

  it('is "under" and exits 0 when the prompt states fewer turns than the template', async () => {
    const report = await lintDispatchPrompt({
      prompt: 'Turn budget: 10',
      role: 'planner',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(report.turns).toEqual({ status: 'under', stated: 10, template: 20 });
    expect(report.exitCode).toBe(0);
  });

  it('is "missing" and exits 1 with no turn-budget line', async () => {
    const report = await lintDispatchPrompt({
      prompt: 'No mention of turns at all.',
      role: 'planner',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(report.turns).toEqual({ status: 'missing', stated: null, template: 20 });
    expect(report.exitCode).toBe(1);
  });

  it('is "missing" with two conflicting turn-budget lines', async () => {
    const report = await lintDispatchPrompt({
      prompt: 'Turn budget: 40\nTurn budget: 20\n',
      role: 'planner',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(report.turns.status).toBe('missing');
    expect(report.exitCode).toBe(1);
  });

  it('is "unverifiable" and exits 0 for an unknown role', async () => {
    const report = await lintDispatchPrompt({
      prompt: 'Turn budget: 40',
      role: 'ghost-role',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(report.turns).toEqual({ status: 'unverifiable', stated: 40, template: null });
    expect(report.exitCode).toBe(0);
  });

  it('is "unverifiable" when the template has no maxTurns line', async () => {
    const report = await lintDispatchPrompt({
      prompt: 'Turn budget: 40',
      role: 'no-max-turns',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(report.turns.status).toBe('unverifiable');
    expect(report.exitCode).toBe(0);
  });

  it('reads the template file fresh, not cached across calls', async () => {
    const first = await lintDispatchPrompt({
      prompt: 'Turn budget: 20',
      role: 'planner',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(first.turns).toEqual({ status: 'ok', stated: 20, template: 20 });

    await writeFile(path.join(agentsDir, 'planner.md'), template('planner', 30));

    const second = await lintDispatchPrompt({
      prompt: 'Turn budget: 20',
      role: 'planner',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(second.turns).toEqual({ status: 'under', stated: 20, template: 30 });
  });
});

describe('lintDispatchPrompt — declared artifact', () => {
  it('is "missing" and exits 1 when a judge prompt carries no declared-artifact line', async () => {
    await dispatchJudge();
    const report = await lintDispatchPrompt({
      prompt: 'Turn budget: 15',
      role: 'reviewer',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(report.artifact.status).toBe('missing');
    expect(report.artifact.expected_line).toBe('Declared artifact: /abs/task-1.reviewer.json');
    expect(report.exitCode).toBe(1);
  });

  it('is "relative" and exits 1 when the declared path is not absolute', async () => {
    await dispatchJudge();
    const report = await lintDispatchPrompt({
      prompt: 'Turn budget: 15\nDeclared artifact: task-1.reviewer.json\n',
      role: 'reviewer',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(report.artifact.status).toBe('relative');
    expect(report.exitCode).toBe(1);
  });

  it('is "mismatch" and exits 1 when the declared path is absolute but wrong', async () => {
    await dispatchJudge();
    const report = await lintDispatchPrompt({
      prompt: 'Turn budget: 15\nDeclared artifact: /abs/other.reviewer.json\n',
      role: 'reviewer',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(report.artifact.status).toBe('mismatch');
    expect(report.exitCode).toBe(1);
  });

  it('is "ok" and exits 0 when the declared line matches the ledger exactly', async () => {
    await dispatchJudge();
    const report = await lintDispatchPrompt({
      prompt: 'Turn budget: 15\nDeclared artifact: /abs/task-1.reviewer.json\n',
      role: 'reviewer',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(report.artifact.status).toBe('ok');
    expect(report.exitCode).toBe(0);
  });

  it('is "not-applicable" and exits 0 for a coder prompt with no artifact line', async () => {
    const report = await lintDispatchPrompt({
      prompt: 'Turn budget: 40',
      role: 'coder',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(report.artifact).toEqual({ status: 'not-applicable', expected_line: null, declared_line: null });
    expect(report.exitCode).toBe(0);
  });

  it('is "undeclared" and exits 1 when the ledger holds no judge dispatch for the role', async () => {
    // No dispatchJudge() call: the ledger is empty for this task/role.
    const report = await lintDispatchPrompt({
      prompt: 'Turn budget: 15\nDeclared artifact: /abs/task-1.reviewer.json\n',
      role: 'reviewer',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(report.artifact.status).toBe('undeclared');
    expect(report.exitCode).toBe(1);
  });
});

describe('mutation discrimination', () => {
  // Each of these proves the check actually looks at the thing it claims to,
  // by showing the "always ok" degenerate answer would be wrong here.
  it('turn-budget "over" would read as "ok" if the comparison were disabled', async () => {
    const report = await lintDispatchPrompt({
      prompt: 'Turn budget: 999',
      role: 'planner',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(report.turns.status).not.toBe('ok');
  });

  it('artifact "mismatch" would read as "ok" if the comparison were disabled', async () => {
    await dispatchJudge();
    const report = await lintDispatchPrompt({
      prompt: 'Turn budget: 15\nDeclared artifact: /abs/definitely-wrong.json\n',
      role: 'reviewer',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(report.artifact.status).not.toBe('ok');
  });
});

describe('drift guard — dispatch.md example lines parse', () => {
  it('the example turn-budget and declared-artifact lines shown in dispatch.md parse with this module’s own parser', async () => {
    const doc = await readFile(
      path.join(REPO_ROOT, '.claude', 'skills', 'bs', 'dispatch.md'),
      'utf8',
    );
    const turnMatch = /Turn budget: \d+/.exec(doc);
    const artifactMatch = /Declared artifact: \S+/.exec(doc);
    expect(turnMatch, 'dispatch.md names no example "Turn budget:" line').not.toBeNull();
    expect(
      artifactMatch,
      'dispatch.md names no example "Declared artifact:" line',
    ).not.toBeNull();
    expect(parseStatedTurns(turnMatch?.[0] as string)).not.toBeNull();
    expect(parseDeclaredArtifactLine(artifactMatch?.[0] as string)).not.toBeNull();
  });
});
