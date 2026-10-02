<script setup lang="ts">
// The top bar's Breadcrumb already shows the page name (App.vue, DS1 §3) and
// is the phone title too, so this h1 is a visible duplicate on every page
// except where the page's title carries content the crumb doesn't (Task
// detail's task name) — those pages opt in with titleVisible.
import { computed, useSlots } from 'vue';

const props = withDefaults(
  defineProps<{ title: string; description?: string; titleVisible?: boolean }>(),
  { titleVisible: false },
);
const slots = useSlots();

// Fix round 2 (UI audit, work-kanban-desktop-dark.png): with nothing visible
// — title hidden, no description, no status/actions slot — the `.bs-ph`
// wrapper div was still an in-flow item of the page's flex stack. A
// position:absolute h1 (sr-only) takes no space itself, but its still-boxed
// ancestors do, and the stack's `gap` is reserved around them regardless of
// their own height, leaving an empty band above the next row (WorkPage,
// SessionsPage, TimelinePage). Skipping the wrapper markup entirely for that
// case, down to the bare sr-only h1, removes it as a stack item altogether.
const isEmpty = computed(
  () => !props.titleVisible && !props.description && !slots.status && !slots.actions,
);
</script>

<template>
  <div v-if="!isEmpty" class="bs-ph">
    <div class="bs-ph__left">
      <div class="bs-ph__titlerow">
        <h1 class="bs-ph__title" :class="{ 'sr-only': !titleVisible }">{{ title }}</h1>
        <slot name="status" />
      </div>
      <p v-if="description" class="bs-ph__desc">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="bs-ph__actions"><slot name="actions" /></div>
  </div>
  <h1 v-else class="bs-ph__title sr-only">{{ title }}</h1>
</template>
