<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(
  defineProps<{
    variant?: 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive' | 'link' | 'inverse';
    size?: 'default' | 'sm' | 'xs' | 'icon' | 'icon-sm' | 'icon-xs';
    icon?: string;
    loading?: boolean;
    disabled?: boolean;
    type?: 'button' | 'submit';
    ariaLabel?: string;
  }>(),
  { variant: 'default', size: 'default', type: 'button' },
);

const sizeClass = computed(
  () =>
    ({
      default: 'hds-btn--default-size',
      sm: 'hds-btn--sm',
      xs: 'hds-btn--xs',
      icon: 'hds-btn--icon',
      'icon-sm': 'hds-btn--icon-sm',
      'icon-xs': 'hds-btn--icon-xs',
    })[props.size],
);

const iconSize = computed(
  () =>
    ({
      default: 16,
      sm: 14,
      xs: 12,
      icon: 16,
      'icon-sm': 16,
      'icon-xs': 12,
    })[props.size],
);

const glyph = computed(() => (props.loading ? 'loader-circle' : props.icon));
</script>

<template>
  <button
    :type="type"
    :class="['hds-btn', `hds-btn--${variant}`, sizeClass]"
    :disabled="disabled || loading"
    :aria-label="ariaLabel"
  >
    <Icon v-if="glyph" :name="glyph" :size="iconSize" :style="loading ? 'animation: hds-spin 1s linear infinite' : undefined" /><!-- ds-allow-hardcode: full-rotation spinner duration, not a --ds-motion-* micro-interaction timing -->
    <slot />
  </button>
</template>
