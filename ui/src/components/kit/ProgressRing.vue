<script setup lang="ts">
// ds-spec.md §2.1 row `ProgressRing` + the "Progress tones and placement"
// paragraph beneath the table.
//
// Two additive props beyond value/max/tone/label:
// - `kind` ('budget' | 'ratio', default 'ratio') selects which of the two
//   auto-tone threshold rules applies when `tone` is omitted — see
//   progressTone.ts for the rationale (a budget can be exceeded past 100%,
//   a ratio cannot by definition).
// - `detail` (optional string): the spec's prose describes a hover/focus
//   Tooltip carrying the exact values ("127,402,118 of 180,000,000 tokens
//   (71%)"), a sentence the component cannot derive from value/max/label
//   alone and that is not in the props table. Omitted -> no Tooltip at all,
//   rather than one with empty/misleading content.
//
// Sizing: built at the spec prose's literal default — 20px ring, r=8,
// pathLength=100, 2.5px stroke. ds-review.html's own CSS disagrees (default
// 18px/stroke-width 3, plus an undocumented `.pring.lg` 20px modifier, and no
// `size` prop anywhere in the spec's props table) — flagged in the DS0
// report as a spec-vs-mockup mismatch rather than silently resolved; no
// `size`/`lg` prop is added here.
import { computed } from 'vue';
import Tooltip from './Tooltip.vue';
import {
  clampedPercent,
  computeProgressTone,
  progressToneColor,
  type ProgressKind,
  type ProgressTone,
} from './progressTone.js';

const props = withDefaults(
  defineProps<{
    value: number;
    max?: number;
    tone?: ProgressTone;
    kind?: ProgressKind;
    label: string;
    detail?: string;
  }>(),
  { max: 100, kind: 'ratio' },
);

const resolvedTone = computed(() => props.tone ?? computeProgressTone(props.value, props.max, props.kind));
const fillColor = computed(() => progressToneColor(resolvedTone.value));
const pct = computed(() => clampedPercent(props.value, props.max));
// Unclamped on purpose: a budget past 100% still reads its true value, e.g.
// "103%", even though the ring itself is visually capped at a full circle.
const rawPercent = computed(() => (props.max > 0 ? (props.value / props.max) * 100 : 0));
const text = computed(() => `${Math.round(rawPercent.value)}%`);
</script>

<template>
  <Tooltip v-if="detail" mode="describe" :text="detail">
    <span class="pring" role="img" :aria-label="label">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle class="trk" cx="10" cy="10" r="8" />
        <circle
          class="fil"
          cx="10"
          cy="10"
          r="8"
          pathLength="100"
          :stroke-dasharray="`${pct} 100`"
          :style="{ stroke: fillColor }"
        />
      </svg>
      <span class="pnum">{{ text }}</span>
    </span>
  </Tooltip>
  <span v-else class="pring" role="img" :aria-label="label">
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle class="trk" cx="10" cy="10" r="8" />
      <circle
        class="fil"
        cx="10"
        cy="10"
        r="8"
        pathLength="100"
        :stroke-dasharray="`${pct} 100`"
        :style="{ stroke: fillColor }"
      />
    </svg>
    <span class="pnum">{{ text }}</span>
  </span>
</template>
