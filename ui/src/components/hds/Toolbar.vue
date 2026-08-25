<script setup lang="ts">
defineProps<{ count?: string }>();
</script>

<template>
  <div class="hds-toolbar">
    <slot />
    <div v-if="count != null || $slots.end" class="hds-toolbar__end">
      <span v-if="count != null" class="hds-toolbar__count">{{ count }}</span>
      <slot name="end" />
    </div>
  </div>
</template>
