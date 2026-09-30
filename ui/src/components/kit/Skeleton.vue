<script setup lang="ts">
import { cssLength } from '../../lib/cssLength.js';

withDefaults(
  defineProps<{
    width?: string;
    height?: number | string;
    radius?: string;
    shape?: 'line' | 'block' | 'circle';
  }>(),
  { width: '100%', height: 16, shape: 'line' },
);
</script>

<template>
  <div
    class="bs-skeleton"
    :class="`bs-skeleton--${shape}`"
    aria-hidden="true"
    :style="{ width: cssLength(width), height: cssLength(height), borderRadius: shape === 'circle' ? undefined : radius }"
  />
</template>
