<script setup lang="ts">
// Overview — design-spec.md §5.1. Polls every 5s (§8: "the one place
// sub-10s freshness matters"). Phase 6b: per-project at /p/:project/overview
// or global (aggregated + per-project breakdown) at /overview; real
// StatCard deltas (5min/1h snapshot scans); "Recent dispatch decisions"
// card (closes the 6a DESIGN.md deviation); epic identity chips (operator
// directive 2) and pending-review tone chips (operator directive 3).
//
// Still flagged: the design's "three independent remote-data zones" MUST
// rule (stat row / main / rail each with their own skeleton/error) assumes
// three separate fetches. The actual API is still ONE overview() call (plus,
// Phase 6b, a supplementary lessons() call for the pending-lessons chip) —
// not a fully independent per-zone fetch.
//
// Phase 6b round 7 (operator directive: "I need to see on the Dashboard what
// is running, a kind of real-time update; mind the timestamps"): the
// polling was already here, the EVIDENCE of it was not. Three additions, all
// leaning on the timestamps the API already returns: a LiveStatus indicator
// (state + age of the last successful load + manual Refresh), a 1s useNow()
// tick that drives every relative label on the page so they count up instead
// of freezing between fetches, and per-agent runtimes in the Live agents card
// (LiveAgentGroupRow). Still polling, not sockets — design-spec §8.
//
// The LiveStatus indicator has since moved into the app shell (App.vue,
// composables/usePulse.ts): every page polls, and on the other nine a frozen
// server looked exactly like a quiet factory — the confusion this page had
// already fixed for itself. The shell's Refresh reaches this page's `load`
// through usePoll's global refresh signal, so nothing here had to know. What
// stays page-local is the Banner: a failing fetchOverview against a server
// that still answers /api/pulse is a page problem, not a liveness one, and
// the Banner is the surface that says so.
//
// Phase 6b round 9 (operator directive: "on the overview I want to see what is
// running ... add a small animation to the chip indicators for the agents that
// are actually working. Updates and blocks need more motion, so you can
// actually see the factory running"). Three parts: a "Now running" card that
// names the tasks (the grouped card below answers *who* is running, by
// role·tier — it took a disclosure click to find out *what*); chip/dot
// animation spent
// only on agents lib/liveness.ts can call `working` (IdentityChip's `live`
// prop); and a one-shot flash on the blocks whose data actually changed under
// the poll, driven by a signature of that data rather than by the fetch —
// otherwise every card would flash every 5s and the motion would mean nothing.
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import coffeeIllustration from '../assets/illustrations/coffee.svg';
import CommandHint, { type CommandHintItem } from '../components/CommandHint.vue';
import Banner from '../components/ds/Banner.vue';
import Button from '../components/ds/Button.vue';
import Card from '../components/ds/Card.vue';
import EmptyState from '../components/ds/EmptyState.vue';
import Highlight from '../components/ds/Highlight.vue';
import Lozenge from '../components/ds/Lozenge.vue';
import MetricGrid from '../components/ds/MetricGrid.vue';
import PageHeader from '../components/ds/PageHeader.vue';
import Row from '../components/ds/Row.vue';
import RowList from '../components/ds/RowList.vue';
import Skeleton from '../components/ds/Skeleton.vue';
import StatCard from '../components/ds/StatCard.vue';
import TwoColumn from '../components/ds/TwoColumn.vue';
import IdentityChip from '../components/IdentityChip.vue';
import LiveAgentGroupRow, { type LiveAgentGroupUI } from '../components/LiveAgentGroupRow.vue';
import ProgressBar from '../components/ProgressBar.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { useFlashOnChange } from '../composables/useFlashOnChange.js';
import { useNow } from '../composables/useNow.js';
import { usePoll } from '../composables/usePoll.js';
import { useProjectContext } from '../composables/useProjectContext.js';
import { useSessionContext } from '../composables/useSessionContext.js';
import { agentScopeLabel } from '../lib/agentScope.js';
import {
  fetchLessons,
  fetchOverview,
  type LiveAgentEntry,
  type OverviewResult,
  type RunningSession,
} from '../lib/api.js';
import { formatDateTime, formatElapsed, formatRelative, pluralize } from '../lib/format.js';
import {
  byRuntimeDesc,
  hiddenAgentsLabel,
  hiddenSessionsLabel,
  longestRunningSince,
  partitionAgents,
  partitionSessions,
  SESSION_ACTIVE_WITHIN_MS,
  type SessionActivity,
  sessionActivity,
} from '../lib/liveness.js';
import { nothingPending, type PendingReviewCounts, pendingClauses } from '../lib/pendingReview.js';

const router = useRouter();
const { setBreadcrumb } = useBreadcrumb();
const { project } = useProjectContext();
const { sessionScope, sessionKey } = useSessionContext();

const POLL_MS = 5000;

const data = ref<OverviewResult | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);
// null while the lessons fetch has not succeeded -- in flight on first load,
// or failed. Not a count, and never rendered as one (D-225).
const pendingLessons = ref<number | null>(null);
const lessonsFailed = ref(false);
const now = useNow(1000);

async function load() {
  // Cleared on success, not on attempt -- the same rule the shell's freshness
  // indicator follows, for the same reason. This page polls every POLL_MS and
  // deliberately does not raise `loading` when it does, so clearing here took
  // the danger banner off the screen for the length of every unattended
  // attempt and put nothing in its place: a dashboard whose server is down
  // spent most of each interval looking like a healthy one (D-226, D-240).
  try {
    data.value = await fetchOverview(sessionScope.value, project.value);
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
  // Supplementary, non-blocking: lesson candidates pending review (directive 3's 3rd chip kind).
  try {
    const lessons = await fetchLessons();
    pendingLessons.value = lessons.pending.length;
    lessonsFailed.value = false;
  } catch {
    // Non-blocking still, but a failed call is not a count of zero. Writing 0
    // here made "the lessons API is down" and "no candidates are waiting"
    // render as the same all-clear (D-225). The poll re-tries in POLL_MS; the
    // card says the number is missing until one of those lands.
    pendingLessons.value = null;
    lessonsFailed.value = true;
  }
}

onMounted(() => {
  setBreadcrumb([{ label: project.value ? `${project.value} · Overview` : 'Overview' }]);
  load();
});
watch([project, sessionKey], () => {
  setBreadcrumb([{ label: project.value ? `${project.value} · Overview` : 'Overview' }]);
  loading.value = true;
  load();
});
usePoll(load, POLL_MS);

// design-spec.md:190 reserves the coffee illustration for the first-ever run,
// "zero events ever logged". Live-agent count and in-flight epics don't say
// that: both go to zero the moment a run *finishes* — inFlightEpics() drops an
// epic once every task is terminal, and an agent row stops being live once its
// terminal event lands. Asking only those two made the steady state between
// two waves indistinguishable from a factory that had never run, and the
// `v-else-if` below took the whole dashboard down with it (D-241).
//
// Every field consulted here rides the same /api/overview payload. pendingLessons
// is deliberately not among them: it arrives on a second request and starts as
// null, so folding it in would flash the illustration on and off at first paint.
const isFirstRun = computed(() => {
  const d = data.value;
  if (d === null) return false;
  return (
    d.liveAgentCount === 0 &&
    d.epicsInFlight.length === 0 &&
    d.runningSessions.length === 0 &&
    d.recentDispatches.length === 0 &&
    d.milestoneProgress.length === 0 &&
    d.closedEpics.length === 0 &&
    d.alerts.escalations === 0 &&
    d.alerts.pendingWaivers === 0
  );
});
// The three counts the operator is asked to act on, two off /api/overview and
// one off /api/lessons. Kept together and passed around as one value so the
// banner and the rail card can never answer the question differently.
const reviewCounts = computed<PendingReviewCounts>(() => ({
  pendingWaivers: data.value?.alerts.pendingWaivers ?? 0,
  escalations: data.value?.alerts.escalations ?? 0,
  pendingLessons: pendingLessons.value,
}));

// Fix-round (uiux S3 #10): only mention the clauses that are actually
// non-zero — "0 waivers pending, 2 tasks escalated, 0 lesson candidates"
// forces the operator to parse past two irrelevant zero-count clauses.
const attentionClauses = computed(() =>
  data.value === null ? [] : pendingClauses(reviewCounts.value),
);
// Rendered iff there is a clause to put in it, so the two cannot disagree.
const needsAttention = computed(() => attentionClauses.value.length > 0);
const attentionSentence = computed(() => attentionClauses.value.join(', '));

function goToKanban() {
  router.push('/kanban');
}

// Operator directive (running-only): the dashboard shows what is working
// and says what it is not showing. A `live` registry row is not proof of
// work — rows stay live until a terminal event closes them, and the factory
// itself reports a row stale after 4h (liveness.ts, AGENT_STALE_AFTER_MS).
// So every agent surface on this page is fed from this partition, computed
// against the ticking `now`: an agent crossing the line drops out on the
// next tick, not on the next fetch. What drops out is counted, never
// dropped silently.
const agentParts = computed(() => partitionAgents(data.value?.liveAgentEntries ?? [], now.value));
const workingEntries = computed(() => agentParts.value.working);
// '' when nothing is hidden, so `v-if` on it renders no empty line.
const hiddenAgentsLine = computed(() =>
  hiddenAgentsLabel(agentParts.value.stalled, agentParts.value.unknown),
);

// Operator directive (Phase 6b round 5): the flat capped list (round 4)
// doesn't scale past a handful of agents either — replaced with role·tier
// GROUPS (IdentityChip + count), each a Disclosure trigger (same
// aria-expanded/aria-controls pattern as CausalTimelineList/TimelineRow)
// revealing its per-agent lines. Grouping is client-side; liveAgentEntries
// already carries everything a group needs (role, tier, taskId).
const liveAgentGroups = computed<LiveAgentGroupUI[]>(() => {
  const byKey = new Map<string, LiveAgentGroupUI>();
  for (const a of workingEntries.value) {
    const key = `${a.agentRole}|${a.modelTier}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      existing.entries.push(a);
    } else {
      byKey.set(key, {
        key,
        agentRole: a.agentRole,
        modelTier: a.modelTier,
        count: 1,
        entries: [a],
      });
    }
  }
  return [...byKey.values()].sort(
    (a, b) => b.count - a.count || a.agentRole.localeCompare(b.agentRole),
  );
});

// Operator directive (Phase 6b round 6): round 5's group rows + full-width
// expanded details (grid-column: 1 / -1) visually collapsed to one column
// whenever consecutive groups were both expanded — a wide detail block
// forces its OWN row, so the column beside it goes empty, group after
// group. Split into two independent columns by index parity instead (NOT
// height-balanced, so toggling one group's disclosure never reflows or
// reorders the OTHER column — a `column-count`/masonry layout would
// rebalance by height and cause exactly that jump). Each column is its own
// flex list (LiveAgentGroupRow.vue) — an expanded group's detail lines
// render directly under their own row, entirely within that row's column,
// never spanning into the other one.
const leftAgentGroups = computed(() => liveAgentGroups.value.filter((_, i) => i % 2 === 0));
const rightAgentGroups = computed(() => liveAgentGroups.value.filter((_, i) => i % 2 === 1));

// Round 7: the one sentence that answers "what is running" without expanding
// a single group — how many agents, and how long the oldest has been at it.
// The second half is the part that carries information: 8 agents at 30s is a
// healthy factory, 8 agents where the oldest is at 2h is a wedged one.
//
// Round 9 split the count: "8 agents working" was a claim the data did not
// support, because it counted agents the factory itself would already report
// as stale. The card now lists only the working ones, so the middle clause
// states what it hides. Agents whose timestamp is unreadable (`unknown`) are
// named as such rather than described as stalled — that would be a second
// unsupported claim, just in the other direction.
const runningSummary = computed(() => {
  const working = workingEntries.value;
  if (working.length === 0) return '';
  const clauses = [`${pluralize(working.length, 'agent')} working`];
  if (hiddenAgentsLine.value) clauses.push(hiddenAgentsLine.value);
  const since = longestRunningSince(working);
  if (since !== null) clauses.push(`longest running ${formatElapsed(since, now.value)}`);
  return clauses.join(' · ');
});

// Dogfood round 2 — operator: "the overview never updates, and the now-running
// block should show the sessions that are running right now, with an animated
// indicator".
//
// Round 9's version of this card listed `liveAgentEntries` longest-running
// first, capped at 8. In the real state/smith.db that made it permanently
// wrong: `agents` rows stay `live` until a terminal event closes them out,
// and 12 rows from a session that ended on 2026-08-07 were still `live` on
// 2026-08-11. Longest-running-first put those twelve ghosts at the top, the
// cap of 8 meant nothing else ever reached the card, and the block never
// changed no matter what the factory did — the "never updates" the operator
// reported.
//
// So the unit of this card is now the SESSION (queries.ts runningSessions()),
// ordered by what appended an event most recently, with its own activity
// state.
//
// Running-only: a session gets a row only while it is RUNNING — an event
// within SESSION_ACTIVE_WITHIN_MS, or at least one working agent (the second
// half matters: agents commonly run 12-35 min between events, so an
// event-only rule hid runs that were mid-task). Idle sessions are counted in
// the summary and the footer, not listed. Under each row only the WORKING
// agents appear; a stalled row cannot claim to be running now, and the
// note under the row says how many of them there are.
const SESSION_CAP = 5;
const SESSION_AGENT_CAP = 6;

interface RunningSessionRow {
  session: RunningSession;
  activity: SessionActivity;
  /** Working agents to show under the session, longest-running first. */
  agents: LiveAgentEntry[];
  /** Working agents past SESSION_AGENT_CAP — stated, never dropped silently. */
  hiddenAgents: number;
  /**
   * The session's live-but-not-working rows, already worded ('' when there
   * are none). Stalled rows are the ghosts that used to fill the whole
   * card; an unreadable timestamp is named as such, not counted as stalled.
   */
  hiddenAgentsNote: string;
}

const sessionParts = computed(() =>
  partitionSessions(
    data.value?.runningSessions ?? [],
    data.value?.liveAgentEntries ?? [],
    now.value,
  ),
);
const hiddenSessionsLine = computed(() =>
  hiddenSessionsLabel(sessionParts.value.idle, sessionParts.value.unknown),
);

const runningSessionRows = computed<RunningSessionRow[]>(() => {
  const agentsBySession = new Map<string, LiveAgentEntry[]>();
  for (const a of data.value?.liveAgentEntries ?? []) {
    const list = agentsBySession.get(a.sessionId) ?? [];
    list.push(a);
    agentsBySession.set(a.sessionId, list);
  }
  // `running` already comes back most-recently-active first.
  return sessionParts.value.running.map((session) => {
    const parts = partitionAgents(agentsBySession.get(session.sessionId) ?? [], now.value);
    const agents = byRuntimeDesc(parts.working);
    return {
      session,
      activity: sessionActivity(session.lastEventAt, now.value),
      agents: agents.slice(0, SESSION_AGENT_CAP),
      hiddenAgents: Math.max(0, agents.length - SESSION_AGENT_CAP),
      hiddenAgentsNote: hiddenAgentsLabel(parts.stalled, parts.unknown),
    };
  });
});
const nowRunning = computed(() => runningSessionRows.value.slice(0, SESSION_CAP));
const hiddenRunning = computed(() => Math.max(0, runningSessionRows.value.length - SESSION_CAP));

const SESSION_ACTIVE_MINUTES = SESSION_ACTIVE_WITHIN_MS / (60 * 1000);
// A listed row is running on one half of the rule or the other: its own
// events ('active'), or an agent vouching for it while the events are quiet
// ('working'). 'idle' is not a word a row here can carry — it is what the
// footer calls the sessions this card does NOT list, and a row under "Now
// running" that reads "idle" looks like the filter failed.
type RowState = 'active' | 'working' | 'unknown';
const ROW_TONE: Record<RowState, 'info' | 'neutral'> = {
  active: 'info',
  working: 'info',
  unknown: 'neutral',
};
function rowState(row: RunningSessionRow): RowState {
  if (row.activity === 'active') return 'active';
  // Event-idle or an unreadable event time: only a working agent could have
  // kept the row on the page, so that is the state it reports. The 'unknown'
  // branch is unreachable while partitionSessions keeps those rows out.
  return row.agents.length > 0 || row.hiddenAgents > 0 ? 'working' : 'unknown';
}

// The state is never carried by the dot's colour alone — this is the same
// fact in words, and it is what a screen reader reads out.
function sessionStateLabel(row: RunningSessionRow): string {
  const when = formatRelative(row.session.lastEventAt, now.value);
  if (rowState(row) === 'working') {
    // The events half is stated as what it is — quiet, or unreadable — and
    // never as more than the log supports.
    const events =
      row.activity === 'unknown'
        ? 'last event time unreadable'
        : `no event for over ${SESSION_ACTIVE_MINUTES} minutes`;
    return `${events}, ${pluralize(row.agents.length + row.hiddenAgents, 'agent')} working`;
  }
  if (row.activity === 'unknown') return 'last event time unreadable';
  return `active, last event ${when}`;
}

// Round 9's summary counted agents; this one counts runs, because that is
// what the card now lists. Idle sessions are no longer listed, so they are
// counted here instead — a factory with four sessions and none running is a
// real state the operator needs to be able to read off this line.
const sessionsSummary = computed(() => {
  const running = sessionParts.value.running;
  if (running.length === 0) return '';
  const clauses = [`${pluralize(running.length, 'session')} running`];
  if (hiddenSessionsLine.value) clauses.push(hiddenSessionsLine.value);
  const newest = running[0];
  if (newest) clauses.push(`last event ${formatRelative(newest.lastEventAt, now.value)}`);
  return clauses.join(' · ');
});

// The signatures behind the flash. Ids only, deliberately: the elapsed labels
// re-render every second off useNow(), and folding them in would flash every
// block once a second forever. What should flash is a dispatch appearing or an
// agent finishing — a change in WHICH rows exist, not in how they read.
// Both run over the SHOWN sets: an agent stalling out of the card, or a
// session going idle and leaving it, is exactly such a change.
const agentsSignature = () =>
  workingEntries.value.map((a) => `${a.id}:${a.taskId ?? ''}`).join('|');
// Dogfood round 2: for the sessions card the meaningful change is a session
// APPENDING something — that is the one signal that says the factory is
// working right now — so the signature is (session, last event), not just
// which sessions exist. A poll where nothing was appended still does not
// flash.
const sessionsSignature = () =>
  sessionParts.value.running.map((s) => `${s.sessionId}:${s.lastEventAt}`).join('|');
const dispatchSignature = () =>
  (data.value?.recentDispatches ?? []).map((d) => d.eventId).join('|');
const { flashing: agentsFlash } = useFlashOnChange(agentsSignature);
const { flashing: sessionsFlash } = useFlashOnChange(sessionsSignature);
const { flashing: dispatchFlash } = useFlashOnChange(dispatchSignature);

// Default: expanded when there are few enough agents overall to see in
// full (<=6), collapsed once there are more. A manual toggle on a specific
// group always wins over this default (tracked separately so it survives
// the 5s poll re-fetch instead of snapping back).
const defaultGroupsExpanded = computed(() => workingEntries.value.length <= 6);
const manuallyOpened = ref<Set<string>>(new Set());
const manuallyClosed = ref<Set<string>>(new Set());
function isGroupExpanded(key: string): boolean {
  if (manuallyOpened.value.has(key)) return true;
  if (manuallyClosed.value.has(key)) return false;
  return defaultGroupsExpanded.value;
}
function toggleGroup(key: string) {
  if (isGroupExpanded(key)) {
    manuallyOpened.value = new Set([...manuallyOpened.value].filter((k) => k !== key));
    manuallyClosed.value = new Set(manuallyClosed.value).add(key);
  } else {
    manuallyClosed.value = new Set([...manuallyClosed.value].filter((k) => k !== key));
    manuallyOpened.value = new Set(manuallyOpened.value).add(key);
  }
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

// Operator directive (Phase 6b round 10): "add a small block on the Overview
// showing how to use the /bs commands". Wording taken from the subcommand
// table in
// .claude/skills/bs/SKILL.md so the hint cannot drift into describing commands
// that do something else. The last two appear only when there is actually
// something waiting — a permanent "/bs waivers" line next to a rail card that
// reads "Nothing pending" is noise.
const bsCommands = computed<CommandHintItem[]>(() => {
  const items: CommandHintItem[] = [
    { cmd: '/bs status', desc: 'Live agent count, budget burn, epic phase' },
    { cmd: '/bs plan <goal>', desc: 'Draft or re-plan an epic with the planner' },
    { cmd: '/bs run <epic>', desc: 'Admit a wave and drive it through to merge' },
  ];
  if ((data.value?.alerts.pendingWaivers ?? 0) > 0) {
    items.push({ cmd: '/bs waivers', desc: 'Answer the pending S3/S4 waiver batch' });
  }
  if (pendingLessons.value > 0) {
    items.push({ cmd: '/bs lessons', desc: 'Review pending lesson candidates' });
  }
  return items;
});
</script>

<template>
  <div class="app-page">
    <PageHeader :title="project ? `${project} · Overview` : 'Overview (all projects)'" />

    <Banner v-if="error" tone="danger" show-retry @retry="load">{{ error }}</Banner>

    <!-- Operator directive (Phase 6b round 5): was tint="amber" — reads
         amber-on-amber against the "Pending your review" rail card's own
         warning-toned chips right below it. Highlight's `lilac` tint
         (--ds-discovery-bold + --ds-text-on-bold, kit's discovery colour,
         distinct from warning/danger) is visually separate from those
         chips while still reading as "this needs attention", not a
         routine info banner. -->
    <Highlight
      v-if="needsAttention && data"
      tint="lilac"
      eyebrow="Needs you"
      :title="attentionSentence"
    >
      <template #action>
        <Button variant="inverse" size="sm" @click="goToKanban">Review in Kanban</Button>
      </template>
    </Highlight>

    <!-- Stat row: its own remote-data zone. Operator directive 3 (round 3):
         each StatCard is now a clickable link to its detail page (native
         <a> via router-link — a:focus-visible is already covered by the
         vendored base layer, ds-tokens.css, so no new focus CSS). -->
    <MetricGrid :columns="4">
      <template v-if="loading">
        <Skeleton v-for="i in 4" :key="i" height="112" />
      </template>
      <template v-else-if="data">
        <router-link
          to="/flow"
          class="ds-stat-link"
          :class="{ 'ds-flash': agentsFlash }"
          aria-label="Active agents, view in Flow"
        >
          <!-- Working, not merely live: the stalled rows are named in the
               hint so the number never quietly shrinks past them. -->
          <StatCard
            label="Active agents"
            :value="data.workingAgentCount"
            icon="bot"
            tint="blue"
            :delta="signed(data.workingAgentCountDelta5m)"
            delta-tone="neutral"
            :hint="
              data.stalledAgentCount > 0
                ? `vs 5 min ago · ${data.stalledAgentCount} stalled not counted`
                : 'vs 5 min ago'
            "
          />
        </router-link>
        <router-link to="/analytics" class="ds-stat-link" aria-label="Budget used, view in Analytics">
          <StatCard
            label="Budget used"
            :value="`${data.tokensByEpic.reduce((s, e) => s + e.tokensSpent, 0)} tok`"
            icon="coins"
            tint="amber"
            :delta="data.budgetUsedPctPointDelta1h === null ? undefined : `${signed(Math.round(data.budgetUsedPctPointDelta1h))}pp`"
            delta-tone="warning"
            :hint="data.budgetUsedPctPointDelta1h === null ? 'No budget set' : 'vs 1h ago'"
          />
        </router-link>
        <router-link to="/kanban" class="ds-stat-link" aria-label="Epics in flight, view in Kanban">
          <StatCard
            label="Epics in flight"
            :value="data.epicsInFlight.length"
            icon="layers"
            tint="mint"
            delta-tone="neutral"
            hint="No history yet"
          />
        </router-link>
        <router-link to="/kanban" class="ds-stat-link" aria-label="Alerts, view in Kanban">
          <StatCard
            label="Alerts"
            :value="data.alerts.escalations + data.alerts.pendingWaivers"
            icon="triangle-alert"
            tint="rose"
            delta-tone="danger"
            hint="No history yet"
          />
        </router-link>
      </template>
    </MetricGrid>

    <!-- Operator directive (dogfood round 2): "the now-running block should
         show the sessions that are running right now, with an animated
         indicator". One row per RUNNING session, most recently active first,
         each with a pulsing dot while it is genuinely appending events. A
         session that has gone quiet and has no agent still working is not
         listed at all — it is counted in the summary and the footer, because
         those rows are the reason this card used to look frozen (script
         section). The card itself stays between runs (D-241): an idle
         factory is a state to read, not a reason to take the block away.
         Only the first-ever run has nothing to read yet, and the
         illustration below covers that. -->
    <Card
      v-if="!loading && data && !isFirstRun"
      title="Now running"
      :class="{ 'ds-flash': sessionsFlash }"
    >
      <template #action>
        <Button variant="ghost" size="sm" @click="router.push('/flow')">View →</Button>
      </template>
      <template v-if="nowRunning.length > 0">
        <p class="live-agents-summary">{{ sessionsSummary }}</p>
        <ul class="running-session-list">
          <li v-for="row in nowRunning" :key="row.session.sessionId" class="running-session">
            <div class="running-session__head">
              <span
                class="running-session__dot"
                :class="`running-session__dot--${rowState(row)}`"
                aria-hidden="true"
              />
              <span class="running-session__id" :title="`started ${formatDateTime(row.session.startedAt)}`">
                {{ row.session.sessionId }}
              </span>
              <Lozenge :tone="ROW_TONE[rowState(row)]">{{ rowState(row) }}</Lozenge>
              <span class="running-session__state">{{ sessionStateLabel(row) }}</span>
            </div>
            <p class="running-session__meta">
              {{ pluralize(row.session.eventCount, 'event') }}
              <template v-if="row.session.lastEventType">
                · last <code>{{ row.session.lastEventType }}</code>
              </template>
              <template v-if="row.session.projects.length > 0">
                · {{ row.session.projects.join(', ') }}
              </template>
            </p>
            <!-- Only WORKING agents get a row: "running now" has to be true
                 of the agent, not just of a registry row nobody closed. -->
            <ul v-if="row.agents.length > 0" class="running-session__agents">
              <li v-for="a in row.agents" :key="a.id">
                <component
                  :is="a.taskId ? 'router-link' : 'div'"
                  :to="a.taskId ? `/tasks/${encodeURIComponent(a.taskId)}` : undefined"
                  class="live-agent-entry"
                  :title="`started ${formatDateTime(a.dispatchedAt)}`"
                  :aria-label="
                    a.taskId
                      ? `${a.agentRole} on ${a.modelTier}, working on ${a.taskId}, running ${formatElapsed(a.dispatchedAt, now)}, opens task detail`
                      : undefined
                  "
                >
                  <span
                    class="live-agent-entry__dot live-agent-entry__dot--working"
                    aria-hidden="true"
                  />
                  <IdentityChip :id="a.agentRole" :label="`${a.agentRole} · ${a.modelTier}`" live />
                  <span class="live-agent-entry__task">{{ agentScopeLabel(a) }}</span>
                  <span class="live-agent-entry__elapsed">{{
                    formatElapsed(a.dispatchedAt, now)
                  }}</span>
                </component>
              </li>
            </ul>
            <!-- Never a silent cap, and never a silent filter. -->
            <p v-if="row.hiddenAgents > 0" class="running-session__note">
              +{{ row.hiddenAgents }} more in Live agents below
            </p>
            <p v-if="row.hiddenAgentsNote" class="running-session__note">
              {{ row.hiddenAgentsNote }}
            </p>
          </li>
        </ul>
        <p v-if="hiddenRunning > 0" class="now-running-more">
          +{{ hiddenRunning }} older {{ hiddenRunning === 1 ? 'session' : 'sessions' }} not shown
        </p>
        <p v-if="hiddenSessionsLine" class="now-running-more">{{ hiddenSessionsLine }}</p>
      </template>
      <template v-else>
        <EmptyState icon="play" inline>No sessions running.</EmptyState>
        <p v-if="hiddenSessionsLine" class="now-running-more">{{ hiddenSessionsLine }}</p>
      </template>
    </Card>

    <!-- First-run empty: the app's one designated illustration slot. The
         message tells the operator to start the factory with a plan, so the
         card that names the command has to survive into this branch — the
         rail it normally lives in is on the other side of the v-else-if. -->
    <template v-if="!loading && isFirstRun">
      <EmptyState :illustration-src="coffeeIllustration">
        Nothing running yet. Start the factory with a plan and this page fills in.
      </EmptyState>
      <Card title="Factory commands">
        <CommandHint :items="bsCommands" />
      </Card>
    </template>

    <TwoColumn v-else-if="!loading && data">
      <!-- Operator directive 3 (round 3): every card gets an explicit
           affordance to its detail page — a ghost Button in Card's own
           `action` slot (the kit's own Card.prompt.md), "View ->" pattern
           already established by the Recent-dispatch row titles' own arrow
           glyph. -->
      <!-- Operator directive (Phase 6b round 5, revised round 6): grouped
           by "role · tier" (IdentityChip + count Lozenge), each a
           Disclosure trigger (LiveAgentGroupRow.vue — same aria-expanded/
           aria-controls pattern as CausalTimelineList's chevron toggle)
           revealing per-agent lines (dot + task id link). TWO independent
           columns (index-parity split, script section) rather than one CSS
           Grid with full-span detail items — that collapsed to a single
           visual column whenever consecutive groups were both expanded
           (round 5's actual bug); this way each column keeps its own
           groups' details confined to itself, so toggling one group never
           reflows or reorders the other column. -->
      <Card title="Live agents" :class="{ 'ds-flash': agentsFlash }">
        <template #action>
          <Button variant="ghost" size="sm" @click="router.push('/flow')">View →</Button>
        </template>
        <div v-if="liveAgentGroups.length > 0" class="live-agents-container">
          <p class="live-agents-summary">{{ runningSummary }}</p>
          <div class="live-agents-grid">
            <div class="live-agents-col">
              <LiveAgentGroupRow
                v-for="g in leftAgentGroups"
                :key="g.key"
                :group="g"
                :expanded="isGroupExpanded(g.key)"
                :now="now"
                @toggle="toggleGroup(g.key)"
              />
            </div>
            <div class="live-agents-col">
              <LiveAgentGroupRow
                v-for="g in rightAgentGroups"
                :key="g.key"
                :group="g"
                :expanded="isGroupExpanded(g.key)"
                :now="now"
                @toggle="toggleGroup(g.key)"
              />
            </div>
          </div>
        </div>
        <template v-else>
          <EmptyState icon="bot" inline>No agents working right now.</EmptyState>
          <p v-if="hiddenAgentsLine" class="now-running-more">{{ hiddenAgentsLine }}</p>
        </template>
      </Card>

      <Card title="Recent dispatch decisions" :class="{ 'ds-flash': dispatchFlash }">
        <template #action>
          <Button variant="ghost" size="sm" @click="router.push('/timeline')">View →</Button>
        </template>
        <RowList v-if="data.recentDispatches.length > 0">
          <Row
            v-for="d in data.recentDispatches"
            :key="d.eventId"
            :title="`${d.agentRole} → ${d.modelTier}/${d.provider}`"
            :meta="`${d.reason ?? 'no reason given'} · ${formatRelative(d.ts, now)}`"
            :clickable="!!d.taskId"
            :aria-label="d.taskId ? `Open task ${d.taskId}` : undefined"
            @activate="d.taskId && router.push(`/tasks/${encodeURIComponent(d.taskId)}`)"
          >
            <template #trailing>
              <IdentityChip :id="d.agentRole" :label="`${d.agentRole} · ${d.modelTier}`" />
            </template>
          </Row>
        </RowList>
        <EmptyState v-else icon="send" inline>No dispatches yet.</EmptyState>
      </Card>

      <Card title="Milestone progress">
        <template #action>
          <Button variant="ghost" size="sm" @click="router.push('/roadmap')">View →</Button>
        </template>
        <div v-if="data.milestoneProgress.length > 0" style="display: flex; flex-direction: column; gap: var(--ds-space-3)">
          <div v-for="m in data.milestoneProgress" :key="m.milestoneId">
            <div class="ds-row__title">{{ m.name }}</div>
            <ProgressBar :value="m.tasksCompleted" :total="m.tasksTotal || 1" :label="`${m.name} progress`" />
          </div>
        </div>
        <EmptyState v-else icon="map" inline>No milestones declared yet.</EmptyState>
      </Card>

      <template #rail>
        <Card title="Epics in flight">
          <!-- Operator directive 3: each row (not just the card header) is
               its own affordance — /kanban?epic=<id>, KanbanPage.vue reads
               the query param to pre-select that epic's lane. -->
          <RowList v-if="data.epicsInFlight.length > 0" density="compact">
            <li v-for="epicId in data.epicsInFlight" :key="epicId" class="ds-row">
              <router-link
                :to="`/kanban?epic=${encodeURIComponent(epicId)}`"
                style="display: flex; align-items: center; gap: var(--ds-space-2); color: inherit; text-decoration: none"
                :aria-label="`${epicId}, view in Kanban`"
              >
                <IdentityChip :id="epicId" />
              </router-link>
            </li>
          </RowList>
          <EmptyState v-else icon="layers" inline>No epics in flight.</EmptyState>
        </Card>
        <Card title="Pending your review">
          <!-- Every count known, every count zero. An unknown lesson count
               fails this on purpose: the all-clear is a claim about the
               factory, and it is not one a dropped request can make (D-225). -->
          <EmptyState v-if="nothingPending(reviewCounts)" icon="circle-check" inline>
            Nothing pending.
          </EmptyState>
          <div v-else style="display: flex; flex-wrap: wrap; gap: var(--ds-space-2)">
            <button v-if="data.alerts.pendingWaivers > 0" type="button" class="ds-btn ds-btn--ghost ds-btn--xs" style="padding: 0" @click="goToKanban">
              <Lozenge tone="warning">{{ pluralize(data.alerts.pendingWaivers, 'waiver') }} pending</Lozenge>
            </button>
            <button v-if="data.alerts.escalations > 0" type="button" class="ds-btn ds-btn--ghost ds-btn--xs" style="padding: 0" @click="goToKanban">
              <Lozenge tone="danger">{{ pluralize(data.alerts.escalations, 'escalation') }}</Lozenge>
            </button>
            <button v-if="pendingLessons !== null && pendingLessons > 0" type="button" class="ds-btn ds-btn--ghost ds-btn--xs" style="padding: 0" @click="router.push('/lessons')">
              <Lozenge tone="discovery">{{ pluralize(pendingLessons, 'lesson candidate') }}</Lozenge>
            </button>
            <!-- Said out loud rather than left as a silence the operator would
                 read as zero. Warning, not danger: the other two counts on this
                 card did arrive, and the poll retries every POLL_MS. -->
            <Lozenge v-if="lessonsFailed" tone="warning">lesson candidates unavailable</Lozenge>
          </div>
        </Card>
        <!-- Operator directive (Phase 6b round 10): the page shows what the
             factory did; this is where the operator finds out how to make it
             do the next thing. Rail, below the two cards it refers to. The
             directive also said "small"; Card has no size, and never did
             (D-258), so that half is unmet rather than silently faked. -->
        <Card title="Factory commands">
          <CommandHint :items="bsCommands" />
        </Card>
      </template>
    </TwoColumn>
  </div>
</template>
