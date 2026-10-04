// Timeline row anatomy (ds-review.html's `.ev`/`.ktag`): the kind tag and
// left colour bar are decorative grouping by EVENT KIND only, never status —
// actual outcome renders as a Lozenge (taxonomy.ts) alongside it, never via
// the kind colour alone.
import type { DispatchRun, TimelineEntry } from './api.js';
import { formatCompactNumber, formatElapsed, formatTime, taskLabel } from './format.js';
import { roleLabel } from './roleLabels.js';
import { specRefLabel } from './specRef.js';

/** The shape `/api/timeline`'s paged mode (`fetchTimelinePage`, api.ts) adds
 * on top of a plain `TimelineEntry`: a server-computed `kind`, the nearest
 * causal prompt's id, and (per kind) the DS6 PR2 run/gate joins. `metaFor`
 * below only reads fields that exist on this richer shape — a bare
 * `TimelineEntry` (the unpaged `fetchTimeline`, still used by the orphaned
 * old `components/TimelineRow.vue`) renders every item as "not measured". */
export interface ActivityEntry extends TimelineEntry {
  kind?: string;
  nearestPromptId?: string | null;
  run?: DispatchRun;
  gateCounts?: { passed: number; failed: number } | null;
}

/** Extra context `metaFor` needs but cannot derive from one row alone: the
 * nearest prompt's own timestamp (for "because of your prompt at HH:MM") and
 * how many dispatches a Prompt row caused — both walks over the whole page,
 * done once by the caller (ActivityPage.vue / TimelineRow.vue). */
export interface MetaContext {
  now?: string;
  promptTs?: string | null;
  causedCount?: number;
}

const NOT_MEASURED = 'not measured';

function tokensItem(run: DispatchRun | undefined): string | null {
  if (!run) return null;
  if (run.tokensIn == null && run.tokensOut == null) return NOT_MEASURED;
  const total = (run.tokensIn ?? 0) + (run.tokensOut ?? 0);
  return `${formatCompactNumber(total)} tokens`;
}

function durationItem(ms: number | null | undefined): string | null {
  if (ms === undefined) return null;
  if (ms === null) return NOT_MEASURED;
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? `${Math.round(ms / 1000)} s` : `${minutes} min`;
}

function becauseOfItem(ctx: MetaContext): string | null {
  if (ctx.promptTs === undefined) return null;
  if (ctx.promptTs === null) return NOT_MEASURED;
  return `because of your prompt at ${formatTime(ctx.promptTs)}`;
}

/** Human check name for the broad set of event types `kindFor` buckets as
 * `gate` (ds-spec.md §4.3's "check name"). */
const GATE_CHECK_NAME: Record<string, string> = {
  'schema-check-result': 'Schema check',
  'artifact-check-result': 'Artifact check',
  'commit-check-result': 'Commit check',
  'deps-check-result': 'Dependency check',
  'judges-outstanding': 'Judges outstanding',
  'grader-verdict': 'Grader verdict',
  'budget-check-result': 'Budget check',
  'testgate-result': 'Unit tests',
  'coverage-evidence': 'Coverage',
  'integration-check': 'Integration check',
  'spec-review-recorded': 'Spec review',
  'goal-check-recorded': 'Goal check',
  'quorum-decision': 'Quorum decision',
  'gate-outcome': 'Gate outcome',
  'issue-reported': 'Issue reported',
};

function gateCountsItem(counts: ActivityEntry['gateCounts']): string | null {
  if (counts === undefined) return null;
  if (counts === null) return NOT_MEASURED;
  const total = counts.passed + counts.failed;
  return counts.failed > 0
    ? `${counts.failed} of ${total} failed`
    : `${counts.passed} of ${total} passed`;
}

/** CausalTimelineList's pre-built causal-parent tree node (moved here, not
 * exported from a .vue SFC — see components/ds/types.ts's header comment
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
    // covers; the role is named, and that is the whole fact about it. The
    // friendly label is only a display step — counting/ranking above stays
    // on the raw taxonomy string so the order doesn't move underneath it.
    .map(([role, n]) => (n > 1 ? `${roleLabel(role)} ×${n}` : roleLabel(role)));
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

/**
 * A `TimelineItem`'s own timestamp — the entry's own `ts` for a plain row, or
 * the NEWEST member's `ts` for a folded dispatch group. Used to bucket the
 * already-folded top-level list into day headers (brief item 3) without
 * splitting a group across two days: the group goes under the day of its
 * newest row, never its oldest or whichever member happens first in the
 * fold's own order.
 */
export function tsForItem(item: TimelineItem): string {
  if (item.kind === 'entry') return item.node.entry.ts;
  return item.group.members.reduce(
    (latest, m) => (m.entry.ts > latest ? m.entry.ts : latest),
    item.group.members[0]?.entry.ts ?? '',
  );
}

/** The raw `TimelineNode`s a `TimelineItem` stands for — one for a plain row,
 * the whole run for a folded group — so a day bucket built from `tsForItem`
 * can hand its members back to `TimelineNodeList` as a flat node list, which
 * re-folds them identically (same nodes, same order). */
export function nodesOfItem(item: TimelineItem): TimelineNode[] {
  return item.kind === 'entry' ? [item.node] : item.group.members;
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
      'task-waiver-approved',
      'gate-outcome',
      'issue-reported',
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
    types: [
      'recheck-proposed',
      'maintenance-proposed',
      'growth-review-due',
      'error-report-proposed',
    ],
  },
  // The plan graph — the whole `graph_event` dimension in taxonomy order, on
  // the same rule the gate chip learned the hard way (D-162): the chip is a
  // copy of a closed list, so a test derives the assertion from the yml rather
  // than trusting the copy. Without it a worker's spec-change proposal, the
  // operator's answer and the plan version their approval cut were reachable
  // only by scrolling the unfiltered log — the same hole the scheduler chip
  // was cut to close, one dimension over.
  {
    value: 'graph',
    label: 'Plan changes',
    types: [
      'plan-version-created',
      'plan-version-superseded',
      'task-added',
      'task-split',
      'task-superseded',
      'edge-recorded',
      'wave-admitted',
      'wave-merged',
      'spec-change-proposed',
      'spec-change-decided',
    ],
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

/** The mock's nine row kinds (ds-review.html's `.k-*` classes): a row's type
 * tag and left colour bar, drawn from `--bs-event-<kind>-text/subtle`. This
 * replaces the old icon+tint pair — colour groups by kind only, never by
 * status, and the tag text is what actually carries the kind (never colour
 * alone). */
export const EVENT_KINDS = [
  'prompt',
  'dispatch',
  'returned',
  'finding',
  'gate',
  'merge',
  'error',
  'feedback',
  'system',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  prompt: 'Prompt',
  dispatch: 'Dispatched',
  returned: 'Returned',
  finding: 'Finding',
  gate: 'Gate',
  merge: 'Merge',
  error: 'Error',
  feedback: 'Feedback',
  system: 'System',
};

/** Reverse of EVENT_KIND_LABEL: the server's PascalCase EventKind (api.ts) to
 * this file's lowercase one (same string values, see api.ts's EventKind). */
const LOWERCASE_KIND_BY_LABEL = new Map<string, EventKind>(
  EVENT_KINDS.map((kind) => [EVENT_KIND_LABEL[kind], kind]),
);

/** Which of the nine mock kinds an event renders as. `/api/timeline`'s paged
 * entries (TimelinePage.entries, api.ts) already carry a server-computed
 * `kind` — DS6 PR3 prefers that over re-deriving one client-side, because
 * the two used to disagree (server's eventKind() in queries.ts follows
 * ds-spec.md §4.3; this file's own eventType switch below predates that and
 * swaps Finding/Feedback for waiver-granted/-denied vs. judge-reported, and
 * widens the Gate set). Entries without a server `kind` (the unpaged
 * `fetchTimeline()`/`TimelineEntry` shape, still used by the orphaned old
 * `components/TimelineRow.vue`) fall through to that same switch. Unknown
 * types fall back to `system` rather than throwing, the same way `titleFor`'s
 * default case prints the raw event_type instead of crashing on a taxonomy
 * the dashboard hasn't caught up with yet. */
export function kindFor(entry: TimelineEntry & { kind?: string }): EventKind {
  if (entry.kind !== undefined) {
    return LOWERCASE_KIND_BY_LABEL.get(entry.kind) ?? 'system';
  }
  switch (entry.eventType) {
    case 'user_prompt':
    case 'operator-note':
      return 'prompt';
    case 'dispatch_decision':
      return 'dispatch';
    case 'task-result-recorded':
      return 'returned';
    case 'finding-raised':
    case 'finding-reverified':
    case 'finding-suppressed':
    case 'finding-transitioned':
    case 'finding-reattributed':
    case 'severity-decisions':
    case 'waiver-granted':
    case 'waiver-denied':
    case 'task-waiver-approved':
      return 'finding';
    case 'schema-check-result':
    case 'artifact-check-result':
    case 'commit-check-result':
    case 'deps-check-result':
    case 'judges-outstanding':
    case 'grader-verdict':
    case 'budget-check-result':
    case 'testgate-result':
    case 'coverage-evidence':
    case 'integration-check':
    case 'spec-review-recorded':
    case 'goal-check-recorded':
    case 'quorum-decision':
    case 'gate-outcome':
    case 'issue-reported':
      return 'gate';
    case 'wave-merged':
    case 'epic-closed':
    case 'integration-pr-opened':
      return 'merge';
    case 'error-logged':
    case 'error-report-proposed':
      return 'error';
    case 'judge-verdict':
    case 'judge-reported':
    case 'cross-finding-reconciled':
    case 'spec-change-proposed':
    case 'spec-change-decided':
      return 'feedback';
    default:
      return 'system';
  }
}

/** Which payload field carries a verdict row's pass/fail outcome, for the
 * same-shaped tag `findingStatus` already renders via `Lozenge`. Only rows
 * with a real pass/fail reach a tag; `null` means "say nothing" rather than
 * guessing one (D-169's "unrecorded" rule, one level up). `'errored'` is its
 * own honest third answer for a judge-verdict run that never reached a
 * verdict at all (`payload.ok === false`, e.g. a missing API key) -- that is
 * not the work failing, so it must never read "Failed". */
export function verdictOutcome(entry: TimelineEntry): 'pass' | 'fail' | 'errored' | null {
  if (entry.eventType === 'judge-verdict') {
    const p = entry.payload as Record<string, unknown>;
    if (p.ok === false) return 'errored';
    if (p.verdict === 'confirm') return 'pass';
    if (p.verdict === 'refute') return 'fail';
    return null;
  }
  if (entry.eventType === 'grader-verdict') {
    const overall = (entry.payload as Record<string, unknown>).overall;
    if (overall === 'pass') return 'pass';
    if (overall === 'fail') return 'fail';
    return null;
  }
  if (entry.eventType in GATE_VERDICT_FIELD) {
    const verdict = gateVerdict(entry);
    return verdict === 'unrecorded' ? null : verdict;
  }
  return null;
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

/** Task 3 (dispatch reason fallback): writers put the reason under other keys
 * than `reason` — the same chain the projector applies server-side, so a row
 * reads the same whether or not the DB has been rebuilt since. */
function dispatchReasonText(p: Record<string, unknown>): string | null {
  for (const key of ['reason', 'rationale', 'note', 'why'] as const) {
    const v = p[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
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
    case 'dispatch_decision': {
      const reason = dispatchReasonText(p);
      return `Dispatched ${roleLabel(String(p.agent_role ?? 'agent'))} (${String(p.model_tier ?? '')}/${String(p.provider ?? '')})${reason ? ` — ${reason}` : ''}`;
    }
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
    case 'finding-raised': {
      // The payload is the finding itself (findings.ts raiseFinding), so a
      // spec finding carries `finding_scope` and `spec_ref` flat in it.
      const ref =
        typeof p.spec_ref === 'object' && p.spec_ref !== null
          ? (p.spec_ref as { plan_version?: unknown; criterion_ref?: unknown })
          : {};
      const label = specRefLabel({
        findingScope: typeof p.finding_scope === 'string' ? p.finding_scope : null,
        specPlanVersion: typeof ref.plan_version === 'number' ? ref.plan_version : null,
        criterionRef: typeof ref.criterion_ref === 'string' ? ref.criterion_ref : null,
      });
      const summary = String(p.summary ?? p.finding_id ?? '');
      return label ? `Finding raised — ${summary} (${label})` : `Finding raised — ${summary}`;
    }
    case 'finding-transitioned':
      return `Finding transitioned — ${String(p.to_status ?? '')}`;
    case 'severity-decisions':
      return 'Severity decisions recorded';
    case 'waiver-granted':
      return 'Waiver granted';
    case 'waiver-denied':
      return 'Waiver denied';
    case 'task-waiver-approved':
      return 'Task waiver approved';
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
    // run.md step 17. `repo#number` is the form GitHub itself resolves, and
    // the refs matter because a stacked PR (an epic cut from another epic's
    // integration branch) does not target `main` — the operator merging in
    // the wrong order is exactly what the row is there to prevent. A
    // hand-appended payload can be thin, so every field is optional and the
    // title degrades to the bare fact rather than to `#undefined`.
    case 'integration-pr-opened': {
      const ref = p.pr_number === undefined ? '' : `${String(p.repo ?? '')}#${String(p.pr_number)}`;
      const refs =
        p.head_ref !== undefined && p.base_ref !== undefined
          ? ` (${String(p.head_ref)} → ${String(p.base_ref)})`
          : '';
      return ref === '' ? 'Integration PR opened' : `Integration PR opened — ${ref}${refs}`;
    }
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
    case 'error-report-proposed': {
      const count = Number(p.occurrences ?? 0);
      return `Error report proposed — ${String(p.errorClass ?? '')} in ${String(p.taskRef ?? '')} (${count} occurrence${count === 1 ? '' : 's'})`;
    }
    // The plan graph, the dimension the Plan chip selects. `task-added` was
    // already here; the rest reached the timeline and rendered as their own
    // event_type, which is the defect D-153 and D-162 are both recorded for —
    // a row an operator can now filter for and still not read.
    case 'plan-version-created': {
      const amends = Array.isArray(p.amends) ? p.amends.length : 0;
      const from = p.previous_version == null ? '' : ` amends v${String(p.previous_version)}`;
      const why = p.rationale ? `: ${String(p.rationale)}` : '';
      return `Plan v${String(p.version ?? '?')}${from} — ${amends} finding${amends === 1 ? '' : 's'} cited${why}`;
    }
    case 'plan-version-superseded':
      return `Plan v${String(p.version ?? '?')} superseded`;
    case 'task-split':
      return `Task split — ${String(entry.taskId ?? '')}`;
    case 'task-superseded':
      return `Task superseded — ${String(entry.taskId ?? '')}`;
    case 'edge-recorded':
      return `Edge — ${String(entry.taskId ?? '')} depends on ${String(p.depends_on ?? '')}`;
    case 'wave-admitted': {
      const ids = Array.isArray(p.task_ids) ? p.task_ids.map(String) : [];
      const shown = ids.slice(0, 3).join(', ');
      const rest = ids.length - Math.min(ids.length, 3);
      return `Wave admitted — ${ids.length} task${ids.length === 1 ? '' : 's'}${shown ? ` (${shown}${rest > 0 ? ` +${rest}` : ''})` : ''}`;
    }
    case 'wave-merged': {
      // One event per task, carrying a single-element task_ids (taskEvents.ts),
      // so the row names the task rather than counting a wave that never
      // reaches this event whole.
      const ids = Array.isArray(p.task_ids) ? p.task_ids.map(String) : [];
      const files = Array.isArray(p.files_changed) ? p.files_changed.length : null;
      const detail = files === null ? '' : ` — ${files} file${files === 1 ? '' : 's'} changed`;
      return `Merged ${ids.join(', ') || String(entry.taskId ?? '')}${detail}`;
    }
    // The worker's own words, in the worker's own order: which criterion, what
    // it assumed, and how much of the codebase has that shape (D-123). The
    // operator is being asked to overturn the assumption, so the assumption is
    // the sentence — not the diff, which the proposals view renders in full.
    case 'spec-change-proposed': {
      const sites = Array.isArray(p.sites) ? p.sites.length : 0;
      const blocking = p.blocking ? 'blocking' : 'non-blocking';
      return `Spec change proposed by ${String(p.proposed_by ?? 'worker')} — ${String(p.criterion_ref ?? '')}: ${String(p.assumption ?? '')} (${blocking}, ${sites} site${sites === 1 ? '' : 's'})`;
    }
    // A rejection carries no plan version by design — refusing a proposal cuts
    // nothing — so the version is named only when there is one, and the
    // operator's reasons ride along either way.
    case 'spec-change-decided': {
      const version = p.plan_version == null ? '' : ` — plan v${String(p.plan_version)}`;
      const why = p.rationale ? `: ${String(p.rationale)}` : '';
      return `Spec change ${String(p.decision ?? 'decided')}${version}${why}`;
    }
    default:
      return entry.eventType;
  }
}

/**
 * The meta line under a TimelineRow's title (ds-spec.md §4.3's per-kind
 * table, reproduced in each case below). A field that is simply absent from
 * the row's own kind (e.g. `run` on anything but `dispatch`) is skipped
 * rather than printed as "not measured" — "not measured" is reserved for a
 * field the kind IS supposed to carry but this particular row's payload
 * came back null for (D-169's own "say the absence" rule, one level down:
 * a null counts, a field that doesn't exist for this kind never did).
 */
export function metaFor(entry: ActivityEntry, ctx: MetaContext = {}): string {
  const p = entry.payload as Record<string, unknown>;
  const kind = kindFor(entry);
  const parts: (string | null)[] = [];
  switch (kind) {
    case 'dispatch': {
      const round = entry.run?.round ?? (typeof p.round === 'number' ? p.round : null);
      if (round != null) parts.push(`round ${round}`);
      if (entry.run?.runStatus == null) {
        // Still running: no terminal result yet, so no token/duration totals.
        // ds-spec.md §4.3 spells the seconds case with a space ("Running for
        // 12 s"); formatElapsed's own terse "12s" is right for every other
        // unit, so only that one case gets split back apart.
        const elapsed = formatElapsed(entry.ts, ctx.now).replace(/^(\d+)s$/, '$1 s');
        parts.push(`Running for ${elapsed}`);
      } else {
        parts.push(tokensItem(entry.run));
        parts.push(durationItem(entry.run.durationMs));
      }
      parts.push(becauseOfItem(ctx));
      break;
    }
    case 'returned': {
      parts.push(tokensItem(entry.run));
      parts.push(durationItem(entry.run?.durationMs));
      parts.push(entry.run?.runStatus == null ? NOT_MEASURED : String(entry.run.runStatus));
      break;
    }
    case 'finding': {
      if (p.agent_role) parts.push(roleLabel(String(p.agent_role)));
      if (p.round != null) parts.push(`round ${String(p.round)}`);
      if (p.overall) parts.push(String(p.overall));
      break;
    }
    case 'gate': {
      const checkName = GATE_CHECK_NAME[entry.eventType] ?? entry.eventType;
      parts.push(checkName);
      parts.push(gateCountsItem(entry.gateCounts));
      if (p.round != null) parts.push(`round ${String(p.round)}`);
      break;
    }
    case 'merge': {
      const ids = Array.isArray(p.task_ids) ? p.task_ids.map(String) : [];
      parts.push(ids.join(', ') || taskLabel(String(entry.taskId ?? '')));
      const files = Array.isArray(p.files_changed) ? p.files_changed.length : null;
      parts.push(files === null ? NOT_MEASURED : `${files} file${files === 1 ? '' : 's'} changed`);
      break;
    }
    case 'prompt': {
      parts.push(
        ctx.causedCount == null
          ? NOT_MEASURED
          : `Caused ${ctx.causedCount} dispatch${ctx.causedCount === 1 ? '' : 'es'}`,
      );
      break;
    }
    case 'error': {
      if (p.class) parts.push(String(p.class));
      if (p.severity) parts.push(String(p.severity));
      break;
    }
    case 'feedback': {
      parts.push(entry.eventType === 'waiver-denied' ? 'Waiver denied' : 'Waiver');
      if (entry.taskId) parts.push(taskLabel(entry.taskId));
      break;
    }
    case 'system':
      return '—';
    default:
      return entry.taskId ? `${taskLabel(entry.taskId)} · ${entry.eventType}` : entry.eventType;
  }
  const filtered = parts.filter((part): part is string => Boolean(part));
  return filtered.length > 0 ? filtered.join(' · ') : '—';
}

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** One day's header and the rows under it, in the input's own order. */
export interface DayGroup<T> {
  label: string;
  items: T[];
}

function startOfLocalDay(iso: string): Date {
  const d = new Date(iso);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** "Today" / "Yesterday" / "29 Sep" relative to `nowIso`, local time. Days
 * further than yesterday never age into a third relative word — a week-old
 * row reads "6 Sep", not "6 days ago" — because the list is a log, not a
 * countdown. */
function dayLabel(day: Date, nowIso: string): string {
  const today = startOfLocalDay(nowIso);
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return `${day.getDate()} ${SHORT_MONTHS[day.getMonth()]}`;
}

/**
 * Groups an already newest-first list into day buckets, each headed "Today",
 * "Yesterday" or a short date (brief item 3). Pure and clock-injected — `now`
 * is a parameter, never `Date.now()` — so a test can fix "today" and assert a
 * deterministic label instead of a label that only matches when the suite
 * happens to run on the day it was written.
 *
 * The caller supplies items already in display order; this only partitions
 * them by local calendar day, it does not re-sort — `buildCausalTree` and
 * `RunHistoryTimeline`'s own list are both newest-first already, and grouping
 * is the wrong place to second-guess that.
 */
export function groupByDay<T extends { ts: string }>(
  items: readonly T[],
  nowIso: string,
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  let currentKey: number | null = null;
  for (const item of items) {
    const day = startOfLocalDay(item.ts);
    const key = day.getTime();
    if (key !== currentKey) {
      groups.push({ label: dayLabel(day, nowIso), items: [] });
      currentKey = key;
    }
    groups[groups.length - 1]?.items.push(item);
  }
  return groups;
}
