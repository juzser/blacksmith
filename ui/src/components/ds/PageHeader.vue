<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <div class="ds-ph">
    <div class="ds-ph__left">
      <div class="ds-ph__titlerow">
        <h1 class="ds-ph__title">{{ title }}</h1>
        <slot name="status" />
      </div>
      <p v-if="description" class="ds-ph__desc">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="ds-ph__actions"><slot name="actions" /></div>
  </div>
</template>
