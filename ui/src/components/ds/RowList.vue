<script setup lang="ts">
withDefaults(defineProps<{ density?: 'prose' | 'compact' }>(), { density: 'prose' });
</script>

<template>
  <ul class="ds-rows" :data-density="density">
    <slot />
  </ul>
</template>
