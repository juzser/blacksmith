<script setup lang="ts">
withDefaults(defineProps<{ orientation?: 'horizontal' | 'vertical' }>(), {
  orientation: 'horizontal',
});
</script>

<template>
  <div
    role="separator"
    :aria-orientation="orientation"
    class="bs-sep"
    :class="orientation === 'horizontal' ? 'bs-sep--h' : 'bs-sep--v'"
  />
</template>
