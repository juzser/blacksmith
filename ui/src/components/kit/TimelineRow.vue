<script setup lang="ts">
// DS6 PR3 scope item 3 (ds-spec.md §4.3 row table, ds-review.html `.ev`): the
// Activity feed's row. Flat — no causal-tree disclosure (that is the old
// components/TimelineRow.vue, still used by TimelinePage.vue's own list) —
// this one only discloses its own per-kind detail (`dl`), toggled by a
// chevron whose open state is sessionStorage-persisted by the caller (see
// expandedRows.ts), not owned here, so "Expand all" can flip every row's
// state from one place.
import { ChevronDown, ChevronRight, CircleCheck, CircleX } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { formatTime } from '../../lib/format.js';
import { isPastStaleWindow } from '../../lib/liveness.js';
import { foreignStoreId, storeKey } from '../../lib/storeKey.js';
// DS6 PR4b round 2 item 4 (ds-review.html `.ev`, spec §4.1 1b): relative time
// replaces HH:MM everywhere this row renders (Activity, task History, Home
// compact); RelativeTime itself carries the absolute time in its tooltip.
import type { KitTone } from '../../lib/taxonomy.js';
import {
  type ActivityEntry,
  gateStatusTag,
  kindFor,
  type MetaContext,
  metaFor,
  titleFor,
} from '../../lib/timelineDisplay.js';
import EventKindTag from './EventKindTag.vue';
import Icon from './Icon.vue';
import IconButton from './IconButton.vue';
import RelativeTime from './RelativeTime.vue';
import Tag from './Tag.vue';

const props = withDefaults(
  defineProps<{
    entry: ActivityEntry;
    expanded: boolean;
    /** Extra context metaFor needs (promptTs/causedCount) — walked once over
     * the whole page by the caller (ActivityPage.vue), not re-derived per row. */
    ctx?: MetaContext;
    /** False on TaskDetailPage's History tab: every row's taskId is already
     * the task on screen, so a title link there would push the page the
     * operator is already standing on — a no-op vue-router discards (D-231). */
    linkable?: boolean;
    /** ds-spec.md §2.2 `TimelineRow` variant list: `rail` (`RunHistoryTimeline`'s
     * rows) — no stripe, a rail dot/line drawn from the §1.5 `--tl-*`
     * geometry instead, time via `RelativeTime` (default stays `formatTime`
     * so Activity/Home stay pixel-identical). `compact` (Home's "Recent
     * activity", DS6 PR4) — title and meta each clamp to one line with
     * ellipsis, otherwise the default row's markup/behaviour. */
    variant?: 'rail' | 'compact';
    /** rail-only: `TaskRun` carries no `eventType`/`payload`, so it cannot
     * drive `titleFor`/`metaFor` — the caller (`RunHistoryTimeline`) passes
     * its own humanized label/meta text instead of this component deriving
     * one from `entry`. */
    titleOverride?: string;
    metaOverride?: string;
    /** rail-only: the outcome `Tag` next to `EventKindTag` (ds-spec.md §2.2
     * "a humanized label ... outcome Tag"), same slot the general row table
     * gives a gate's Passed/Failed status tag. */
    tag?: { tone: KitTone; label: string } | null;
    /** Activity in a multi-project feed only: adds a Project pair to the
     * expanded detail. Off elsewhere, so Home and task History do not move. */
    showProject?: boolean;
  }>(),
  { linkable: true },
);
const emit = defineEmits<{
  // The id the row reports is storeKey(entry, eventId): a bare event id for a
  // row with no store, so every caller outside a multi-store read is unchanged.
  toggle: [rowKey: string];
  selectTask: [taskId: string, store: string | undefined];
  becauseOf: [promptKey: string];
}>();

const kind = computed(() => kindFor(props.entry));
// The rail's explicit `tag` wins; otherwise a gate row shows its own
// Passed/Failed tag (ds-spec.md §4.3), never on the rail (its rows are runs).
const STATUS_ICON = { CircleCheck, CircleX };
const gateTag = computed(() =>
  kind.value === 'gate' && props.variant !== 'rail' ? gateStatusTag(props.entry) : null,
);
const statusTag = computed(() => props.tag ?? gateTag.value);
const statusIcon = computed(() =>
  !props.tag && gateTag.value ? STATUS_ICON[gateTag.value.icon] : null,
);
const title = computed(() => props.titleOverride ?? titleFor(props.entry));

// "Running for N s" ticks live while a Dispatched row has no run result yet
// (ds-spec.md §4.3). Only this one row kind/state needs a clock, so the
// interval lives here rather than hoisting `now` through the whole feed.
// Past the stale window the meta reads "No result after …" and stops ticking.
const tickNow = ref(new Date().toISOString());
const stillRunning = computed(
  () =>
    kind.value === 'dispatch' &&
    props.entry.run?.runStatus == null &&
    !isPastStaleWindow(props.entry.ts, props.ctx?.now ?? tickNow.value),
);
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  if (stillRunning.value)
    timer = setInterval(() => (tickNow.value = new Date().toISOString()), 1000);
});
// A row open across the stale window stops its own clock.
watch(stillRunning, (running) => {
  if (!running) clearInterval(timer);
});
onBeforeUnmount(() => clearInterval(timer));

const meta = computed(
  () =>
    props.metaOverride ??
    metaFor(props.entry, {
      ...props.ctx,
      now: stillRunning.value ? tickNow.value : props.ctx?.now,
    }),
);

const hasPromptLink = computed(
  () =>
    kind.value === 'dispatch' && props.ctx?.promptTs !== undefined && props.ctx?.promptTs !== null,
);

// ds-spec.md §4.3: "A kind with no useful stats (System: 'Session … started')
// has no meta line and no chevron." metaFor() returns '' for exactly that
// case, so an empty meta is also the signal that there is nothing to expand.
// A gate row whose meta de-duplicated away still has Task/Session to expand.
// A rail row with an explicit outcome tag always has the Outcome pair to show.
const hasDetails = computed(
  () =>
    meta.value !== '' ||
    (kind.value === 'gate' && props.variant !== 'rail') ||
    (props.variant === 'rail' && !!props.tag),
);

// Deep-links into SessionsPage's own `?session=<id>` marker
// (sessionsSelection.ts) when the entry carries one; a plain string route
// when it does not, so a stray entry with no sessionId still lands on the
// list rather than on `/sessions?session=`.
const rowKey = computed(() => storeKey(props.entry, props.entry.eventId));
const store = computed(() => foreignStoreId(props.entry));
const sessionLink = computed(() =>
  props.entry.sessionId
    ? {
        path: '/sessions',
        query: { session: props.entry.sessionId, ...(store.value ? { store: store.value } : {}) },
      }
    : '/sessions',
);

function onBecauseOf() {
  const promptId = props.entry.nearestPromptId;
  if (promptId) emit('becauseOf', storeKey(props.entry, promptId));
}
</script>

<template>
  <li
    class="bs-timeline-row"
    :class="{ 'bs-timeline-row--rail': variant === 'rail', 'bs-timeline-row--compact': variant === 'compact' }"
    :data-kind="kind"
    :id="`activity-row-${rowKey}`"
  >
    <div class="bs-timeline-row__body">
      <div class="bs-timeline-row__head">
        <EventKindTag :kind="kind" />
        <Tag v-if="statusTag" :tone="statusTag.tone" variant="subtle" size="sm" class="bs-timeline-row__status">
          <Icon v-if="statusIcon" :icon="statusIcon" :size="14" />{{ statusTag.label }}
        </Tag>
        <button
          v-if="entry.taskId && linkable"
          type="button"
          class="bs-timeline-row__title bs-timeline-row__title--link"
          @click="emit('selectTask', entry.taskId, store)"
        >
          <span class="bs-timeline-row__title-label">{{ title }}</span>
        </button>
        <span v-else class="bs-timeline-row__title">{{ title }}</span>
      </div>
      <div v-if="hasDetails" class="bs-timeline-row__meta">
        <span v-if="meta">{{ meta }}</span>
        <button
          v-if="hasPromptLink"
          type="button"
          class="bs-timeline-row__because-of bs-timeline-row__because-of--meta"
          @click="onBecauseOf"
        >
          because of your prompt at {{ formatTime(ctx?.promptTs ?? '') }}
        </button>
        <!-- Phone (ds-spec.md §4.1 1b): the meta line ends with the time
             instead of the dedicated time column below, which hides there. -->
        <RelativeTime class="bs-timeline-row__ts bs-timeline-row__ts--meta" :iso="entry.ts" />
      </div>
      <!-- Fix round 2 item 1 (ds-review.html `.mrow.tlrow .mm`): a row with no
           meta text still needs its time to show on phone, so it gets its own
           meta line holding only the time instead of skipping the line. -->
      <div v-else class="bs-timeline-row__meta">
        <RelativeTime class="bs-timeline-row__ts bs-timeline-row__ts--meta" :iso="entry.ts" />
      </div>
      <!-- v-show, not v-if: aria-controls above names this id unconditionally
           while collapsed, so the element it names must exist unconditionally
           too, or the IDREF dangles (D-227). Gated on hasDetails because the
           chevron naming it is gated the same way. -->
      <dl
        v-if="hasDetails"
        v-show="expanded"
        :id="`activity-row-detail-${rowKey}`"
        class="bs-timeline-row__detail"
      >
        <dt>Kind</dt>
        <dd>{{ kind }}</dd>
        <dt>Title</dt>
        <dd>{{ title }}</dd>
        <template v-if="meta">
          <dt>Meta</dt>
          <dd>{{ meta }}</dd>
        </template>
        <!-- Phone only (ds-review.html #p-activity: "because of" moves into the
             detail); on desktop the link stays in the meta line above. -->
        <template v-if="hasPromptLink">
          <dt class="bs-timeline-row__cause">Because of</dt>
          <dd class="bs-timeline-row__cause">
            <button type="button" class="bs-timeline-row__because-of" @click="onBecauseOf">
              your prompt at {{ formatTime(ctx?.promptTs ?? '') }}
            </button>
          </dd>
        </template>
        <!-- rail rows are already scoped to the task on screen (RunHistoryTimeline
             on TaskDetailPage), and TaskRun carries no taskId. An event with no
             task (epic-level, a prompt) has nothing to show, so no Task pair. -->
        <template v-if="variant === 'rail' && tag">
          <dt>Outcome</dt>
          <dd>{{ tag.label }}</dd>
        </template>
        <template v-if="variant !== 'rail'">
          <template v-if="showProject && entry.project">
            <dt>Project</dt>
            <dd>{{ entry.project }}</dd>
          </template>
          <template v-if="entry.taskId">
            <dt>Task</dt>
            <dd>{{ entry.taskId }}</dd>
          </template>
          <dt>Session</dt>
          <dd>
            <!-- SessionsPage's `?session=<id>` deep link (sessionsSelection.ts)
                 opens and scrolls to the exact run; fall back to the plain
                 list only when the entry carries no sessionId at all. -->
            <RouterLink :to="sessionLink">{{ entry.sessionTitle }}</RouterLink>
          </dd>
        </template>
      </dl>
    </div>
    <!-- Row rework (DS6 PR4b round 2 item 4, mock `.ev` grid: body / time /
         chevron): the time and chevron sit in their own end columns on the
         row's grid, not inline with the title/meta. -->
    <RelativeTime class="bs-timeline-row__ts" :iso="entry.ts" />
    <IconButton
      v-if="hasDetails"
      class="bs-timeline-row__chevron"
      :icon="expanded ? ChevronDown : ChevronRight"
      label="Show details"
      size="sm"
      :aria-expanded="expanded"
      :aria-controls="`activity-row-detail-${rowKey}`"
      @click="emit('toggle', rowKey)"
    />
    <!-- Fix round item 4 (mock `.ev` grid: always 3 columns): a row with no
         details still reserves the chevron's track, or its time column
         drifts out of alignment with rows that do have one. -->
    <span v-else class="bs-timeline-row__chevron-placeholder" aria-hidden="true"></span>
  </li>
</template>
