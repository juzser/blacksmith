<script setup lang="ts">
// LineChart — inline SVG, no charting library (design-spec.md §4), modeled
// on the kit's own reference (knowledge/design-system/hds/components/
// charts/LineChart.jsx): gridlines + a visible chart-token stroke + point
// markers with native <title> tooltips + x-axis category labels + min/max
// scale text below. Every chart gets role="img" + aria-label + an sr-only
// <table> data alternative (WCAG 1.1.1 — a colour-only trend line has no
// text alternative otherwise).
//
// Fix-round (uiux S2 #2): the previous version defined `.hds-chart__axislabel`
// but never rendered it, and a single-data-point series drew an invisible
// "M x,y"-only path (no line segment to see). Points now always render as
// markers (visible even for n=1), and x-axis/min-max labels are real DOM.
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    points: { label: string; value: number }[];
    label: string;
    height?: number;
    format?: (v: number) => string;
  }>(),
  { height: 200, format: (v: number) => String(v) },
);

const width = 480;
const padding = 8;

const max = computed(() => Math.max(...props.points.map((p) => p.value), 1));
const min = computed(() => Math.min(...props.points.map((p) => p.value), 0));
const span = computed(() => max.value - min.value || 1);
const stepX = computed(() =>
  props.points.length > 1 ? (width - padding * 2) / (props.points.length - 1) : 0,
);

const plotted = computed(() =>
  props.points.map((p, i) => ({
    ...p,
    x: padding + i * stepX.value,
    y: props.height - padding - ((p.value - min.value) / span.value) * (props.height - padding * 2),
  })),
);

const path = computed(() => {
  if (plotted.value.length < 2) return '';
  return plotted.value.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
});

const summary = computed(() => {
  if (props.points.length === 0) return `${props.label}: no data.`;
  const first = props.points[0]?.value ?? 0;
  const last = props.points[props.points.length - 1]?.value ?? 0;
  const trend = last > first ? 'rising' : last < first ? 'falling' : 'flat';
  return `${props.label}, ${trend} from ${first} to ${last}.`;
});

// x-axis category labels: first, middle, last (avoids overlapping text with many points).
const xLabels = computed(() => {
  const pts = plotted.value;
  if (pts.length === 0) return [];
  if (pts.length <= 3) return pts;
  const mid = pts[Math.floor((pts.length - 1) / 2)];
  const first = pts[0];
  const last = pts[pts.length - 1];
  return [first, mid, last].filter((p): p is (typeof pts)[number] => p !== undefined);
});
</script>

<template>
  <div class="hds-chart">
    <svg
      :viewBox="`0 0 ${width} ${height}`"
      role="img"
      :aria-label="summary"
      preserveAspectRatio="none"
      style="width: 100%; height: auto"
    >
      <line
        v-for="i in 3"
        :key="i"
        class="hds-chart__gridline"
        x1="0"
        :x2="width"
        :y1="(height / 4) * i"
        :y2="(height / 4) * i"
      />
      <path v-if="path" :d="path" class="hds-chart__line" vector-effect="non-scaling-stroke" />
      <circle v-for="p in plotted" :key="p.label" :cx="p.x" :cy="p.y" r="3" class="hds-chart__point">
        <title>{{ p.label }}: {{ format(p.value) }}</title>
      </circle>
    </svg>
    <div v-if="xLabels.length > 0" class="hds-chart__axisrow">
      <span v-for="l in xLabels" :key="l.label" class="hds-chart__axislabel">{{ l.label }}</span>
    </div>
    <div v-if="points.length > 0" class="hds-chart__scale">
      <span>min {{ format(min) }}</span>
      <span>max {{ format(max) }}</span>
    </div>
    <table class="sr-only">
      <caption>{{ label }}</caption>
      <thead>
        <tr>
          <th scope="col">Label</th>
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in points" :key="p.label">
          <td>{{ p.label }}</td>
          <td>{{ p.value }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
