<script setup lang="ts">
// The header row for a folded run of dispatches (timelineDisplay.ts's
// groupDispatches). Deliberately built from the same `.timeline-row` anatomy
// as TimelineRow — chevron, icon circle, title, meta — because it stands in
// the same column as the rows it holds; a header with its own shape would read
// as a different kind of thing rather than as several of the rows below it.
import { computed } from 'vue';
import type { DispatchGroup } from '../lib/timelineDisplay.js';
import { formatDateTime, formatTime } from '../lib/format.js';
import Icon from './hds/Icon.vue';

const props = defineProps<{ group: DispatchGroup; expanded: boolean }>();
const emit = defineEmits<{ toggle: [] }>();

// Slate is dispatch_decision's own tint (timelineDisplay.ts tintFor): the fold
// is the same kind of event, so it keeps the kind's colour. Only the glyph
// changes — `layers` for many, `send` for one.
const TINT = { bg: 'var(--ds-tint-slate)', fg: 'var(--ds-tint-slate-text)' };

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
  <div class="timeline-row">
    <button
      type="button"
      class="hds-btn hds-btn--ghost hds-btn--icon-xs"
      :aria-expanded="expanded"
      :aria-controls="`tl-group-${group.id}`"
      :aria-label="expanded ? 'Collapse dispatches' : 'Expand dispatches'"
      style="margin-top: var(--ds-space-1)"
      @click="emit('toggle')"
    >
      <Icon :name="expanded ? 'chevron-down' : 'chevron-right'" :size="14" />
    </button>
    <span class="timeline-row__icon" :style="{ background: TINT.bg, color: TINT.fg }">
      <Icon name="layers" :size="14" />
    </span>
    <div class="timeline-row__main">
      <div class="timeline-row__head">
        <span class="timeline-row__title">{{ group.label }}</span>
      </div>
      <span class="timeline-row__meta">{{ span }} · dispatch_decision</span>
    </div>
  </div>
</template>
