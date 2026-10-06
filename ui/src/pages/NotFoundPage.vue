<script setup lang="ts">
import { SearchX } from '@lucide/vue';
import EmptyState from '../components/kit/EmptyState.vue';
</script>

<template>
  <EmptyState
    :icon="SearchX"
    title="Page not found"
    body="There is nothing at this address. It may have moved, or the link may be mistyped."
  >
    <template #action>
      <RouterLink class="bs-btn bs-btn--secondary bs-btn--sm" to="/overview">Go to Home</RouterLink>
    </template>
  </EmptyState>
</template>
