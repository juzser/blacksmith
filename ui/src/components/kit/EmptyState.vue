<script setup lang="ts">
import type { Component } from 'vue';
import Icon from './Icon.vue';

defineProps<{ icon: Component; title: string; body: string }>();
</script>

<template>
  <!-- `action` is an optional named slot, not a prop: callers compose their
       own kit/Button.vue (or a link) inside it rather than EmptyState
       rendering one on their behalf, same pattern as PageHeader's
       actions/status slots. -->
  <div class="bs-empty">
    <Icon class="bs-empty__icon" :icon="icon" :size="24" />
    <p class="bs-empty__title">{{ title }}</p>
    <p v-if="body" class="bs-empty__body">{{ body }}</p>
    <slot name="action" />
  </div>
</template>
