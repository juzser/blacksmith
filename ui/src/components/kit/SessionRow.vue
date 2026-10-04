<script setup lang="ts">
// SessionRow (ds-spec.md §4.6, pattern table row 414): one row in the
// Sessions history list. `clickable` follows LessonCard.vue's own pattern —
// the same markup serves the list (a button, one click target) and would
// serve a read-only context as a plain div if one ever needed it.
import { computed } from 'vue';
import { lastStepLabel } from '../../lib/agentStatus.js';
import type { RunningSession } from '../../lib/api.js';
import { formatDurationMs } from '../../lib/format.js';
import RelativeTime from './RelativeTime.vue';

const props = defineProps<{
  session: RunningSession;
  /** Renders the row as the list item's own click target. */
  clickable?: boolean;
  /** The run currently open in the detail section below the list. */
  selected?: boolean;
  /** Test seam for RelativeTime's clock, same as elsewhere in the kit. */
  now?: string;
}>();

const emit = defineEmits<{ click: [] }>();

function onClick() {
  if (props.clickable) emit('click');
}

const title = computed(() => props.session.title ?? props.session.sessionId);

const projectsLabel = computed(() =>
  props.session.projects.length > 0 ? props.session.projects.join(', ') : 'No project',
);

// The duration is the run's own span (last event minus start), not "time
// since start until now" — a running session's span still grows as it polls
// in fresh lastEventAt values, and a finished one's span stays fixed at
// however long it actually ran for.
const duration = computed(() => {
  const start = new Date(props.session.startedAt).getTime();
  const end = new Date(props.session.lastEventAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return '';
  return formatDurationMs(Math.max(0, end - start));
});

// liveAgentCount is 0 for every finished run (its agents are no longer
// live), not a count of how many agents it actually had -- the history list
// has no field for that. Showing "0 agents" would read as a real zero, so
// the count only renders while it is still a live measurement.
const agentCountLabel = computed(() => {
  const n = props.session.liveAgentCount;
  if (n <= 0) return null;
  return `${n} ${n === 1 ? 'agent' : 'agents'}`;
});

const lastStep = computed(() => lastStepLabel(props.session.lastEventType));
</script>

<template>
  <component
    :is="clickable ? 'button' : 'div'"
    :type="clickable ? 'button' : undefined"
    class="bs-sessionrow"
    :class="{ 'bs-sessionrow--clickable': clickable, 'bs-sessionrow--selected': selected }"
    :aria-current="selected ? 'true' : undefined"
    @click="onClick"
  >
    <div class="bs-sessionrow__title">{{ title }}</div>
    <div class="bs-sessionrow__meta">
      <span>{{ projectsLabel }}</span>
      <RelativeTime :iso="session.startedAt" :now="now" />
      <span v-if="duration">{{ duration }}</span>
      <span v-if="agentCountLabel">{{ agentCountLabel }}</span>
      <span class="bs-sessionrow__laststep">{{ lastStep }}</span>
    </div>
  </component>
</template>
