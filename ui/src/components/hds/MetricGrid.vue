<script setup lang="ts">
withDefaults(defineProps<{ columns?: 2 | 4 }>(), { columns: 4 });
</script>

<template>
  <div class="hds-mgrid" :data-cols="columns">
    <slot />
  </div>
</template>
