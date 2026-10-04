<script setup lang="ts">
import { computed } from 'vue';
import { EVENT_KIND_LABEL, type EventKind } from '../../lib/timelineDisplay.js';

const props = defineProps<{ kind: EventKind }>();

// ds-spec.md §4.3 / ds-review.html `.ktag`: text-only tag on the kind's own
// `--bs-event-<kind>-subtle` background in `--bs-event-<kind>-text`. Same
// "read the tone tokens, don't hardcode a palette" approach as kit/Tag.vue.
const style = computed(() => ({
  background: `var(--bs-event-${props.kind}-subtle)`,
  color: `var(--bs-event-${props.kind}-text)`,
}));

const label = computed(() => EVENT_KIND_LABEL[props.kind]);
</script>

<template>
  <span class="bs-event-kind-tag" :style="style">{{ label }}</span>
</template>
