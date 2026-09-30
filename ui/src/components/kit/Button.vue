<script setup lang="ts">
// ds-spec.md §2.1: variant primary|secondary|ghost|danger|link, size sm|md,
// icon?, states "default, hover, pressed, disabled, loading (spinner
// replaces label, width locked)". Width stays locked with no JS measurement:
// the label span is always rendered (never v-if'd away), only visually
// hidden while loading, so it keeps occupying its normal layout box; the
// spinner is positioned on top of it via bs-primitives.css. type/disabled
// follow ds/Button.vue's existing convention (not itself a §2.1 prop, but a
// plain <button> needs one to behave inside a <form>, same as the old kit).

import { LoaderCircle } from 'lucide-vue-next';
import type { Component } from 'vue';
import { computed } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
    size?: 'sm' | 'md';
    icon?: Component;
    disabled?: boolean;
    loading?: boolean;
    type?: 'button' | 'submit';
  }>(),
  { variant: 'primary', size: 'md', type: 'button' },
);

const iconSize = computed(() => (props.size === 'sm' ? 14 : 16));
</script>

<template>
  <button
    :type="type"
    class="bs-btn"
    :class="[`bs-btn--${variant}`, `bs-btn--${size}`, { 'bs-btn--loading': loading }]"
    :disabled="disabled || loading"
  >
    <Icon v-if="icon && !loading" :icon="icon" :size="iconSize" />
    <Icon v-if="loading" class="bs-btn__spinner" :icon="LoaderCircle" :size="iconSize" />
    <span class="bs-btn__label" :class="{ 'bs-btn__label--hidden': loading }"><slot /></span>
  </button>
</template>
