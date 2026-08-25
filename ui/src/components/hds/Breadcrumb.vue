<script setup lang="ts">
import Icon from './Icon.vue';
import type { Crumb } from '../../composables/useBreadcrumb.js';

const props = defineProps<{ items: Crumb[] }>();
const emit = defineEmits<{ select: [to: string] }>();
void props;
</script>

<template>
  <nav class="hds-crumbs" aria-label="Breadcrumb">
    <template v-for="(it, i) in items" :key="i">
      <span v-if="i === items.length - 1" class="hds-crumbs__current" aria-current="page">{{ it.label }}</span>
      <template v-else>
        <button type="button" class="hds-crumbs__link" @click="it.to && emit('select', it.to)">{{ it.label }}</button>
        <Icon name="chevron-right" :size="14" />
      </template>
    </template>
  </nav>
</template>
