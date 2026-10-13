import { describe, expect, it } from 'vitest';
import { loadTaxonomy } from '../../factory/orchestrator/src/taxonomy.js';
import type { TimelineEntry } from '../src/lib/api.js';
import {
  type ActivityEntry,
  EVENT_KINDS,
  gateStatusTag,
  groupByDay,
  groupByRoleMinute,
  isMultiProjectFeed,
  kindFor,
  metaFor,
  sessionDividerBefore,
  sessionDividerLabel,
  sessionDividerText,
  titleFor,
  verdictOutcome,
} from '../src/lib/timelineDisplay.js';

function entry(overrides: Partial<TimelineEntry>): TimelineEntry {
  return {
    eventId: 'e1',
    ts: '2026-08-01T00:00:00.000Z',
    eventType: 'user_prompt',
    taskId: null,
    agentId: null,
    planVersion: 1,
    causalParent: null,
    payload: {},
    project: null,
    actor: null,
    sessionId: 'sess-1',
    sessionTitle: 'sess-1',
    taskTitle: null,
    ...overrides,
  };
}

describe('lib/timelineDisplay.ts', () => {
  it('maps user_prompt to the prompt kind', () => {
    const e = entry({ eventType: 'user_prompt', payload: { prompt: 'hello' } });
    expect(kindFor(e)).toBe('prompt');
    expect(titleFor(e)).toBe('hello');
  });

  it('maps dispatch_decision to the dispatch kind', () => {
    const e = entry({ eventType: 'dispatch_decision', payload: { agent_role: 'coder' } });
    expect(kindFor(e)).toBe('dispatch');
  });

  // Task 2 (friendly role labels): the row's own title text names the role
  // too, alongside the IdentityChip TimelineRow.vue already labels — both
  // should read "Builder", never the raw taxonomy string "coder".
  it('titles a dispatch_decision with the friendly role label', () => {
    const e = entry({
      eventType: 'dispatch_decision',
      payload: { agent_role: 'coder', model_tier: 'mid', provider: 'anthropic' },
    });
    expect(titleFor(e)).toBe('Dispatched Builder (mid/anthropic)');
  });

  it('never prints empty parentheses or a bare slash when tier/provider are missing', () => {
    const bare = entry({ eventType: 'dispatch_decision', payload: { agent_role: 'coder' } });
    expect(titleFor(bare)).toBe('Dispatched Builder');
    const tierOnly = entry({
      eventType: 'dispatch_decision',
      payload: { agent_role: 'coder', model_tier: 'mid' },
    });
    expect(titleFor(tierOnly)).toBe('Dispatched Builder (mid)');
  });

  // Task 3 (dispatch reason fallback): writers put the reason under other
  // keys than `reason` — the same fallback chain the projector now applies
  // server-side (reason ?? rationale ?? note ?? why, strings only, trimmed)
  // is applied here too, so a rebuilt-vs-not-yet-rebuilt row reads the same.
  describe('dispatch_decision reason fallback chain', () => {
    const base = { agent_role: 'coder', model_tier: 'mid', provider: 'anthropic' };

    it('prefers reason when present', () => {
      const e = entry({
        eventType: 'dispatch_decision',
        payload: { ...base, reason: 'fix the bug' },
      });
      expect(titleFor(e)).toBe('Dispatched Builder (mid/anthropic): fix the bug');
    });

    it('falls back to rationale, then note, then why', () => {
      expect(
        titleFor(
          entry({ eventType: 'dispatch_decision', payload: { ...base, rationale: 'a rationale' } }),
        ),
      ).toBe('Dispatched Builder (mid/anthropic): a rationale');
      expect(
        titleFor(entry({ eventType: 'dispatch_decision', payload: { ...base, note: 'a note' } })),
      ).toBe('Dispatched Builder (mid/anthropic): a note');
      expect(
        titleFor(entry({ eventType: 'dispatch_decision', payload: { ...base, why: 'a why' } })),
      ).toBe('Dispatched Builder (mid/anthropic): a why');
    });

    it('trims whitespace and skips a blank string in favour of the next key', () => {
      expect(
        titleFor(
          entry({
            eventType: 'dispatch_decision',
            payload: { ...base, reason: '   ', rationale: '  a rationale  ' },
          }),
        ),
      ).toBe('Dispatched Builder (mid/anthropic): a rationale');
    });

    it('ignores a non-string value at a key and keeps looking', () => {
      expect(
        titleFor(
          entry({
            eventType: 'dispatch_decision',
            payload: { ...base, reason: 42, note: 'a note' },
          }),
        ),
      ).toBe('Dispatched Builder (mid/anthropic): a note');
    });

    it('names no reason at all when none of the four keys carry one', () => {
      expect(titleFor(entry({ eventType: 'dispatch_decision', payload: base }))).toBe(
        'Dispatched Builder (mid/anthropic)',
      );
    });
  });

  it('reads pass/fail from a gate-outcome payload', () => {
    expect(verdictOutcome(entry({ eventType: 'gate-outcome', payload: { outcome: 'pass' } }))).toBe(
      'pass',
    );
    expect(
      verdictOutcome(entry({ eventType: 'gate-outcome', payload: { outcome: 'blocked' } })),
    ).toBe('fail');
  });

  it('reads pass/fail from schema-check-result / testgate-result', () => {
    expect(
      verdictOutcome(entry({ eventType: 'schema-check-result', payload: { valid: false } })),
    ).toBe('fail');
    expect(verdictOutcome(entry({ eventType: 'testgate-result', payload: { pass: false } }))).toBe(
      'fail',
    );
  });

  // D-169. Three testgate-result events on the factory's own log carry no
  // `pass` at all -- hand-appended records whose author wrote the outcome
  // under their own keys -- and `p.pass !== false` rendered every one of
  // them with the green shield and the words "Test gate -- passed". A row
  // may not report a verdict the event never recorded, in either direction:
  // the third state says the record is thin, which is the only true thing
  // there is to say about it.
  it('reports no verdict rather than a pass when the field is absent (D-169)', () => {
    for (const eventType of ['testgate-result', 'schema-check-result', 'deps-check-result']) {
      expect(verdictOutcome(entry({ eventType, payload: {} }))).toBeNull();
    }
    expect(titleFor(entry({ eventType: 'testgate-result', payload: {} }))).toBe(
      'Test gate: no verdict recorded',
    );
    expect(titleFor(entry({ eventType: 'schema-check-result', payload: {} }))).toBe(
      'Schema check: no verdict recorded',
    );
    expect(
      titleFor(entry({ eventType: 'deps-check-result', payload: { detail: 'no .bin' } })),
    ).toBe('Dependency check (no verdict recorded): no .bin');
  });

  // A verdict field of the wrong type is not a verdict. `pass: 'false'` is
  // the shape a shell template or a hand-edited payload produces, and under
  // `!== false` a *string* saying false read as a pass -- the worst of the
  // three cases, because the writer did record a failure.
  it('treats a non-boolean verdict as unrecorded, not as a pass (D-169)', () => {
    expect(
      verdictOutcome(entry({ eventType: 'testgate-result', payload: { pass: 'false' } })),
    ).toBeNull();
    expect(
      verdictOutcome(entry({ eventType: 'schema-check-result', payload: { valid: null } })),
    ).toBeNull();
  });

  // gate-outcome already tested `outcome` positively, so its icon was never
  // wrong; its title still printed a dangling em dash for the same absence.
  // Not observed on any real log -- fixed here because it is the fourth
  // branch of the same switch and the next reader should find one rule.
  it('names a missing gate outcome instead of trailing an empty dash (D-169)', () => {
    expect(titleFor(entry({ eventType: 'gate-outcome', payload: {} }))).toBe(
      'Gate outcome: no outcome recorded',
    );
  });

  // P9-16(d) added a gate stage; a stage the dashboard renders as a generic
  // `history` row reads as trivia, and this one is the reason a green epic
  // was measuring the wrong node_modules.
  it('renders deps-check-result as the gate stage it is', () => {
    expect(
      titleFor(
        entry({ eventType: 'deps-check-result', payload: { ok: false, detail: 'no .bin' } }),
      ),
    ).toBe('Dependency check: no .bin');
  });

  // The other half of the fix that put seven free event types onto the
  // timeline (queries.ts's FREE_TIMELINE_EVENT_TYPES). Reaching the operator's
  // screen as `lesson-candidate-raised` with a generic clock is only half a
  // row: the type is the machine's name for the event, not the event.
  describe('the free event types the timeline filter used to drop', () => {
    it('titles a session start with its note', () => {
      const e = entry({ eventType: 'session-start', payload: { note: 'dogfood run 2' } });
      expect(titleFor(e)).toBe('Session started: dogfood run 2');
      expect(titleFor(entry({ eventType: 'session-start', payload: {} }))).toBe('Session started');
    });

    it('titles a task result with its run status and agent', () => {
      const e = entry({
        eventType: 'task-result-recorded',
        payload: { run_status: 'done', agent: 'coder', diff_lines_changed: 42 },
      });
      expect(titleFor(e)).toBe('Task result: done (coder, 42 lines changed)');
    });

    it('titles a judge verdict, and names a failure by its cause', () => {
      expect(
        titleFor(
          entry({
            eventType: 'judge-verdict',
            payload: { ok: true, verdict: 'refute', agent: 'verifier', provider: 'deepseek' },
          }),
        ),
      ).toBe('Judge verdict: refute (verifier/deepseek)');
      // ok:false leaves verdict null — "Judge verdict — " with nothing after
      // it reads as a judge that abstained, not one whose run never produced
      // an answer. D-253: which failure it was is the whole content of the
      // row, and the row used to say "schema failure" for a provider whose
      // API key was never set, i.e. one that sent no request at all.
      expect(
        titleFor(
          entry({
            eventType: 'judge-verdict',
            payload: {
              ok: false,
              verdict: null,
              error_code: 'provider.missing-api-key',
              agent: 'verifier',
              provider: 'deepseek',
            },
          }),
        ),
      ).toBe('Judge verdict: failed: provider.missing-api-key (verifier/deepseek)');
      expect(
        titleFor(
          entry({
            eventType: 'judge-verdict',
            payload: {
              ok: false,
              verdict: null,
              error_code: 'provider.invalid-output',
              agent: 'verifier',
              provider: 'codex',
            },
          }),
        ),
      ).toBe('Judge verdict: failed: provider.invalid-output (verifier/codex)');
      // Written before D-253 stamped the code: the row says the run failed
      // and stops there, rather than naming a cause the log never recorded.
      expect(
        titleFor(
          entry({
            eventType: 'judge-verdict',
            payload: { ok: false, verdict: null, agent: 'verifier', provider: 'deepseek' },
          }),
        ),
      ).toBe('Judge verdict: failed (verifier/deepseek)');
    });

    it('titles a judge report with its finding count', () => {
      const e = entry({
        eventType: 'judge-reported',
        payload: { agent_role: 'reviewer', round: 2, finding_count: 3 },
      });
      expect(titleFor(e)).toBe('reviewer reported: 3 findings (round 2)');
      expect(
        titleFor(
          entry({
            eventType: 'judge-reported',
            payload: { agent_role: 'reviewer', round: 1, finding_count: 1 },
          }),
        ),
      ).toBe('reviewer reported: 1 finding (round 1)');
    });

    it('titles an epic close with its verdict and merge count', () => {
      const e = entry({
        eventType: 'epic-closed',
        payload: { epic_id: 'dogfood-2', machine_verdict: 'pass', tasks_merged: 4 },
      });
      expect(titleFor(e)).toBe('Epic closed: dogfood-2: pass, 4 tasks merged');
    });

    it('titles lesson events with the statement, not the id', () => {
      expect(
        titleFor(
          entry({
            eventType: 'lesson-candidate-raised',
            payload: { lesson_id: 'L-9', statement: 'Pin the lockfile' },
          }),
        ),
      ).toBe('Lesson candidate: Pin the lockfile');
      expect(
        titleFor(
          entry({ eventType: 'lesson-edited', payload: { lesson_id: 'L-9', statement: 'Pin it' } }),
        ),
      ).toBe('Lesson edited: Pin it');
      // An edit that changes only the type or scope carries no statement.
      expect(titleFor(entry({ eventType: 'lesson-edited', payload: { lesson_id: 'L-9' } }))).toBe(
        'Lesson edited: L-9',
      );
      expect(
        titleFor(
          entry({
            eventType: 'lesson-status-changed',
            payload: { lesson_id: 'L-9', to_status: 'active' },
          }),
        ),
      ).toBe('Lesson L-9: active');
    });

    // The structural half: whatever the wording, none of these may fall
    // through to the default and render as its own event_type.
    it('leaves none of them rendering as a raw event type', () => {
      const types = [
        'session-start',
        'task-result-recorded',
        'judge-verdict',
        'judge-reported',
        'epic-closed',
        'lesson-candidate-raised',
        'lesson-edited',
        'lesson-status-changed',
      ];
      expect(types.filter((eventType) => titleFor(entry({ eventType })) === eventType)).toEqual([]);
    });
  });

  /**
   * The scheduler's three proposals — the same defect as the block above, one
   * writer further out, and the one the P9-37 lint could not see: they are
   * written as `event_type: eventTypeFor(proposal)`, a helper's return value,
   * so they were undeclared, unlisted on the timeline and untitled here while
   * every check stayed green. A row that reads `recheck-proposed` and names no
   * task asks the operator a question they cannot answer from the row.
   */
  describe('the scheduler proposals', () => {
    it('names the task a recheck is proposed for, and why', () => {
      const e = entry({
        eventType: 'recheck-proposed',
        payload: {
          kind: 'recheck',
          taskId: 'epic-9/task-3',
          epicId: 'epic-9',
          reasons: ['merge-threshold', 'low-confidence'],
        },
      });
      expect(titleFor(e)).toBe('Recheck proposed: Task 3 (merge-threshold, low-confidence)');
    });

    it('names the recheck task by its title when the entry is that task', () => {
      const e = entry({
        eventType: 'recheck-proposed',
        taskId: 'epic-9/task-3',
        taskTitle: 'Fix the login form',
        payload: { kind: 'recheck', taskId: 'epic-9/task-3', epicId: 'epic-9', reasons: ['x'] },
      });
      expect(titleFor(e)).toBe('Recheck proposed: Fix the login form (x)');
    });

    it('keeps the epic id when the recheck names no task', () => {
      const e = entry({
        eventType: 'recheck-proposed',
        payload: { kind: 'recheck', epicId: 'epic-9', reasons: [] },
      });
      expect(titleFor(e)).toBe('Recheck proposed: epic-9');
    });

    it('counts the outdated packages and names the first few', () => {
      const packages = ['vite', 'vitest', 'hono', 'ajv'].map((name) => ({
        name,
        current: '1.0.0',
        wanted: '1.1.0',
        latest: '2.0.0',
      }));
      const e = entry({
        eventType: 'maintenance-proposed',
        payload: { kind: 'maintenance', packages },
      });
      expect(titleFor(e)).toBe('Maintenance proposed: 4 outdated (vite, vitest, hono +1)');
      expect(
        titleFor(entry({ eventType: 'maintenance-proposed', payload: { packages: [] } })),
      ).toBe('Maintenance proposed: 0 outdated (none)');
    });

    it('names the error class, task and count of an unreported error', () => {
      const e = entry({
        eventType: 'error-report-proposed',
        payload: {
          kind: 'error-report',
          fingerprint: 'abc123',
          errorClass: 'AssertionError',
          taskRef: 'epic/task-3',
          occurrences: 2,
        },
      });
      expect(titleFor(e)).toBe(
        'Error report proposed: AssertionError in epic/task-3 (2 occurrences)',
      );
      expect(titleFor(entry({ eventType: 'error-report-proposed', payload: {} }))).toBe(
        'Error report proposed:  in  (0 occurrences)',
      );
      expect(
        titleFor(
          entry({
            eventType: 'error-report-proposed',
            payload: {
              kind: 'error-report',
              errorClass: 'AssertionError',
              taskRef: 'epic/task-3',
              occurrences: 1,
            },
          }),
        ),
      ).toBe('Error report proposed: AssertionError in epic/task-3 (1 occurrence)');
    });

    it('gives the growth review its cadence, and degrades without a last review', () => {
      const e = entry({
        eventType: 'growth-review-due',
        payload: { kind: 'growth-review', cadenceDays: 14, lastReviewAt: '2026-08-01T09:00:00Z' },
      });
      expect(titleFor(e)).toBe('Growth review due: every 14 days, last 2026-08-01');
      expect(titleFor(entry({ eventType: 'growth-review-due', payload: {} }))).toBe(
        'Growth review due: every ? days',
      );
    });

    it('gives every proposal a known kind and its own title', () => {
      const types = [
        'recheck-proposed',
        'maintenance-proposed',
        'growth-review-due',
        'error-report-proposed',
      ];
      const missing = types
        .map((eventType) => kindFor(entry({ eventType })))
        .filter((kind) => !EVENT_KINDS.includes(kind));
      expect(missing).toEqual([]);
      expect(types.filter((eventType) => titleFor(entry({ eventType })) === eventType)).toEqual([]);
    });
  });

  // The integration PR is the epic's terminal deliverable — the one thing the
  // operator is asked to merge — and run.md step 17 records it with `smith
  // event append` as `integration-pr-opened`. It reached neither the free list
  // (queries.ts) nor a case here, so the timeline of a closed epic ended at
  // `epic-closed` and never showed the PR the closing was for.
  describe('the integration PR the epic opened', () => {
    const pr = entry({
      eventType: 'integration-pr-opened',
      taskId: 'example-2/integration',
      payload: {
        step: 17,
        pr_url: 'https://github.com/example-org/example-app/pull/54',
        pr_number: 54,
        repo: 'example-org/example-app',
        base_ref: 'smith/example-1/integration',
        head_ref: 'smith/example-2/integration',
        head_sha: '931079e',
        commits: 11,
        changed_files: 11,
      },
    });

    it('titles the row with the PR, its repo and the refs it merges', () => {
      expect(titleFor(pr)).toBe(
        'Integration PR opened: example-org/example-app#54 (smith/example-2/integration → smith/example-1/integration)',
      );
    });

    it('gives the row a known kind, not the generic fallback', () => {
      expect(kindFor(pr)).toBe('merge');
    });

    it('still names the type when a hand-appended payload is thin', () => {
      const thin = entry({ eventType: 'integration-pr-opened', payload: {} });
      expect(titleFor(thin)).toBe('Integration PR opened');
    });
  });

  // D-153. The same defect one type further out, and the loudest instance of
  // it: `operator-note` ties for third most common in the factory's own logs
  // (57 of 668) and is the only one carrying the operator's reasoning in their
  // own words. It reached neither the filter (queries.ts) nor a case here, so
  // the one lens an operator opens to re-read their own decisions showed none
  // of them.
  // The plan graph. `task-added` was the only one of the ten with a title, so
  // the nine others reached the timeline and rendered as their own event_type
  // — the D-153/D-162 defect, one dimension over. The two the factory writes
  // for a living spec are the reason it was worth closing now: an operator who
  // is asked to answer a proposal quickly has to be able to read it.
  // A spec finding is minted against a criterion (findings.ts `spec_ref`), and
  // the criterion is the one thing that tells an operator what to re-read.
  // The title used to drop it, so a spec-reviewer's finding read like one
  // more diff finding.
  describe('a spec finding on the timeline', () => {
    it('names the plan version and the criterion the finding is about', () => {
      const e = entry({
        eventType: 'finding-raised',
        payload: {
          summary: 'criterion-1 pins no behaviour',
          finding_scope: 'spec',
          spec_ref: { plan_version: 1, criterion_ref: 'epic-1/task-2:criterion-1' },
        },
      });
      expect(titleFor(e)).toBe(
        'Finding raised: criterion-1 pins no behaviour (spec · plan v1 · epic-1/task-2:criterion-1)',
      );
    });

    it('leaves a diff finding as it was', () => {
      const e = entry({
        eventType: 'finding-raised',
        payload: { summary: 'off by one', finding_scope: 'diff' },
      });
      expect(titleFor(e)).toBe('Finding raised: off by one');
    });

    it('treats an absent scope as diff, the way findingScope() does', () => {
      const e = entry({ eventType: 'finding-raised', payload: { summary: 'off by one' } });
      expect(titleFor(e)).toBe('Finding raised: off by one');
    });
  });

  describe('the plan graph', () => {
    it("reads a worker proposal in the worker's own words, with the site count", () => {
      const e = entry({
        eventType: 'spec-change-proposed',
        payload: {
          proposed_by: 'coder',
          criterion_ref: 'epic-1/task-2:criterion-1',
          assumption: 'every value is single-line',
          sites: ['src/parse.ts', 'src/emit.ts'],
          blocking: true,
        },
      });
      expect(titleFor(e)).toBe(
        'Spec change proposed by coder on epic-1/task-2:criterion-1: every value is single-line (blocking, 2 sites)',
      );
    });

    it('says non-blocking when the worker can keep going without the amendment', () => {
      const title = titleFor(
        entry({
          eventType: 'spec-change-proposed',
          payload: { criterion_ref: 'c-1', assumption: 'a', sites: ['x'], blocking: false },
        }),
      );
      expect(title).toContain('(non-blocking, 1 site)');
      expect(title).toContain('proposed by worker');
    });

    // A rejection cuts no version, so naming one would be a lie the row tells
    // by default. Both decisions carry the operator's reasons.
    it('names the version an approval cut, and none on a rejection', () => {
      const approved = entry({
        eventType: 'spec-change-decided',
        payload: { decision: 'approved', plan_version: 2, rationale: 'the parser is right' },
      });
      expect(titleFor(approved)).toBe('Spec change approved (plan v2): the parser is right');
      expect(
        titleFor(
          entry({
            eventType: 'spec-change-decided',
            payload: { decision: 'rejected', plan_version: null, rationale: 'read it again' },
          }),
        ),
      ).toBe('Spec change rejected: read it again');
    });

    it('says what a new plan version amends and why', () => {
      const e = entry({
        eventType: 'plan-version-created',
        payload: {
          version: 2,
          previous_version: 1,
          amends: [{ finding_id: 'F-1' }],
          rationale: 'quoted newlines are legal',
        },
      });
      expect(titleFor(e)).toBe('Plan v2 amends v1: 1 finding cited: quoted newlines are legal');
    });

    it('reads the graph rows the plan ingest writes', () => {
      expect(
        titleFor(
          entry({ eventType: 'edge-recorded', taskId: 'e/t2', payload: { depends_on: 'e/t1' } }),
        ),
      ).toBe('Edge: T2 depends on T1');
      expect(
        titleFor(
          entry({ eventType: 'wave-admitted', payload: { task_ids: ['a', 'b', 'c', 'd'] } }),
        ),
      ).toBe('Wave admitted: 4 tasks (a, b, c +1)');
      expect(
        titleFor(
          entry({
            eventType: 'wave-merged',
            payload: { task_ids: ['a'], files_changed: ['x.ts'] },
          }),
        ),
      ).toBe('Merged A (1 file changed)');
      expect(titleFor(entry({ eventType: 'wave-merged', payload: { task_ids: ['a'] } }))).toBe(
        'Merged A',
      );
      expect(titleFor(entry({ eventType: 'task-superseded', taskId: 'e/t9' }))).toBe(
        'Task superseded: T9',
      );
    });

    describe('names the task by its short name, never the raw id or the objective', () => {
      const taskId = 'epic-a/t3-trim-readme';
      const objective = 'A long objective paragraph that must stay out of the row title.';
      const named = { taskId, taskTitle: 'Trim the readme' };

      it('task-added', () => {
        const e = entry({ eventType: 'task-added', ...named, payload: { objective } });
        expect(titleFor(e)).toBe('Task added: Trim the readme');
        expect(titleFor(entry({ eventType: 'task-added', taskId, payload: { objective } }))).toBe(
          'Task added: T3 trim readme',
        );
      });

      it('task-split and task-superseded', () => {
        expect(titleFor(entry({ eventType: 'task-split', ...named }))).toBe(
          'Task split: Trim the readme',
        );
        expect(titleFor(entry({ eventType: 'task-superseded', ...named }))).toBe(
          'Task superseded: Trim the readme',
        );
      });

      it('edge-recorded titles the task and slugs the dependency', () => {
        const e = entry({
          eventType: 'edge-recorded',
          ...named,
          payload: { depends_on: 'epic-a/t2-write-spec' },
        });
        expect(titleFor(e)).toBe('Edge: Trim the readme depends on T2 write spec');
      });

      it('wave-merged titles the entry task and slugs any other id', () => {
        const e = entry({
          eventType: 'wave-merged',
          ...named,
          payload: { task_ids: [taskId, 'epic-a/t2-write-spec'], files_changed: ['x.ts'] },
        });
        expect(titleFor(e)).toBe('Merged Trim the readme, T2 write spec (1 file changed)');
        expect(
          titleFor(entry({ eventType: 'wave-merged', ...named, payload: { task_ids: [] } })),
        ).toBe('Merged Trim the readme');
        expect(metaFor(e)).toContain('Trim the readme, T2 write spec');
        expect(metaFor(e)).not.toContain('epic-a/');
      });
    });

    /**
     * The guard, not the examples, and the whole dimension rather than the
     * types this feature happened to add: a graph_event the taxonomy grows
     * later is selectable by the Plan chip the day it is declared, and would
     * render as its own event_type under a kind tag that was never taught it.
     */
    it('gives every graph_event a title of its own and a known kind', () => {
      const dimension = loadTaxonomy().dimensions.graph_event ?? [];
      expect(dimension.length).toBeGreaterThan(0);
      expect(
        dimension.filter((eventType) => !EVENT_KINDS.includes(kindFor(entry({ eventType })))),
      ).toEqual([]);
      expect(dimension.filter((eventType) => titleFor(entry({ eventType })) === eventType)).toEqual(
        [],
      );
    });
  });

  describe('operator-note', () => {
    it('titles the note by its own text, not by its event type', () => {
      const e = entry({
        eventType: 'operator-note',
        payload: { note: 'artifact home relocation before the task-2 gate run' },
      });
      expect(titleFor(e)).toBe('artifact home relocation before the task-2 gate run');
    });

    // 28 of the 57 use `note`, 11 use `summary`, and the rest carry neither —
    // the payload is deliberately free-form, so the title has to degrade to
    // something readable rather than to the empty string an unguarded
    // `String(p.note)` would print.
    it('falls back to summary, then to a generic label', () => {
      expect(
        titleFor(entry({ eventType: 'operator-note', payload: { summary: 'three findings' } })),
      ).toBe('three findings');
      expect(titleFor(entry({ eventType: 'operator-note', payload: {} }))).toBe('Operator note');
    });

    // The remaining 18 carry a note_kind and no body at all — their prose is
    // spread across ten bespoke payload keys, which is exactly the freedom this
    // event type is for. Their note_kind is already a sentence, so appending a
    // generic label to it says nothing and costs a third of the rows their
    // legibility: "predictions-recorded-before-the-gate-runs — Operator note".
    it('lets a bodyless note stand on its note_kind alone', () => {
      expect(
        titleFor(
          entry({
            eventType: 'operator-note',
            payload: { note_kind: 'predictions-recorded-before-the-gate-runs', exit_code: 0 },
          }),
        ),
      ).toBe('predictions-recorded-before-the-gate-runs');
    });

    // `note_kind` is present on 33 of them and is the operator's own
    // classification of what they were doing. It belongs in front of the text,
    // not buried in the expanded payload.
    it('prefixes the operator’s own note_kind when there is one', () => {
      expect(
        titleFor(
          entry({
            eventType: 'operator-note',
            payload: { note_kind: 'correction', note: 'correcting 179' },
          }),
        ),
      ).toBe('correction: correcting 179');
    });

    // Tinted with user_prompt rather than with the machine events: what these
    // two have in common is that a person wrote them, which is exactly the
    // grouping the "Prompts" chip selects on.
    it('shares the prompt kind with user_prompt', () => {
      expect(kindFor(entry({ eventType: 'operator-note' }))).toBe('prompt');
    });
  });

  /**
   * The independent finder's row. In shadow mode this event is the ONLY thing
   * a run produces -- it gates nothing by construction -- so if it does not
   * reach the timeline legibly there is no way to evaluate the shadow
   * deployment before promoting it, which is the whole reason shadow mode
   * exists.
   */
  describe('cross-finding-reconciled', () => {
    it('leads with the findings only the second eye raised', () => {
      const e = entry({
        eventType: 'cross-finding-reconciled',
        payload: {
          task_id: 'epic-1/task-1',
          mode: 'active',
          counts: { corroborated: 2, 'co-located': 1, 'independent-only': 3, 'native-only': 4 },
          providers: ['codex', 'gemini'],
        },
      });
      expect(titleFor(e)).toBe('Cross-finding: 3 independent-only, 2 corroborated (codex, gemini)');
    });

    // Same numbers, no gating power. An operator reading the row has to be
    // able to tell "the finder would have raised three" from "the finder
    // raised three", and only the mode says which.
    it('says so when the same numbers gated nothing', () => {
      const e = entry({
        eventType: 'cross-finding-reconciled',
        payload: {
          mode: 'shadow',
          counts: { 'independent-only': 3, corroborated: 2 },
          providers: ['codex'],
        },
      });
      expect(titleFor(e)).toBe('Cross-finding: 3 independent-only, 2 corroborated (codex, shadow)');
    });

    // A run where the two readers agreed on everything is the common case and
    // still has to render: reading `NaN` off an absent count would make the
    // quietest, most reassuring row the one that looks broken.
    it('reads absent counts as zero rather than as NaN', () => {
      expect(titleFor(entry({ eventType: 'cross-finding-reconciled', payload: {} }))).toBe(
        'Cross-finding: 0 independent-only, 0 corroborated ()',
      );
    });

    it('gives the row a known kind', () => {
      expect(kindFor(entry({ eventType: 'cross-finding-reconciled' }))).toBe('feedback');
    });
  });
});

// DS6 PR3: metaFor() is now the row's per-kind meta line (ds-spec.md §4.3's
// table), rather than a bare "<task> · <eventType>" fallback. A merge row
// is named via shortTaskName(); an unmapped kind (System) renders
// no meta at all, per the table's own "— (no meta, no chevron)" row.
describe('lib/timelineDisplay.ts metaFor()', () => {
  it('says "nothing to check" for a gate row whose check counted nothing, never "0 of 0"', () => {
    const e = entry({ eventType: 'artifact-check-result', payload: {} });
    (e as unknown as { gateCounts: unknown }).gateCounts = { passed: 0, failed: 0 };
    expect(metaFor(e)).toBe('nothing to check');
    (e as unknown as { gateCounts: unknown }).gateCounts = { passed: 3, failed: 0 };
    expect(metaFor(e)).toBe('3 of 3 passed');
  });

  it('humanizes a taskId rather than showing the raw slug (merge, no task_ids)', () => {
    const e = entry({
      eventType: 'wave-merged',
      taskId: 'epic-9/task-29-readme-merge-trim',
      payload: {},
    });
    expect(metaFor(e)).toBe('Readme merge trim · not measured');
  });

  it('renders no meta for a System-kind row', () => {
    const e = entry({ eventType: 'session-start', taskId: null, payload: {} });
    expect(metaFor(e)).toBe('');
  });

  it('prefers task_ids and reports a files-changed count when present', () => {
    const e = entry({
      eventType: 'wave-merged',
      taskId: 'epic-9/task-29-readme-merge-trim',
      payload: { task_ids: ['epic-9/task-29'], files_changed: ['a.ts', 'b.ts'] },
    });
    expect(metaFor(e)).toBe('Task 29 · 2 files changed');
  });

  it('shows a running dispatch as "Running for" rather than a token/duration total', () => {
    const e = entry({ eventType: 'dispatch_decision', payload: { round: 2 } });
    expect(metaFor(e, { now: e.ts })).toBe('round 2 · Running for 0 s');
    // (formatElapsed rounds up from a zero-width window to "0s"; the space
    // before "s" is inserted to match ds-spec.md §4.3's own wording.)
  });

  it('says "No result after" for a runless dispatch past the stale window', () => {
    const e = entry({ eventType: 'dispatch_decision', payload: { round: 2 } });
    const at = (ms: number) => new Date(Date.parse(e.ts) + ms).toISOString();
    const H = 3_600_000;
    expect(metaFor(e, { now: at(5 * H) })).toBe('round 2 · No result after 5h');
    expect(metaFor(e, { now: at(3 * H) })).toBe('round 2 · Running for 3h');
    expect(metaFor(e, { now: at(4 * H) })).toContain('Running for');
    expect(metaFor(e, { now: at(4 * H + 1000) })).toContain('No result after');
  });

  it("shows a finished dispatch's tokens and duration", () => {
    const e = entry({ eventType: 'dispatch_decision', payload: { round: 1 } });
    (e as unknown as { run: unknown }).run = {
      tokensIn: 1000,
      tokensOut: 500,
      durationMs: 65_000,
      runStatus: 'done',
      dispatchedAt: e.ts,
      round: 1,
    };
    expect(metaFor(e)).toBe('round 1 · 1.5K tokens · 1 min');
  });

  // Visual pass round 4, item 2: a finished dispatch whose run never had a
  // duration stamped (no writer in this codebase sets `duration_ms` today)
  // omits the item rather than labelling it "not measured" next to the real
  // token count.
  it("omits duration from a finished dispatch's meta when the run never stamped it", () => {
    const e = entry({ eventType: 'dispatch_decision', payload: { round: 1 } });
    (e as unknown as { run: unknown }).run = {
      tokensIn: 1000,
      tokensOut: 500,
      durationMs: null,
      runStatus: 'done',
      dispatchedAt: e.ts,
      round: 1,
    };
    expect(metaFor(e)).toBe('round 1 · 1.5K tokens');
  });

  // The prompt reference has one owner: TimelineRow renders it as a link, so
  // the meta string never spells it, resolved prompt or not.
  it('leaves "because of" out of a finished dispatch\'s meta, resolved prompt or not', () => {
    const e = entry({ eventType: 'dispatch_decision', payload: { round: 1 } });
    (e as unknown as { run: unknown }).run = {
      tokensIn: 1000,
      tokensOut: 500,
      durationMs: 65_000,
      runStatus: 'done',
      dispatchedAt: e.ts,
      round: 1,
    };
    expect(metaFor(e, { promptTs: e.ts })).toBe('round 1 · 1.5K tokens · 1 min');
    expect(metaFor(e, { promptTs: null })).toBe('round 1 · 1.5K tokens · 1 min');
  });

  it('leaves tokens out of a finished dispatch when the run measured none', () => {
    const e = entry({ eventType: 'dispatch_decision', payload: { round: 3 } });
    (e as unknown as { run: unknown }).run = {
      tokensIn: null,
      tokensOut: null,
      durationMs: null,
      runStatus: 'done',
      dispatchedAt: e.ts,
      round: 3,
    };
    expect(metaFor(e)).toBe('round 3');
  });

  describe("Returned meta reads the row's own payload", () => {
    const returned = (payload: Record<string, unknown>) =>
      entry({ eventType: 'task-result-recorded', payload });

    it('uses total_tokens when it is the only number', () => {
      expect(metaFor(returned({ run_status: 'done', token_usage: { total_tokens: 1500 } }))).toBe(
        '1.5K tokens',
      );
    });

    it('sums input and output tokens, plus a measured duration', () => {
      expect(
        metaFor(
          returned({
            run_status: 'done',
            token_usage: { input_tokens: 1000, output_tokens: 500 },
            duration_ms: 65_000,
          }),
        ),
      ).toBe('1.5K tokens · 1 min');
    });

    it('leaves out {measured:false} tokens, never "not measured" or 0', () => {
      expect(metaFor(returned({ run_status: 'done', token_usage: { measured: false } }))).toBe('');
    });

    it('is empty when nothing is measured and the title already shows the status', () => {
      expect(metaFor(returned({ run_status: 'done' }))).toBe('');
    });
  });

  // ds-review.html #p-activity's own Prompt row meta: "You · caused 2
  // dispatches". titleFor() already renders the verbatim prompt text as the
  // title (see the 'maps user_prompt to the prompt kind' test above) — the
  // gap was the meta line omitting "You" entirely.
  it('marks a prompt row\'s meta as "You · caused N dispatches"', () => {
    const e = entry({ eventType: 'user_prompt', payload: { prompt: 'hello' } });
    expect(metaFor(e, { causedCount: 2 })).toBe('You · caused 2 dispatches');
  });

  it('still names "You" when the prompt caused nothing measured', () => {
    const e = entry({ eventType: 'user_prompt', payload: { prompt: 'hello' } });
    expect(metaFor(e)).toBe('You · not measured');
  });

  it("marks a judge-reported row's meta as role, round, verdict", () => {
    // judge-reported only reaches the `finding` branch when the server's own
    // `kind` says so (queries.ts's eventKind()) — see the kindFor() tests
    // above for the reconciled client/server mapping.
    const e = {
      ...entry({
        eventType: 'judge-reported',
        payload: { agent_role: 'judge', round: 1, overall: 'pass' },
      }),
      kind: 'Finding',
    };
    expect(metaFor(e)).toBe('Judge · round 1 · pass');
  });

  // Fix brief item 1 (S2): metaFor() used to push 'Waiver' for every feedback
  // event, including the four kindFor() also routes to 'feedback' that are
  // not waivers at all. Each gets its own honest label, reusing titleFor()'s
  // own prefix for that event type rather than inventing a second vocabulary.
  it.each([
    ['waiver-granted', 'Waiver granted'],
    ['waiver-denied', 'Waiver denied'],
    ['judge-verdict', 'Judge verdict'],
    ['cross-finding-reconciled', 'Cross-finding reconciled'],
    ['spec-change-proposed', 'Spec change proposed'],
    ['spec-change-decided', 'Spec change decided'],
  ] as const)("labels a %s row's meta as %s", (eventType, label) => {
    const e = entry({ eventType, taskId: null, payload: {} });
    expect(metaFor(e)).toBe(label);
  });

  it('names a minted follow-up id "Follow-up fix" in a meta line, never its hex', () => {
    const e = entry({
      eventType: 'judge-verdict',
      taskId: 'epic-9/followup-0a1b2c3d',
      payload: {},
    });
    expect(metaFor(e)).toBe('Judge verdict · Follow-up fix');
  });

  it('names a task by its title where the entry carries one', () => {
    const base = { taskId: 'epic-9/task-29-readme-merge-trim', payload: {} };
    expect(metaFor(entry({ ...base, eventType: 'judge-verdict', taskTitle: 'Trim readme' }))).toBe(
      'Judge verdict · Trim readme',
    );
    expect(metaFor(entry({ ...base, eventType: 'wave-merged', taskTitle: 'Trim readme' }))).toBe(
      'Trim readme · not measured',
    );
  });

  it('appends the task label to a feedback meta line when there is one', () => {
    const e = entry({
      eventType: 'judge-verdict',
      taskId: 'epic-9/task-29-readme-merge-trim',
      payload: {},
    });
    expect(metaFor(e)).toBe('Judge verdict · Readme merge trim');
  });
});

// Item 1 of the mock-conformance brief: every row wears one of the mock's
// nine kind tags (ds-review.html's `.k-*` classes), never the old icon.
describe('lib/timelineDisplay.ts kindFor()', () => {
  it.each([
    ['user_prompt', 'prompt'],
    ['operator-note', 'prompt'],
    ['dispatch_decision', 'dispatch'],
    ['task-result-recorded', 'returned'],
    ['finding-raised', 'finding'],
    ['judge-reported', 'finding'],
    ['task-waiver-approved', 'finding'],
    ['schema-check-result', 'gate'],
    ['testgate-result', 'gate'],
    ['gate-outcome', 'gate'],
    ['grader-verdict', 'gate'],
    ['wave-merged', 'merge'],
    ['epic-closed', 'merge'],
    ['integration-pr-opened', 'merge'],
    ['error-logged', 'error'],
    ['error-report-proposed', 'error'],
    ['judge-verdict', 'feedback'],
    ['waiver-granted', 'feedback'],
    ['cross-finding-reconciled', 'feedback'],
    ['session-start', 'system'],
    ['task-added', 'system'],
    ['some-future-event-type', 'system'],
  ] as const)('maps %s to %s', (eventType, kind) => {
    expect(kindFor(entry({ eventType }))).toBe(kind);
  });

  it('prefers a server-supplied kind over the eventType switch', () => {
    // waiver-granted maps to 'finding' client-side but 'Feedback' server-side
    // (queries.ts's eventKind()) — DS6 PR3: the server wins once it is present.
    expect(kindFor({ ...entry({ eventType: 'waiver-granted' }), kind: 'Feedback' })).toBe(
      'feedback',
    );
  });

  it('falls back to system for an unrecognized server kind', () => {
    expect(kindFor({ ...entry({ eventType: 'user_prompt' }), kind: 'Nonsense' })).toBe('system');
  });

  it('never leaves a kind unmapped for the whole gate_event taxonomy dimension', () => {
    const dimension = loadTaxonomy().dimensions.gate_event ?? [];
    expect(dimension.length).toBeGreaterThan(0);
    const unmapped = dimension.filter(
      (eventType) => !EVENT_KINDS.includes(kindFor(entry({ eventType }))),
    );
    expect(unmapped).toEqual([]);
  });

  // ds-spec.md §4.3: "never an empty label, never '—'". Every event type in
  // the gate_event and graph_event taxonomy dimensions, plus the handful of
  // types titleFor() names explicitly outside those dimensions, must build a
  // title and meta with no em dash, whatever their payload looks like.
  it('never builds a title or meta containing an em dash, for the whole event vocabulary', () => {
    const taxonomy = loadTaxonomy();
    const types = new Set<string>([
      ...(taxonomy.dimensions.gate_event ?? []),
      ...(taxonomy.dimensions.graph_event ?? []),
      'user_prompt',
      'operator-note',
      'dispatch_decision',
      'task-result-recorded',
      'session-start',
      'judge-reported',
      'judge-verdict',
      'cross-finding-reconciled',
      'lesson-candidate-raised',
      'lesson-edited',
      'lesson-status-changed',
      'recheck-proposed',
      'maintenance-proposed',
      'growth-review-due',
      'error-report-proposed',
      'spec-change-proposed',
      'spec-change-decided',
    ]);
    for (const eventType of types) {
      const e = entry({ eventType });
      expect(titleFor(e), `titleFor(${eventType})`).not.toMatch(/[—–]/);
      expect(metaFor(e), `metaFor(${eventType})`).not.toMatch(/[—–]/);
    }
  });

  // Fix brief item 2 (S3): the sweep above only checks for the absence of an
  // em dash, which stays green even if a label goes wrong in some other way
  // (DS6 PR3 round 5's own "Waiver" for every feedback event never tripped
  // it). This sibling table pins the exact title and meta string an empty
  // payload produces for every event type in that same sweep, so swapping in
  // a wrong label fails a test rather than only a human reading the row.
  it('builds the exact title and meta for every event type in the vocabulary sweep', () => {
    const taxonomy = loadTaxonomy();
    const types = new Set<string>([
      ...(taxonomy.dimensions.gate_event ?? []),
      ...(taxonomy.dimensions.graph_event ?? []),
      'user_prompt',
      'operator-note',
      'dispatch_decision',
      'task-result-recorded',
      'session-start',
      'judge-reported',
      'judge-verdict',
      'cross-finding-reconciled',
      'lesson-candidate-raised',
      'lesson-edited',
      'lesson-status-changed',
      'recheck-proposed',
      'maintenance-proposed',
      'growth-review-due',
      'error-report-proposed',
      'spec-change-proposed',
      'spec-change-decided',
    ]);
    // [title, meta] for an entry built from entry({ eventType }) alone --
    // empty payload, taskId null, no server-side kind/run/gateCounts.
    const expected: Record<string, [string, string]> = {
      'schema-check-result': ['Schema check: no verdict recorded', ''],
      'artifact-check-result': ['Artifact check result', ''],
      'commit-check-result': ['Commit check result', ''],
      'deps-check-result': ['Dependency check (no verdict recorded)', ''],
      'judges-outstanding': ['Judges outstanding', ''],
      'grader-verdict': ['Grader verdict', ''],
      'budget-check-result': ['Budget check result', ''],
      'testgate-result': ['Test gate: no verdict recorded', 'Unit tests'],
      'coverage-evidence': ['Coverage evidence', ''],
      'integration-check': ['Integration check', ''],
      'spec-review-recorded': ['Spec review recorded', ''],
      'goal-check-recorded': ['Goal check recorded', ''],
      'quorum-decision': ['Quorum decision', ''],
      'finding-raised': ['Finding raised: ', ''],
      'finding-reverified': ['Finding reverified', ''],
      'finding-suppressed': ['Finding suppressed', ''],
      'finding-transitioned': ['Finding transitioned: ', ''],
      'finding-reattributed': ['Finding reattributed', ''],
      'severity-decisions': ['Severity decisions recorded', ''],
      'waiver-granted': ['Waiver granted', 'Waiver granted'],
      'waiver-denied': ['Waiver denied', 'Waiver denied'],
      'task-waiver-approved': ['Task waiver approved', ''],
      'gate-outcome': ['Gate outcome: no outcome recorded', ''],
      'issue-reported': ['Issue reported', ''],
      'plan-version-created': ['Plan v?: 0 findings cited', ''],
      'plan-version-superseded': ['Plan v? superseded', ''],
      'task-added': ['Task added: ', ''],
      'task-split': ['Task split: ', ''],
      'task-superseded': ['Task superseded: ', ''],
      'edge-recorded': ['Edge:  depends on ', ''],
      'wave-admitted': ['Wave admitted: 0 tasks', ''],
      'wave-merged': ['Merged ', 'not measured'],
      'spec-change-proposed': [
        'Spec change proposed by worker on :  (non-blocking, 0 sites)',
        'Spec change proposed',
      ],
      'spec-change-decided': ['Spec change decided', 'Spec change decided'],
      user_prompt: ['', 'You · not measured'],
      'operator-note': ['Operator note', 'You · not measured'],
      dispatch_decision: ['Dispatched Agent', 'Running for 0 s'],
      'task-result-recorded': ['Task result: ', ''],
      'session-start': ['Session started', ''],
      'judge-reported': ['Judge reported: 0 findings (round )', ''],
      'judge-verdict': ['Judge verdict:  (/)', 'Judge verdict'],
      'cross-finding-reconciled': [
        'Cross-finding: 0 independent-only, 0 corroborated ()',
        'Cross-finding reconciled',
      ],
      'lesson-candidate-raised': ['Lesson candidate: ', ''],
      'lesson-edited': ['Lesson edited: ', ''],
      'lesson-status-changed': ['Lesson : ', ''],
      'recheck-proposed': ['Recheck proposed: ', ''],
      'maintenance-proposed': ['Maintenance proposed: 0 outdated (none)', ''],
      'growth-review-due': ['Growth review due: every ? days', ''],
      'error-report-proposed': ['Error report proposed:  in  (0 occurrences)', ''],
    };
    expect(new Set(Object.keys(expected))).toEqual(types);
    for (const eventType of types) {
      const e = entry({ eventType });
      const pair = expected[eventType];
      if (pair === undefined) throw new Error(`no expected title/meta for ${eventType}`);
      const [title, meta] = pair;
      expect(titleFor(e), `titleFor(${eventType})`).toBe(title);
      // dispatch_decision's "Running for" text grows with real elapsed time,
      // so it needs the same frozen `now` the dedicated dispatch tests use.
      expect(metaFor(e, { now: e.ts }), `metaFor(${eventType})`).toBe(meta);
    }
  });

  // Item 2 of the fix brief: a raw kebab-case type slug (e.g. one titleFor()
  // has no dedicated case for) must still read as a sentence.
  it('humanizes an unmapped event type instead of printing its raw slug', () => {
    expect(titleFor(entry({ eventType: 'operator-feedback-resolved' }))).toBe(
      'Operator feedback resolved',
    );
  });
});

describe('lib/timelineDisplay.ts verdictOutcome()', () => {
  it('reads confirm/refute off a judge-verdict payload', () => {
    expect(
      verdictOutcome(
        entry({ eventType: 'judge-verdict', payload: { ok: true, verdict: 'confirm' } }),
      ),
    ).toBe('pass');
    expect(
      verdictOutcome(
        entry({ eventType: 'judge-verdict', payload: { ok: true, verdict: 'refute' } }),
      ),
    ).toBe('fail');
  });

  it('marks a judge run that errored out before reaching a verdict as "errored", not failed', () => {
    // Item 5 of the mock-conformance-3 brief: `ok === false` is a judge run
    // that never ran (e.g. "failed: provider.missing-api-key"), not a
    // verdict that the work failed, so it must not read "Failed".
    expect(
      verdictOutcome(entry({ eventType: 'judge-verdict', payload: { ok: false, verdict: null } })),
    ).toBe('errored');
  });

  it('says nothing for a row kind with no pass/fail concept', () => {
    expect(verdictOutcome(entry({ eventType: 'session-start', payload: {} }))).toBeNull();
  });

  it("reads pass/fail off a grader-verdict payload's overall field", () => {
    expect(
      verdictOutcome(entry({ eventType: 'grader-verdict', payload: { overall: 'pass' } })),
    ).toBe('pass');
    expect(
      verdictOutcome(entry({ eventType: 'grader-verdict', payload: { overall: 'fail' } })),
    ).toBe('fail');
  });

  it('says nothing for a grader-verdict row with no overall recorded', () => {
    expect(
      verdictOutcome(entry({ eventType: 'grader-verdict', payload: { overall: null } })),
    ).toBeNull();
    expect(verdictOutcome(entry({ eventType: 'grader-verdict', payload: {} }))).toBeNull();
  });
});

// Item 3: the day-grouping helper backing the Activity/History day headers.
describe('lib/timelineDisplay.ts groupByDay()', () => {
  // Local (zone-less) ISO strings, not UTC `Z` ones: groupByDay buckets by
  // *local* calendar day (brief item 3), and a `Z` timestamp near midnight
  // lands on a different local day depending on the runner's own TZ — e.g.
  // it collapsed to one group under UTC+7. A zone-less string parses as the
  // local day it names, so the fixture holds regardless of the host TZ.
  const NOW = '2026-10-03T19:00:00.000';

  it('labels today and yesterday, newest day first', () => {
    const items = [
      { ts: '2026-10-03T17:47:00.000', id: 'a' },
      { ts: '2026-10-03T16:20:00.000', id: 'b' },
      { ts: '2026-10-02T09:20:00.000', id: 'c' },
    ];
    const groups = groupByDay(items, NOW);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday']);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(groups[1]?.items.map((i) => i.id)).toEqual(['c']);
  });

  it('falls back to a short date past yesterday', () => {
    const items = [{ ts: '2026-09-29T08:00:00.000', id: 'd' }];
    expect(groupByDay(items, NOW)[0]?.label).toBe('29 Sep');
  });

  it('returns no groups for an empty list', () => {
    expect(groupByDay([], NOW)).toEqual([]);
  });
});

// DS6 PR3 scope item 3: Activity's flat feed folds consecutive same-role
// dispatch rows landing in the same minute into one summary row, rather than
// the causal-tree fold above (groupDispatches), which this flat feed does not
// build. "wave" is not a field the paged timeline carries (api.ts's
// TimelineEntry/ActivityEntry has no wave/epic-wave id), so the fold keys on
// role + minute only — flagged as a deviation from the brief's "Builder ×4 in
// wave 3" wording in the PR3 return report.
describe('groupByRoleMinute', () => {
  const base: ActivityEntry = {
    eventId: 'e1',
    ts: '2026-01-01T00:00:10.000Z',
    eventType: 'dispatch_decision',
    taskId: null,
    agentId: null,
    planVersion: 1,
    causalParent: null,
    payload: { agent_role: 'builder' },
    project: null,
    actor: null,
    sessionId: 'sess-1',
    sessionTitle: 'sess-1',
    taskTitle: null,
    kind: 'Dispatched',
  };

  it('does not fold a run shorter than the minimum', () => {
    const entries = [base, { ...base, eventId: 'e2' }];
    expect(groupByRoleMinute(entries).map((i) => i.kind)).toEqual(['entry', 'entry']);
  });

  it('folds three or more same-role same-minute dispatches into one group', () => {
    const entries = [
      base,
      { ...base, eventId: 'e2', ts: '2026-01-01T00:00:20.000Z' },
      { ...base, eventId: 'e3', ts: '2026-01-01T00:00:30.000Z' },
    ];
    const items = groupByRoleMinute(entries);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'group' });
  });

  it('keeps a different role out of the run', () => {
    const entries = [
      base,
      { ...base, eventId: 'e2' },
      { ...base, eventId: 'e3', payload: { agent_role: 'judge' } },
    ];
    expect(groupByRoleMinute(entries).map((i) => i.kind)).toEqual(['entry', 'entry', 'entry']);
  });

  it('keeps a different minute out of the run', () => {
    const entries = [
      base,
      { ...base, eventId: 'e2' },
      { ...base, eventId: 'e3', ts: '2026-01-01T00:05:00.000Z' },
    ];
    expect(groupByRoleMinute(entries).map((i) => i.kind)).toEqual(['entry', 'entry', 'entry']);
  });

  it('only folds dispatch-kind rows', () => {
    const entries = [
      { ...base, kind: 'Returned' as const },
      { ...base, eventId: 'e2', kind: 'Returned' as const },
      { ...base, eventId: 'e3', kind: 'Returned' as const },
    ];
    expect(groupByRoleMinute(entries).map((i) => i.kind)).toEqual(['entry', 'entry', 'entry']);
  });
});

describe('lib/timelineDisplay.ts sessionDividerBefore() (DS6 PR4b)', () => {
  const base: TimelineEntry = entry({ sessionId: 'sess-a', sessionTitle: 'alpha' });

  it('marks no divider before the first row', () => {
    expect(sessionDividerBefore([base], 0)).toBe(false);
  });

  it('marks no divider when consecutive rows share a session', () => {
    const entries = [base, { ...base, eventId: 'e2' }];
    expect(sessionDividerBefore(entries, 1)).toBe(false);
  });

  it('marks a divider when the session id changes', () => {
    const entries = [base, { ...base, eventId: 'e2', sessionId: 'sess-b', sessionTitle: 'beta' }];
    expect(sessionDividerBefore(entries, 1)).toBe(true);
  });
});

// Fix round 5 item 3 (review): the divider must never render a bare
// "Session: " -- the server already falls back `sessionTitle` to the raw
// session id (joinSessionTitles), but the client-side label stays defensive
// against an empty string reaching it by any other path.
describe('lib/timelineDisplay.ts sessionDividerLabel() (fix round 5)', () => {
  it('uses the sessionTitle when present', () => {
    expect(sessionDividerLabel(entry({ sessionId: 'sess-a', sessionTitle: 'alpha' }))).toBe(
      'alpha',
    );
  });

  it('labels a prompt-log session by the first 8 characters of its uuid', () => {
    const sessionId = 'prompts-0a1b2c3d-1111-4111-8111-aaaaaaaaaaaa';
    expect(sessionDividerLabel(entry({ sessionId, sessionTitle: sessionId }))).toBe(
      'Prompts \u00b7 0a1b2c3d',
    );
  });

  it('falls back to the session id when sessionTitle is empty', () => {
    expect(sessionDividerLabel(entry({ sessionId: 'sess-a', sessionTitle: '' }))).toBe('sess-a');
  });

  it('shows an operator title that starts with prompts- unchanged', () => {
    expect(
      sessionDividerLabel(entry({ sessionId: 'sess-a', sessionTitle: 'prompts-roadmap' })),
    ).toBe('prompts-roadmap');
  });
});

// Gate rows carry a Passed/Failed status tag (ds-spec.md §4.3), so the title
// and meta no longer repeat the verdict word or the check name.
describe('lib/timelineDisplay.ts gateStatusTag()', () => {
  const passed = { tone: 'done', label: 'Passed', icon: 'CircleCheck' };
  const failed = { tone: 'danger', label: 'Failed', icon: 'CircleX' };
  const tag = (eventType: string, payload: Record<string, unknown>, counts?: unknown) => {
    const e = entry({ eventType, payload });
    if (counts !== undefined) (e as unknown as { gateCounts: unknown }).gateCounts = counts;
    return gateStatusTag(e);
  };

  it('reads the verdict field of schema-check / testgate / deps-check / gate-outcome', () => {
    expect(tag('schema-check-result', { valid: true })).toEqual(passed);
    expect(tag('schema-check-result', { valid: false })).toEqual(failed);
    expect(tag('testgate-result', { pass: true })).toEqual(passed);
    expect(tag('deps-check-result', { ok: false })).toEqual(failed);
    expect(tag('gate-outcome', { outcome: 'pass' })).toEqual(passed);
    expect(tag('gate-outcome', { outcome: 'blocked' })).toEqual(failed);
  });

  it('reads the grader overall verdict', () => {
    expect(tag('grader-verdict', { overall: 'pass' })).toEqual(passed);
    expect(tag('grader-verdict', { overall: 'fail' })).toEqual(failed);
  });

  it('reads artifact-check ok and the failed counts', () => {
    expect(tag('artifact-check-result', { ok: true })).toEqual(passed);
    expect(tag('artifact-check-result', { ok: false })).toEqual(failed);
    expect(tag('artifact-check-result', {}, { passed: 2, failed: 1 })).toEqual(failed);
    expect(tag('artifact-check-result', { ok: true }, { passed: 2, failed: 1 })).toEqual(failed);
    expect(tag('artifact-check-result', {})).toBeNull();
  });

  it('reads commit-check certified and integration-check pass', () => {
    expect(tag('commit-check-result', { certified: true })).toEqual(passed);
    expect(tag('commit-check-result', { certified: false })).toEqual(failed);
    expect(tag('integration-check', { pass: true })).toEqual(passed);
    expect(tag('integration-check', { pass: false })).toEqual(failed);
  });

  it('never guesses a pass: no tag when the verdict field is absent or mistyped', () => {
    expect(tag('schema-check-result', {})).toBeNull();
    expect(tag('testgate-result', { pass: 'false' })).toBeNull();
    expect(tag('gate-outcome', {})).toBeNull();
    expect(tag('commit-check-result', {})).toBeNull();
    expect(tag('grader-verdict', {})).toBeNull();
  });

  it('has no tag for a gate type without a verdict field, or a non-gate row', () => {
    expect(tag('budget-check-result', { status: 'checked' })).toBeNull();
    expect(tag('judges-outstanding', {})).toBeNull();
    expect(tag('coverage-evidence', {})).toBeNull();
    expect(tag('user_prompt', { pass: true })).toBeNull();
  });
});

describe('gate row title and meta without repeats', () => {
  it('drops the verdict word from the title when a status tag shows it', () => {
    expect(titleFor(entry({ eventType: 'schema-check-result', payload: { valid: true } }))).toBe(
      'Schema check',
    );
    expect(titleFor(entry({ eventType: 'testgate-result', payload: { pass: false } }))).toBe(
      'Test gate',
    );
    expect(
      titleFor(entry({ eventType: 'deps-check-result', payload: { ok: true, detail: 'no .bin' } })),
    ).toBe('Dependency check: no .bin');
    expect(titleFor(entry({ eventType: 'gate-outcome', payload: { outcome: 'pass' } }))).toBe(
      'Gate outcome',
    );
    expect(titleFor(entry({ eventType: 'gate-outcome', payload: { outcome: 'blocked' } }))).toBe(
      'Gate outcome: blocked',
    );
    expect(
      titleFor(
        entry({ eventType: 'gate-outcome', payload: { outcome: 'pass-with-waivers-pending' } }),
      ),
    ).toBe('Gate outcome: pass-with-waivers-pending');
  });

  it('leaves out of the meta the check name the title already names', () => {
    expect(metaFor(entry({ eventType: 'schema-check-result', payload: { valid: true } }))).toBe('');
    expect(
      metaFor(entry({ eventType: 'grader-verdict', payload: { overall: 'pass', round: 2 } })),
    ).toBe('round 2');
    const e = entry({ eventType: 'artifact-check-result', payload: { ok: true } });
    (e as unknown as { gateCounts: unknown }).gateCounts = { passed: 3, failed: 0 };
    expect(metaFor(e)).toBe('3 of 3 passed');
  });

  it('keeps the check name when the title does not carry it', () => {
    expect(metaFor(entry({ eventType: 'testgate-result', payload: { pass: true } }))).toBe(
      'Unit tests',
    );
  });
});

describe('lib/timelineDisplay.ts empty gate checks carry no status tag', () => {
  const withCounts = (eventType: string, payload: Record<string, unknown>, counts: unknown) => {
    const e = entry({ eventType, payload });
    (e as unknown as { gateCounts: unknown }).gateCounts = counts;
    return gateStatusTag(e);
  };
  it('returns null when nothing was checked', () => {
    expect(withCounts('artifact-check-result', { ok: true }, { passed: 0, failed: 0 })).toBeNull();
    expect(withCounts('testgate-result', { pass: true }, { passed: 0, failed: 0 })).toBeNull();
  });
  it('still tags a non-empty pass and a schema check without counts', () => {
    expect(withCounts('artifact-check-result', { ok: true }, { passed: 3, failed: 0 })).toEqual({
      tone: 'done',
      label: 'Passed',
      icon: 'CircleCheck',
    });
    expect(withCounts('schema-check-result', { valid: true }, undefined)).toEqual({
      tone: 'done',
      label: 'Passed',
      icon: 'CircleCheck',
    });
  });
});

describe('lib/timelineDisplay.ts budget-check-result title and meta', () => {
  const budget = (payload: Record<string, unknown>) =>
    entry({ eventType: 'budget-check-result', payload });
  it('titles each status from the payload', () => {
    expect(titleFor(budget({ status: 'checked', overruns: [] }))).toBe(
      'Budget check: within budget',
    );
    expect(
      titleFor(
        budget({ status: 'checked', overruns: [{ field: 'diff_lines', cap: 480, measured: 543 }] }),
      ),
    ).toBe('Budget check: over budget');
    expect(titleFor(budget({ status: 'not-declared' }))).toBe('Budget check: no budget declared');
    expect(titleFor(budget({ status: 'unmeasurable' }))).toBe('Budget check: could not measure');
  });
  it('falls back for a missing or unknown status and never tags', () => {
    expect(titleFor(budget({}))).toBe('Budget check result');
    expect(titleFor(budget({ status: 'weird' }))).toBe('Budget check result');
    expect(gateStatusTag(budget({ status: 'checked', overruns: [] }))).toBeNull();
  });
  it('lists one meta item per overrun from real numbers', () => {
    const e = budget({
      status: 'checked',
      overruns: [
        { field: 'diff_lines', cap: 480, measured: 543 },
        { field: 'tokens', cap: 1_000_000, measured: 1_200_000 },
      ],
    });
    expect(metaFor(e)).toBe('543 lines changed, cap 480 · 1.2M tokens, cap 1M');
  });
  it('skips a malformed overrun and prints nothing for none', () => {
    expect(
      metaFor(
        budget({
          status: 'checked',
          overruns: [
            { field: 'diff_lines', cap: 480 },
            { field: 'diff_lines', cap: 'x', measured: 5 },
          ],
        }),
      ),
    ).toBe('');
    expect(metaFor(budget({ status: 'checked', overruns: [] }))).toBe('');
  });
});

describe('lib/timelineDisplay.ts empty gate checks still recorded a verdict', () => {
  const title = (eventType: string, payload: Record<string, unknown>) => {
    const e = entry({ eventType, payload });
    (e as unknown as { gateCounts: unknown }).gateCounts = { passed: 0, failed: 0 };
    return titleFor(e);
  };
  it('a test gate with pass:true and nothing to run is not "no verdict recorded"', () => {
    expect(title('testgate-result', { pass: true })).toBe('Test gate');
  });
  it('a schema check with valid:true and nothing to run keeps its plain title', () => {
    expect(title('schema-check-result', { valid: true })).toBe('Schema check');
  });
  it('a deps check with a verdict keeps its detail', () => {
    expect(title('deps-check-result', { ok: true, detail: 'no .bin' })).toBe(
      'Dependency check: no .bin',
    );
  });
  it('still says "no verdict recorded" when the verdict field is absent', () => {
    expect(title('testgate-result', {})).toBe('Test gate: no verdict recorded');
    expect(title('schema-check-result', {})).toBe('Schema check: no verdict recorded');
    expect(title('deps-check-result', { detail: 'no .bin' })).toBe(
      'Dependency check (no verdict recorded): no .bin',
    );
  });
});

// Operator decision 2026-10-08: with more than one project in the feed, the
// divider names the project. A store is not a project, so only `project` counts.
describe('lib/timelineDisplay.ts isMultiProjectFeed()', () => {
  it('is false for an empty feed, one project, or nulls beside one project', () => {
    expect(isMultiProjectFeed([])).toBe(false);
    expect(
      isMultiProjectFeed([entry({ project: 'project-a' }), entry({ project: 'project-a' })]),
    ).toBe(false);
    expect(isMultiProjectFeed([entry({ project: 'project-a' }), entry({ project: null })])).toBe(
      false,
    );
  });

  it('is true once two distinct non-null projects appear', () => {
    expect(
      isMultiProjectFeed([entry({ project: 'project-a' }), entry({ project: 'project-b' })]),
    ).toBe(true);
  });
});

describe('lib/timelineDisplay.ts sessionDividerText()', () => {
  const e = entry({ sessionId: 'sess-a', sessionTitle: 'epic-1', project: 'project-b' });

  it('reads "Session: <title>" in a one-project feed', () => {
    expect(sessionDividerText(e, false)).toBe('Session: epic-1');
  });

  it('prefixes the project in a multi-project feed', () => {
    expect(sessionDividerText(e, true)).toBe('project-b · Session: epic-1');
  });

  it('stays "Session: <title>" when the entry has no project', () => {
    expect(sessionDividerText({ ...e, project: null }, true)).toBe('Session: epic-1');
  });
});
