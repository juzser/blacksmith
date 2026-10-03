<script setup lang="ts">
// The header row for a folded run of dispatches (timelineDisplay.ts's
// groupDispatches). Deliberately built from the same `.timeline-row` anatomy
// as TimelineRow — chevron, icon circle, title, meta — because it stands in
// the same column as the rows it holds; a header with its own shape would read
// as a different kind of thing rather than as several of the rows below it.
import { computed } from 'vue';
import { formatDateTime, formatTime } from '../lib/format.js';
import type { DispatchGroup } from '../lib/timelineDisplay.js';
import { EVENT_KIND_LABEL } from '../lib/timelineDisplay.js';
import Icon from './ds/Icon.vue';

const props = defineProps<{ group: DispatchGroup; expanded: boolean }>();
const emit = defineEmits<{ toggle: [] }>();

// Every member is a dispatch_decision, so the fold keeps that kind's own tag
// and left bar (brief item 1) rather than a bespoke icon.
const kindLabel = EVENT_KIND_LABEL.dispatch;
const kindStyle = {
  background: 'var(--bs-event-dispatch-subtle)',
  color: 'var(--bs-event-dispatch-text)',
};

const span = computed(() => {
  const stamps = props.group.members.map((m) => m.entry.ts).sort();
  const first = stamps[0];
  const last = stamps[stamps.length - 1];
  // A collapsed group answers "when did this fan-out happen", which is a
  // span, not an instant — and the span is what tells an operator whether the
  // planner dispatched these together or over the course of an hour.
  return first === last ? formatDateTime(first) : `${formatDateTime(first)} → ${formatTime(last)}`;
});
</script>

<template>
  <div class="timeline-row" style="border-left-color: var(--bs-event-dispatch-text)">
    <button
      type="button"
      class="ds-btn ds-btn--ghost ds-btn--icon-xs"
      :aria-expanded="expanded"
      :aria-controls="`tl-group-${group.id}`"
      :aria-label="expanded ? 'Collapse dispatches' : 'Expand dispatches'"
      style="margin-top: var(--ds-space-1)"
      @click="emit('toggle')"
    >
      <Icon :name="expanded ? 'chevron-down' : 'chevron-right'" :size="14" />
    </button>
    <div class="timeline-row__main">
      <div class="timeline-row__head">
        <span class="timeline-row__ktag" :style="kindStyle">{{ kindLabel }}</span>
        <span class="timeline-row__title">{{ group.label }}</span>
      </div>
      <span class="timeline-row__meta">{{ span }} · dispatch_decision</span>
    </div>
  </div>
</template>
