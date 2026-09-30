<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <div class="bs-ph">
    <div class="bs-ph__left">
      <div class="bs-ph__titlerow">
        <h1 class="bs-ph__title">{{ title }}</h1>
        <slot name="status" />
      </div>
      <p v-if="description" class="bs-ph__desc">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="bs-ph__actions"><slot name="actions" /></div>
  </div>
</template>
