<script setup lang="ts">
withDefaults(defineProps<{ orientation?: 'horizontal' | 'vertical' }>(), {
  orientation: 'horizontal',
});
</script>

<template>
  <div
    role="separator"
    :aria-orientation="orientation"
    class="ds-sep"
    :class="orientation === 'horizontal' ? 'ds-sep--h' : 'ds-sep--v'"
  />
</template>
