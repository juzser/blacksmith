<script setup lang="ts">
withDefaults(defineProps<{ orientation?: 'horizontal' | 'vertical' }>(), {
  orientation: 'horizontal',
});
</script>

<template>
  <div
    role="separator"
    :aria-orientation="orientation"
    class="hds-sep"
    :class="orientation === 'horizontal' ? 'hds-sep--h' : 'hds-sep--v'"
  />
</template>
