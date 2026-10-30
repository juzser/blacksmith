import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { templateFileFor } from '../src/agentNames.js';
import { readTemplateMaxTurns } from '../src/agentsSync.js';
import { composeBrief } from '../src/briefCompose.js';
// TDD red step, observed and recorded verbatim before this module existed:
//   Error: Cannot find module '.../factory/orchestrator/src/dispatchLint.js'
//   imported from '.../factory/orchestrator/test/dispatchLint.test.ts'
// Everything below is the green step, against the module written to satisfy it.
import {
  GATE_CHECKS_HEADING,
  JUDGE_ROLES,
  lintDispatchPrompt,
  parseDeclaredArtifactLine,
  parseStatedTurns,
  shellQuote,
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
  await writeFile(path.join(agentsDir, templateFileFor('planner')), template('planner', 20));
  await writeFile(path.join(agentsDir, templateFileFor('coder')), template('coder', 40));
  await writeFile(path.join(agentsDir, templateFileFor('reviewer')), template('reviewer', 15));
  await writeFile(path.join(agentsDir, 'bs-no-max-turns.md'), template('no-max-turns', null));
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
      ['reviewer', 'verifier', 'grader', 'spec-reviewer', 'security-reviewer', 'auditor'].sort(),
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

  it('is "under" and exits 1 when the prompt states fewer turns than the template', async () => {
    // Fail closed like every other applicable status but "ok": understating
    // the budget is still a prompt that disagrees with its own template, not
    // a safe direction to let slide (task-5 spec: "Fail closed: any
    // applicable status but `ok` exits non-zero").
    const report = await lintDispatchPrompt({
      prompt: 'Turn budget: 10',
      role: 'planner',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(report.turns).toEqual({ status: 'under', stated: 10, template: 20 });
    expect(report.exitCode).toBe(1);
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

  it('is "unverifiable" and exits 1 for an unknown role', async () => {
    // Fail closed: an unverifiable answer is not a pass, exactly like
    // `dispatch check`, `tester check`, `delegation check`, and `escalation
    // check` all already treat "cannot tell" as a failure, never a maybe.
    const report = await lintDispatchPrompt({
      prompt: 'Turn budget: 40',
      role: 'ghost-role',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(report.turns).toEqual({ status: 'unverifiable', stated: 40, template: null });
    expect(report.exitCode).toBe(1);
  });

  it('is "unverifiable" and exits 1 when the template has no maxTurns line', async () => {
    const report = await lintDispatchPrompt({
      prompt: 'Turn budget: 40',
      role: 'no-max-turns',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(report.turns.status).toBe('unverifiable');
    expect(report.exitCode).toBe(1);
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

    await writeFile(path.join(agentsDir, templateFileFor('planner')), template('planner', 30));

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

  it('is "relative", not "ok", when a relative line equals a relative ledger path', async () => {
    // An old log can hold a relative declared_artifact; recordJudgeDispatch no
    // longer writes one, so the event goes straight to the log.
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'user',
        event_type: 'dispatch_decision',
        task_id: 'epic-1/task-1',
        plan_version: 1,
        causal_parent: `${sessionId}#0`,
        payload: {
          agent_role: 'reviewer',
          provider: 'claude',
          model_tier: 'frontier',
          model: 'claude-opus-5',
          round: 1,
          declared_artifact: 'task-1.reviewer.json',
        },
      },
      eventOpts(),
    );
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
      prompt: [
        'Turn budget: 40',
        'bs results check epic-1/task-1 --as coder --result /w/r.json --agent coder --provider claude --model-tier mid --worktree /w/wt --base main --artifacts-dir /w/a',
        GATE_CHECKS_HEADING,
        '- unit:',
        '    run-the-suite',
      ].join('\n'),
      role: 'coder',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });
    expect(report.artifact).toEqual({
      status: 'not-applicable',
      expected_line: null,
      declared_line: null,
    });
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
    expect(artifactMatch, 'dispatch.md names no example "Declared artifact:" line').not.toBeNull();
    expect(parseStatedTurns(turnMatch?.[0] as string)).not.toBeNull();
    expect(parseDeclaredArtifactLine(artifactMatch?.[0] as string)).not.toBeNull();
  });
});

// Task-8 close-review r2 (f-bs-gate-bounce/integration-fdeb317e): the preflight check.
describe('lintDispatchPrompt preflight check', () => {
  const LINE =
    'bs results check epic-1/task-1 --as coder --result /w/r.json --agent coder --provider claude --model-tier mid --worktree /w/wt --base main --artifacts-dir /w/a';
  const CHECKS = `${GATE_CHECKS_HEADING}\n- unit (heavy):\n    run-the-suite`;
  const lint = (prompt: string, role = 'coder', taskId = 'epic-1/task-1') =>
    lintDispatchPrompt({
      prompt: `Turn budget: ${readTemplateMaxTurns(agentsDir, role)}\n\n${prompt}`,
      role,
      taskId,
      sessionId,
      agentsDir,
      eventOpts: eventOpts(),
    });

  it('is ok with one filled line and a counted check, and exits 0', async () => {
    const report = await lint(`${LINE}\n\n${CHECKS}`);
    expect(report.preflight).toEqual({ status: 'ok', line: LINE, gate_checks: 1 });
    expect(report.exitCode).toBe(0);
  });

  it('accepts a backticked line and the bare spelling of a qualified task id', async () => {
    const report = await lint(`\`${LINE}\`\n\n${CHECKS}`, 'coder', 'task-1');
    expect(report.preflight.status).toBe('ok');
  });

  it('reads a single-quoted path holding a space as one value', async () => {
    const line = LINE.replace('--artifacts-dir /w/a', "--artifacts-dir '/w x/a'");
    const report = await lint(`${line}\n\n${CHECKS}`);
    expect(report.preflight.status).toBe('ok');
  });

  it('does not count a line quoted inside spec JSON or a lesson', async () => {
    const quoted = `  "summary": "${LINE}",\n- lesson: ${LINE}`;
    const report = await lint(`${quoted}\n\n${LINE}\n\n${CHECKS}`);
    expect(report.preflight.status).toBe('ok');
  });

  it.each([
    ['missing', () => CHECKS, 'missing'],
    ['ambiguous', () => `${LINE}\n${LINE}\n\n${CHECKS}`, 'ambiguous'],
    [
      'mismatch (task)',
      () => `${LINE.replace('epic-1/task-1', 'epic-1/task-2')}\n\n${CHECKS}`,
      'mismatch',
    ],
    [
      'mismatch (role)',
      () => `${LINE.replace('--as coder', '--as tester')}\n\n${CHECKS}`,
      'mismatch',
    ],
    [
      'placeholder',
      () => `${LINE.replace('--provider claude', '--provider <name>')}\n\n${CHECKS}`,
      'placeholder',
    ],
    ['no heading', () => LINE, 'no-checks'],
    ['check without a command', () => `${LINE}\n\n${GATE_CHECKS_HEADING}\n- unit:`, 'no-checks'],
    [
      'check with a blank command',
      () => `${LINE}\n\n${GATE_CHECKS_HEADING}\n- unit:\n    `,
      'no-checks',
    ],
  ])('is %s and exits 1', async (_label, build, status) => {
    const report = await lint(build());
    expect(report.preflight.status).toBe(status);
    expect(report.exitCode).toBe(1);
  });

  it('counts only checks with a command', async () => {
    const report = await lint(
      `${LINE}\n\n${GATE_CHECKS_HEADING}\n- a:\n- b:\n    x\n    y\n- c:\n    `,
    );
    expect(report.preflight.gate_checks).toBe(1);
  });

  it('is not-applicable for reviewer and uiux, and a grader needs no gate checks', async () => {
    for (const role of ['reviewer', 'uiux', 'spec-reviewer']) {
      const report = await lint('nothing here', role);
      expect(report.preflight).toEqual({ status: 'not-applicable', line: null, gate_checks: null });
    }
    const grader =
      'bs results check epic-1/task-1 --as grader --grader /w/g.json --artifacts-dir /w/a';
    const report = await lint(grader, 'grader');
    expect(report.preflight).toEqual({ status: 'ok', line: grader, gate_checks: null });
  });

  it('shellQuote writes a plain value bare and quotes the rest, round-tripping through a shell', () => {
    expect(shellQuote('/a/b-c_d.e:f@g%h+i=j,k')).toBe('/a/b-c_d.e:f@g%h+i=j,k');
    for (const value of ["it's", 'a b', '$x', '']) {
      const out = spawnSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], {
        encoding: 'utf8',
      });
      expect(out.stdout).toBe(value);
    }
  });
});

describe('lintDispatchPrompt on composed briefs', () => {
  const realAgents = path.join(REPO_ROOT, '.claude', 'agents');
  const compose = async (summary: string, taskId: string, epicId?: string) => {
    const plan = path.join(stateDir, 'plan.json');
    await writeFile(
      plan,
      JSON.stringify({
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [
          {
            task_id: 'epic-1/task-1',
            epic_id: 'epic-1',
            plan_version: 1,
            title: 't',
            summary,
            claims: ['src/a.ts'],
            task_status: 'todo',
            agent_role: 'coder',
          },
        ],
        edges: [],
      }),
    );
    const { text } = await composeBrief({
      role: 'coder',
      taskId,
      ...(epicId ? { epicId } : {}),
      planFile: plan,
      sessionId,
      worktree: path.join(stateDir, 'wt'),
      specsDir: stateDir,
      events: [],
      now: new Date('2026-10-22T00:00:00.000Z'),
      agentsDir: realAgents,
      eventOpts: { stateDir },
      provider: 'claude',
      modelTier: 'mid',
      base: 'main',
      workRoot: path.join(stateDir, 'work'),
      checks: [{ name: 'unit', cmd: 'run-the-suite' }],
    });
    return text;
  };
  const lint = (prompt: string) =>
    lintDispatchPrompt({
      prompt,
      role: 'coder',
      taskId: 'epic-1/task-1',
      sessionId,
      agentsDir: realAgents,
      eventOpts: eventOpts(),
    });

  it('lints ok for a brief composed with the bare task id and --epic', async () => {
    const report = await lint(await compose('Build it.', 'task-1', 'epic-1'));
    expect(report.preflight.status).toBe('ok');
    expect(report.exitCode).toBe(0);
  });

  it('lints ok when the spec quotes a full bs results check line mid-text', async () => {
    const quoted =
      'Run bs results check epic-1/task-1 --as coder --result r.json --agent coder after.';
    const text = await compose(quoted, 'epic-1/task-1');
    expect(text).toContain(quoted);
    expect((await lint(text)).preflight.status).toBe('ok');
  });
});
