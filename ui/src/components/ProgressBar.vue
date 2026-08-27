<script setup lang="ts">
// Gap component (design-spec.md §6.2.3): a track/fill div, not in the
// 48-primitive list. bg-primary fill on bg-surface-sunken track is the
// existing Lozenge "info" pairing's foreground (--ds-info-bold reused as
// the fill so no new colour is introduced) — contrast already AA-verified
// at the token level per design-spec.md §7.
import { computed } from 'vue';

const props = defineProps<{ value: number; total: number; label?: string }>();
const pct = computed(() => (props.total > 0 ? Math.round((props.value / props.total) * 100) : 0));
</script>

<template>
  <div>
    <div
      role="progressbar"
      :aria-valuenow="pct"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-label="label ?? `${value} of ${total}`"
      style="height: 6px; border-radius: var(--ds-radius-pill); background: var(--ds-surface-sunken); overflow: hidden"
    >
      <div
        :style="{
          height: '100%',
          width: `${pct}%`,
          background: 'var(--ds-info-bold)',
          borderRadius: 'var(--ds-radius-pill)',
        }"
      />
    </div>
    <span class="ds-stat__label" style="font-size: var(--ds-text-xs)">{{ value }}/{{ total }} ({{ pct }}%)</span>
  </div>
</template>
