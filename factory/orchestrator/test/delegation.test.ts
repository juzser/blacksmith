import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AsymmetricRolePair, RoleIsolationPair } from '../src/crosscheck.js';
import { loadCrosscheckPolicy } from '../src/crosscheck.js';
import {
  checkDelegationGrants,
  checkDelegationLog,
  type DelegationError,
  type DelegationPolicy,
  loadDelegationPolicy,
  parseDelegationPolicy,
} from '../src/delegation.js';
import type { StoredEvent } from '../src/events.js';
import { loadTaxonomy } from '../src/taxonomy.js';

// ---------------------------------------------------------------------------
// D13 step 3. Until now no role template was granted `Agent`, and three checks
// leaned on that: `tester check` and `dispatch check` both read a separate
// `dispatch_decision` as proof of a separate turn, which only holds while the
// orchestrator is the sole writer of dispatches.
//
// Granting `Agent` to a role does not break that reading -- it makes it
// conditional. A grantee that opens its own session is a dispatching node that
// owns its own log, so its dispatches are still one-per-agent and still not
// written by the agent about itself. A grantee that does NOT open a session is
// exactly the hole, so the log half of this module hunts for it.
//
// The static half hunts for the other shape of the same hole: a grant that
// hands a worker its own auditor, or a finder its own critic, would let the
// graded party choose and prompt its grader while `tester check` stays green.
// ---------------------------------------------------------------------------

const ISOLATION: RoleIsolationPair[] = [{ worker: 'coder', auditor: 'tester' }];
const ASYMMETRIC: AsymmetricRolePair[] = [
  { finder: 'planner', critic: 'spec-reviewer' },
  { finder: 'reviewer', critic: 'verifier' },
];
const ROLES = [
  'planner',
  'spec-reviewer',
  'researcher',
  'coder',
  'tester',
  'grader',
  'reviewer',
  'verifier',
  'security-reviewer',
  'merger',
  'scribe',
  'uiux',
  'wave-runner',
];

let agentsDir: string;

beforeEach(() => {
  agentsDir = mkdtempSync(path.join(tmpdir(), 'smith-delegation-agents-'));
});

afterEach(() => {
  rmSync(agentsDir, { recursive: true, force: true });
});

/** Writes a role template whose frontmatter grants exactly `tools`. */
function template(role: string, tools: string): void {
  writeFileSync(
    path.join(agentsDir, `${role}.md`),
    [
      '---',
      `name: ${role}`,
      'description: t',
      'model: sonnet',
      `tools: ${tools}`,
      '---',
      '',
      '# T',
      '',
    ].join('\n'),
    'utf8',
  );
}

/** The code, not the message: the code is the part an operator can act on. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as DelegationError).code;
  }
  throw new Error('expected a throw, got a value');
}

function policyOf(grants: DelegationPolicy['grants']): DelegationPolicy {
  return { version: 1, grants };
}

function grants(policy: DelegationPolicy) {
  return checkDelegationGrants(policy, {
    agentRoles: ROLES,
    isolationPairs: ISOLATION,
    asymmetricPairs: ASYMMETRIC,
    agentsDir,
  });
}

function details(report: { checks: { detail: string }[] }): string {
  return report.checks.map((c) => c.detail).join(' | ');
}

// ---------------------------------------------------------------------------
// A. The policy file
// ---------------------------------------------------------------------------

describe('parseDelegationPolicy', () => {
  it('reads a grant, its dispatch list, and its session rule', () => {
    const policy = parseDelegationPolicy(
      [
        'version: 1',
        'grants:',
        '  wave-runner:',
        '    may_dispatch: [coder, tester]',
        '    must_open_session: true',
      ].join('\n'),
    );
    expect(policy.version).toBe(1);
    expect(policy.grants).toEqual([
      { role: 'wave-runner', mayDispatch: ['coder', 'tester'], mustOpenSession: true },
    ]);
  });

  it('defaults must_open_session to true, because the lax reading is the hole', () => {
    const policy = parseDelegationPolicy(
      ['version: 1', 'grants:', '  wave-runner:', '    may_dispatch: [coder]'].join('\n'),
    );
    expect(policy.grants[0]?.mustOpenSession).toBe(true);
  });

  it('accepts an empty grants map -- "nobody holds Agent" is a configuration', () => {
    const policy = parseDelegationPolicy(['version: 1', 'grants: {}'].join('\n'));
    expect(policy.grants).toEqual([]);
  });

  it('rejects a policy with no version', () => {
    expect(codeOf(() => parseDelegationPolicy('grants: {}'))).toBe('delegation.invalid-policy');
  });

  it('rejects a grant that dispatches nothing', () => {
    expect(
      codeOf(() =>
        parseDelegationPolicy(
          ['version: 1', 'grants:', '  wave-runner:', '    may_dispatch: []'].join('\n'),
        ),
      ),
    ).toBe('delegation.invalid-policy');
  });
});

// ---------------------------------------------------------------------------
// B. The static half -- policy against taxonomy, crosscheck topology, templates
// ---------------------------------------------------------------------------

describe('checkDelegationGrants', () => {
  it('passes a grant that names real roles and matches its template', () => {
    template('wave-runner', 'Read, Bash, Agent');
    const report = grants(
      policyOf([{ role: 'wave-runner', mayDispatch: ['coder'], mustOpenSession: true }]),
    );
    expect(report.ok, details(report)).toBe(true);
    expect(report.grantsExamined).toBe(1);
  });

  it('reads a scoped grant as a grant', () => {
    template('wave-runner', 'Read, Agent(coder, tester)');
    const report = grants(
      policyOf([{ role: 'wave-runner', mayDispatch: ['coder', 'tester'], mustOpenSession: true }]),
    );
    expect(report.ok, details(report)).toBe(true);
  });

  it('rejects a scoped grant whose scope disagrees with delegation.yml', () => {
    template('wave-runner', 'Read, Agent(coder)');
    const report = grants(
      policyOf([{ role: 'wave-runner', mayDispatch: ['coder', 'tester'], mustOpenSession: true }]),
    );
    expect(report.ok).toBe(false);
    expect(details(report)).toMatch(/scopes `Agent` to \(coder\) while delegation\.yml grants/);
  });

  it('does not read a tool that merely starts with Agent as a grant', () => {
    template('wave-runner', 'Read, AgentOutput');
    const report = grants(
      policyOf([{ role: 'wave-runner', mayDispatch: ['coder'], mustOpenSession: true }]),
    );
    expect(report.ok).toBe(false);
    expect(details(report)).toMatch(/does not list `Agent`/);
  });

  it('rejects a grantee that is not a taxonomy agent', () => {
    template('nobody', 'Read, Agent');
    const report = grants(
      policyOf([{ role: 'nobody', mayDispatch: ['coder'], mustOpenSession: true }]),
    );
    expect(report.ok).toBe(false);
    expect(details(report)).toMatch(/not a taxonomy `agent` value/);
  });

  it('rejects a dispatch target that is not a taxonomy agent', () => {
    template('wave-runner', 'Read, Agent');
    const report = grants(
      policyOf([{ role: 'wave-runner', mayDispatch: ['ghost'], mustOpenSession: true }]),
    );
    expect(report.ok).toBe(false);
    expect(details(report)).toMatch(/ghost/);
  });

  it('rejects a role granted the right to dispatch itself', () => {
    template('wave-runner', 'Read, Agent');
    const report = grants(
      policyOf([
        { role: 'wave-runner', mayDispatch: ['coder', 'wave-runner'], mustOpenSession: true },
      ]),
    );
    expect(report.ok).toBe(false);
    expect(details(report)).toMatch(/dispatch itself/);
  });

  it('rejects a worker granted its own auditor', () => {
    template('coder', 'Read, Agent');
    const report = grants(
      policyOf([{ role: 'coder', mayDispatch: ['tester'], mustOpenSession: true }]),
    );
    expect(report.ok).toBe(false);
    expect(details(report)).toMatch(/role_isolation/);
  });

  it('rejects a finder granted its own critic', () => {
    template('planner', 'Read, Agent');
    const report = grants(
      policyOf([{ role: 'planner', mayDispatch: ['spec-reviewer'], mustOpenSession: true }]),
    );
    expect(report.ok).toBe(false);
    expect(details(report)).toMatch(/asymmetric_roles/);
  });

  it('rejects a grant whose role ships no template', () => {
    const report = grants(
      policyOf([{ role: 'wave-runner', mayDispatch: ['coder'], mustOpenSession: true }]),
    );
    expect(report.ok).toBe(false);
    expect(details(report)).toMatch(/no template/);
  });

  it('rejects a template that holds Agent with no grant behind it', () => {
    template('coder', 'Read, Agent');
    const report = grants(policyOf([]));
    expect(report.ok).toBe(false);
    expect(details(report)).toMatch(/coder\.md lists `Agent`/);
  });

  it('answers not-applicable when nobody holds Agent at all', () => {
    template('coder', 'Read, Edit, Bash');
    const report = grants(policyOf([]));
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.status)).toEqual(['not-applicable']);
  });
});

// ---------------------------------------------------------------------------
// C. The shipped repo is its own first test case
// ---------------------------------------------------------------------------

describe('the shipped delegation policy', () => {
  it('agrees with the shipped taxonomy, crosscheck topology, and templates', () => {
    const crosscheck = loadCrosscheckPolicy(undefined, { offline: true });
    const report = checkDelegationGrants(loadDelegationPolicy(), {
      agentRoles: loadTaxonomy().dimensions.agent ?? [],
      isolationPairs: crosscheck.roleIsolation.pairs,
      asymmetricPairs: crosscheck.asymmetricRoles.pairs,
    });
    expect(report.ok, details(report)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. The log half
// ---------------------------------------------------------------------------

const WAVE_POLICY = policyOf([
  { role: 'wave-runner', mayDispatch: ['coder', 'tester'], mustOpenSession: true },
]);

let clock = 0;

function at(): string {
  clock += 1;
  return `2026-09-03T10:${String(clock).padStart(2, '0')}:00.000Z`;
}

function event(
  sessionId: string,
  index: number,
  eventType: string,
  opts: {
    actor?: string;
    taskId?: string | null;
    parent?: string | null;
    payload?: Record<string, unknown>;
  } = {},
): StoredEvent {
  return {
    event_id: `${sessionId}#${index}`,
    record: {
      session_id: sessionId,
      actor: opts.actor ?? 'system',
      event_type: eventType,
      ...(opts.taskId === undefined || opts.taskId === null ? {} : { task_id: opts.taskId }),
      plan_version: 1,
      causal_parent: opts.parent ?? null,
      ts: at(),
      payload: opts.payload ?? {},
    },
  };
}

function dispatch(
  sessionId: string,
  index: number,
  role: string,
  opts: { actor?: string; taskId?: string } = {},
): StoredEvent {
  return event(sessionId, index, 'dispatch_decision', {
    ...opts,
    taskId: opts.taskId ?? 'E1/t-1',
    parent: `${sessionId}#0`,
    payload: {
      agent_role: role,
      provider: 'claude',
      model_tier: 'frontier',
      model: 'claude-opus-5',
    },
  });
}

function terminal(sessionId: string, index: number, role: string, taskId = 'E1/t-1'): StoredEvent {
  return event(sessionId, index, 'task-result-recorded', {
    taskId,
    parent: `${sessionId}#0`,
    payload: { agent: role, status: 'done' },
  });
}

function log(events: StoredEvent[], taskId?: string) {
  return checkDelegationLog(events, WAVE_POLICY, {
    sessionId: 'epic-1',
    ...(taskId === undefined ? {} : { taskId }),
  });
}

describe('checkDelegationLog', () => {
  beforeEach(() => {
    clock = 0;
  });

  it('asserts nothing when no role holds Agent', () => {
    const events = [
      event('epic-1', 0, 'session-start'),
      dispatch('epic-1', 1, 'coder'),
      terminal('epic-1', 2, 'coder'),
    ];
    const report = checkDelegationLog(events, policyOf([]), { sessionId: 'epic-1' });
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.status)).toEqual(['not-applicable']);
  });

  it('passes a wave-runner that opened its own log and dispatched inside its grant', () => {
    const events = [
      event('epic-1', 0, 'session-start'),
      dispatch('epic-1', 1, 'wave-runner'),
      event('wave-1', 0, 'session-start', { parent: 'epic-1#1' }),
      dispatch('wave-1', 1, 'coder', { actor: 'wave-runner' }),
      terminal('wave-1', 2, 'coder'),
      terminal('epic-1', 2, 'wave-runner'),
    ];
    const report = log(events);
    expect(report.ok, details(report)).toBe(true);
    expect(report.delegatedSessions).toBe(1);
  });

  it('catches a wave-runner that ran to completion without ever opening a log', () => {
    const events = [
      event('epic-1', 0, 'session-start'),
      dispatch('epic-1', 1, 'wave-runner'),
      terminal('epic-1', 2, 'wave-runner'),
    ];
    const report = log(events);
    expect(report.ok).toBe(false);
    expect(details(report)).toMatch(/opened no session/);
    expect(report.checks.some((c) => c.status === 'violation')).toBe(true);
  });

  it('reports a still-open wave-runner as unverifiable, and fails on it', () => {
    const events = [event('epic-1', 0, 'session-start'), dispatch('epic-1', 1, 'wave-runner')];
    const report = log(events);
    expect(report.ok).toBe(false);
    expect(report.checks.map((c) => c.status)).toContain('unverifiable');
  });

  it('catches a granted actor dispatching outside its grant', () => {
    const events = [
      event('epic-1', 0, 'session-start'),
      dispatch('epic-1', 1, 'wave-runner'),
      event('wave-1', 0, 'session-start', { parent: 'epic-1#1' }),
      dispatch('wave-1', 1, 'merger', { actor: 'wave-runner' }),
      terminal('wave-1', 2, 'merger'),
      terminal('epic-1', 2, 'wave-runner'),
    ];
    const report = log(events);
    expect(report.ok).toBe(false);
    expect(details(report)).toMatch(/merger/);
  });

  it('catches a dispatch inside a delegated session written under some other actor', () => {
    const events = [
      event('epic-1', 0, 'session-start'),
      dispatch('epic-1', 1, 'wave-runner'),
      event('wave-1', 0, 'session-start', { parent: 'epic-1#1' }),
      dispatch('wave-1', 1, 'coder', { actor: 'operator' }),
      terminal('wave-1', 2, 'coder'),
      terminal('epic-1', 2, 'wave-runner'),
    ];
    const report = log(events);
    expect(report.ok).toBe(false);
    expect(details(report)).toMatch(/wave-1#1/);
  });

  it('leaves an ordinary session alone when an agent-role actor writes a dispatch', () => {
    // actors.ts documents that agent roles legitimately author decision-shaped
    // events, so a coder-authored dispatch in a session nobody delegated is
    // history, not a finding. Only granted roles and delegated sessions are
    // this module's business.
    const events = [
      event('epic-1', 0, 'session-start'),
      dispatch('epic-1', 1, 'tester', { actor: 'coder' }),
      terminal('epic-1', 2, 'tester'),
    ];
    const report = log(events);
    expect(report.ok, details(report)).toBe(true);
  });

  it('narrows to one task when asked', () => {
    const events = [
      event('epic-1', 0, 'session-start'),
      dispatch('epic-1', 1, 'wave-runner', { taskId: 'E1/t-1' }),
      event('wave-1', 0, 'session-start', { parent: 'epic-1#1' }),
      dispatch('wave-1', 1, 'coder', { actor: 'wave-runner' }),
      terminal('wave-1', 2, 'coder'),
      terminal('epic-1', 2, 'wave-runner', 'E1/t-1'),
      dispatch('epic-1', 3, 'wave-runner', { taskId: 'E1/t-2' }),
      terminal('epic-1', 4, 'wave-runner', 'E1/t-2'),
    ];
    expect(log(events).ok).toBe(false);
    const narrowed = log(events, 'E1/t-1');
    expect(narrowed.ok, details(narrowed)).toBe(true);
  });
});
