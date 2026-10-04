<script setup lang="ts">
// DS6 PR3 scope item 3 (ds-spec.md §4.3 row table, ds-review.html `.ev`): the
// Activity feed's row. Flat — no causal-tree disclosure (that is the old
// components/TimelineRow.vue, still used by TimelinePage.vue's own list) —
// this one only discloses its own per-kind detail (`dl`), toggled by a
// chevron whose open state is sessionStorage-persisted by the caller (see
// expandedRows.ts), not owned here, so "Expand all" can flip every row's
// state from one place.
import { ChevronDown, ChevronRight } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { formatTime } from '../../lib/format.js';
// DS6 PR4b round 2 item 4 (ds-review.html `.ev`, spec §4.1 1b): relative time
// replaces HH:MM everywhere this row renders (Activity, task History, Home
// compact); RelativeTime itself carries the absolute time in its tooltip.
import type { KitTone } from '../../lib/taxonomy.js';
import {
  type ActivityEntry,
  kindFor,
  type MetaContext,
  metaFor,
  titleFor,
} from '../../lib/timelineDisplay.js';
import EventKindTag from './EventKindTag.vue';
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
  }>(),
  { linkable: true },
);
const emit = defineEmits<{
  toggle: [eventId: string];
  selectTask: [taskId: string];
  becauseOf: [promptId: string];
}>();

const kind = computed(() => kindFor(props.entry));
const title = computed(() => props.titleOverride ?? titleFor(props.entry));

// "Running for N s" ticks live while a Dispatched row has no run result yet
// (ds-spec.md §4.3). Only this one row kind/state needs a clock, so the
// interval lives here rather than hoisting `now` through the whole feed.
const stillRunning = computed(
  () => kind.value === 'dispatch' && props.entry.run?.runStatus == null,
);
const tickNow = ref(new Date().toISOString());
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  if (stillRunning.value)
    timer = setInterval(() => (tickNow.value = new Date().toISOString()), 1000);
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
const hasDetails = computed(() => meta.value !== '');

function onBecauseOf() {
  const promptId = props.entry.nearestPromptId;
  if (promptId) emit('becauseOf', promptId);
}
</script>

<template>
  <li
    class="bs-timeline-row"
    :class="{ 'bs-timeline-row--rail': variant === 'rail', 'bs-timeline-row--compact': variant === 'compact' }"
    :data-kind="kind"
    :id="`activity-row-${entry.eventId}`"
  >
    <div class="bs-timeline-row__body">
      <div class="bs-timeline-row__head">
        <EventKindTag :kind="kind" />
        <Tag v-if="tag" :tone="tag.tone" variant="subtle" size="sm">{{ tag.label }}</Tag>
        <button
          v-if="entry.taskId && linkable"
          type="button"
          class="bs-timeline-row__title bs-timeline-row__title--link"
          @click="emit('selectTask', entry.taskId)"
        >
          <span class="bs-timeline-row__title-label">{{ title }}</span>
        </button>
        <span v-else class="bs-timeline-row__title">{{ title }}</span>
      </div>
      <div v-if="hasDetails" class="bs-timeline-row__meta">
        <span>{{ meta }}</span>
        <button v-if="hasPromptLink" type="button" class="bs-timeline-row__because-of" @click="onBecauseOf">
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
        :id="`activity-row-detail-${entry.eventId}`"
        class="bs-timeline-row__detail"
      >
        <dt>Kind</dt>
        <dd>{{ kind }}</dd>
        <dt>Title</dt>
        <dd>{{ title }}</dd>
        <dt>Meta</dt>
        <dd>{{ meta }}</dd>
        <!-- rail rows are already scoped to the task on screen (RunHistoryTimeline
             on TaskDetailPage): a "Task" row here would only ever read 'not
             measured', since TaskRun carries no taskId. -->
        <template v-if="variant !== 'rail'">
          <dt>Task</dt>
          <dd>{{ entry.taskId ?? 'not measured' }}</dd>
          <dt>Session</dt>
          <dd>
            <!-- SessionsPage has no deep-link query param to open a specific
                 session, so this links to the plain list rather than a session
                 it cannot actually scroll to (DS6 PR4b). -->
            <RouterLink to="/sessions">{{ entry.sessionTitle }}</RouterLink>
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
      :aria-controls="`activity-row-detail-${entry.eventId}`"
      @click="emit('toggle', entry.eventId)"
    />
    <!-- Fix round item 4 (mock `.ev` grid: always 3 columns): a row with no
         details still reserves the chevron's track, or its time column
         drifts out of alignment with rows that do have one. -->
    <span v-else class="bs-timeline-row__chevron-placeholder" aria-hidden="true"></span>
  </li>
</template>
