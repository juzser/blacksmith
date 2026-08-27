<script setup lang="ts">
import { computed } from 'vue';
import { ICON_PATHS } from '../../icons.js';

const props = withDefaults(
  defineProps<{
    name: string;
    size?: number;
    strokeWidth?: number;
    label?: string;
  }>(),
  { size: 16, strokeWidth: 2 },
);

const path = computed(() => ICON_PATHS[props.name] ?? '');
</script>

<template>
  <svg
    v-if="path"
    viewBox="0 0 24 24"
    :width="size"
    :height="size"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    :aria-hidden="label ? undefined : 'true'"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    style="flex-shrink: 0; display: block"
    v-html="path"
  />
</template>
