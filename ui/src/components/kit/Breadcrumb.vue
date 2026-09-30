<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next';
import type { Crumb } from '../../composables/useBreadcrumb.js';
import Icon from './Icon.vue';

const props = defineProps<{ items: Crumb[] }>();
const emit = defineEmits<{ select: [to: string] }>();
void props;
</script>

<template>
  <nav class="bs-crumbs" aria-label="Breadcrumb">
    <template v-for="(it, i) in items" :key="i">
      <span v-if="i === items.length - 1" class="bs-crumbs__current" aria-current="page">{{ it.label }}</span>
      <template v-else>
        <button type="button" class="bs-crumbs__link" @click="it.to && emit('select', it.to)">{{ it.label }}</button>
        <Icon :icon="ChevronRight" :size="14" />
      </template>
    </template>
  </nav>
</template>
