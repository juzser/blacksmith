<script setup lang="ts">
// ds-spec.md §2.1 row `ProgressBar`: segments: [{tone, value}], stacked,
// replaces a single-fill bar. Unlike ProgressRing/ProgressBarMini, this one
// has no old-kit predecessor and no mockup markup to port from (ds-review.html
// has no stacked-bar HTML) — the .bs-pbar/.bs-pbar__seg class names below
// are new, not a port, flagged as such in the DS0 report.
//
// Renders only the stacked track: no built-in percentage number. The spec's
// prose puts the overall % beside it as a separate ProgressBarMini-style
// read, composed by the caller/page — out of scope here.
import { computed } from 'vue';
import { type ProgressTone, progressToneColor } from './progressTone.js';

// DS4 S5c §1 — 'done'/'review'/'progress' back the statusCounts stacked bar
// (EpicBlock/RoadmapPage), additive alongside the existing ProgressTone set
// WaveList.vue's per-wave bars still use.
type Segment = { tone: ProgressTone | 'neutral' | 'done' | 'review' | 'progress'; value: number };

const KIT_TONE_VAR: Record<'done' | 'review' | 'progress', string> = {
  done: 'var(--bs-tone-done-text)',
  review: 'var(--bs-tone-review-text)',
  progress: 'var(--bs-tone-progress-text)',
};

const props = defineProps<{
  segments: Segment[];
  label: string;
}>();

// Segments are sized against the larger of their own sum or 100, so a track
// that doesn't add up to a full 100 leaves genuine empty space rather than
// stretching to fill it, while a track that does (or overflows) never spills
// past its own width.
const denom = computed(() =>
  Math.max(
    props.segments.reduce((sum, s) => sum + s.value, 0),
    100,
  ),
);

function widthOf(segment: Segment): string {
  return `${(segment.value / denom.value) * 100}%`;
}

function colorOf(segment: Segment): string {
  if (segment.tone === 'neutral') return 'var(--bs-tone-neutral-text)';
  if (segment.tone in KIT_TONE_VAR) {
    return KIT_TONE_VAR[segment.tone as keyof typeof KIT_TONE_VAR];
  }
  return progressToneColor(segment.tone as ProgressTone);
}
</script>

<template>
  <span class="bs-pbar" role="img" :aria-label="label">
    <span
      v-for="(segment, i) in segments"
      :key="i"
      class="bs-pbar__seg"
      :style="{ width: widthOf(segment), background: colorOf(segment) }"
    />
  </span>
</template>
