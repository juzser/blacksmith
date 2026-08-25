<script setup lang="ts">
import { computed } from 'vue';
import type { LozengeVariant, Tone } from '../../lib/taxonomy.js';

const props = withDefaults(
  defineProps<{
    tone?: Tone;
    variant?: LozengeVariant;
  }>(),
  { tone: 'neutral', variant: 'subtle' },
);

const style = computed(() => {
  if (props.variant === 'subtle') {
    return { background: `var(--ds-${props.tone}-subtle)`, color: `var(--ds-${props.tone}-text)` };
  }
  if (props.variant === 'bold') {
    return {
      background: `var(--ds-${props.tone}-bold)`,
      color: props.tone === 'warning' ? 'var(--ds-warning-on-bold)' : 'var(--ds-text-on-bold)',
    };
  }
  return undefined;
});
</script>

<template>
  <span class="hds-loz" :class="`hds-loz--${variant}`" :style="style"><slot /></span>
</template>
