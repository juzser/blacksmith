<script setup lang="ts">
withDefaults(defineProps<{ title?: string; description?: string; padded?: boolean }>(), {
  padded: true,
});
</script>

<template>
  <div class="hds-card">
    <div v-if="title || description || $slots.action" class="hds-card__header">
      <div class="hds-card__headrow">
        <div v-if="title" class="hds-card__title">{{ title }}</div>
        <span v-else />
        <div v-if="$slots.action" class="hds-card__headend"><slot name="action" /></div>
      </div>
      <div v-if="description" class="hds-card__desc">{{ description }}</div>
    </div>
    <div :class="padded ? 'hds-card__body' : 'hds-card__body--unpadded'">
      <slot />
    </div>
    <div v-if="$slots.footer" class="hds-card__footer"><slot name="footer" /></div>
  </div>
</template>
