<script setup lang="ts">
// The top bar's Breadcrumb already shows the page name (App.vue, DS1 §3) and
// is the phone title too, so this h1 is a visible duplicate on every page
// that uses this component (ds-spec pages, none of which carry a title that
// differs from their crumb) — kept for screen readers only. SessionsPage and
// TimelinePage use this component, not kit/PageHeader.vue.
import { computed, useSlots } from 'vue';

const props = defineProps<{ title: string; description?: string }>();
const slots = useSlots();

// Fix round 3 (same defect as kit/PageHeader.vue's round 2 fix): with
// nothing visible -- title always sr-only here, no description, no
// status/actions slot -- the `.ds-ph` wrapper div was still an in-flow item
// of the page's flex stack, leaving an empty band above the next row
// (SessionsPage, TimelinePage). Skipping the wrapper markup entirely for
// that case, down to the bare sr-only h1, removes it as a stack item
// altogether.
const isEmpty = computed(() => !props.description && !slots.status && !slots.actions);
</script>

<template>
  <div v-if="!isEmpty" class="ds-ph">
    <div class="ds-ph__left">
      <div class="ds-ph__titlerow">
        <h1 class="ds-ph__title sr-only">{{ title }}</h1>
        <slot name="status" />
      </div>
      <p v-if="description" class="ds-ph__desc">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="ds-ph__actions"><slot name="actions" /></div>
  </div>
  <h1 v-else class="ds-ph__title sr-only">{{ title }}</h1>
</template>
