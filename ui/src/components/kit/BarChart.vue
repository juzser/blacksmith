<script setup lang="ts">
// Ported from the old kit's BarChart component (ds-spec.md §2.1/§5), capped
// at 8 series per design-spec.md §4. Its old-kit-prefixed classes/tokens are
// renamed to the bs- prefix for the DS0 kit; logic otherwise unchanged.
// bs-tokens.css only defines --bs-chart-1..6 (the old token set had 8) —
// this component never references a chart-N token directly (colour comes
// from CSS class defaults or, for stacked series, the caller's own
// `series[].tone`), so that shrink doesn't block porting, it's just noted
// here per the DS0 report.
//
// `takeaway` is new: every kit chart now requires a one-line prose summary
// from the caller, rendered above the plot, per the DS0 batch directive.
//
// `stacked`/`series`/`stackedBars` are additive and under-specified in the
// spec (no stacked-bar mockup or prose exists to port from). Minimal
// decision: a second, mutually exclusive render path selected by `stacked`,
// reusing the same column/track/x-axis structure but with one
// `bs-bars__bar--stack` segment per series, positioned by cumulative
// `bottom` offset so segments stack visually without overlapping. Segment
// colour comes from `series[].tone` (a caller-supplied CSS colour value,
// such as a chart token reference) via inline style, same as ProgressBar's
// tone-to-colour approach.
import { computed } from 'vue';
import { axisDayLabels } from '../../lib/format';

type StackedBar = { label: string; values: Record<string, number> };

const props = withDefaults(
  defineProps<{
    bars: { label: string; value: number }[];
    label: string;
    height?: number;
    format?: (v: number) => string;
    takeaway: string;
    stacked?: boolean;
    series?: { key: string; tone: string }[];
    stackedBars?: { label: string; values: Record<string, number> }[];
    /** Opt-in: a swatch + name per series, below the plot. Stacked charts only. */
    legend?: boolean;
    /**
     * Opt-in: a zero-total stacked column renders its track as empty
     * (transparent) instead of the default filled-looking sunken
     * background, so a day with no tokens does not read as a full bar of
     * data. Defaults false so every existing stacked caller is unchanged.
     */
    hideEmptyTrack?: boolean;
    /**
     * Opt-in: the stacked chart's labels are `YYYY-MM-DD` days. Instead of one
     * date under every column (which clips once the columns are narrow), the
     * columns sit on a baseline and one row under the plot names the first and
     * the last day (ds-review.html `.vchart` / `.xaxis`). The "0 … max" row is
     * dropped: under a date axis it reads as a second x-axis. The screen-reader
     * table keeps every day's full date. Stacked charts only.
     */
    dayAxis?: boolean;
  }>(),
  {
    height: 200,
    format: (v: number) => String(v),
    stacked: false,
    series: () => [],
    stackedBars: () => [],
    legend: false,
    hideEmptyTrack: false,
    dayAxis: false,
  },
);

const capped = computed(() => props.bars.slice(0, 8));
const max = computed(() => Math.max(...capped.value.map((b) => b.value), 1));

function pct(value: number): number {
  return Math.max((value / max.value) * 100, 2);
}

const summary = computed(() => {
  if (props.stacked) {
    if (cappedStacked.value.length === 0) return `${props.label}: no data.`;
    const top = [...cappedStacked.value].sort((a, b) => stackedTotal(b) - stackedTotal(a))[0];
    return `${props.label}, ${cappedStacked.value.length} categories, highest ${top?.label} at ${stackedTotal(
      top as StackedBar,
    )}.`;
  }
  if (capped.value.length === 0) return `${props.label}: no data.`;
  const top = [...capped.value].sort((a, b) => b.value - a.value)[0];
  return `${props.label}, ${capped.value.length} categories, highest ${top?.label} at ${top?.value}.`;
});

const cappedStacked = computed(() => props.stackedBars.slice(0, 8));

function stackedTotal(entry: StackedBar): number {
  return Object.values(entry.values).reduce((sum, v) => sum + v, 0);
}

const stackedMax = computed(() => Math.max(...cappedStacked.value.map(stackedTotal), 1));

const axisDays = computed(() => axisDayLabels(cappedStacked.value.map((e) => e.label)));

function segmentHeight(entry: StackedBar, seriesIndex: number): string {
  const value = entry.values[props.series[seriesIndex]?.key ?? ''] ?? 0;
  return `${(value / stackedMax.value) * 100}%`;
}

function segmentBottom(entry: StackedBar, seriesIndex: number): string {
  const before = props.series
    .slice(0, seriesIndex)
    .reduce((sum, s) => sum + (entry.values[s.key] ?? 0), 0);
  return `${(before / stackedMax.value) * 100}%`;
}
</script>

<template>
  <div class="bs-chart">
    <p class="bs-chart__takeaway">{{ takeaway }}</p>
    <div v-if="stacked" class="bs-bars" :class="{ 'bs-bars--axis': dayAxis }" role="img" :aria-label="summary">
      <div
        class="bs-bars__plot"
        :class="{ 'bs-bars__plot--axis': dayAxis }"
        :style="{ height: `${height}px` }"
      >
        <div v-for="entry in cappedStacked" :key="entry.label" class="bs-bars__col">
          <span
            class="bs-bars__track"
            :class="{ 'bs-bars__track--empty': hideEmptyTrack && stackedTotal(entry) === 0 }"
          >
            <span
              v-for="(s, i) in series"
              :key="s.key"
              class="bs-bars__bar bs-bars__bar--stack"
              :style="{ height: segmentHeight(entry, i), bottom: segmentBottom(entry, i), background: s.tone }"
            />
          </span>
          <span v-if="!dayAxis" class="bs-bars__x">{{ entry.label }}</span>
        </div>
      </div>
      <div v-if="dayAxis" class="bs-bars__axis"><span v-for="d in axisDays" :key="d">{{ d }}</span></div>
      <div v-if="!dayAxis" class="bs-bars__scale"><span>0</span><span>{{ format(stackedMax) }}</span></div>
      <ul v-if="legend" class="bs-bars__legend">
        <li v-for="s in series" :key="s.key" class="bs-bars__legend-item">
          <span class="bs-bars__legend-swatch" :style="{ background: s.tone }" />
          {{ s.key }}
        </li>
      </ul>
    </div>
    <div v-else class="bs-bars" role="img" :aria-label="summary">
      <div class="bs-bars__plot" :style="{ height: `${height}px` }">
        <div v-for="b in capped" :key="b.label" class="bs-bars__col">
          <span class="bs-bars__v">{{ format(b.value) }}</span>
          <span class="bs-bars__track">
            <span
              class="bs-bars__bar"
              :style="{ height: `${pct(b.value)}%` }"
              :title="`${b.label}: ${format(b.value)}`"
            />
          </span>
          <span class="bs-bars__x">{{ b.label }}</span>
        </div>
      </div>
      <div class="bs-bars__scale"><span>0</span><span>{{ format(max) }}</span></div>
    </div>
    <table v-if="stacked" class="sr-only">
      <caption>{{ label }}</caption>
      <thead>
        <tr>
          <th scope="col">Category</th>
          <th v-for="s in series" :key="s.key" scope="col">{{ s.key }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in cappedStacked" :key="entry.label">
          <td>{{ entry.label }}</td>
          <td v-for="s in series" :key="s.key">{{ entry.values[s.key] ?? 0 }}</td>
        </tr>
      </tbody>
    </table>
    <table v-else class="sr-only">
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
