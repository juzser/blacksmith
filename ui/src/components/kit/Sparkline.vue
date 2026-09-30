<script setup lang="ts">
// Ported from the old kit's Sparkline component — inline trend, no axes
// (design-spec.md §4), optional StatCard child.
//
// `takeaway` is new: every kit chart now requires a one-line prose summary
// from the caller, per the DS0 batch directive. The old component's root
// was a bare svg element with nowhere to put a paragraph — this adds a
// wrapper div (`bs-chart bs-chart--spark`, flagged as an interpretation:
// the `--spark` modifier keeps the wrapper's width auto/inline instead of
// the full-width column layout `.bs-chart` uses for BarChart/LineChart,
// which would break Sparkline's fixed 80x24 inline-trend sizing).
import { computed } from 'vue';

const props = defineProps<{
  values: number[];
  label: string;
  takeaway: string;
}>();
const width = 80;
const height = 24;
// Bound from the same width/height consts above (not a second literal) —
// StatCard's inline-trend slot has a fixed intrinsic size by design (design-
// spec.md §4), not a design-token-driven one.
const svgStyle = { width: `${width}px`, height: `${height}px` };

const path = computed(() => {
  if (props.values.length === 0) return '';
  const max = Math.max(...props.values, 1);
  const min = Math.min(...props.values, 0);
  const range = max - min || 1;
  const stepX = props.values.length > 1 ? width / (props.values.length - 1) : 0;
  return props.values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
});
</script>

<template>
  <div class="bs-chart bs-chart--spark">
    <p class="bs-chart__takeaway">{{ takeaway }}</p>
    <svg
      :viewBox="`0 0 ${width} ${height}`"
      role="img"
      :aria-label="label"
      :style="svgStyle"
    >
      <path v-if="path" :d="path" class="bs-chart__line" />
    </svg>
  </div>
</template>
