// Timeline row anatomy (design-spec.md §5.2): icon+tint is decorative
// grouping by EVENT KIND only, never status — actual outcome renders as a
// Lozenge (taxonomy.ts) alongside it, never via tint alone.
import type { TimelineEntry } from './api.js';

export type RowTint = 'blue' | 'slate' | 'lilac';

/** CausalTimelineList's pre-built causal-parent tree node (moved here, not
 * exported from a .vue SFC — see components/hds/types.ts's header comment
 * for why: ui/tsconfig.json doesn't type-check .vue files). */
export interface TimelineNode {
  entry: TimelineEntry;
  children: TimelineNode[];
}

/** Event types that are a log's root marker rather than a cause. Every event
 * in a session names session-start somewhere up its causal chain, so letting
 * it adopt children renders the whole session as one collapsed row — the more
 * complete the timeline, the less it shows. It stays in the list as its own
 * row; it just doesn't swallow the session underneath it. Only reachable
 * since session-start began reaching the timeline at all; before that the
 * event-type filter dropped it and its children were roots by accident. */
const NON_ADOPTING_EVENT_TYPES = new Set(['session-start']);

/** Builds CausalTimelineList's disclosure tree from a *filtered* entry set:
 * an entry whose causal parent isn't in the set is promoted to a root, so the
 * tree always spans exactly what the operator asked to see. */
export function buildCausalTree(entries: TimelineEntry[]): TimelineNode[] {
  const byId = new Map(entries.map((e) => [e.eventId, e]));
  const childrenOf = new Map<string, TimelineEntry[]>();
  const roots: TimelineEntry[] = [];
  for (const entry of entries) {
    const parent = entry.causalParent ? byId.get(entry.causalParent) : undefined;
    if (parent && !NON_ADOPTING_EVENT_TYPES.has(parent.eventType)) {
      const list = childrenOf.get(parent.eventId) ?? [];
      list.push(entry);
      childrenOf.set(parent.eventId, list);
    } else {
      roots.push(entry);
    }
  }
  function build(entry: TimelineEntry): TimelineNode {
    const kids = (childrenOf.get(entry.eventId) ?? []).sort((a, b) => a.ts.localeCompare(b.ts));
    return { entry, children: kids.map(build) };
  }
  return [...roots].sort((a, b) => b.ts.localeCompare(a.ts)).map(build);
}

/**
 * A run of consecutive sibling `dispatch_decision` rows, folded into one.
 *
 * The timeline carries two kinds of prompt: the ones a person wrote, and the
 * ones agents handed each other. A planner fanning out eight coders writes
 * eight dispatch rows that differ only in a role and a sentence, and they push
 * the operator's own words off the screen. This is the sessions-canvas band
 * idiom applied to a list — the agents under a session collapse into one node
 * carrying a count, so a run of dispatches collapses into one row carrying the
 * count and the roles, with the rows themselves one click away.
 */
export interface DispatchGroup {
  id: string;
  label: string;
  members: TimelineNode[];
}

/** What a level of the tree renders as: a row, or a folded run of them. */
export type TimelineItem =
  | { kind: 'entry'; node: TimelineNode }
  | { kind: 'group'; group: DispatchGroup };

/**
 * Shortest run worth folding. A group trades rows for a click, so two rows
 * becoming one header plus a click to see the same two rows is a loss; three
 * is the first length where the fold pays for itself.
 */
export const DISPATCH_GROUP_MIN = 3;

/** How many distinct roles a group header names before it counts the rest. */
const LABEL_ROLE_CAP = 3;

function dispatchRole(node: TimelineNode): string {
  const p = node.entry.payload as { agent_role?: string };
  // `agent` is titleFor's own fallback for the same missing field: a folded
  // row and an unfolded one should not disagree about what was dispatched.
  return p.agent_role ?? 'agent';
}

function groupLabel(members: TimelineNode[]): string {
  const counts = new Map<string, number>();
  for (const m of members) {
    const role = dispatchRole(m);
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  // Commonest role first, ties alphabetical — what the run mostly was, then a
  // stable order so the header doesn't reshuffle itself between polls.
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = ranked
    .slice(0, LABEL_ROLE_CAP)
    // `×1` on a role that appears once is noise the header count already
    // covers; the role is named, and that is the whole fact about it.
    .map(([role, n]) => (n > 1 ? `${role} ×${n}` : role));
  const rest = ranked.length - shown.length;
  const roles = rest > 0 ? [...shown, `+${rest} more`] : shown;
  return `${members.length} dispatches — ${roles.join(', ')}`;
}

function groupId(members: TimelineNode[]): string {
  // Keyed on the oldest member, not the first rendered one: roots render
  // newest-first and children oldest-first, so the run's leading row differs
  // between the two orders. The id is what the expanded Set holds, and an id
  // that moved would close an open group on the next 15s poll. The prefix
  // keeps it out of the same Set's event-id namespace.
  const oldest = members.reduce((a, b) =>
    a.entry.ts < b.entry.ts || (a.entry.ts === b.entry.ts && a.entry.eventId <= b.entry.eventId)
      ? a
      : b,
  );
  return `dispatch-group-${oldest.entry.eventId}`;
}

/**
 * Fold each run of consecutive `dispatch_decision` siblings at one level of
 * the tree into a group, leaving every other row where it is.
 *
 * A fold over the siblings *in the order they already have* — not a partition
 * that gathers every dispatch at the level into one group. That order is the
 * causality the timeline exists to show, and a group that reordered rows to
 * make itself bigger would be trading the page's subject for its size.
 */
export function groupDispatches(nodes: TimelineNode[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let run: TimelineNode[] = [];
  const flush = () => {
    if (run.length >= DISPATCH_GROUP_MIN) {
      items.push({
        kind: 'group',
        group: { id: groupId(run), label: groupLabel(run), members: run },
      });
    } else {
      for (const node of run) items.push({ kind: 'entry', node });
    }
    run = [];
  };
  for (const node of nodes) {
    if (node.entry.eventType === 'dispatch_decision') run.push(node);
    else {
      flush();
      items.push({ kind: 'entry', node });
    }
  }
  flush();
  return items;
}

/**
 * What one level of the recursive renderer draws: folded, or plainly.
 *
 * The `false` case is not a preference — it is what keeps the fold finite. A
 * group's members are by construction a run of dispatches long enough to fold,
 * so handing them back to `groupDispatches` rebuilds the identical group, with
 * the identical id, which the expanded set still holds open: the renderer
 * would descend into it forever. Inside a group, the rows render as rows.
 */
export function timelineItems(nodes: TimelineNode[], fold: boolean): TimelineItem[] {
  return fold ? groupDispatches(nodes) : nodes.map((node) => ({ kind: 'entry', node }));
}

/** One FilterChips option, carrying the event types it selects rather than
 * relying on its `value` being an event type. `Prompts` is the reason: what an
 * operator means by it is "the rows a person wrote", which is two types today
 * and was one when the chip was written. */
export interface KindOption {
  value: string;
  label: string;
  types: readonly string[];
}

/**
 * TimelinePage's event-kind chips (design-spec.md §5.2), here rather than in
 * the SFC so the mapping is type-checked and tested — ui/tsconfig.json doesn't
 * type-check .vue files, and this list held the D-153 defect precisely because
 * nothing could reach it: `Prompts` selected `user_prompt` alone, which the
 * factory's own logs contain none of, so the one chip an operator reaches for
 * to re-read their own decisions returned an empty timeline over a full log.
 */
export const KIND_OPTIONS: readonly KindOption[] = [
  // Both types, and both directions of the fix: operator-note is what this
  // factory has 57 of, user_prompt is what `smith prompt record` writes. A
  // chip that means "a person said this" has to cover the ones already logged
  // and the ones logged from now on.
  { value: 'user_prompt', label: 'Prompts', types: ['user_prompt', 'operator-note'] },
  { value: 'dispatch_decision', label: 'Dispatches', types: ['dispatch_decision'] },
  // D-162. This was the nine subtypes design-spec.md §5.2's mock draws plus
  // deps-check-result, and the mock's caption warns against reading it as the
  // list: "the ones this mock renders, not the whole dimension; the closed
  // list is `gate_event` in factory/policies/taxonomy.yml". The dimension had
  // reached 21, so the chip an operator clicks to see the gates hid 102 of the
  // 403 gate rows in this factory's own logs — every artifact check, commit
  // check, grader verdict, budget check and quorum decision among them. The
  // whole dimension now, in its taxonomy order; a browser can't read the yml,
  // so what holds the copy to it is the test that does.
  {
    value: 'gate',
    label: 'Gate events',
    types: [
      'schema-check-result',
      'artifact-check-result',
      'commit-check-result',
      'deps-check-result',
      'judges-outstanding',
      'grader-verdict',
      'budget-check-result',
      'testgate-result',
      'coverage-evidence',
      'integration-check',
      'spec-review-recorded',
      'goal-check-recorded',
      'quorum-decision',
      'finding-raised',
      'finding-reverified',
      'finding-suppressed',
      'finding-transitioned',
      'finding-reattributed',
      'severity-decisions',
      'waiver-granted',
      'waiver-denied',
      'gate-outcome',
    ],
  },
  // The scheduler's whole output. `smith scheduler run` appends one event per
  // proposal and dispatches nothing itself (architecture §12), so these three
  // rows ARE the ask — and until this chip existed they were the only writer
  // in the factory no chip could select: an operator filtering the log could
  // see every gate and every dispatch, but not the recheck they were being
  // asked to approve. Free strings rather than a taxonomy dimension (same
  // precedent as dispatch_decision), so the test derives the list from
  // scheduler.ts's eventTypeFor() instead of from taxonomy.yml.
  {
    value: 'scheduler',
    label: 'Scheduler',
    types: ['recheck-proposed', 'maintenance-proposed', 'growth-review-due'],
  },
  { value: 'error-logged', label: 'Errors', types: ['error-logged'] },
];

const TYPES_BY_KIND = new Map(KIND_OPTIONS.map((option) => [option.value, option.types]));

/** Whether an entry survives the chip selection. No chips means no filter, and
 * several chips union rather than intersect — an entry is of one kind. */
export function matchesKind(entry: TimelineEntry, kinds: readonly string[]): boolean {
  if (kinds.length === 0) return true;
  return kinds.some((kind) => (TYPES_BY_KIND.get(kind) ?? [kind]).includes(entry.eventType));
}

export function iconFor(entry: TimelineEntry): string {
  switch (entry.eventType) {
    case 'user_prompt':
      return 'message-circle';
    // Distinct from user_prompt's speech bubble: a prompt is an instruction
    // given, a note is reasoning written down. Same voice, different act.
    case 'operator-note':
      return 'file-text';
    case 'dispatch_decision':
      return 'send';
    case 'schema-check-result':
    case 'deps-check-result':
    case 'testgate-result':
    case 'gate-outcome': {
      const verdict = gateVerdict(entry);
      if (verdict === 'unrecorded') return 'circle-alert';
      return verdict === 'pass' ? 'shield-check' : 'shield-alert';
    }
    case 'finding-raised':
    case 'finding-suppressed':
    case 'finding-transitioned':
    case 'severity-decisions':
    case 'waiver-granted':
    case 'waiver-denied':
      return 'shield-check';
    case 'error-logged':
      return 'triangle-alert';
    case 'session-start':
      return 'play';
    case 'task-result-recorded':
      return 'file-check';
    case 'judge-verdict':
    case 'judge-reported':
      return 'scale';
    // The second eye, not a second scale: this row is one reader's independent
    // pass over a diff, and it says what was seen rather than what was decided.
    case 'cross-finding-reconciled':
      return 'eye';
    // The one gate that reads outside the plan. Not a shield — a shield says
    // "this artifact was checked against its own criteria", and the whole
    // point of this row is that the criteria came from somewhere the planner
    // could not reach.
    case 'goal-check-recorded':
      return 'target';
    case 'epic-closed':
      return 'git-merge';
    case 'lesson-candidate-raised':
    case 'lesson-edited':
    case 'lesson-status-changed':
      return 'graduation-cap';
    // The scheduler's three proposals. Each gets the icon of the thing it is
    // proposing rather than one shared "proposal" glyph, because the operator
    // decides them one at a time and the icon is the first thing that says
    // which decision this is.
    case 'recheck-proposed':
      return 'rotate-cw';
    case 'maintenance-proposed':
      return 'refresh-cw';
    case 'growth-review-due':
      return 'map';
    default:
      return 'history';
  }
}

export function tintFor(entry: TimelineEntry): RowTint {
  switch (entry.eventType) {
    // Both tints are blue because tint groups by kind, and the kind these two
    // share is "a person wrote this" — the same grouping the Prompts filter
    // selects on. Everything else on the timeline is the machine talking.
    case 'user_prompt':
    case 'operator-note':
      return 'blue';
    case 'dispatch_decision':
      return 'slate';
    default:
      return 'lilac';
  }
}

/** Which payload field carries each gate event's verdict. */
const GATE_VERDICT_FIELD: Record<string, string> = {
  'schema-check-result': 'valid',
  'deps-check-result': 'ok',
  'testgate-result': 'pass',
  'gate-outcome': 'outcome',
};

/**
 * A gate row's verdict, with `unrecorded` as a first-class third answer
 * (D-169).
 *
 * Three of these four branches used to read `p.<field> !== false`, which
 * answers "passed" to a payload that never mentioned the field — and the
 * factory's own log carries three hand-appended `testgate-result` records
 * whose author wrote the outcome under their own keys (`outcome: "pass"`,
 * `lint: 0, typecheck: 0`). All three rendered with the green shield and the
 * words "Test gate — passed", a verdict the dashboard inferred and the event
 * never made. The mirror error is just as wrong: rendering them red would
 * assert a failure nobody recorded either. So the row says the one true
 * thing — the record is thin — and leaves the reading to the operator
 * (D-31: silence is not assent; D-168: a claim needs the observations it is
 * a claim about).
 *
 * The field must be present AND the right type. `pass: 'false'` is what a
 * shell template or a hand-edited payload produces, and under `!== false` a
 * *string* saying false read as a pass — the worst of the cases, because
 * there the writer did record a failure.
 */
export function gateVerdict(entry: TimelineEntry): 'pass' | 'fail' | 'unrecorded' {
  const field = GATE_VERDICT_FIELD[entry.eventType];
  if (field === undefined) return 'pass';
  const raw = (entry.payload as Record<string, unknown>)[field];
  if (entry.eventType === 'gate-outcome') {
    if (typeof raw !== 'string' || raw === '') return 'unrecorded';
    return raw === 'pass' || raw === 'pass-with-waivers-pending' ? 'pass' : 'fail';
  }
  if (typeof raw !== 'boolean') return 'unrecorded';
  return raw ? 'pass' : 'fail';
}

/** D-169: the third word is the point — a row with no verdict says so. */
const GATE_VERDICT_WORD: Record<'pass' | 'fail' | 'unrecorded', string> = {
  pass: 'passed',
  fail: 'failed',
  unrecorded: 'no verdict recorded',
};

/**
 * D-253: the code names the repair — `provider.missing-api-key` is an unset
 * environment variable, `provider.invalid-output` is a prompt/schema problem.
 * The code is printed raw rather than mapped to friendlier prose: it is the
 * exact string the operator greps the log and the runbook for, and a second
 * vocabulary here would only have to be kept in step with the first.
 */
function judgeFailureLabel(code: unknown): string {
  return typeof code === 'string' && code !== '' ? `failed: ${code}` : 'failed';
}

/** One-line title per event kind — falls back to the event_type itself for kinds this dashboard doesn't special-case. */
export function titleFor(entry: TimelineEntry): string {
  const p = entry.payload as Record<string, unknown>;
  switch (entry.eventType) {
    case 'user_prompt':
      return String(p.prompt ?? p.text ?? '');
    // The payload is free-form by design — of the 57 notes in the factory's
    // own logs 28 carry `note`, 11 carry `summary`, and the remaining 18 carry
    // their prose under bespoke keys and no body field at all — so the title
    // degrades through every step rather than printing the empty string an
    // unguarded String(p.note) would. `note_kind` is the operator's own word
    // for what they were doing: it leads when there is a body, and stands
    // alone when there is not, because it is already a sentence and pinning a
    // generic label to it would only make a third of the rows say less.
    case 'operator-note': {
      const kind = p.note_kind ? String(p.note_kind) : '';
      const body = p.note ?? p.summary;
      if (body === undefined) return kind || 'Operator note';
      return kind ? `${kind} — ${String(body)}` : String(body);
    }
    case 'dispatch_decision':
      return `Dispatched ${String(p.agent_role ?? 'agent')} (${String(p.model_tier ?? '')}/${String(p.provider ?? '')})${p.reason ? ` — ${String(p.reason)}` : ''}`;
    case 'schema-check-result':
      return `Schema check — ${GATE_VERDICT_WORD[gateVerdict(entry)]}`;
    case 'deps-check-result':
      // The detail is the whole point of this row: "passed" alone cannot
      // distinguish an installed worktree from one with nothing to install.
      return `Dependency check — ${GATE_VERDICT_WORD[gateVerdict(entry)]}: ${String(p.detail ?? '')}`;
    case 'testgate-result':
      return `Test gate — ${GATE_VERDICT_WORD[gateVerdict(entry)]}`;
    case 'gate-outcome': {
      // The outcome value itself when there is one — `blocked`,
      // `pass-with-waivers-pending` and the rest each mean something the word
      // "failed" would flatten. Only the absence needs naming (D-169), which
      // used to print as a dangling em dash and nothing after it.
      const verdict = gateVerdict(entry);
      if (verdict === 'unrecorded') return 'Gate outcome — no outcome recorded';
      return `Gate outcome — ${String(p.outcome)}`;
    }
    case 'finding-raised':
      return `Finding raised — ${String(p.summary ?? p.finding_id ?? '')}`;
    case 'finding-transitioned':
      return `Finding transitioned — ${String(p.to_status ?? '')}`;
    case 'severity-decisions':
      return 'Severity decisions recorded';
    case 'waiver-granted':
      return 'Waiver granted';
    case 'waiver-denied':
      return 'Waiver denied';
    case 'error-logged':
      return `Error — ${String(p.error ?? '')}`;
    case 'task-added':
      return `Task added — ${String(p.objective ?? entry.taskId ?? '')}`;
    // The seven that queries.ts's FREE_TIMELINE_EVENT_TYPES used to drop
    // before the renderer ever saw them, plus lesson-status-changed, which
    // reached the timeline and rendered as its own event_type.
    case 'session-start':
      return p.note ? `Session started — ${String(p.note)}` : 'Session started';
    case 'task-result-recorded': {
      const detail = [
        p.agent,
        p.diff_lines_changed != null ? `${p.diff_lines_changed} lines changed` : null,
      ]
        .filter(Boolean)
        .join(', ');
      return `Task result — ${String(p.run_status ?? '')}${detail ? ` (${detail})` : ''}`;
    }
    case 'judge-verdict':
      // ok:false leaves verdict null: this run reached no verdict at all,
      // which is a different event from a judge that refuted, and the row has
      // to say which. It also has to say WHY it reached none — this row used
      // to read "schema failure" for every failure, including the eight
      // deepseek runs whose API key was never exported, which sent no request
      // and so produced no answer to call unparseable (D-253). Rows written
      // before D-253 carry no code and say only "failed".
      return `Judge verdict — ${p.ok === false ? judgeFailureLabel(p.error_code) : String(p.verdict ?? '')} (${String(p.agent ?? '')}/${String(p.provider ?? '')})`;
    case 'cross-finding-reconciled': {
      // The counts are the row. `independent-only` is what the native reviewer
      // missed and `native-only` is what the finder did, and an operator
      // scanning the timeline is looking for the first number: the whole point
      // of a second finder is the findings only it raised. Shadow mode is
      // named in the row because the same numbers gate nothing under it.
      const counts = (p.counts ?? {}) as Record<string, unknown>;
      const only = Number(counts['independent-only'] ?? 0);
      const both = Number(counts.corroborated ?? 0);
      const shadow = p.mode === 'shadow' ? ', shadow' : '';
      return `Cross-finding — ${only} independent-only, ${both} corroborated (${String(
        (p.providers as unknown[] | undefined)?.join(', ') ?? '',
      )}${shadow})`;
    }
    case 'judge-reported':
      return `${String(p.agent_role ?? 'Judge')} reported — ${String(p.finding_count ?? 0)} finding${p.finding_count === 1 ? '' : 's'} (round ${String(p.round ?? '')})`;
    case 'epic-closed':
      return `Epic closed — ${String(p.epic_id ?? '')}: ${String(p.machine_verdict ?? '')}, ${String(p.tasks_merged ?? 0)} tasks merged`;
    case 'lesson-candidate-raised':
      return `Lesson candidate — ${String(p.statement ?? p.lesson_id ?? '')}`;
    case 'lesson-edited':
      return `Lesson edited — ${String(p.statement ?? p.lesson_id ?? '')}`;
    case 'lesson-status-changed':
      return `Lesson ${String(p.lesson_id ?? '')} — ${String(p.to_status ?? '')}`;
    // The scheduler writes its proposal object straight through as the
    // payload, so these read camelCase keys where the rest of this file reads
    // snake_case — the shape is scheduler.ts's SchedulerProposal, not an
    // envelope built for the log.
    //
    // Each title names what the operator is being asked to decide, because
    // that is the whole content of the event: architecture §12 has the
    // scheduler propose and the operator dispose, and a row reading
    // "recheck-proposed" with no task on it asks a question nobody can answer.
    case 'recheck-proposed': {
      const reasons = Array.isArray(p.reasons) ? p.reasons.join(', ') : '';
      return `Recheck proposed — ${String(p.taskId ?? p.epicId ?? '')}${reasons ? ` (${reasons})` : ''}`;
    }
    case 'maintenance-proposed': {
      const packages = Array.isArray(p.packages) ? p.packages : [];
      const names = packages
        .slice(0, 3)
        .map((entry) => String((entry as Record<string, unknown>).name ?? ''))
        .filter(Boolean);
      const rest = packages.length - names.length;
      const detail =
        names.length > 0 ? `${names.join(', ')}${rest > 0 ? ` +${rest}` : ''}` : 'none';
      return `Maintenance proposed — ${packages.length} outdated (${detail})`;
    }
    case 'growth-review-due': {
      const since = p.lastReviewAt ? `, last ${String(p.lastReviewAt).slice(0, 10)}` : '';
      return `Growth review due — every ${String(p.cadenceDays ?? '?')} days${since}`;
    }
    default:
      return entry.eventType;
  }
}

export function metaFor(entry: TimelineEntry): string {
  return entry.taskId ? `${entry.taskId} · ${entry.eventType}` : entry.eventType;
}
