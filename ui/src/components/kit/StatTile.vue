<script setup lang="ts">
// StatTile (ds-spec.md §4.1 item 1): one read-only figure, lifted from the
// Analytics phone tile (the mock's .stat and .mstat). The caller wraps the
// tiles in <dl class="bs-stat-grid">, so each tile is a dt and its dd pair.
// Not a link and no actions: a tile only reads out a number.
//
// `floor` marks a value as a lower bound: a visible "≥" that a screen reader
// hears as "at least". `quiet` sets a word in the value slot ("None", "Not
// measured") quieter than a figure. `loading` stands a Skeleton in for the value.
import Skeleton from './Skeleton.vue';

defineProps<{
  label: string;
  value: string;
  helper?: string;
  quiet?: boolean;
  floor?: boolean;
  loading?: boolean;
}>();
</script>

<template>
  <div class="bs-stat">
    <dt class="bs-stat__label">{{ label }}</dt>
    <dd class="bs-stat__value" :class="{ 'bs-stat__value--nd': quiet }">
      <Skeleton v-if="loading" width="50%" height="var(--bs-leading-xl)" />
      <template v-else><template v-if="floor"><span aria-hidden="true">≥</span><span class="sr-only">at least </span></template>{{ value }}</template>
    </dd>
    <dd v-if="helper" class="bs-stat__helper">{{ helper }}</dd>
  </div>
</template>
