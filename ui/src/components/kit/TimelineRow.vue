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
import {
  type ActivityEntry,
  kindFor,
  type MetaContext,
  metaFor,
  titleFor,
} from '../../lib/timelineDisplay.js';
import EventKindTag from './EventKindTag.vue';
import IconButton from './IconButton.vue';

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
  }>(),
  { linkable: true },
);
const emit = defineEmits<{
  toggle: [eventId: string];
  selectTask: [taskId: string];
  becauseOf: [promptId: string];
}>();

const kind = computed(() => kindFor(props.entry));
const title = computed(() => titleFor(props.entry));

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

const meta = computed(() =>
  metaFor(props.entry, { ...props.ctx, now: stillRunning.value ? tickNow.value : props.ctx?.now }),
);

const hasPromptLink = computed(
  () =>
    kind.value === 'dispatch' && props.ctx?.promptTs !== undefined && props.ctx?.promptTs !== null,
);

function onBecauseOf() {
  const promptId = props.entry.nearestPromptId;
  if (promptId) emit('becauseOf', promptId);
}
</script>

<template>
  <li class="bs-timeline-row" :data-kind="kind" :id="`activity-row-${entry.eventId}`">
    <div class="bs-timeline-row__head">
      <EventKindTag :kind="kind" />
      <button
        v-if="entry.taskId && linkable"
        type="button"
        class="bs-timeline-row__title bs-timeline-row__title--link"
        @click="emit('selectTask', entry.taskId)"
      >
        {{ title }}
      </button>
      <span v-else class="bs-timeline-row__title">{{ title }}</span>
      <time class="bs-timeline-row__ts" :datetime="entry.ts">{{ formatTime(entry.ts) }}</time>
    </div>
    <div class="bs-timeline-row__meta">
      <span>{{ meta }}</span>
      <button v-if="hasPromptLink" type="button" class="bs-timeline-row__because-of" @click="onBecauseOf">
        because of your prompt at {{ formatTime(ctx?.promptTs ?? '') }}
      </button>
      <IconButton
        :icon="expanded ? ChevronDown : ChevronRight"
        label="Show details"
        size="sm"
        :aria-expanded="expanded"
        :aria-controls="`activity-row-detail-${entry.eventId}`"
        @click="emit('toggle', entry.eventId)"
      />
    </div>
    <!-- v-show, not v-if: aria-controls above names this id unconditionally
         while collapsed, so the element it names must exist unconditionally
         too, or the IDREF dangles (D-227). -->
    <dl
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
      <dt>Task</dt>
      <dd>{{ entry.taskId ?? 'not measured' }}</dd>
    </dl>
  </li>
</template>
