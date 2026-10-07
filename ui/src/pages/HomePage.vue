<script lang="ts">
// Closed epics this tab saw in flight: lives for the page session, across
// SPA navigation away from Home and back (ds-spec.md §4.1 point 2, "this
// session"). A reload starts it empty, so nothing is "just finished" then.
const seenInFlight = new Set<string>();
</script>

<script setup lang="ts">
// Home (ds-spec.md §4.1): replaces Overview and Projects. Sections, in
// order: what needs you, Running now (with Just finished), "Recent
// activity" (point 1b, DS6 PR4), what the factory decided recently, Budget.
// Numbers and sentences come from lib/homeView.ts; this file only lays
// them out.
import { Activity, MonitorPlay } from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import ActivityScopeToggle from '../components/ActivityScopeToggle.vue';
import LiveSessionCard from '../components/LiveSessionCard.vue';
import NeedsYouInbox from '../components/NeedsYouInbox.vue';
import Banner from '../components/kit/Banner.vue';
import Card from '../components/kit/Card.vue';
import EmptyState from '../components/kit/EmptyState.vue';
import PageHeader from '../components/kit/PageHeader.vue';
import ProgressRing from '../components/kit/ProgressRing.vue';
import RelativeTime from '../components/kit/RelativeTime.vue';
import Skeleton from '../components/kit/Skeleton.vue';
import TimelineRow from '../components/kit/TimelineRow.vue';
import { useActiveScope } from '../composables/useActiveScope.js';
import { useActivityScope } from '../composables/useActivityScope.js';
import { usePoll } from '../composables/usePoll.js';
import { useProjectContext } from '../composables/useProjectContext.js';
import { useSessionContext } from '../composables/useSessionContext.js';
import { isActiveProject } from '../lib/activeScope.js';
import {
  type ActiveScopeResult,
  type ActivityEntry,
  type ClosedEpic,
  fetchCliSessions,
  fetchInbox,
  fetchOverview,
  fetchTimelinePage,
  type InboxRow,
  type OverviewResult,
} from '../lib/api.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import { toggleExpanded } from '../lib/expandedRows.js';
import { pluralize } from '../lib/format.js';
import { hiddenCount, type LiveSessionsResult } from '../lib/liveSessions.js';
import {
  budgetRingLabel,
  budgetView,
  cardShowsRing,
  cardTokensText,
  decisionLine,
  outlierSentence,
  runningNowCards,
  trackJustFinished,
} from '../lib/homeView.js';
import { scrollToTimelineRow } from '../lib/scrollToRow.js';
import { storeKey } from '../lib/storeKey.js';

const POLL_MS = 5000;
/** How many decisions the section lists; the rest live on Activity. */
const DECISIONS_SHOWN = 8;
/** ds-spec.md §4.1 point 1b / ds-review.html: "the 8 newest TimelineRows". */
const RECENT_ACTIVITY_SHOWN = 8;

const { project } = useProjectContext();
const { sessionScope, sessionKey } = useSessionContext();
const router = useRouter();
const { scope: mode, scopeTo } = useActivityScope();
const { scope: activeScope, settled: activeScopeSettled } = useActiveScope();

// A failed read counts as unmeasured, never as "nothing is active"; null only
// while the first answer is still in flight (same rule as Sessions and Kanban).
const UNMEASURED: ActiveScopeResult = {
  measured: false,
  readAt: '',
  liveSessions: 0,
  unlinkedSessions: 0,
  projects: [],
  epics: [],
  factorySessions: [],
};
const liveScope = computed(() => activeScope.value ?? (activeScopeSettled.value ? UNMEASURED : null));

const overview = ref<OverviewResult | null>(null);
const overviewFailed = ref(false);
const inbox = ref<InboxRow[] | null>(null);
const inboxFailed = ref(false);
const justFinished = ref<ClosedEpic[]>([]);
const recentActivity = ref<ActivityEntry[] | null>(null);
const recentActivityFailed = ref(false);
const recentActivityExpanded = ref<Set<string>>(new Set());
const live = ref<LiveSessionsResult | null>(null);
const liveFailed = ref(false);
const liveHidden = computed(() => (live.value ? hiddenCount(live.value.hidden) : 0));

function toggleRecentActivity(eventId: string) {
  recentActivityExpanded.value = toggleExpanded(recentActivityExpanded.value, eventId);
}

// Each error is cleared on success, not on attempt (D-226): a server that
// is down must not look healthy between polls.
async function loadOverview() {
  try {
    const o = await fetchOverview(sessionScope.value, project.value);
    overview.value = o;
    justFinished.value = trackJustFinished(seenInFlight, o);
    overviewFailed.value = false;
  } catch {
    overviewFailed.value = true;
  }
}

async function loadInbox() {
  try {
    inbox.value = (await fetchInbox(sessionScope.value)).rows;
    inboxFailed.value = false;
  } catch {
    inboxFailed.value = true;
  }
}

async function loadRecentActivity() {
  try {
    const page = await fetchTimelinePage({
      session: sessionScope.value,
      project: project.value,
      limit: RECENT_ACTIVITY_SHOWN,
    });
    recentActivity.value = page.entries;
    recentActivityFailed.value = false;
  } catch {
    recentActivityFailed.value = true;
  }
}

async function loadLive() {
  try {
    live.value = await fetchCliSessions();
    liveFailed.value = false;
  } catch {
    liveFailed.value = true;
  }
}

async function load() {
  await Promise.all([loadOverview(), loadInbox(), loadRecentActivity(), loadLive()]);
}

onMounted(load);

watch([project, sessionKey], () => {
  overview.value = null;
  inbox.value = null;
  recentActivity.value = null;
  load();
});
usePoll(load, POLL_MS);

// While the first scope answer is in flight under Active, Running now keeps
// its loading state: never draw every card and then narrow them.
const scopePending = computed(() => mode.value === 'active' && liveScope.value === null);
const running = computed(() =>
  overview.value
    ? runningNowCards(overview.value, liveScope.value, mode.value, project.value)
    : { shown: [], quiet: [] },
);
const cards = computed(() => running.value.shown);
const decisions = computed(() => overview.value?.recentDispatches.slice(0, DECISIONS_SHOWN) ?? []);
const budget = computed(() => (overview.value ? budgetView(cards.value, overview.value.budgetUsedPctPointDelta1h ?? null) : null));

// Same causal-chain walk ActivityPage.vue uses for ctxFor(), scoped to this
// page's own 8-row list rather than the whole feed.
const promptTsById = computed(
  () => new Map((recentActivity.value ?? []).map((e) => [e.eventId, e.ts])),
);
const causedCountByPromptId = computed(() => {
  const counts = new Map<string, number>();
  for (const e of recentActivity.value ?? []) {
    if (e.nearestPromptId) counts.set(e.nearestPromptId, (counts.get(e.nearestPromptId) ?? 0) + 1);
  }
  return counts;
});
function recentActivityCtx(entry: ActivityEntry) {
  const promptTs = entry.nearestPromptId
    ? (promptTsById.value.get(entry.nearestPromptId) ?? null)
    : undefined;
  const causedCount = causedCountByPromptId.value.get(entry.eventId);
  return { promptTs, causedCount };
}

// The Active edge lines replace the card list; each is one muted line, with
// Sessions' rules and copy.
const activeView = computed(() => mode.value === 'active' && liveScope.value?.measured === true);
const noLiveSessions = computed(() => activeView.value && liveScope.value?.liveSessions === 0);
const noneOnAnEpic = computed(() => {
  const l = liveScope.value;
  return (
    activeView.value &&
    l !== null &&
    l.factorySessions.length === 0 &&
    l.unlinkedSessions > 0
  );
});
const noSessionOnProject = computed(
  () =>
    activeView.value &&
    project.value !== undefined &&
    !isActiveProject(liveScope.value, {}, project.value),
);
const unmeasuredNote = computed(() => mode.value === 'active' && liveScope.value?.measured === false);
const quietLine = computed(() => {
  const hidden = running.value.quiet;
  return hidden.length === 1
    ? { text: `${hidden[0]?.project} is quiet`, link: 'Show it' }
    : { text: pluralize(hidden.length, 'quiet project'), link: 'Show all' };
});

function workLink(p: string) {
  return { path: '/work/kanban', query: { project: p } };
}

// DS8 PR3 item 5: a "Running now" card is per-project, with no single
// session id of its own (a project can have zero, one, or several runs at
// once) - so this links to the project's own Sessions history rather than
// to any one run.
function sessionsLink(p: string) {
  return { path: '/sessions', query: { project: p } };
}

function goToTask(taskId: string) {
  router.push(`/tasks/${encodeURIComponent(taskId)}`);
}

// Same scroll+highlight ActivityPage.vue gives its own "because of your
// prompt" button. The referenced prompt is sometimes outside this page's 8
// shown rows -- promptTsById above already returns undefined/null for that
// case, which TimelineRow's own hasPromptLink already turns into "no button
// shown" for us, so there is nothing else to gate here.
const highlighted = ref<string | null>(null);
function becauseOf(promptId: string) {
  highlighted.value = promptId;
  scrollToTimelineRow(promptId);
}
</script>

<template>
  <div class="bs-home">
    <PageHeader title="Home" description="What needs you, what is running, and what it costs." />

    <NeedsYouInbox :rows="inbox" :failed="inboxFailed" :project="project" @retry="loadInbox" />

    <!-- ds-spec.md §4.1 item 1a: directly under the inbox, one card per live,
         in-scope CLI session (GET /api/cli-sessions). -->
    <section class="bs-home__section" aria-labelledby="live-sessions-heading">
      <div class="bs-home__section-head">
        <h2 id="live-sessions-heading" class="bs-section-title">Live sessions</h2>
        <RouterLink to="/sessions" class="bs-btn bs-btn--link bs-btn--sm">All sessions</RouterLink>
      </div>
      <Banner v-if="liveFailed" show-retry @retry="loadLive">Could not load live sessions</Banner>
      <template v-else-if="live === null">
        <Skeleton shape="block" :height="96" />
        <Skeleton shape="block" :height="96" />
      </template>
      <Banner v-else-if="live.state === 'unreadable'" tone="warning">
        Could not read the live sessions<template v-if="live.formatWarning">: {{ live.formatWarning }}</template>
      </Banner>
      <EmptyState
        v-else-if="live.state === 'absent'"
        :icon="MonitorPlay"
        title="No live Blacksmith sessions"
        body="Session tracking is not set up on this machine."
      />
      <EmptyState
        v-else-if="canClaimEmpty(live !== null, live.sessions.length)"
        :icon="MonitorPlay"
        title="No live Blacksmith sessions"
        :body="liveHidden > 0 ? `${pluralize(liveHidden, 'other session')} hidden` : ''"
      />
      <ul v-else class="bs-live-list" aria-labelledby="live-sessions-heading">
        <li v-for="s in live.sessions" :key="storeKey(s.focus ?? {}, s.cliSessionId)">
          <LiveSessionCard :card="s" />
        </li>
      </ul>
    </section>

    <!-- ds-spec.md §4.1 point 1b: directly under the inbox, 8 newest TimelineRows
         (compact), no Expand-all, no filters, link to Activity. -->
    <section class="bs-home__section" aria-labelledby="recent-activity-heading">
      <div class="bs-home__section-head">
        <h2 id="recent-activity-heading" class="bs-section-title">Recent activity</h2>
        <RouterLink to="/activity" class="bs-btn bs-btn--link bs-btn--sm">View all activity</RouterLink>
      </div>
      <Banner v-if="recentActivityFailed" show-retry @retry="loadRecentActivity">
        Could not load recent activity.
      </Banner>
      <Skeleton v-else-if="recentActivity === null" :height="96" />
      <EmptyState
        v-else-if="canClaimEmpty(recentActivity !== null, recentActivity?.length ?? 0)"
        :icon="Activity"
        title="Nothing has happened yet."
        body="Prompts, dispatches and gate results will show up here as the factory works."
      />
      <ol v-else class="bs-home__recent-activity timeline-feed" role="list">
        <TimelineRow
          v-for="entry in recentActivity"
          :key="entry.eventId"
          :entry="entry"
          variant="compact"
          :class="{ 'bs-timeline-row--highlight': highlighted === entry.eventId }"
          :expanded="recentActivityExpanded.has(entry.eventId)"
          :ctx="recentActivityCtx(entry)"
          @toggle="toggleRecentActivity"
          @select-task="goToTask"
          @because-of="becauseOf"
        />
      </ol>
    </section>

    <Banner v-if="overviewFailed" show-retry @retry="loadOverview">Could not load Home.</Banner>

    <section class="bs-home__section" aria-labelledby="running-heading">
      <div class="bs-home__section-head bs-home__section-head--flush">
        <h2 id="running-heading" class="bs-section-title">Running now</h2>
        <ActivityScopeToggle />
      </div>
      <p v-if="unmeasuredNote" class="bs-sessions__quiet">Live sessions can't be read here</p>
      <Skeleton v-if="(overview === null && !overviewFailed) || scopePending" :height="96" />
      <template v-else-if="overview !== null">
        <p v-if="noLiveSessions" class="bs-sessions__quiet">
          Nothing is active right now. ·
          <RouterLink :to="scopeTo('all')">Show all</RouterLink>
        </p>
        <p v-else-if="noneOnAnEpic" class="bs-sessions__quiet">
          {{ pluralize(liveScope?.unlinkedSessions ?? 0, 'live session') }}, none on an epic ·
          <RouterLink :to="scopeTo('all')">Show all</RouterLink>
        </p>
        <p v-else-if="noSessionOnProject" class="bs-sessions__quiet">
          No live session is on this project ·
          <RouterLink :to="scopeTo('all')">Show all</RouterLink>
        </p>
        <p v-else-if="cards.length === 0 && running.quiet.length === 0" class="bs-home__quiet">
          Nothing is running right now.
        </p>
        <div v-if="cards.length > 0" class="bs-home__cards">
          <Card
            v-for="c in cards"
            :key="storeKey(c, c.project)"
            :title="c.project"
            :class="{ 'bs-home__card--quiet': c.quiet }"
          >
            <template #action>
              <RouterLink
                class="bs-btn bs-btn--link bs-btn--sm"
                :to="workLink(c.project)"
                :aria-label="`View ${c.project} in Work`"
              >
                View
              </RouterLink>
              <RouterLink
                class="bs-btn bs-btn--link bs-btn--sm"
                :to="sessionsLink(c.project)"
                :aria-label="`View ${c.project} in Sessions`"
              >
                Sessions
              </RouterLink>
            </template>
            <div class="bs-home__card-body">
              <p v-if="c.workingAgents > 0" class="bs-home__stat">
                {{ pluralize(c.workingAgents, 'agent') }} working
              </p>
              <p class="bs-home__stat">{{ pluralize(c.epics.length, 'epic') }} in flight</p>
              <div class="bs-home__tokens">
                <ProgressRing
                  v-if="c.tokens.budget && cardShowsRing(c.tokens)"
                  :value="c.tokens.spent"
                  :max="c.tokens.budget"
                  kind="budget"
                  :label="budgetRingLabel(c.tokens.spent, c.tokens.budget)"
                />
                <span>{{ cardTokensText(c.tokens) }}</span>
              </div>
              <p v-if="outlierSentence(c.tokens.outliers)" class="bs-home__quiet">
                {{ outlierSentence(c.tokens.outliers) }}
              </p>
            </div>
          </Card>
        </div>
        <p
          v-if="running.quiet.length > 0 && !noLiveSessions && !noneOnAnEpic && !noSessionOnProject"
          class="bs-sessions__quiet"
        >
          {{ quietLine.text }} ·
          <RouterLink :to="scopeTo('all')">{{ quietLine.link }}</RouterLink>
        </p>
        <div v-if="justFinished.length > 0" class="bs-home__finished">
          <h3 class="bs-home__subhead">Just finished</h3>
          <ul class="bs-home__list">
            <li v-for="e in justFinished" :key="storeKey(e, e.epicId)" class="bs-home__line">
              <RouterLink :to="{ path: '/work/kanban', query: { epic: e.epicId } }">{{ e.epicId }}</RouterLink>
              <span>finished</span>
              <RelativeTime :iso="e.closedAt" />
            </li>
          </ul>
        </div>
      </template>
    </section>

    <section class="bs-home__section" aria-labelledby="decisions-heading">
      <h2 id="decisions-heading" class="bs-section-title">What the factory decided recently</h2>
      <Skeleton v-if="overview === null && !overviewFailed" :height="96" />
      <template v-else-if="overview !== null">
        <EmptyState
          v-if="canClaimEmpty(overview !== null, decisions.length)"
          :icon="Activity"
          title="No decisions yet."
          body="Each time the factory hands a task to an agent, the choice and its reason appear here."
        />
        <ul v-else class="bs-home__list">
          <li v-for="d in decisions" :key="storeKey(d, d.eventId)" class="bs-home__line">
            <RouterLink v-if="d.taskId" :to="`/tasks/${encodeURIComponent(d.taskId)}`" class="bs-home__decision">
              {{ decisionLine(d) }}
            </RouterLink>
            <span v-else class="bs-home__decision">{{ decisionLine(d) }}</span>
            <RelativeTime :iso="d.ts" />
          </li>
        </ul>
      </template>
    </section>

    <section class="bs-home__section" aria-labelledby="budget-heading">
      <h2 id="budget-heading" class="bs-section-title">Budget</h2>
      <Skeleton v-if="overview === null && !overviewFailed" :height="48" />
      <p v-else-if="budget?.kind === 'none'" class="bs-home__quiet">{{ budget.text }}</p>
      <template v-else-if="budget?.kind === 'figures'">
        <div class="bs-home__tokens">
          <ProgressRing
            v-if="budget.ring"
            :value="budget.ring.value"
            :max="budget.ring.max"
            kind="budget"
            :label="budget.ring.label"
          />
          <span class="bs-home__stat">{{ budget.tokensText }}</span>
        </div>
        <p v-if="budget.deltaSentence" class="bs-home__quiet">{{ budget.deltaSentence }}</p>
        <p v-if="budget.unmeasuredSentence" class="bs-home__quiet">{{ budget.unmeasuredSentence }}</p>
        <p v-if="budget.outlierSentence" class="bs-home__quiet">
          {{ budget.outlierSentence }}
          <RouterLink to="/analytics">Details</RouterLink>.
        </p>
      </template>
    </section>
  </div>
</template>
