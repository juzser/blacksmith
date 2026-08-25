<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <div class="hds-ph">
    <div class="hds-ph__left">
      <div class="hds-ph__titlerow">
        <h1 class="hds-ph__title">{{ title }}</h1>
        <slot name="status" />
      </div>
      <p v-if="description" class="hds-ph__desc">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="hds-ph__actions"><slot name="actions" /></div>
  </div>
</template>
