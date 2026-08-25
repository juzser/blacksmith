<script setup lang="ts">
// BarChart — capped at 8 series per design-spec.md §4 ("Cap at 8 series...
// more than eight categories means the chart is the wrong shape"). Modeled
// on the kit's own reference (knowledge/design-system/hds/components/
// charts/BarChart.jsx): flex column-per-category (value label + track +
// bar + x-axis label), NOT scaled SVG rects — a raw `preserveAspectRatio:
// none` SVG stretches a single bar to fill the whole viewBox width with no
// text anywhere near it (uiux S2 #2: "renders data-free"). Same a11y
// treatment as LineChart: the plot is one `role="img"` unit (native
// per-bar `title` tooltips are a bonus, not the accessible path — the
// sr-only sibling `<table>` is) + aria-label + sr-only data table.
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    bars: { label: string; value: number }[];
    label: string;
    height?: number;
    format?: (v: number) => string;
  }>(),
  { height: 200, format: (v: number) => String(v) },
);

const capped = computed(() => props.bars.slice(0, 8));
const max = computed(() => Math.max(...capped.value.map((b) => b.value), 1));

function pct(value: number): number {
  return Math.max((value / max.value) * 100, 2);
}

const summary = computed(() => {
  if (capped.value.length === 0) return `${props.label}: no data.`;
  const top = [...capped.value].sort((a, b) => b.value - a.value)[0];
  return `${props.label}, ${capped.value.length} categories, highest ${top?.label} at ${top?.value}.`;
});
</script>

<template>
  <div class="hds-chart">
    <div class="hds-bars" role="img" :aria-label="summary">
      <div class="hds-bars__plot" :style="{ height: `${height}px` }">
        <div v-for="b in capped" :key="b.label" class="hds-bars__col">
          <span class="hds-bars__v">{{ format(b.value) }}</span>
          <span class="hds-bars__track">
            <span
              class="hds-bars__bar"
              :style="{ height: `${pct(b.value)}%` }"
              :title="`${b.label}: ${format(b.value)}`"
            />
          </span>
          <span class="hds-bars__x">{{ b.label }}</span>
        </div>
      </div>
      <div class="hds-bars__scale"><span>0</span><span>{{ format(max) }}</span></div>
    </div>
    <table class="sr-only">
      <caption>{{ label }}</caption>
      <thead>
        <tr>
          <th scope="col">Category</th>
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="b in capped" :key="b.label">
          <td>{{ b.label }}</td>
          <td>{{ b.value }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
