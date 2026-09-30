<script setup lang="ts">
import { ChevronDown, ChevronUp, CircleAlert, Info, TriangleAlert } from 'lucide-vue-next';
import { computed, ref } from 'vue';
import Button from './Button.vue';
import Icon from './Icon.vue';
import IconButton from './IconButton.vue';

const props = withDefaults(
  defineProps<{
    tone?: 'danger' | 'warning' | 'info';
    retryLabel?: string;
    showRetry?: boolean;
    collapsible?: boolean;
  }>(),
  { tone: 'danger', retryLabel: 'Retry', showRetry: false, collapsible: false },
);

const emit = defineEmits<{ retry: [] }>();

const TONES = {
  danger: { text: '--bs-tone-danger-text', subtle: '--bs-tone-danger-subtle', icon: CircleAlert },
  warning: {
    text: '--bs-tone-warning-text',
    subtle: '--bs-tone-warning-subtle',
    icon: TriangleAlert,
  },
  info: { text: '--bs-tone-info-text', subtle: '--bs-tone-info-subtle', icon: Info },
} as const;
const t = computed(() => TONES[props.tone]);
const style = computed(() => ({
  background: `var(${t.value.subtle})`,
  color: `var(${t.value.text})`,
}));

// `collapsible` starts expanded; the toggle's accessible label names the
// action it performs (not the current state), matching disclosure-widget
// convention. No ARIA expanded state is exposed beyond the label text since
// the collapsed slot content is still present in the DOM (v-show), not removed.
const expanded = ref(true);
</script>

<template>
  <div class="bs-banner" role="status" aria-live="polite" :style="style">
    <Icon class="bs-banner__icon" :icon="t.icon" :size="16" />
    <div class="bs-banner__body">
      <span v-show="!collapsible || expanded" class="bs-banner__content"><slot /></span>
      <span v-if="showRetry">
        <Button variant="secondary" size="sm" @click="emit('retry')">{{ retryLabel }}</Button>
      </span>
    </div>
    <IconButton
      v-if="collapsible"
      class="bs-banner__toggle"
      :icon="expanded ? ChevronUp : ChevronDown"
      :label="expanded ? 'Collapse' : 'Expand'"
      size="sm"
      @click="expanded = !expanded"
    />
  </div>
</template>
