<script setup lang="ts">
import { type Component, computed } from 'vue';

const props = withDefaults(
  defineProps<{
    icon: Component;
    size?: 14 | 16 | 20;
    label?: string;
  }>(),
  { size: 16 },
);

// ds-spec.md §2.5: stroke 1.75 at 14/16, 1.5 at 20. Colour is currentColor,
// which lucide-vue-next already defaults to, so it is not passed explicitly.
const strokeWidth = computed(() => (props.size === 20 ? 1.5 : 1.75));
</script>

<template>
  <component
    :is="icon"
    :size="size"
    :stroke-width="strokeWidth"
    class="bs-icon"
    :aria-hidden="label ? undefined : 'true'"
    :focusable="label ? undefined : 'false'"
    :role="label ? 'img' : undefined"
    :aria-label="label"
  />
</template>
