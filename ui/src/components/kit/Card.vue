<script setup lang="ts">
withDefaults(
  defineProps<{
    title?: string;
    description?: string;
    padding?: 'sm' | 'md' | 'lg';
    interactive?: boolean;
  }>(),
  { padding: 'md', interactive: false },
);
</script>

<template>
  <div
    class="bs-card"
    :class="[`bs-card--${padding}`, { 'bs-card--interactive': interactive }]"
    :tabindex="interactive ? '0' : undefined"
  >
    <div v-if="title || description || $slots.action" class="bs-card__header">
      <div class="bs-card__headrow">
        <div v-if="title" class="bs-card__title">{{ title }}</div>
        <span v-else />
        <div v-if="$slots.action" class="bs-card__headend"><slot name="action" /></div>
      </div>
      <div v-if="description" class="bs-card__desc">{{ description }}</div>
    </div>
    <div class="bs-card__body">
      <slot />
    </div>
    <div v-if="$slots.footer" class="bs-card__footer"><slot name="footer" /></div>
  </div>
</template>
