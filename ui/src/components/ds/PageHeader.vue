<script setup lang="ts">
// The top bar's Breadcrumb already shows the page name (App.vue, DS1 §3) and
// is the phone title too, so this h1 is a visible duplicate on every page
// that uses this component (ds-spec pages, none of which carry a title that
// differs from their crumb) — kept for screen readers only.
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <div class="ds-ph">
    <div class="ds-ph__left">
      <div class="ds-ph__titlerow">
        <h1 class="ds-ph__title sr-only">{{ title }}</h1>
        <slot name="status" />
      </div>
      <p v-if="description" class="ds-ph__desc">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="ds-ph__actions"><slot name="actions" /></div>
  </div>
</template>
