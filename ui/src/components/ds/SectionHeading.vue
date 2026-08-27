<script setup lang="ts">
withDefaults(defineProps<{ title: string; description?: string; level?: 2 | 3 | 4 }>(), {
  level: 3,
});
</script>

<template>
  <div class="ds-sh">
    <div class="ds-sh__left">
      <component :is="`h${level}`" class="ds-sh__t">{{ title }}</component>
      <span v-if="description" class="ds-sh__d">{{ description }}</span>
    </div>
    <slot name="action" />
  </div>
</template>
