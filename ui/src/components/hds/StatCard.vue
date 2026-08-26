<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    icon?: string;
    tint?: 'blue' | 'mint' | 'amber' | 'lilac' | 'rose' | 'slate';
    delta?: string;
    deltaTone?: 'success' | 'danger' | 'neutral' | 'warning';
    hint?: string;
  }>(),
  { tint: 'blue' },
);

const raw = computed(() => (props.delta == null ? '' : String(props.delta).trim()));
const down = computed(() => raw.value.startsWith('-'));
const flat = computed(() => raw.value === '0' || raw.value === '±0' || raw.value.startsWith('0%'));
const dTone = computed(
  () => props.deltaTone || (flat.value ? 'neutral' : down.value ? 'danger' : 'success'),
);
const chipStyle = computed(() => ({
  background: `var(--ds-tint-${props.tint})`,
  color: `var(--ds-tint-${props.tint}-text)`,
}));
const deltaStyle = computed(() => ({
  background: `var(--ds-${dTone.value}-subtle)`,
  color: `var(--ds-${dTone.value}-text)`,
}));
const deltaIcon = computed(() => (flat.value ? 'minus' : down.value ? 'arrow-down' : 'arrow-up'));
</script>

<template>
  <div class="hds-stat">
    <div class="hds-stat__top">
      <span class="hds-stat__label">{{ label }}</span>
      <span v-if="icon" class="hds-stat__chip" :style="chipStyle">
        <Icon :name="icon" :size="16" />
      </span>
    </div>
    <p class="hds-stat__value">{{ value }}</p>
    <div v-if="raw || hint" class="hds-stat__foot">
      <span v-if="raw" class="hds-stat__delta" :style="deltaStyle">
        <Icon :name="deltaIcon" :size="12" :stroke-width="2.5" />
        {{ raw.replace(/^-/, '') }}
      </span>
      <span v-if="hint">{{ hint }}</span>
    </div>
    <span class="hds-stat__bar" :style="{ background: `var(--ds-tint-${tint}-text)` }" />
  </div>
</template>
