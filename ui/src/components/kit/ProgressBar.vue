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

type Segment = { tone: ProgressTone | 'neutral'; value: number };

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
  return progressToneColor(segment.tone);
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
