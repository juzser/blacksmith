<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';
import Button from './Button.vue';

const props = withDefaults(
  defineProps<{
    tone?: 'danger' | 'warning' | 'info' | 'success';
    retryLabel?: string;
    showRetry?: boolean;
  }>(),
  { tone: 'danger', retryLabel: 'Retry', showRetry: false },
);
const emit = defineEmits<{ retry: [] }>();

const TONES = {
  danger: { bg: '--ds-danger-subtle', fg: '--ds-danger-text', icon: 'circle-alert' },
  warning: { bg: '--ds-warning-subtle', fg: '--ds-warning-text', icon: 'triangle-alert' },
  info: { bg: '--ds-info-subtle', fg: '--ds-info-text', icon: 'info' },
  success: { bg: '--ds-success-subtle', fg: '--ds-success-text', icon: 'circle-check' },
} as const;

const t = computed(() => TONES[props.tone]);
const style = computed(() => ({ background: `var(${t.value.bg})`, color: `var(${t.value.fg})` }));
</script>

<template>
  <!-- design-spec.md §7: load-failure Banners are role="status" aria-live="polite"
       (persistent, not urgent enough for assertive). -->
  <div class="hds-banner" role="status" aria-live="polite" :style="style">
    <Icon :name="t.icon" :size="16" style="margin-top: var(--ds-space-0-5)" />
    <div class="hds-banner__body">
      <span><slot /></span>
      <span v-if="showRetry">
        <Button variant="outline" size="sm" @click="emit('retry')">{{ retryLabel }}</Button>
      </span>
    </div>
  </div>
</template>
