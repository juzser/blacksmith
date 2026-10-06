<script setup lang="ts">
import { SearchX } from '@lucide/vue';
import EmptyState from '../components/kit/EmptyState.vue';
import PageHeader from '../components/kit/PageHeader.vue';
</script>

<template>
  <div class="app-page">
    <PageHeader title="Page not found" />
    <EmptyState
      :icon="SearchX"
      title="Nothing at this address"
      body="It may have moved, or the link may be mistyped."
    >
      <template #action>
        <RouterLink class="bs-btn bs-btn--secondary bs-btn--sm" to="/overview">Go to Home</RouterLink>
      </template>
    </EmptyState>
  </div>
</template>
