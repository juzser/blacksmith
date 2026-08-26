<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    eyebrow?: string;
    title?: string;
    tint?: 'blue' | 'mint' | 'amber' | 'orange' | 'lilac' | 'rose' | 'slate';
  }>(),
  { tint: 'blue' },
);

const BOLD: Record<string, [string, string]> = {
  blue: ['var(--ds-info-bold)', 'var(--ds-text-on-bold)'],
  mint: ['var(--ds-success-bold)', 'var(--ds-text-on-bold)'],
  amber: ['var(--ds-warning-bold)', 'var(--ds-warning-on-bold)'],
  orange: ['var(--ds-orange-bold)', 'var(--ds-orange-on-bold)'],
  lilac: ['var(--ds-discovery-bold)', 'var(--ds-text-on-bold)'],
  rose: ['var(--ds-danger-bold)', 'var(--ds-text-on-bold)'],
  slate: ['var(--ds-neutral-bold)', 'var(--ds-text-on-bold)'],
};

const style = computed(() => {
  const [bg, fg] = BOLD[props.tint] ??
    BOLD.blue ?? ['var(--ds-info-bold)', 'var(--ds-text-on-bold)'];
  return {
    background: bg,
    color: fg,
    '--ds-btn-fg': fg,
    '--ds-btn-ground': bg,
  };
});
</script>

<template>
  <div class="hds-hl" :style="style">
    <div class="hds-hl__body">
      <span v-if="eyebrow" class="hds-hl__eyebrow">{{ eyebrow }}</span>
      <h3 v-if="title" class="hds-hl__title">{{ title }}</h3>
      <p v-if="$slots.default" class="hds-hl__text"><slot /></p>
      <div v-if="$slots.action" class="hds-hl__actions"><slot name="action" /></div>
    </div>
  </div>
</template>
