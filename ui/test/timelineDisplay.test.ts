import { describe, expect, it } from 'vitest';
import { loadTaxonomy } from '../../factory/orchestrator/src/taxonomy.js';
import type { TimelineEntry } from '../src/lib/api.js';
import {
  buildCausalTree,
  DISPATCH_GROUP_MIN,
  type DispatchGroup,
  groupDispatches,
  iconFor,
  KIND_OPTIONS,
  matchesKind,
  type TimelineItem,
  type TimelineNode,
  timelineItems,
  tintFor,
  titleFor,
} from '../src/lib/timelineDisplay.js';
import { nth } from './helpers.js';

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
    ...overrides,
  };
}

/**
 * The group at `index`, typed as one. A `kind === 'group'` check on an index
 * read narrows nothing that survives to the next property, so the assertions
 * below each carried their own `&&` or ternary — and those assert `false` or
 * `''` when the fold produced a plain row, reporting a label mismatch for what
 * is really a fold that did not happen.
 */
function groupAt(items: TimelineItem[], index: number): DispatchGroup {
  const item = items[index];
  if (item?.kind !== 'group') {
    throw new Error(`expected a group at ${index}, got ${item?.kind ?? 'nothing'}`);
  }
  return item.group;
}

describe('lib/timelineDisplay.ts', () => {
  it('maps user_prompt to message-circle/blue', () => {
    const e = entry({ eventType: 'user_prompt', payload: { prompt: 'hello' } });
    expect(iconFor(e)).toBe('message-circle');
    expect(tintFor(e)).toBe('blue');
    expect(titleFor(e)).toBe('hello');
  });

  it('maps dispatch_decision to send/slate', () => {
    const e = entry({ eventType: 'dispatch_decision', payload: { agent_role: 'coder' } });
    expect(iconFor(e)).toBe('send');
    expect(tintFor(e)).toBe('slate');
  });

  it('picks shield-check for a passing gate-outcome, shield-alert for blocked', () => {
    expect(iconFor(entry({ eventType: 'gate-outcome', payload: { outcome: 'pass' } }))).toBe(
      'shield-check',
    );
    expect(iconFor(entry({ eventType: 'gate-outcome', payload: { outcome: 'blocked' } }))).toBe(
      'shield-alert',
    );
  });

  it('picks shield-alert for a failed schema-check-result / testgate-result', () => {
    expect(iconFor(entry({ eventType: 'schema-check-result', payload: { valid: false } }))).toBe(
      'shield-alert',
    );
    expect(iconFor(entry({ eventType: 'testgate-result', payload: { pass: false } }))).toBe(
      'shield-alert',
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
      expect(iconFor(entry({ eventType, payload: {} }))).toBe('circle-alert');
    }
    expect(titleFor(entry({ eventType: 'testgate-result', payload: {} }))).toBe(
      'Test gate — no verdict recorded',
    );
    expect(titleFor(entry({ eventType: 'schema-check-result', payload: {} }))).toBe(
      'Schema check — no verdict recorded',
    );
    expect(
      titleFor(entry({ eventType: 'deps-check-result', payload: { detail: 'no .bin' } })),
    ).toBe('Dependency check — no verdict recorded: no .bin');
  });

  // A verdict field of the wrong type is not a verdict. `pass: 'false'` is
  // the shape a shell template or a hand-edited payload produces, and under
  // `!== false` a *string* saying false read as a pass -- the worst of the
  // three cases, because the writer did record a failure.
  it('treats a non-boolean verdict as unrecorded, not as a pass (D-169)', () => {
    expect(iconFor(entry({ eventType: 'testgate-result', payload: { pass: 'false' } }))).toBe(
      'circle-alert',
    );
    expect(iconFor(entry({ eventType: 'schema-check-result', payload: { valid: null } }))).toBe(
      'circle-alert',
    );
  });

  // gate-outcome already tested `outcome` positively, so its icon was never
  // wrong; its title still printed a dangling em dash for the same absence.
  // Not observed on any real log -- fixed here because it is the fourth
  // branch of the same switch and the next reader should find one rule.
  it('names a missing gate outcome instead of trailing an empty dash (D-169)', () => {
    expect(iconFor(entry({ eventType: 'gate-outcome', payload: {} }))).toBe('circle-alert');
    expect(titleFor(entry({ eventType: 'gate-outcome', payload: {} }))).toBe(
      'Gate outcome — no outcome recorded',
    );
  });

  // P9-16(d) added a gate stage; a stage the dashboard renders as a generic
  // `history` row reads as trivia, and this one is the reason a green epic
  // was measuring the wrong node_modules.
  it('renders deps-check-result as the gate stage it is', () => {
    expect(iconFor(entry({ eventType: 'deps-check-result', payload: { ok: false } }))).toBe(
      'shield-alert',
    );
    expect(iconFor(entry({ eventType: 'deps-check-result', payload: { ok: true } }))).toBe(
      'shield-check',
    );
    expect(
      titleFor(
        entry({ eventType: 'deps-check-result', payload: { ok: false, detail: 'no .bin' } }),
      ),
    ).toBe('Dependency check — failed: no .bin');
  });

  // The other half of the fix that put seven free event types onto the
  // timeline (queries.ts's FREE_TIMELINE_EVENT_TYPES). Reaching the operator's
  // screen as `lesson-candidate-raised` with a generic clock is only half a
  // row: the type is the machine's name for the event, not the event.
  describe('the free event types the timeline filter used to drop', () => {
    it('titles a session start with its note', () => {
      const e = entry({ eventType: 'session-start', payload: { note: 'dogfood run 2' } });
      expect(iconFor(e)).toBe('play');
      expect(titleFor(e)).toBe('Session started — dogfood run 2');
      expect(titleFor(entry({ eventType: 'session-start', payload: {} }))).toBe('Session started');
    });

    it('titles a task result with its run status and agent', () => {
      const e = entry({
        eventType: 'task-result-recorded',
        payload: { run_status: 'done', agent: 'coder', diff_lines_changed: 42 },
      });
      expect(iconFor(e)).toBe('file-check');
      expect(titleFor(e)).toBe('Task result — done (coder, 42 lines changed)');
    });

    it('titles a judge verdict, and names a failure by its cause', () => {
      expect(
        titleFor(
          entry({
            eventType: 'judge-verdict',
            payload: { ok: true, verdict: 'refute', agent: 'verifier', provider: 'deepseek' },
          }),
        ),
      ).toBe('Judge verdict — refute (verifier/deepseek)');
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
      ).toBe('Judge verdict — failed: provider.missing-api-key (verifier/deepseek)');
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
      ).toBe('Judge verdict — failed: provider.invalid-output (verifier/codex)');
      // Written before D-253 stamped the code: the row says the run failed
      // and stops there, rather than naming a cause the log never recorded.
      expect(
        titleFor(
          entry({
            eventType: 'judge-verdict',
            payload: { ok: false, verdict: null, agent: 'verifier', provider: 'deepseek' },
          }),
        ),
      ).toBe('Judge verdict — failed (verifier/deepseek)');
    });

    it('titles a judge report with its finding count', () => {
      const e = entry({
        eventType: 'judge-reported',
        payload: { agent_role: 'reviewer', round: 2, finding_count: 3 },
      });
      expect(iconFor(e)).toBe('scale');
      expect(titleFor(e)).toBe('reviewer reported — 3 findings (round 2)');
      expect(
        titleFor(
          entry({
            eventType: 'judge-reported',
            payload: { agent_role: 'reviewer', round: 1, finding_count: 1 },
          }),
        ),
      ).toBe('reviewer reported — 1 finding (round 1)');
    });

    it('titles an epic close with its verdict and merge count', () => {
      const e = entry({
        eventType: 'epic-closed',
        payload: { epic_id: 'dogfood-2', machine_verdict: 'pass', tasks_merged: 4 },
      });
      expect(iconFor(e)).toBe('git-merge');
      expect(titleFor(e)).toBe('Epic closed — dogfood-2: pass, 4 tasks merged');
    });

    it('titles lesson events with the statement, not the id', () => {
      expect(
        iconFor(entry({ eventType: 'lesson-candidate-raised', payload: { statement: 'x' } })),
      ).toBe('graduation-cap');
      expect(
        titleFor(
          entry({
            eventType: 'lesson-candidate-raised',
            payload: { lesson_id: 'L-9', statement: 'Pin the lockfile' },
          }),
        ),
      ).toBe('Lesson candidate — Pin the lockfile');
      expect(
        titleFor(
          entry({ eventType: 'lesson-edited', payload: { lesson_id: 'L-9', statement: 'Pin it' } }),
        ),
      ).toBe('Lesson edited — Pin it');
      // An edit that changes only the type or scope carries no statement.
      expect(titleFor(entry({ eventType: 'lesson-edited', payload: { lesson_id: 'L-9' } }))).toBe(
        'Lesson edited — L-9',
      );
      expect(
        titleFor(
          entry({
            eventType: 'lesson-status-changed',
            payload: { lesson_id: 'L-9', to_status: 'active' },
          }),
        ),
      ).toBe('Lesson L-9 — active');
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

  // D-153. The same defect one type further out, and the loudest instance of
  // it: `operator-note` ties for third most common in the factory's own logs
  // (57 of 668) and is the only one carrying the operator's reasoning in their
  // own words. It reached neither the filter (queries.ts) nor a case here, so
  // the one lens an operator opens to re-read their own decisions showed none
  // of them.
  describe('operator-note', () => {
    it('titles the note by its own text, not by its event type', () => {
      const e = entry({
        eventType: 'operator-note',
        payload: { note: 'artifact home relocation before the task-2 gate run' },
      });
      expect(titleFor(e)).toBe('artifact home relocation before the task-2 gate run');
      expect(iconFor(e)).toBe('file-text');
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
      ).toBe('correction — correcting 179');
    });

    // Tinted with user_prompt rather than with the machine events: what these
    // two have in common is that a person wrote them, which is exactly the
    // grouping the "Prompts" chip selects on.
    it('shares the operator tint with user_prompt', () => {
      expect(tintFor(entry({ eventType: 'operator-note' }))).toBe('blue');
    });
  });

  // The other half of D-153, and the half the operator reported: rendering
  // operator-note correctly is worth nothing while the chip they reach for to
  // find it selects a single event type that this factory's logs contain none
  // of. The chip says "Prompts", so it has to mean everything a person said —
  // otherwise the filter is a permanently empty view of a full log.
  describe('matchesKind', () => {
    it('selects every operator-authored event under Prompts, not one type', () => {
      expect(matchesKind(entry({ eventType: 'user_prompt' }), ['user_prompt'])).toBe(true);
      expect(matchesKind(entry({ eventType: 'operator-note' }), ['user_prompt'])).toBe(true);
      expect(matchesKind(entry({ eventType: 'dispatch_decision' }), ['user_prompt'])).toBe(false);
    });

    it('leaves the gate chip covering the gate stages, and an empty filter covering all', () => {
      expect(matchesKind(entry({ eventType: 'testgate-result' }), ['gate'])).toBe(true);
      expect(matchesKind(entry({ eventType: 'gate-outcome' }), ['gate'])).toBe(true);
      expect(matchesKind(entry({ eventType: 'user_prompt' }), ['gate'])).toBe(false);
      expect(matchesKind(entry({ eventType: 'anything-at-all' }), [])).toBe(true);
    });

    it('unions the selected chips rather than intersecting them', () => {
      const chips = ['user_prompt', 'error-logged'];
      expect(matchesKind(entry({ eventType: 'operator-note' }), chips)).toBe(true);
      expect(matchesKind(entry({ eventType: 'error-logged' }), chips)).toBe(true);
      expect(matchesKind(entry({ eventType: 'dispatch_decision' }), chips)).toBe(false);
    });

    // D-162. The gate chip hand-copied the nine subtypes the design-spec's
    // §5.2 mock happens to draw, and that mock's own caption warns against
    // exactly this: the parenthetical is "the ones this mock renders, not the
    // whole dimension; the closed list is `gate_event` in
    // factory/policies/taxonomy.yml". The dimension has grown to 21 since, so
    // the chip an operator clicks to see the gates dropped 102 of the 403 gate
    // rows in this factory's own logs — every artifact check, every commit
    // check, every grader verdict, every budget check, every quorum decision.
    // A browser can't read the yml, so the list stays a copy; deriving the
    // ASSERTION from the yml is what keeps the copy from drifting again.
    it('gives the gate chip the whole gate_event dimension, not the mock subset', () => {
      const dimension = loadTaxonomy().dimensions.gate_event ?? [];
      const chip = KIND_OPTIONS.find((option) => option.value === 'gate')?.types ?? [];
      expect(dimension.length).toBeGreaterThan(0);
      expect([...chip].sort()).toEqual([...dimension].sort());
    });

    // A type claimed by two chips renders under two labels, so deselecting the
    // one the operator means still leaves the row on screen.
    it('gives every chip event types, and gives no event type to two chips', () => {
      expect(KIND_OPTIONS.filter((o) => o.types.length === 0)).toEqual([]);
      const claimed = KIND_OPTIONS.flatMap((o) => o.types);
      expect(claimed.length).toBe(new Set(claimed).size);
    });
  });

  describe('buildCausalTree', () => {
    const at = (n: number) => `2026-08-01T00:00:0${n}.000Z`;

    it('nests an entry under its causal parent', () => {
      const tree = buildCausalTree([
        entry({ eventId: 'a', ts: at(1) }),
        entry({ eventId: 'b', ts: at(2), causalParent: 'a' }),
      ]);
      expect(tree.map((n) => n.entry.eventId)).toEqual(['a']);
      expect(nth(tree, 0).children.map((n) => n.entry.eventId)).toEqual(['b']);
    });

    it('promotes an entry whose parent is filtered out of the set', () => {
      const tree = buildCausalTree([entry({ eventId: 'b', ts: at(2), causalParent: 'a' })]);
      expect(tree.map((n) => n.entry.eventId)).toEqual(['b']);
    });

    it('sorts roots newest-first and children oldest-first', () => {
      const tree = buildCausalTree([
        entry({ eventId: 'r1', ts: at(1) }),
        entry({ eventId: 'r2', ts: at(4) }),
        entry({ eventId: 'c2', ts: at(3), causalParent: 'r1' }),
        entry({ eventId: 'c1', ts: at(2), causalParent: 'r1' }),
      ]);
      expect(tree.map((n) => n.entry.eventId)).toEqual(['r2', 'r1']);
      expect(nth(tree, 1).children.map((n) => n.entry.eventId)).toEqual(['c1', 'c2']);
    });

    // session-start is the log's root marker, not a cause. Every event in a
    // session descends from it, so if it adopts children the entire session
    // renders as one collapsed row and the operator's Timeline is empty until
    // they click. This only became reachable when session-start started
    // reaching the timeline at all; before that the filter dropped it and its
    // children were roots by accident.
    it('keeps a session-start row without letting it adopt the session', () => {
      const tree = buildCausalTree([
        entry({ eventId: 's', ts: at(1), eventType: 'session-start' }),
        entry({ eventId: 'p', ts: at(2), eventType: 'user_prompt', causalParent: 's' }),
        entry({ eventId: 'd', ts: at(3), eventType: 'dispatch_decision', causalParent: 'p' }),
      ]);
      expect(tree.map((n) => n.entry.eventId)).toEqual(['p', 's']);
      expect(nth(tree, 1).children).toEqual([]);
      // Only session-start is exempt — the rest of the chain still nests.
      expect(nth(tree, 0).children.map((n) => n.entry.eventId)).toEqual(['d']);
    });
  });

  // The operator's ask: a timeline should show the rows a person wrote, and
  // fold the ones agents wrote to each other. `dispatch_decision` is the
  // second kind — one row per subagent handed a task — and a planner fanning
  // out eight coders costs eight rows that say the same thing eight times.
  // Folding a run into one header is the sessions-canvas band idiom (the
  // agents under a session collapse into one node with a count) applied to a
  // list: the count and the roles stay visible, the rows go behind a click.
  describe('groupDispatches', () => {
    const at = (n: number) => `2026-08-01T00:00:${String(n).padStart(2, '0')}.000Z`;

    function node(id: string, role: string | null, ts = at(1)): TimelineNode {
      return {
        entry: entry({
          eventId: id,
          ts,
          eventType: 'dispatch_decision',
          payload: role ? { agent_role: role } : {},
        }),
        children: [],
      };
    }
    function other(id: string, ts = at(1)): TimelineNode {
      return { entry: entry({ eventId: id, ts, eventType: 'user_prompt' }), children: [] };
    }
    const ids = (items: ReturnType<typeof groupDispatches>) =>
      items.map((i) =>
        i.kind === 'group' ? i.group.members.map((m) => m.entry.eventId) : i.node.entry.eventId,
      );

    it('folds a run of consecutive dispatch siblings into one group', () => {
      const items = groupDispatches([
        node('d1', 'coder'),
        node('d2', 'coder'),
        node('d3', 'coder'),
      ]);
      expect(items.length).toBe(1);
      expect(items[0]?.kind).toBe('group');
      expect(ids(items)).toEqual([['d1', 'd2', 'd3']]);
    });

    // A group is a disclosure: it trades rows for a click. Below the threshold
    // the trade is a loss — two rows become one header plus a click to see the
    // same two rows — so short runs stay as they are.
    it('leaves a run shorter than the threshold as plain rows', () => {
      const short = Array.from({ length: DISPATCH_GROUP_MIN - 1 }, (_, i) =>
        node(`d${i}`, 'coder'),
      );
      const items = groupDispatches(short);
      expect(items.every((i) => i.kind === 'entry')).toBe(true);
      expect(items.length).toBe(short.length);
    });

    // Grouping is a fold over the siblings in the order they are already in.
    // Pulling every dispatch out to one group would reorder the timeline, and
    // the order is the causality the page exists to show.
    it('keeps the surrounding rows in place and splits runs a non-dispatch interrupts', () => {
      const items = groupDispatches([
        other('p1'),
        node('d1', 'coder'),
        node('d2', 'coder'),
        node('d3', 'coder'),
        other('p2'),
        node('d4', 'coder'),
        node('d5', 'coder'),
        node('d6', 'coder'),
      ]);
      expect(ids(items)).toEqual(['p1', ['d1', 'd2', 'd3'], 'p2', ['d4', 'd5', 'd6']]);
    });

    it('names the count and the roles in the run, commonest first', () => {
      const items = groupDispatches([
        node('d1', 'coder'),
        node('d2', 'reviewer'),
        node('d3', 'coder'),
        node('d4', 'coder'),
        node('d5', 'reviewer'),
      ]);
      expect(groupAt(items, 0).label).toBe('5 dispatches — coder ×3, reviewer ×2');
    });

    // `×1` on four of five roles is noise, and the count is already in the
    // header. A role that appears once is named once.
    it('drops the multiplier for a role that appears once, and caps a long list', () => {
      const once = groupDispatches([node('a', 'coder'), node('b', 'coder'), node('c', 'tester')]);
      expect(groupAt(once, 0).label).toBe('3 dispatches — coder ×2, tester');

      const many = groupDispatches(
        ['coder', 'coder', 'reviewer', 'tester', 'planner', 'scribe'].map((r, i) =>
          node(`m${i}`, r),
        ),
      );
      expect(groupAt(many, 0).label).toBe('6 dispatches — coder ×2, planner, reviewer, +2 more');
    });

    it("falls back to the row's own word for a dispatch with no role", () => {
      const items = groupDispatches([node('a', null), node('b', null), node('c', null)]);
      expect(groupAt(items, 0).label).toBe('3 dispatches — agent ×3');
    });

    // The id is the key the expand/collapse Set holds. Roots render newest
    // first and children oldest first, so a run's *display* first row is not
    // stable across those two orders — an id taken from it would reset an open
    // group the next time the page polled. The oldest member is the same row
    // either way.
    it('keys the group on its oldest member, whichever end it renders from', () => {
      const forwards = groupDispatches([
        node('d1', 'coder', at(1)),
        node('d2', 'coder', at(2)),
        node('d3', 'coder', at(3)),
      ]);
      const backwards = groupDispatches([
        node('d3', 'coder', at(3)),
        node('d2', 'coder', at(2)),
        node('d1', 'coder', at(1)),
      ]);
      const id = groupAt(forwards, 0).id;
      expect(id).toContain('d1');
      expect(groupAt(backwards, 0).id).toBe(id);
    });

    // A group id shares the one expanded Set with every row id, so a
    // collision would tie a group's disclosure to an unrelated row's.
    it('namespaces the group id away from the event ids it holds', () => {
      const items = groupDispatches([
        node('d1', 'coder'),
        node('d2', 'coder'),
        node('d3', 'coder'),
      ]);
      const id = groupAt(items, 0).id;
      expect(['d1', 'd2', 'd3']).not.toContain(id);
    });

    it('leaves a level with no dispatches untouched', () => {
      const items = groupDispatches([other('p1'), other('p2')]);
      expect(ids(items)).toEqual(['p1', 'p2']);
    });

    // The renderer is recursive and a group's members are, by construction, a
    // foldable run: folding them again rebuilds the same group under the same
    // id, which the expanded set still holds open, and the renderer descends
    // into it forever. Inside a group, rows are rows.
    it("renders a group's own members unfolded, so an expanded group cannot refold itself", () => {
      const run = [node('d1', 'coder'), node('d2', 'coder'), node('d3', 'coder')];
      const folded = timelineItems(run, true);
      expect(folded[0]?.kind).toBe('group');

      const inner = timelineItems(groupAt(folded, 0).members, false);
      expect(inner.every((i) => i.kind === 'entry')).toBe(true);
      expect(ids(inner)).toEqual(['d1', 'd2', 'd3']);
    });
  });
});
