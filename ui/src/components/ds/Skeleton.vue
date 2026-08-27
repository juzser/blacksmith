<script setup lang="ts">
// Sizes go through cssLength() because a template attribute is always a
// string: `height="240"` arrives as '240'. The old inline number check never
// matched it, so the style came out as `height: 240` — not a CSS length, so
// the browser dropped it and every skeleton collapsed to nothing (D-223).
import { cssLength } from '../../lib/cssLength.js';

withDefaults(defineProps<{ width?: string; height?: number | string; radius?: string }>(), {
  width: '100%',
  height: 16,
});
</script>

<template>
  <div
    class="ds-skeleton"
    aria-hidden="true"
    :style="{ width: cssLength(width), height: cssLength(height), borderRadius: radius }"
  />
</template>
