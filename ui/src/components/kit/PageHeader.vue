<script setup lang="ts">
// The top bar's Breadcrumb already shows the page name (App.vue, DS1 §3) and
// is the phone title too, so this h1 is a visible duplicate on every page
// except where the page's title carries content the crumb doesn't (Task
// detail's task name) — those pages opt in with titleVisible.
withDefaults(defineProps<{ title: string; description?: string; titleVisible?: boolean }>(), {
  titleVisible: false,
});
</script>

<template>
  <div class="bs-ph">
    <div class="bs-ph__left">
      <div class="bs-ph__titlerow">
        <h1 class="bs-ph__title" :class="{ 'sr-only': !titleVisible }">{{ title }}</h1>
        <slot name="status" />
      </div>
      <p v-if="description" class="bs-ph__desc">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="bs-ph__actions"><slot name="actions" /></div>
  </div>
</template>
