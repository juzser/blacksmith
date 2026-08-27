<script setup lang="ts">
defineProps<{ count?: string }>();
</script>

<template>
  <div class="ds-toolbar">
    <slot />
    <div v-if="count != null || $slots.end" class="ds-toolbar__end">
      <span v-if="count != null" class="ds-toolbar__count">{{ count }}</span>
      <slot name="end" />
    </div>
  </div>
</template>
