<script lang="ts">
// Closed epics this tab saw in flight: lives for the page session, across
// SPA navigation away from Home and back (ds-spec.md §4.1 point 2, "this
// session"). A reload starts it empty, so nothing is "just finished" then.
const seenInFlight = new Set<string>();
</script>

<script setup lang="ts">
// Home (ds-spec.md §4.1): replaces Overview and Projects. Sections, in
// order: what needs you, Running now (with Just finished), what the factory
// decided recently, Budget. "Recent activity" (point 1b) is deferred to DS6
// — see ui/docs/DESIGN.md Known Deviations. Numbers and sentences come from
// lib/homeView.ts; this file only lays them out.
import { Activity } from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import NeedsYouInbox from '../components/NeedsYouInbox.vue';
import Banner from '../components/kit/Banner.vue';
import Card from '../components/kit/Card.vue';
import EmptyState from '../components/kit/EmptyState.vue';
import PageHeader from '../components/kit/PageHeader.vue';
import ProgressRing from '../components/kit/ProgressRing.vue';
import RelativeTime from '../components/kit/RelativeTime.vue';
import Skeleton from '../components/kit/Skeleton.vue';
import { usePoll } from '../composables/usePoll.js';
import { useProjectContext } from '../composables/useProjectContext.js';
import { useSessionContext } from '../composables/useSessionContext.js';
import { type ClosedEpic, fetchInbox, fetchOverview, type InboxRow, type OverviewResult } from '../lib/api.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import { pluralize } from '../lib/format.js';
import {
  budgetDeltaSentence,
  budgetRingLabel,
  budgetSummary,
  decisionLine,
  outlierSentence,
  runningNowCards,
  tokensOfBudget,
  trackJustFinished,
  unmeasuredSentence,
} from '../lib/homeView.js';

const POLL_MS = 5000;
/** How many decisions the section lists; the rest live on Activity. */
const DECISIONS_SHOWN = 8;

const { project } = useProjectContext();
const { sessionScope, sessionKey } = useSessionContext();

const overview = ref<OverviewResult | null>(null);
const overviewFailed = ref(false);
const inbox = ref<InboxRow[] | null>(null);
const inboxFailed = ref(false);
const justFinished = ref<ClosedEpic[]>([]);

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

async function load() {
  await Promise.all([loadOverview(), loadInbox()]);
}

onMounted(load);

watch([project, sessionKey], () => {
  overview.value = null;
  inbox.value = null;
  load();
});
usePoll(load, POLL_MS);

const cards = computed(() => (overview.value ? runningNowCards(overview.value, project.value) : []));
const decisions = computed(() => overview.value?.recentDispatches.slice(0, DECISIONS_SHOWN) ?? []);
const budget = computed(() => (overview.value ? budgetSummary(overview.value.tokensByEpic) : null));
const budgetDelta = computed(() => budgetDeltaSentence(overview.value?.budgetUsedPctPointDelta1h ?? null));

function workLink(p: string) {
  return { path: '/kanban', query: { project: p } };
}
</script>

<template>
  <div class="bs-home">
    <PageHeader title="Home" description="What needs you, what is running, and what it costs." />

    <NeedsYouInbox :rows="inbox" :failed="inboxFailed" :project="project" @retry="loadInbox" />

    <Banner v-if="overviewFailed" show-retry @retry="loadOverview">Could not load Home.</Banner>

    <section class="bs-home__section" aria-labelledby="running-heading">
      <h2 id="running-heading" class="bs-section-title">Running now</h2>
      <Skeleton v-if="overview === null && !overviewFailed" :height="96" />
      <template v-else-if="overview !== null">
        <p v-if="cards.length === 0" class="bs-home__quiet">Nothing is running right now.</p>
        <div v-else class="bs-home__cards">
          <Card v-for="c in cards" :key="c.project" :title="c.project">
            <template #action>
              <RouterLink
                class="bs-btn bs-btn--link bs-btn--sm"
                :to="workLink(c.project)"
                :aria-label="`View ${c.project} in Work`"
              >
                View
              </RouterLink>
            </template>
            <div class="bs-home__card-body">
              <p class="bs-home__stat">{{ pluralize(c.workingAgents, 'agent') }} working</p>
              <p class="bs-home__stat">{{ pluralize(c.epics.length, 'epic') }} in flight</p>
              <div class="bs-home__tokens">
                <ProgressRing
                  v-if="c.tokens.budget"
                  :value="c.tokens.spent"
                  :max="c.tokens.budget"
                  kind="budget"
                  :label="budgetRingLabel(c.tokens.spent, c.tokens.budget)"
                />
                <span>{{ tokensOfBudget(c.tokens) }}</span>
              </div>
            </div>
          </Card>
        </div>
        <div v-if="justFinished.length > 0" class="bs-home__finished">
          <h3 class="bs-home__subhead">Just finished</h3>
          <ul class="bs-home__list">
            <li v-for="e in justFinished" :key="e.epicId" class="bs-home__line">
              <RouterLink :to="{ path: '/kanban', query: { epic: e.epicId } }">{{ e.epicId }}</RouterLink>
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
          <li v-for="d in decisions" :key="d.eventId" class="bs-home__line">
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
      <template v-else-if="budget !== null">
        <div class="bs-home__tokens">
          <ProgressRing
            v-if="budget.budget"
            :value="budget.spent"
            :max="budget.budget"
            kind="budget"
            :label="budgetRingLabel(budget.spent, budget.budget)"
          />
          <span class="bs-home__stat">{{ tokensOfBudget(budget) }}</span>
        </div>
        <p v-if="budgetDelta" class="bs-home__quiet">{{ budgetDelta }}</p>
        <p v-if="unmeasuredSentence(budget.unmeasured)" class="bs-home__quiet">
          {{ unmeasuredSentence(budget.unmeasured) }}
        </p>
        <p v-if="outlierSentence(budget.outliers.length)" class="bs-home__quiet">
          {{ outlierSentence(budget.outliers.length) }}
          <RouterLink to="/analytics">Details</RouterLink>.
        </p>
      </template>
    </section>
  </div>
</template>
