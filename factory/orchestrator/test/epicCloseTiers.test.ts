import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  certificationReasonText,
  closeEpic,
  type DeclaredCheck,
  type DeclaredCheckStatus,
  EPIC_CLOSED_EVENT_TYPE,
  type EpicSummary,
  epicVerdictJudgeRequest,
  type IntegrationStatus,
  runEpicVerdict,
  summarizeEpic,
} from '../src/epic.js';
import { appendEvent, readEvents } from '../src/events.js';
import { type EpicGoalStatus, GOAL_CHECK_EVENT, goalDigest } from '../src/goalCheck.js';
import type { IntegrationCheckRecord } from '../src/integration.js';
import { MCP_SURFACE_NOT_REQUIRED } from '../src/mcp.js';
import { SPEC_REVIEW_EVENT } from '../src/spec.js';

const sessionId = 'sess-tiers';
const epicId = 'epic-1';
const BRANCH = `bs/${epicId}/integration`;
const HEAD = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c';
const OLD = 'aaaaaaaa4b5a69788796a5b4c3d2e1f00f1e2d3c';
const H8 = HEAD.slice(0, 8);
const GOAL_TEXT = 'Ship the epic gate.';
const BUDGET = { timeout_ms: 1000, max_output_bytes: 1000 };

const P: DeclaredCheck = { name: 'P', tier: 'pre-merge', checkSha256: 'sha-P' };
const Q: DeclaredCheck = { name: 'Q', tier: 'post-merge', checkSha256: 'sha-Q' };
const R: DeclaredCheck = { name: 'R', tier: 'pre-release', checkSha256: 'sha-R' };

type Res = Record<string, unknown>;
const pass = (c: DeclaredCheck, extra: Res = {}): Res => ({
  name: c.name,
  pass: true,
  exitCode: 0,
  tail: '',
  cmd: `run ${c.name}`,
  check_sha256: c.checkSha256,
  ...extra,
});
const fail = (c: DeclaredCheck, extra: Res = {}): Res =>
  pass(c, { pass: false, exitCode: 3, ...extra });

describe('epic close and verdict certify every declared check at the head', () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-epic-tiers-'));
    const base = { session_id: sessionId, plan_version: 1, causal_parent: `${sessionId}#0` };
    await appendEvent(
      { ...base, actor: 'user', event_type: 'session-start', causal_parent: null, payload: {} },
      { stateDir },
    );
    const taskId = `${epicId}/task-1`;
    await appendEvent(
      {
        ...base,
        actor: 'gate',
        event_type: 'task-result-recorded',
        task_id: taskId,
        payload: { task_id: taskId, status: 'done' },
      },
      { stateDir },
    );
    await appendEvent(
      {
        ...base,
        actor: 'gate',
        event_type: 'gate-outcome',
        task_id: taskId,
        payload: { outcome: 'pass', reason: null },
      },
      { stateDir },
    );
    await appendEvent(
      {
        ...base,
        actor: 'planner',
        event_type: 'task-added',
        task_id: taskId,
        payload: { epic_id: epicId, task_status: 'completed' },
      },
      { stateDir },
    );
    await appendEvent(
      {
        ...base,
        actor: 'spec-reviewer',
        event_type: SPEC_REVIEW_EVENT,
        task_id: `${epicId}/integration`,
        payload: {
          epic_id: epicId,
          plan_version: 1,
          head_sha: HEAD,
          reviewed_by: 'spec-reviewer',
          finding_ids: [],
          finding_count: 0,
        },
      },
      { stateDir },
    );
    await appendEvent(
      {
        ...base,
        actor: 'spec-reviewer',
        event_type: GOAL_CHECK_EVENT,
        task_id: `${epicId}/integration`,
        payload: {
          epic_id: epicId,
          milestone_id: 'milestone-1',
          plan_version: 1,
          goal_digest: goalDigest(GOAL_TEXT),
          checked_by: 'spec-reviewer',
          coverage: [{ clause: GOAL_TEXT, verdict: 'covered', taskIds: [taskId] }],
          clause_count: 1,
          uncovered_count: 0,
          out_of_scope_count: 0,
          finding_ids: [],
          finding_count: 0,
        },
      },
      { stateDir },
    );
  });
  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  /** Appends an integration-check record and returns its event id. */
  async function record(
    results: unknown,
    payload: Res = {},
    headSha: unknown = HEAD,
  ): Promise<string> {
    const stored = await appendEvent(
      {
        session_id: sessionId,
        actor: 'operator',
        event_type: 'integration-check',
        task_id: `${epicId}/integration`,
        plan_version: 1,
        causal_parent: `${sessionId}#0`,
        payload: {
          epic_id: epicId,
          branch: BRANCH,
          head_sha: headSha,
          pass: true,
          results,
          ...payload,
        },
      },
      { stateDir },
    );
    return stored.event_id;
  }

  const goal = (): EpicGoalStatus => ({
    milestoneId: 'milestone-1',
    goal: GOAL_TEXT,
    clauses: [GOAL_TEXT],
    digest: goalDigest(GOAL_TEXT),
  });
  const ctx = () => ({ sessionId, planVersion: 1, causalParent: `${sessionId}#0` });
  const input = (checks?: readonly DeclaredCheck[], head: string | null = HEAD) => ({
    epicId,
    integrationHeadSha: head,
    integrationBranch: BRANCH,
    mcp: MCP_SURFACE_NOT_REQUIRED,
    goal: goal(),
    effort: { tier: 'huge' as const, closingSpecReview: 'always' as const },
    ...(checks === undefined ? {} : { checks }),
  });
  async function verdict(checks?: readonly DeclaredCheck[], head: string | null = HEAD) {
    const outcome = await runEpicVerdict(input(checks, head), ctx(), { stateDir });
    // An unreadable head also stales the closing spec review; that is not under test.
    const blockers = outcome.summary.blockers.filter((b) => !b.includes('closing spec review'));
    return { outcome, summary: outcome.summary, blockers };
  }
  const notCertified = (c: DeclaredCheck, text: string) =>
    `Check "${c.name}" (${c.tier}) is not certified at ${H8} of ${BRANCH}: ${text}.`;
  const NO_RESULT = 'no non-probe record there has a result for its check_sha256';

  describe('with a declaration', () => {
    it('blocks P and R when only a post-merge record sits at the head, and clears when one names them', async () => {
      await record([pass(P), pass(Q), pass(R)], { tiers: ['all'] }, OLD);
      await record([pass(Q)], { tiers: ['post-merge'], tiers_present: ['post-merge'] });
      const checks = [P, Q, R];

      const held = await verdict(checks);
      expect(held.outcome.outcome).toBe('hold');
      expect(held.blockers).toEqual([notCertified(P, NO_RESULT), notCertified(R, NO_RESULT)]);
      const closed = await closeEpic(
        { ...input(checks), overrideRationale: 'operator accepts' },
        ctx(),
        { stateDir },
      );
      expect(closed.blockers).toEqual(held.blockers);

      await record([pass(P), pass(R)], { tiers: ['pre-merge', 'pre-release'] });
      const cleared = await verdict(checks);
      expect(cleared.blockers).toEqual([]);
      expect(cleared.outcome.outcome).toBe('go');
      const record2 = await closeEpic(input(checks), ctx(), { stateDir });
      expect(record2.closedBy).toBe('verdict');
      expect(record2.blockers).toEqual([]);
    });

    it('names each reason exactly', async () => {
      const edited = { ...P, checkSha256: 'sha-P-new' };
      // changed: a result at the head under the old digest only.
      const a = await record([pass(P)]);
      expect((await verdict([edited])).blockers).toEqual([
        notCertified(
          edited,
          'its results there exist only under another check_sha256 (its name, command, heavy flag or timeout changed since they ran)',
        ),
      ]);
      // no-result: the old digest's only result is at an older head.
      const b = await record([pass(R)], {}, OLD);
      expect((await verdict([R])).blockers).toEqual([notCertified(R, NO_RESULT)]);
      // failed, with the exit code and the record id.
      const c = await record([fail(Q)]);
      expect((await verdict([Q])).blockers).toEqual([
        notCertified(Q, `its last result failed (exit 3, record ${c})`),
      ]);
      // a tier move after the run is no blocker.
      expect((await verdict([{ ...P, tier: 'pre-release' }])).blockers).toEqual([]);
      expect(a).not.toBe(b);
    });

    it('names a heavy.wait-timeout result as not-run', async () => {
      const id = await record([fail(P, { reason: 'heavy.wait-timeout', exitCode: 75 })]);
      expect((await verdict([P])).blockers).toEqual([
        notCertified(P, `its last result did not run (heavy.wait-timeout, record ${id})`),
      ]);
    });

    it('reads a pass then a fail at the head as failed, and a fail then a pass as certified', async () => {
      await record([pass(P)]);
      const failing = await record([fail(P)]);
      expect((await verdict([P])).blockers).toEqual([
        notCertified(P, `its last result failed (exit 3, record ${failing})`),
      ]);
      await record([pass(P)]);
      expect((await verdict([P])).blockers).toEqual([]);
    });

    it('does not certify on a passing probe, or on a record written before this epic', async () => {
      await record([pass(P)], { probe_of: 'all' });
      expect((await verdict([P])).blockers).toEqual([notCertified(P, NO_RESULT)]);
      await record([{ name: 'Q', pass: true, exitCode: 0, tail: '' }]);
      expect((await verdict([Q])).blockers).toEqual([notCertified(Q, NO_RESULT)]);
    });

    it('gives one blocker per uncertified check, in declaration order', async () => {
      await record([pass(Q)]);
      expect((await verdict([R, P, Q])).blockers).toEqual([
        notCertified(R, NO_RESULT),
        notCertified(P, NO_RESULT),
      ]);
      expect((await verdict([R, P, { ...Q, checkSha256: 'x' }])).blockers).toHaveLength(3);
    });

    it('fails closed on an empty declaration even with passing records at the head', async () => {
      await record([pass(P)]);
      expect((await verdict([])).blockers).toEqual([
        `Epic "${epicId}" has an empty checks declaration, so no check can be shown certified at ${BRANCH}.`,
      ]);
    });

    it('fails closed on an unreadable head with one blocker and no per-check blocker', async () => {
      await record([pass(P)]);
      expect((await verdict([P, Q], null)).blockers).toEqual([
        `Could not read the head of ${BRANCH}, so no declared check can be shown certified at it.`,
      ]);
    });

    it('tests the empty declaration before the unreadable head', async () => {
      expect((await verdict([], null)).blockers).toEqual([
        `Epic "${epicId}" has an empty checks declaration, so no check can be shown certified at ${BRANCH}.`,
      ]);
    });

    it('blocks every declared check when the epic has no record at all', async () => {
      expect((await verdict([P, Q])).blockers).toEqual([
        notCertified(P, NO_RESULT),
        notCertified(Q, NO_RESULT),
      ]);
    });

    it('lets a malformed record certify nothing', async () => {
      await record('not-an-array');
      await record([pass(Q)], {}, 12345);
      expect((await verdict([P, Q])).blockers).toEqual([
        notCertified(P, NO_RESULT),
        notCertified(Q, NO_RESULT),
      ]);
    });
  });

  describe('without a declaration', () => {
    const TIERED = (id: string) =>
      `Epic "${epicId}" has integration-check records written under check tiers (latest: ${id}), so its close needs the checks declaration: pass --checks <file> to bs epic close and bs epic verdict.`;

    it('refuses with the tiered blocker where last-wins would pass', async () => {
      await record([pass(P), pass(Q), pass(R)], { tiers: ['all'] }, OLD);
      const id = await record([pass(Q)], { tiers: ['post-merge'], tiers_present: ['post-merge'] });
      expect((await verdict()).blockers).toEqual([TIERED(id)]);
    });

    it('refuses an epic whose only records are probes', async () => {
      await record([pass(P)], { probe_of: 'all' });
      const id = await record([pass(P)], { probe_of: 'all' });
      expect((await verdict()).blockers).toEqual([TIERED(id)]);
    });

    it('refuses records from before this epic beside later probes', async () => {
      await record([{ name: 'lint', pass: true, exitCode: 0, tail: '' }]);
      const id = await record([pass(P)], { probe_of: 'all' }, OLD);
      expect((await verdict()).blockers).toEqual([TIERED(id)]);
    });

    it('refuses a record whose tiers_present is a bare string', async () => {
      const id = await record([pass(P)], { tiers_present: 'post-merge' });
      expect((await verdict()).blockers).toEqual([TIERED(id)]);
    });

    it('prefers the tiered blocker over main stale and unreadable-head strings', async () => {
      const id = await record([pass(P)], { tiers: ['post-merge'] }, OLD);
      expect((await verdict()).blockers).toEqual([TIERED(id)]);
      expect((await verdict(undefined, null)).blockers).toEqual([TIERED(id)]);
    });

    it('keeps main for an epic that never ran', async () => {
      expect((await verdict()).blockers).toEqual([
        `Epic "${epicId}" has no integration-root check on record: no command has ever run against ${BRANCH}. Per-task gates only ever saw a worktree (D-42).`,
      ]);
    });

    it('keeps main for records from before this epic', async () => {
      const legacy = [{ name: 'lint', pass: true, exitCode: 0, tail: '' }];
      await record(legacy);
      expect((await verdict()).blockers).toEqual([]);
      expect((await verdict(undefined, null)).blockers).toEqual([
        `Could not read the head of ${BRANCH}, so the integration-root check recorded at ${H8} cannot be shown to cover it.`,
      ]);
      await record(legacy, {}, OLD);
      expect((await verdict()).blockers).toEqual([
        `The integration-root check for "${epicId}" is stale: it ran against aaaaaaaa, and ${BRANCH} is now at ${H8}. Anything merged since is uncertified.`,
      ]);
    });

    it('keeps main for an unlabelled project whose records carry only pre-merge tiers', async () => {
      await record([pass(P, { pass: false })], {
        pass: false,
        tiers: ['pre-merge'],
        tiers_present: ['pre-merge'],
      });
      expect((await verdict()).blockers).toEqual([
        `The integration-root check for "${epicId}" failed at ${H8}: P.`,
      ]);
    });
  });

  describe('readers', () => {
    it('exports the reason texts and null for a certified check', () => {
      expect(
        certificationReasonText({ certified: true, reason: null, recordId: 'r#1', result: null }),
      ).toBeNull();
      expect(
        certificationReasonText({
          certified: false,
          reason: 'no-result',
          recordId: null,
          result: null,
        }),
      ).toBe(NO_RESULT);
    });

    it('certifies a declaration while the last event is a passing probe at an older head', async () => {
      await record([pass(P, { cmd: 'echo   a\n b' }), pass(Q)]);
      const probe = await record([pass(P)], { probe_of: 'all' }, OLD);
      const outcome = await verdict([P, Q]);
      expect(outcome.blockers).toEqual([]);
      expect(outcome.summary.integration.check?.headSha).toBe(HEAD);
      const closed = await closeEpic(input([P, Q]), ctx(), { stateDir });
      const events = await readEvents(sessionId, { stateDir });
      const payload = events.find((e) => e.record.event_type === EPIC_CLOSED_EVENT_TYPE)?.record
        .payload as { summary: { integration: Record<string, unknown> } };
      const integration = payload.summary.integration as {
        head_sha: string;
        check: { head_sha: string };
        declared: Record<string, unknown>[];
        tiered_record_id?: string;
      };
      expect(integration.check.head_sha).toBe(integration.head_sha);
      expect(integration.tiered_record_id).toBeUndefined();
      expect(integration.declared).toEqual([
        {
          name: 'P',
          tier: 'pre-merge',
          check_sha256: 'sha-P',
          certified: true,
          reason: null,
          record_id: closed.summary.integration.declared?.[0]?.certification?.recordId,
        },
        {
          name: 'Q',
          tier: 'post-merge',
          check_sha256: 'sha-Q',
          certified: true,
          reason: null,
          record_id: closed.summary.integration.declared?.[1]?.certification?.recordId,
        },
      ]);
      expect(integration.declared[0]?.record_id).toBeTruthy();
      expect(probe).toBeTruthy();
      const prompt = epicVerdictJudgeRequest(outcome.summary, BUDGET).prompt;
      expect(prompt).toContain(
        [
          `  Branch: ${BRANCH}`,
          `  Declared checks: 2, read at commit ${H8}:`,
          `  P (pre-merge) (\`echo a b\`): passed (exit 0), record ${integration.declared[0]?.record_id}`,
          `  Q (post-merge) (\`run Q\`): passed (exit 0), record ${integration.declared[1]?.record_id}`,
        ].join('\n'),
      );
    });

    it('prints one NOT certified line per reason, the empty-declaration line and the unreadable-head line', async () => {
      const failed = await record([fail(P)]);
      await record([fail(Q, { reason: 'heavy.wait-timeout' })]);
      const edited = { ...R, checkSha256: 'sha-R2' };
      await record([pass(R)]);
      const none: DeclaredCheck = { name: 'N', tier: 'pre-merge', checkSha256: 'sha-N' };
      const checks = [P, Q, edited, none];
      const prompt = (c: readonly DeclaredCheck[], head: string | null = HEAD) =>
        verdict(c, head).then((v) => epicVerdictJudgeRequest(v.summary, BUDGET).prompt);
      const text = await prompt(checks);
      expect(text).toContain(
        `  P (pre-merge): NOT certified: its last result failed (exit 3, record ${failed})`,
      );
      expect(text).toMatch(
        /\n {2}Q \(post-merge\): NOT certified: its last result did not run \(heavy\.wait-timeout, record [^)]+\)\n/,
      );
      expect(text).toContain(
        '  R (pre-release): NOT certified: its results there exist only under another check_sha256 (its name, command, heavy flag or timeout changed since they ran)',
      );
      expect(text).toContain(`  N (pre-merge): NOT certified: ${NO_RESULT}`);
      expect(await prompt([])).toContain(
        '  Declared checks: none (the checks declaration is empty).',
      );
      expect(await prompt([P], null)).toContain(`  Could not read the head of ${BRANCH}.`);
    });

    it('records declared entries with the reason code on an override close', async () => {
      const failed = await record([fail(P)]);
      const closed = await closeEpic({ ...input([P, Q]), overrideRationale: 'accepted' }, ctx(), {
        stateDir,
      });
      expect(closed.closedBy).toBe('operator-override');
      const integration = await closedIntegration();
      expect(integration.declared).toEqual([
        {
          name: 'P',
          tier: 'pre-merge',
          check_sha256: 'sha-P',
          certified: false,
          reason: 'failed',
          record_id: failed,
        },
        {
          name: 'Q',
          tier: 'post-merge',
          check_sha256: 'sha-Q',
          certified: false,
          reason: 'no-result',
          record_id: null,
        },
      ]);
    });

    it('records every entry unreadable on an override close at an unreadable head', async () => {
      await record([pass(P)]);
      const closed = await closeEpic(
        { ...input([P], null), overrideRationale: 'accepted' },
        ctx(),
        { stateDir },
      );
      expect(closed.summary.integration.check).toBeNull();
      const integration = await closedIntegration();
      expect(integration.declared).toEqual([
        {
          name: 'P',
          tier: 'pre-merge',
          check_sha256: 'sha-P',
          certified: false,
          reason: null,
          record_id: null,
        },
      ]);
    });

    it('records tiered_record_id on a refused close recorded through the override', async () => {
      const id = await record([pass(P)], { probe_of: 'all' });
      await closeEpic({ ...input(), overrideRationale: 'accepted' }, ctx(), { stateDir });
      const integration = await closedIntegration();
      expect(integration.tiered_record_id).toBe(id);
      expect('declared' in integration).toBe(false);
    });

    async function closedIntegration(): Promise<Record<string, unknown>> {
      const events = await readEvents(sessionId, { stateDir });
      const event = events.find((e) => e.record.event_type === EPIC_CLOSED_EVENT_TYPE);
      if (event === undefined) throw new Error('no epic-closed event');
      const payload = event.record.payload as { summary: { integration: Record<string, unknown> } };
      return payload.summary.integration;
    }

    function pureSummary(integration: IntegrationStatus): EpicSummary {
      return summarizeEpic(
        epicId,
        [],
        [],
        integration,
        MCP_SURFACE_NOT_REQUIRED,
        { review: null, headSha: HEAD, branch: BRANCH },
        { check: null, goal: goal() },
        { tier: 'huge', closingSpecReview: 'always' },
      );
    }

    it('leaves the judge prompt as main wrote it when declared and tieredRecordId are unset', () => {
      const legacy: IntegrationCheckRecord = {
        epicId,
        branch: BRANCH,
        headSha: HEAD,
        pass: true,
        results: [{ name: 'lint', pass: true, exitCode: 0, tail: '', cmd: 'pnpm  lint' }],
        eventId: 'sess#7',
        ts: '2026-01-01T00:00:00.000Z',
      };
      const prompts = [null, legacy].map(
        (check) =>
          epicVerdictJudgeRequest(pureSummary({ check, headSha: HEAD, branch: BRANCH }), BUDGET)
            .prompt,
      );
      expect(prompts[0]).toContain(`  There is no integration-root check on record for ${BRANCH}.`);
      expect(prompts[1]).toContain(
        [
          `  Branch: ${BRANCH}`,
          `  Checked at commit ${H8} (the current head), recorded 2026-01-01T00:00:00.000Z`,
          '  Result: passed — 1 command ran:',
          '  lint (`pnpm lint`): passed (exit 0)',
        ].join('\n'),
      );
      const status: IntegrationStatus = { check: legacy, headSha: HEAD, branch: BRANCH };
      expect(Object.keys(status)).toEqual(['check', 'headSha', 'branch']);
      const declared: DeclaredCheckStatus[] = [{ ...P, certification: null }];
      expect(declared[0]?.name).toBe('P');
    });
  });
});
