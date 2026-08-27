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
// Phase 6b round 7 (operator directive: "Tôi cần nhìn được ở Dashboard cái gì
// đang chạy, một dạng real-time update, để ý đến các mốc thời gian"): the
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
// Phase 6b round 9 (operator directive: "trong phần overview, tôi muốn thấy
// cái gì đang running ... thêm animation nhỏ cho các indicator ở chip với các
// agent đang thực sự hoạt động. Các update hoặc block cần động hơn để thấy
// thực sự factory đang chạy"). Three parts: a "Now running" card that names
// the tasks (the grouped card below answers *who* is running, by role·tier —
// it took a disclosure click to find out *what*); chip/dot animation spent
// only on agents lib/liveness.ts can call `working` (IdentityChip's `live`
// prop); and a one-shot flash on the blocks whose data actually changed under
// the poll, driven by a signature of that data rather than by the fetch —
// otherwise every card would flash every 5s and the motion would mean nothing.
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import coffeeIllustration from '../assets/illustrations/coffee.svg';
import CommandHint, { type CommandHintItem } from '../components/CommandHint.vue';
import Banner from '../components/hds/Banner.vue';
import Button from '../components/hds/Button.vue';
import Card from '../components/hds/Card.vue';
import EmptyState from '../components/hds/EmptyState.vue';
import Highlight from '../components/hds/Highlight.vue';
import Lozenge from '../components/hds/Lozenge.vue';
import MetricGrid from '../components/hds/MetricGrid.vue';
import PageHeader from '../components/hds/PageHeader.vue';
import Row from '../components/hds/Row.vue';
import RowList from '../components/hds/RowList.vue';
import Skeleton from '../components/hds/Skeleton.vue';
import StatCard from '../components/hds/StatCard.vue';
import TwoColumn from '../components/hds/TwoColumn.vue';
import IdentityChip from '../components/IdentityChip.vue';
import LiveAgentGroupRow, { type LiveAgentGroupUI } from '../components/LiveAgentGroupRow.vue';
import ProgressBar from '../components/ProgressBar.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { useFlashOnChange } from '../composables/useFlashOnChange.js';
import { useNow } from '../composables/useNow.js';
import { usePoll } from '../composables/usePoll.js';
import { useProjectContext } from '../composables/useProjectContext.js';
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
  AGENT_STALE_AFTER_MS,
  activeSessionCount,
  agentActivity,
  byRuntimeDesc,
  bySessionRecency,
  longestRunningSince,
  SESSION_ACTIVE_WITHIN_MS,
  type SessionActivity,
  sessionActivity,
  workingCount,
} from '../lib/liveness.js';
import { nothingPending, type PendingReviewCounts, pendingClauses } from '../lib/pendingReview.js';

const router = useRouter();
const { setBreadcrumb } = useBreadcrumb();
const { project } = useProjectContext();

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
    data.value = await fetchOverview(undefined, project.value);
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
watch(project, () => {
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

// Operator directive (Phase 6b round 5): the flat capped list (round 4)
// doesn't scale past a handful of agents either — replaced with role·tier
// GROUPS (IdentityChip + count), each a Disclosure trigger (same
// aria-expanded/aria-controls pattern as CausalTimelineList/TimelineRow)
// revealing its per-agent lines. Grouping is client-side; liveAgentEntries
// already carries everything a group needs (role, tier, taskId).
const liveAgentGroups = computed<LiveAgentGroupUI[]>(() => {
  const byKey = new Map<string, LiveAgentGroupUI>();
  for (const a of data.value?.liveAgentEntries ?? []) {
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

// Round 7: the one sentence that answers "cái gì đang chạy" without expanding
// a single group — how many agents, and how long the oldest has been at it.
// The second half is the part that carries information: 8 agents at 30s is a
// healthy factory, 8 agents where the oldest is at 2h is a wedged one.
//
// Round 9 splits the count: "8 agents working" was a claim the data did not
// support, because it counted agents the factory itself would already report
// as stale. Agents whose timestamp is unreadable (`unknown`) are counted in
// neither clause rather than being described as stalled — that would be a
// second unsupported claim, just in the other direction.
const STALE_HOURS = AGENT_STALE_AFTER_MS / (60 * 60 * 1000);
const runningSummary = computed(() => {
  const entries = data.value?.liveAgentEntries ?? [];
  if (entries.length === 0) return '';
  const stalled = entries.filter((a) => agentActivity(a, now.value) === 'stalled').length;
  const clauses = [`${pluralize(workingCount(entries, now.value), 'agent')} working`];
  if (stalled > 0) clauses.push(`${stalled} with no update in over ${STALE_HOURS}h`);
  const since = longestRunningSince(entries);
  if (since !== null) clauses.push(`longest running ${formatElapsed(since, now.value)}`);
  return clauses.join(', ');
});

// Dogfood round 2 — operator: "Không thấy overview update, và nên thay thông
// tin trong block now running bằng các session đang chạy hiện tại, có
// animation indicator".
//
// Round 9's version of this card listed `liveAgentEntries` longest-running
// first, capped at 8. In the real state/smith.db that made it permanently
// wrong: `agents` rows stay `live` until a terminal event closes them out,
// and 12 rows from a session that ended on 2026-08-07 were still `live` on
// 2026-08-11. Longest-running-first put those twelve ghosts at the top, the
// cap of 8 meant nothing else ever reached the card, and the block never
// changed no matter what the factory did — the "không thấy update" the
// operator reported.
//
// So the unit of this card is now the SESSION (queries.ts runningSessions()),
// ordered by what appended an event most recently, with its own activity
// state. A session's live agents are shown UNDER it, and only while that
// session is itself active — an agent row cannot claim to be running now if
// its whole run has been quiet for hours.
const SESSION_CAP = 5;
const SESSION_AGENT_CAP = 6;

interface RunningSessionRow {
  session: RunningSession;
  activity: SessionActivity;
  /** Live agents to show under an active session, longest-running first. */
  agents: LiveAgentEntry[];
  /** Agents past SESSION_AGENT_CAP on an active session — stated, never dropped silently. */
  hiddenAgents: number;
  /**
   * Rows still `live` under a session that is NOT active. Named for what it
   * is: no terminal event was ever recorded, which is not the same as work
   * in progress. This is the ghost count that used to fill the whole card.
   */
  unclosedAgents: number;
}

const runningSessionRows = computed<RunningSessionRow[]>(() => {
  const agentsBySession = new Map<string, LiveAgentEntry[]>();
  for (const a of data.value?.liveAgentEntries ?? []) {
    const list = agentsBySession.get(a.sessionId) ?? [];
    list.push(a);
    agentsBySession.set(a.sessionId, list);
  }
  return bySessionRecency(data.value?.runningSessions ?? []).map((session) => {
    const activity = sessionActivity(session.lastEventAt, now.value);
    const agents = byRuntimeDesc(agentsBySession.get(session.sessionId) ?? []);
    const active = activity === 'active';
    return {
      session,
      activity,
      agents: active ? agents.slice(0, SESSION_AGENT_CAP) : [],
      hiddenAgents: active ? Math.max(0, agents.length - SESSION_AGENT_CAP) : 0,
      unclosedAgents: active ? 0 : agents.length,
    };
  });
});
const nowRunning = computed(() => runningSessionRows.value.slice(0, SESSION_CAP));
const hiddenRunning = computed(() => Math.max(0, runningSessionRows.value.length - SESSION_CAP));

const SESSION_ACTIVE_MINUTES = SESSION_ACTIVE_WITHIN_MS / (60 * 1000);
const ACTIVITY_TONE: Record<SessionActivity, 'info' | 'neutral'> = {
  active: 'info',
  idle: 'neutral',
  unknown: 'neutral',
};
const ACTIVITY_WORD: Record<SessionActivity, string> = {
  active: 'active',
  idle: 'idle',
  unknown: 'unknown',
};

// The state is never carried by the dot's colour alone — this is the same
// fact in words, and it is what a screen reader reads out.
function sessionStateLabel(row: RunningSessionRow): string {
  const when = formatRelative(row.session.lastEventAt, now.value);
  if (row.activity === 'unknown') return 'last event time unreadable';
  if (row.activity === 'active') return `active, last event ${when}`;
  return `idle for over ${SESSION_ACTIVE_MINUTES} minutes, last event ${when}`;
}

// Round 9's summary counted agents; this one counts runs, because that is
// what the card now lists. Idle sessions are named rather than hidden — a
// factory with four sessions and none active is a real state the operator
// needs to be able to read off this line.
const sessionsSummary = computed(() => {
  const sessions = data.value?.runningSessions ?? [];
  if (sessions.length === 0) return '';
  const active = activeSessionCount(sessions, now.value);
  const clauses = [`${pluralize(active, 'session')} active`];
  if (sessions.length > active) clauses.push(`${sessions.length - active} idle`);
  const newest = bySessionRecency(sessions)[0];
  if (newest) clauses.push(`last event ${formatRelative(newest.lastEventAt, now.value)}`);
  return clauses.join(', ');
});

// The signatures behind the flash. Ids only, deliberately: the elapsed labels
// re-render every second off useNow(), and folding them in would flash every
// block once a second forever. What should flash is a dispatch appearing or an
// agent finishing — a change in WHICH rows exist, not in how they read.
const agentsSignature = () =>
  (data.value?.liveAgentEntries ?? []).map((a) => `${a.id}:${a.taskId ?? ''}`).join('|');
// Dogfood round 2: for the sessions card the meaningful change is a session
// APPENDING something — that is the one signal that says the factory is
// working right now — so the signature is (session, last event), not just
// which sessions exist. A poll where nothing was appended still does not
// flash.
const sessionsSignature = () =>
  (data.value?.runningSessions ?? []).map((s) => `${s.sessionId}:${s.lastEventAt}`).join('|');
const dispatchSignature = () =>
  (data.value?.recentDispatches ?? []).map((d) => d.eventId).join('|');
const { flashing: agentsFlash } = useFlashOnChange(agentsSignature);
const { flashing: sessionsFlash } = useFlashOnChange(sessionsSignature);
const { flashing: dispatchFlash } = useFlashOnChange(dispatchSignature);

// Default: expanded when there are few enough agents overall to see in
// full (<=6), collapsed once there are more. A manual toggle on a specific
// group always wins over this default (tracked separately so it survives
// the 5s poll re-fetch instead of snapping back).
const defaultGroupsExpanded = computed(() => (data.value?.liveAgentEntries.length ?? 0) <= 6);
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

// Operator directive (Phase 6b round 10): "Thêm block nho nhỏ ở Overview để
// hướng dẫn dùng các command /bs". Wording taken from the subcommand table in
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
         vendored base layer, hds-tokens.css, so no new focus CSS). -->
    <MetricGrid :columns="4">
      <template v-if="loading">
        <Skeleton v-for="i in 4" :key="i" height="112" />
      </template>
      <template v-else-if="data">
        <router-link
          to="/flow"
          class="hds-stat-link"
          :class="{ 'hds-flash': agentsFlash }"
          aria-label="Active agents, view in Flow"
        >
          <StatCard
            label="Active agents"
            :value="data.liveAgentCount"
            icon="bot"
            tint="blue"
            :delta="signed(data.liveAgentCountDelta5m)"
            delta-tone="neutral"
            hint="vs 5 min ago"
          />
        </router-link>
        <router-link to="/analytics" class="hds-stat-link" aria-label="Budget used, view in Analytics">
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
        <router-link to="/kanban" class="hds-stat-link" aria-label="Epics in flight, view in Kanban">
          <StatCard
            label="Epics in flight"
            :value="data.epicsInFlight.length"
            icon="layers"
            tint="mint"
            delta-tone="neutral"
            hint="No history yet"
          />
        </router-link>
        <router-link to="/kanban" class="hds-stat-link" aria-label="Alerts, view in Kanban">
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

    <!-- Operator directive (dogfood round 2): "nên thay thông tin trong block
         now running bằng các session đang chạy hiện tại, có animation
         indicator". One row per SESSION, most recently active first, each
         with a pulsing dot while it is genuinely appending events. A session
         that has gone quiet keeps its row but loses the pulse and collapses
         to its header — and says plainly how many of its agents were never
         closed out, because those rows are the reason this card used to look
         frozen (script section). -->
    <Card
      v-if="!loading && data && nowRunning.length > 0"
      title="Now running"
      :class="{ 'hds-flash': sessionsFlash }"
    >
      <template #action>
        <Button variant="ghost" size="sm" @click="router.push('/flow')">View →</Button>
      </template>
      <p class="live-agents-summary">{{ sessionsSummary }}</p>
      <ul class="running-session-list">
        <li v-for="row in nowRunning" :key="row.session.sessionId" class="running-session">
          <div class="running-session__head">
            <span
              class="running-session__dot"
              :class="`running-session__dot--${row.activity}`"
              aria-hidden="true"
            />
            <span class="running-session__id" :title="`started ${formatDateTime(row.session.startedAt)}`">
              {{ row.session.sessionId }}
            </span>
            <Lozenge :tone="ACTIVITY_TONE[row.activity]">{{ ACTIVITY_WORD[row.activity] }}</Lozenge>
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
          <!-- An agent row appears only under a session that is itself
               active: "running now" has to be true of the run, not just of a
               registry row nobody closed. -->
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
                  class="live-agent-entry__dot"
                  :class="`live-agent-entry__dot--${agentActivity(a, now)}`"
                  aria-hidden="true"
                />
                <IdentityChip
                  :id="a.agentRole"
                  :label="`${a.agentRole} · ${a.modelTier}`"
                  :live="agentActivity(a, now) === 'working'"
                />
                <span class="live-agent-entry__task">{{ agentScopeLabel(a) }}</span>
                <span class="live-agent-entry__elapsed">{{
                  formatElapsed(a.dispatchedAt, now)
                }}</span>
              </component>
            </li>
          </ul>
          <!-- Never a silent cap, in either direction. -->
          <p v-if="row.hiddenAgents > 0" class="running-session__note">
            +{{ row.hiddenAgents }} more in Live agents below
          </p>
          <p v-else-if="row.unclosedAgents > 0" class="running-session__note">
            {{ pluralize(row.unclosedAgents, 'agent') }} still marked live, no terminal event
            recorded
          </p>
        </li>
      </ul>
      <p v-if="hiddenRunning > 0" class="now-running-more">
        +{{ hiddenRunning }} older {{ hiddenRunning === 1 ? 'session' : 'sessions' }} not shown
      </p>
    </Card>

    <!-- First-run empty: the app's one designated illustration slot. The
         message tells the operator to start the factory with a plan, so the
         card that names the command has to survive into this branch — the
         rail it normally lives in is on the other side of the v-else-if. -->
    <template v-if="!loading && isFirstRun">
      <EmptyState :illustration-src="coffeeIllustration">
        Nothing running yet. Start the factory with a plan and this page fills in.
      </EmptyState>
      <Card title="Factory commands" size="sm">
        <CommandHint :items="bsCommands" />
      </Card>
    </template>

    <TwoColumn v-else-if="!loading && data">
      <!-- Operator directive 3 (round 3): every card gets an explicit
           affordance to its detail page — a ghost Button in Card's own
           `action` slot (design-system/hds/components/surfaces/
           Card.prompt.md), "View ->" pattern already established by the
           Recent-dispatch row titles' own arrow glyph. -->
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
      <Card title="Live agents" :class="{ 'hds-flash': agentsFlash }">
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
        <EmptyState v-else icon="bot" inline>No agents running right now.</EmptyState>
      </Card>

      <Card title="Recent dispatch decisions" :class="{ 'hds-flash': dispatchFlash }">
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
            <div class="hds-row__title">{{ m.name }}</div>
            <ProgressBar :value="m.tasksCompleted" :total="m.tasksTotal || 1" :label="`${m.name} progress`" />
          </div>
        </div>
        <EmptyState v-else icon="map" inline>No milestones declared yet.</EmptyState>
      </Card>

      <template #rail>
        <Card title="Epics in flight" size="sm">
          <!-- Operator directive 3: each row (not just the card header) is
               its own affordance — /kanban?epic=<id>, KanbanPage.vue reads
               the query param to pre-select that epic's lane. -->
          <RowList v-if="data.epicsInFlight.length > 0" density="compact">
            <li v-for="epicId in data.epicsInFlight" :key="epicId" class="hds-row">
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
        <Card title="Pending your review" size="sm">
          <!-- Every count known, every count zero. An unknown lesson count
               fails this on purpose: the all-clear is a claim about the
               factory, and it is not one a dropped request can make (D-225). -->
          <EmptyState v-if="nothingPending(reviewCounts)" icon="circle-check" inline>
            Nothing pending.
          </EmptyState>
          <div v-else style="display: flex; flex-wrap: wrap; gap: var(--ds-space-2)">
            <button v-if="data.alerts.pendingWaivers > 0" type="button" class="hds-btn hds-btn--ghost hds-btn--xs" style="padding: 0" @click="goToKanban">
              <Lozenge tone="warning">{{ pluralize(data.alerts.pendingWaivers, 'waiver') }} pending</Lozenge>
            </button>
            <button v-if="data.alerts.escalations > 0" type="button" class="hds-btn hds-btn--ghost hds-btn--xs" style="padding: 0" @click="goToKanban">
              <Lozenge tone="danger">{{ pluralize(data.alerts.escalations, 'escalation') }}</Lozenge>
            </button>
            <button v-if="pendingLessons !== null && pendingLessons > 0" type="button" class="hds-btn hds-btn--ghost hds-btn--xs" style="padding: 0" @click="router.push('/lessons')">
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
             do the next thing. Rail, small, below the two cards it refers to. -->
        <Card title="Factory commands" size="sm">
          <CommandHint :items="bsCommands" />
        </Card>
      </template>
    </TwoColumn>
  </div>
</template>
