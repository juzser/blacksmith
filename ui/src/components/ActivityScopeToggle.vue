<script setup lang="ts">
// The Active/All switch every activity screen shares. A SegmentedControl with
// its own `current` (vue-router's exact-active ignores the query, so both
// query-only links would otherwise read as current) and `touch`, because the
// scope must stay reachable on phone where a plain SegmentedControl hides.
import { computed } from 'vue';
import { useActivityScope } from '../composables/useActivityScope.js';
import SegmentedControl from './kit/SegmentedControl.vue';

const { scope, scopeTo } = useActivityScope();
const items = computed(() => [
  { label: 'Active', to: scopeTo('active') },
  { label: 'All', to: scopeTo('all') },
]);
const current = computed(() => (scope.value === 'all' ? 'All' : 'Active'));
</script>

<template>
  <SegmentedControl :items="items" :current="current" touch aria-label="Session scope" />
</template>
