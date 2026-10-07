<script setup lang="ts">
// The Roadmap's one legend: the four status tones a swimlane bar can take, in
// the order the status Tags use. Labels come from waveList.ts so the two never
// drift; swatches reuse the `.lbar--<tone>` rules (bs-primitives.css). Hidden
// at phone width, where the swimlane is not rendered.
import { useViewport } from '../composables/useViewport.js';
import type { BarTone } from '../lib/roadmapSwimlane.js';
import { epicStatusFromServerStatus } from '../lib/waveList.js';

const { isPhoneWidth } = useViewport();

const ENTRIES = [
  { tone: 'done', status: 'done' },
  { tone: 'review', status: 'review' },
  { tone: 'in-progress', status: 'in_progress' },
  { tone: 'todo', status: 'todo' },
] as const satisfies ReadonlyArray<{ tone: BarTone; status: string }>;

const entries = ENTRIES.map((e) => ({
  tone: e.tone,
  label: epicStatusFromServerStatus(e.status).statusLabel,
}));
</script>

<template>
  <div v-if="!isPhoneWidth" class="rm-legend">
    <span v-for="e in entries" :key="e.tone" class="rm-legend__item">
      <span class="rm-legend__swatch" :class="`lbar--${e.tone}`" aria-hidden="true" />
      {{ e.label }}
    </span>
  </div>
</template>
