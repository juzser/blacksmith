<script setup lang="ts">
import type { Crumb } from '../../composables/useBreadcrumb.js';
import Icon from './Icon.vue';

const props = defineProps<{ items: Crumb[] }>();
const emit = defineEmits<{ select: [to: string] }>();
void props;
</script>

<template>
  <nav class="ds-crumbs" aria-label="Breadcrumb">
    <template v-for="(it, i) in items" :key="i">
      <span v-if="i === items.length - 1" class="ds-crumbs__current" aria-current="page">{{ it.label }}</span>
      <template v-else>
        <button type="button" class="ds-crumbs__link" @click="it.to && emit('select', it.to)">{{ it.label }}</button>
        <Icon name="chevron-right" :size="14" />
      </template>
    </template>
  </nav>
</template>
