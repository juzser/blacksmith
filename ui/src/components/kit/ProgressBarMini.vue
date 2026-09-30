<script setup lang="ts">
// ds-spec.md §2.1 row `ProgressBarMini`. Same value/max/tone/label props as
// ProgressRing, plus the same two additive props (`kind`, `detail`) for the
// same reasons — see ProgressRing.vue's own comment and progressTone.ts.
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
// Unclamped on purpose — see ProgressRing.vue's rawPercent for why.
const rawPercent = computed(() => (props.max > 0 ? (props.value / props.max) * 100 : 0));
const text = computed(() => `${Math.round(rawPercent.value)}%`);
</script>

<template>
  <Tooltip v-if="detail" mode="describe" :text="detail">
    <span class="pmini" role="img" :aria-label="label">
      <span class="ptrack"><span :style="{ width: `${pct}%`, background: fillColor }" /></span>
      <span class="pnum">{{ text }}</span>
    </span>
  </Tooltip>
  <span v-else class="pmini" role="img" :aria-label="label">
    <span class="ptrack"><span :style="{ width: `${pct}%`, background: fillColor }" /></span>
    <span class="pnum">{{ text }}</span>
  </span>
</template>
