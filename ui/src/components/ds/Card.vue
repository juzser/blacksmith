<script setup lang="ts">
withDefaults(defineProps<{ title?: string; description?: string; padded?: boolean }>(), {
  padded: true,
});
</script>

<template>
  <div class="ds-card">
    <div v-if="title || description || $slots.action" class="ds-card__header">
      <div class="ds-card__headrow">
        <div v-if="title" class="ds-card__title">{{ title }}</div>
        <span v-else />
        <div v-if="$slots.action" class="ds-card__headend"><slot name="action" /></div>
      </div>
      <div v-if="description" class="ds-card__desc">{{ description }}</div>
    </div>
    <div :class="padded ? 'ds-card__body' : 'ds-card__body--unpadded'">
      <slot />
    </div>
    <div v-if="$slots.footer" class="ds-card__footer"><slot name="footer" /></div>
  </div>
</template>
