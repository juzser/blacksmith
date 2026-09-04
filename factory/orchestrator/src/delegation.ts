// factory/policies/delegation.yml loader and the two audits it feeds
// (`smith delegation check`, D13 step 3).
//
// Every check in this factory that asks "did two different turns happen?"
// answers it the same way: by finding two `dispatch_decision` events. That
// reading holds only while dispatches are written by a node that owns the log
// it writes into -- otherwise an agent can write a dispatch about itself, and
// `smith tester check` reports a tester's turn that was really the coder's.
//
// Granting `Agent` to a role does not break the reading; it makes it
// conditional, on two things this module checks:
//
//   1. The grant itself must not hand a role its own auditor, its own critic,
//      or itself. Those are the shapes where the graded party gets to choose
//      and prompt its grader -- a D-119 hole: the gate stays green because it
//      is now reading evidence the graded party produced.
//   2. The grantee must open its own session before it dispatches. A wave that
//      writes into the epic's log under its own actor name is one log with two
//      writers, and the epic's causal chain stops being a chain.
//
// Deliberate non-rule: a dispatch written under an agent-role actor in an
// ordinary session raises nothing here. actors.ts documents that agent roles
// legitimately author decision-shaped events, and a rule that fired on every
// such dispatch would report years of honest history as a finding. This module
// is scoped to granted roles and to the sessions a grant actually opened.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  DISPATCH_EVENT_TYPE,
  ERROR_EVENT_TYPE,
  TASK_RESULT_EVENT_TYPE,
} from './agents-registry.js';
import type { AsymmetricRolePair, RoleIsolationPair } from './crosscheck.js';
import { SmithError } from './errors.js';
import { ROOT_EVENT_TYPE, type StoredEvent } from './events.js';
import { AGENTS_DIR, DELEGATION_POLICY_PATH } from './paths.js';
import { taskIdsMatch } from './taskId.js';

export class DelegationError extends SmithError {}

/** One role's right to dispatch, as delegation.yml declares it. */
export interface DelegationGrant {
  role: string;
  mayDispatch: string[];
  /** True unless the file says otherwise -- see parseDelegationPolicy(). */
  mustOpenSession: boolean;
}

export interface DelegationPolicy {
  version: number;
  grants: DelegationGrant[];
}

export type DelegationStatus = 'ok' | 'violation' | 'unverifiable' | 'not-applicable';

interface RawGrant {
  may_dispatch?: unknown;
  must_open_session?: unknown;
}

interface RawDelegationYaml {
  version?: unknown;
  grants?: unknown;
}

function invalid(message: string, details: Record<string, unknown> = {}): DelegationError {
  return new DelegationError('delegation.invalid-policy', message, details);
}

/**
 * Parses delegation.yml.
 *
 * `must_open_session` defaults to **true** rather than false. A grant that
 * forgets the field is a grant somebody wrote in a hurry, and of the two
 * readings only one of them can be caught later: a grantee wrongly required to
 * open a session fails a check loudly, while a grantee wrongly excused from it
 * writes into someone else's log and nothing notices.
 */
export function parseDelegationPolicy(yamlText: string): DelegationPolicy {
  const doc = (parseYaml(yamlText) ?? {}) as RawDelegationYaml;
  if (typeof doc.version !== 'number') {
    throw invalid('delegation.yml has no numeric `version`.');
  }
  const rawGrants = doc.grants;
  if (rawGrants !== undefined && rawGrants !== null && typeof rawGrants !== 'object') {
    throw invalid('delegation.yml `grants` must be a map of role to grant.');
  }
  const grants: DelegationGrant[] = [];
  for (const [role, value] of Object.entries(
    (rawGrants ?? {}) as Record<string, RawGrant | null>,
  )) {
    const grant = value ?? {};
    const list = grant.may_dispatch;
    if (!Array.isArray(list) || list.length === 0 || !list.every((v) => typeof v === 'string')) {
      throw invalid(
        `delegation.yml grant \`${role}\` must list at least one role in \`may_dispatch\`. A grant that dispatches nothing is a grant nobody can use and everybody has to reason about.`,
        { role },
      );
    }
    const mustOpen = grant.must_open_session;
    if (mustOpen !== undefined && typeof mustOpen !== 'boolean') {
      throw invalid(`delegation.yml grant \`${role}\` has a non-boolean \`must_open_session\`.`, {
        role,
      });
    }
    grants.push({
      role,
      mayDispatch: list as string[],
      mustOpenSession: mustOpen ?? true,
    });
  }
  return { version: doc.version, grants };
}

export function loadDelegationPolicy(filePath: string = DELEGATION_POLICY_PATH): DelegationPolicy {
  return parseDelegationPolicy(readFileSync(filePath, 'utf8'));
}

// ---------------------------------------------------------------------------
// The static half: the grant against the taxonomy, the topology, the templates
// ---------------------------------------------------------------------------

export interface DelegationGrantCheck {
  /** The granted role, or `*` for a finding about a template holding no grant. */
  role: string;
  status: DelegationStatus;
  detail: string;
}

export interface DelegationGrantsReport {
  grantsExamined: number;
  templatesExamined: number;
  checks: DelegationGrantCheck[];
  /** False on any violation -- there is no "unverifiable" here, the files are all readable. */
  ok: boolean;
}

export interface DelegationGrantsOptions {
  /** The taxonomy `agent` dimension: the closed set a grant may name. */
  agentRoles: string[];
  /** crosscheck.yml `role_isolation.pairs`. */
  isolationPairs: RoleIsolationPair[];
  /** crosscheck.yml `asymmetric_roles.pairs`. */
  asymmetricPairs: AsymmetricRolePair[];
  /** Defaults to the shipped `.claude/agents/`. */
  agentsDir?: string;
}

/**
 * The Agent tool named as a whole word, so that `AgentOutput` is not a grant.
 * Matched against the raw `tools:` line rather than its comma-split entries,
 * because a scoped grant contains commas of its own.
 */
const AGENT_TOOL = /\bAgent\b/;

/** The roles a scoped grant names, e.g. `Agent(coder, tester)`. */
const AGENT_SCOPE = /\bAgent\s*\(([^)]*)\)/;

/** The raw `tools:` line of a role template's frontmatter. Null when there is no template. */
function templateTools(dir: string, role: string): string | null {
  const file = path.join(dir, `${role}.md`);
  if (!existsSync(file)) return null;
  return toolsOf(readFileSync(file, 'utf8'));
}

function toolsOf(markdown: string): string {
  const line = markdown.split('\n').find((l) => l.startsWith('tools:'));
  return line === undefined ? '' : line.slice('tools:'.length);
}

function holdsAgent(tools: string): boolean {
  return AGENT_TOOL.test(tools);
}

function agentScope(tools: string): string[] | null {
  const match = AGENT_SCOPE.exec(tools);
  if (match === null) return null;
  return (match[1] ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

/**
 * Reads the policy against every file that has to agree with it.
 *
 * This is the half that runs in CI rather than against a log: the shipped
 * policy is checked by delegation.test.ts, so widening a grant into a shape
 * the audits cannot see fails the build rather than a run.
 */
export function checkDelegationGrants(
  policy: DelegationPolicy,
  options: DelegationGrantsOptions,
): DelegationGrantsReport {
  const dir = options.agentsDir ?? AGENTS_DIR;
  const roles = new Set(options.agentRoles);
  const checks: DelegationGrantCheck[] = [];

  for (const grant of policy.grants) {
    const problems: string[] = [];
    if (!roles.has(grant.role)) {
      problems.push(
        `\`${grant.role}\` is not a taxonomy \`agent\` value, so no dispatch can ever name it and the grant is unreachable.`,
      );
    }
    for (const target of grant.mayDispatch) {
      if (!roles.has(target)) {
        problems.push(
          `\`${grant.role}\` may dispatch \`${target}\`, which is not a taxonomy \`agent\` value, so that dispatch would be rejected at write time.`,
        );
      }
    }
    if (grant.mayDispatch.includes(grant.role)) {
      problems.push(
        `\`${grant.role}\` may dispatch itself. A role that dispatches itself writes \`dispatch_decision\` events about itself, and every check that reads a second dispatch as a second turn starts counting one turn twice.`,
      );
    }
    for (const pair of options.isolationPairs) {
      if (pair.worker === grant.role && grant.mayDispatch.includes(pair.auditor)) {
        problems.push(
          `\`${grant.role}\` may dispatch \`${pair.auditor}\`, its own auditor under crosscheck.yml \`role_isolation\`. The worker would choose and prompt its grader, and \`smith tester check\` would report the isolation it was reading evidence for.`,
        );
      }
    }
    for (const pair of options.asymmetricPairs) {
      if (pair.finder === grant.role && grant.mayDispatch.includes(pair.critic)) {
        problems.push(
          `\`${grant.role}\` may dispatch \`${pair.critic}\`, its own critic under crosscheck.yml \`asymmetric_roles\`. The finder would pick the model meant to refute it, which is the tunnel vision the pair exists to break.`,
        );
      }
    }
    const tools = templateTools(dir, grant.role);
    if (tools === null) {
      problems.push(
        `\`${grant.role}\` holds a grant but ships no template at ${path.join(path.basename(dir), `${grant.role}.md`)}, so the grant reaches no agent (D-191).`,
      );
    } else if (!holdsAgent(tools)) {
      problems.push(
        `${grant.role}.md does not list \`Agent\` in \`tools\`, so the grant reaches no agent (D-191).`,
      );
    } else {
      // A scoped grant is enforced by the harness at dispatch time and this
      // policy is enforced after the fact, so the two disagreeing is the worst
      // of both: the file an operator reads is not the file that binds.
      const scope = agentScope(tools);
      if (scope !== null) {
        const declared = [...grant.mayDispatch].sort().join(', ');
        const scoped = [...scope].sort().join(', ');
        if (declared !== scoped) {
          problems.push(
            `${grant.role}.md scopes \`Agent\` to (${scoped}) while delegation.yml grants (${declared}). The template is what the harness enforces and the policy is what the audits read, so a disagreement is a rule nobody applies.`,
          );
        }
      }
    }

    if (problems.length === 0) {
      checks.push({
        role: grant.role,
        status: 'ok',
        detail: `${grant.role} may dispatch ${grant.mayDispatch.join(', ')}${grant.mustOpenSession ? ' and must open its own session first' : ''}; its template holds \`Agent\` and the grant contradicts no crosscheck.yml pair.`,
      });
    } else {
      for (const detail of problems) checks.push({ role: grant.role, status: 'violation', detail });
    }
  }

  // The converse of D-191, and the one that actually widens the topology: a
  // template may hand itself `Agent` without any grant naming it, and nothing
  // else in the repo reads the frontmatter closely enough to notice.
  const templates = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
  const granted = new Set(policy.grants.map((g) => g.role));
  let ungrantedHolders = 0;
  for (const file of templates) {
    const role = path.basename(file, '.md');
    if (granted.has(role)) continue;
    if (!holdsAgent(toolsOf(readFileSync(path.join(dir, file), 'utf8')))) continue;
    ungrantedHolders += 1;
    checks.push({
      role,
      status: 'violation',
      detail: `${file} lists \`Agent\` in \`tools\` but delegation.yml holds no grant for \`${role}\`, so it may dispatch anything and no check knows what to hold it to.`,
    });
  }

  if (policy.grants.length === 0 && ungrantedHolders === 0) {
    checks.push({
      role: '*',
      status: 'not-applicable',
      detail:
        'delegation.yml grants nobody `Agent` and no role template lists it, so dispatch is flat: one session dispatches, one log, one causal chain.',
    });
  }

  return {
    grantsExamined: policy.grants.length,
    templatesExamined: templates.length,
    checks,
    ok: checks.every((c) => c.status === 'ok' || c.status === 'not-applicable'),
  };
}

// ---------------------------------------------------------------------------
// The log half: what the grantees actually did
// ---------------------------------------------------------------------------

export interface DelegationLogCheck {
  role: string;
  sessionId: string | null;
  taskId: string | null;
  eventId: string | null;
  status: DelegationStatus;
  detail: string;
}

export interface DelegationLogReport {
  sessionId: string;
  taskId: string | null;
  dispatchesExamined: number;
  /** Sessions a granted dispatch actually opened, by the `causal_parent` edge. */
  delegatedSessions: number;
  checks: DelegationLogCheck[];
  /** False on any violation OR any unverifiable -- an open grant is not a clean one. */
  ok: boolean;
}

export interface DelegationLogOptions {
  sessionId: string;
  taskId?: string;
}

interface DispatchRow {
  eventId: string;
  sessionId: string;
  ts: string;
  actor: string;
  role: string;
  taskId: string | null;
}

interface TerminalRow {
  sessionId: string;
  ts: string;
  role: string;
  taskId: string | null;
}

/**
 * How a dispatched turn is recorded as over, and which payload field names the
 * role that ended it -- testerAudit.ts's table, for its reason. The fallback to
 * `actor` is that file's too: the older half of the log names the role there
 * and nowhere else, and without it a finished wave-runner reads as one still
 * running, which is the difference between `violation` and `unverifiable`.
 */
const TERMINAL_ROLE_KEY: Record<string, string> = {
  [TASK_RESULT_EVENT_TYPE]: 'agent',
  [ERROR_EVENT_TYPE]: 'agent',
};

function str(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readDispatches(events: readonly StoredEvent[]): DispatchRow[] {
  const rows: DispatchRow[] = [];
  for (const { event_id, record } of events) {
    if (record.event_type !== DISPATCH_EVENT_TYPE) continue;
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const role = str(payload, 'agent_role');
    if (role === null) continue;
    rows.push({
      eventId: event_id,
      sessionId: record.session_id,
      ts: record.ts,
      actor: record.actor,
      role,
      taskId: record.task_id ?? str(payload, 'task_id'),
    });
  }
  return rows;
}

function readTerminals(events: readonly StoredEvent[]): TerminalRow[] {
  const rows: TerminalRow[] = [];
  for (const { record } of events) {
    const key = TERMINAL_ROLE_KEY[record.event_type];
    if (key === undefined) continue;
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const role = str(payload, key) ?? record.actor;
    if (role === null || role.length === 0) continue;
    rows.push({
      sessionId: record.session_id,
      ts: record.ts,
      role,
      taskId: record.task_id ?? str(payload, 'task_id'),
    });
  }
  return rows;
}

/** The session a dispatch opened, keyed by the dispatch's event id. */
function sessionsOpenedByDispatch(events: readonly StoredEvent[]): Map<string, string> {
  const opened = new Map<string, string>();
  for (const { record } of events) {
    if (record.event_type !== ROOT_EVENT_TYPE) continue;
    if (record.causal_parent === null || record.causal_parent === undefined) continue;
    opened.set(record.causal_parent, record.session_id);
  }
  return opened;
}

/**
 * Asserts delegation.yml against a lineage's log.
 *
 * D-181: scope is `taskIdsMatch`'s question, not `===`'s -- the log writes
 * `E1/t-1` and an operator types `t-1`.
 */
export function checkDelegationLog(
  events: readonly StoredEvent[],
  policy: DelegationPolicy,
  options: DelegationLogOptions,
): DelegationLogReport {
  const taskId = options.taskId ?? null;
  const base = {
    sessionId: options.sessionId,
    taskId,
  };
  const byRole = new Map(policy.grants.map((g) => [g.role, g]));

  if (byRole.size === 0) {
    return {
      ...base,
      dispatchesExamined: 0,
      delegatedSessions: 0,
      checks: [
        {
          role: '*',
          sessionId: null,
          taskId: null,
          eventId: null,
          status: 'not-applicable',
          detail:
            'delegation.yml grants nobody `Agent`, so every dispatch in this lineage was written by a session that owns its own log and there is nothing here to violate.',
        },
      ],
      ok: true,
    };
  }

  const inScope = (rowTask: string | null): boolean =>
    taskId === null || (rowTask !== null && taskIdsMatch(rowTask, taskId));

  const dispatches = readDispatches(events).filter((d) => inScope(d.taskId));
  const terminals = readTerminals(events);
  const opened = sessionsOpenedByDispatch(events);
  const checks: DelegationLogCheck[] = [];

  // Which sessions a grant opened, and for whom. Built before the per-dispatch
  // rules so rule 3 can ask "whose session is this?" of any dispatch.
  const delegated = new Map<string, DispatchRow>();
  for (const d of dispatches) {
    if (!byRole.has(d.role)) continue;
    const child = opened.get(d.eventId);
    if (child !== undefined) delegated.set(child, d);
  }

  for (const d of dispatches) {
    // Rule 1 -- a granted role dispatches only inside its grant.
    const actorGrant = byRole.get(d.actor);
    if (actorGrant !== undefined && !actorGrant.mayDispatch.includes(d.role)) {
      checks.push({
        role: d.actor,
        sessionId: d.sessionId,
        taskId: d.taskId,
        eventId: d.eventId,
        status: 'violation',
        detail: `${d.actor} dispatched \`${d.role}\` at ${d.eventId}, which its delegation.yml grant does not list (${actorGrant.mayDispatch.join(', ')}).`,
      });
    }

    // Rule 2 -- a grantee that must open a log did.
    const grant = byRole.get(d.role);
    if (grant === undefined || !grant.mustOpenSession) continue;
    const child = opened.get(d.eventId);
    if (child !== undefined) {
      checks.push({
        role: d.role,
        sessionId: child,
        taskId: d.taskId,
        eventId: d.eventId,
        status: 'ok',
        detail: `${d.role} was dispatched at ${d.eventId} and opened session ${child} against it, so the dispatches it writes are its own log's.`,
      });
      continue;
    }
    const finished = terminals.some(
      (t) =>
        t.sessionId === d.sessionId &&
        t.role === d.role &&
        t.ts >= d.ts &&
        (t.taskId === null || d.taskId === null || taskIdsMatch(t.taskId, d.taskId)),
    );
    checks.push({
      role: d.role,
      sessionId: d.sessionId,
      taskId: d.taskId,
      eventId: d.eventId,
      status: finished ? 'violation' : 'unverifiable',
      detail: finished
        ? `${d.role} was dispatched at ${d.eventId}, opened no session against it, and has already reported, so whatever it dispatched was written into ${d.sessionId}'s log by something that does not own it.`
        : `${d.role} was dispatched at ${d.eventId} and has opened no session against it yet. It may still do so, which is exactly why this is not a pass.`,
    });
  }

  // Rule 3 -- inside a delegated session, the grantee is the only dispatcher.
  // Without this, the grant is enforced against an actor string the delegated
  // agent picks for itself.
  for (const d of dispatches) {
    const owner = delegated.get(d.sessionId);
    if (owner === undefined || d.actor === owner.role) continue;
    checks.push({
      role: owner.role,
      sessionId: d.sessionId,
      taskId: d.taskId,
      eventId: d.eventId,
      status: 'violation',
      detail: `${d.sessionId} is ${owner.role}'s delegated session (opened against ${owner.eventId}), but the dispatch at ${d.eventId} is written by \`${d.actor}\`. One dispatching node, one log: a second writer in here is a second author of the same causal chain.`,
    });
  }

  if (checks.length === 0) {
    checks.push({
      role: '*',
      sessionId: null,
      taskId: null,
      eventId: null,
      status: 'not-applicable',
      detail: `No dispatch in this lineage names or is written by a role delegation.yml grants (${[...byRole.keys()].join(', ')}), so this audit asserts nothing about it.`,
    });
  }

  return {
    ...base,
    dispatchesExamined: dispatches.length,
    delegatedSessions: delegated.size,
    checks,
    ok: checks.every((c) => c.status === 'ok' || c.status === 'not-applicable'),
  };
}
