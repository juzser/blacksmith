<script setup lang="ts">
import { ref } from 'vue';

withDefaults(defineProps<{ label: string; side?: 'top' | 'right' | 'bottom' }>(), { side: 'top' });
const shown = ref(false);
</script>

<template>
  <span
    class="ds-tt"
    @mouseenter="shown = true"
    @mouseleave="shown = false"
    @focusin="shown = true"
    @focusout="shown = false"
  >
    <slot />
    <span v-if="shown" class="ds-tt__bubble" :data-side="side" role="tooltip">{{ label }}</span>
  </span>
</template>
