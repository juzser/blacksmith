<script setup lang="ts">
// Gap component (design-spec.md §6.2.1): the kit's Timeline primitive is a
// flat dated list with no expand/collapse. This layers the WAI-ARIA
// Disclosure pattern on RowList/Timeline row anatomy — chevron Button
// toggling aria-expanded/aria-controls, indented children in role="group".
// Builds the causal-parent tree ONCE here; TimelineNodeList.vue renders the
// already-built Node[] recursively (kept separate so recursion never
// re-derives parent/child relationships from a narrowing entries subset).
// The build itself lives in lib/timelineDisplay.ts so it can be unit-tested —
// ui/tsconfig.json doesn't type-check .vue files and there's no component-test
// harness, so tree shape asserted from an SFC is untestable in this repo.
import { computed } from 'vue';
import type { TimelineEntry } from '../lib/api.js';
import { buildCausalTree, type TimelineNode } from '../lib/timelineDisplay.js';
import TimelineNodeList from './TimelineNodeList.vue';

const props = defineProps<{ entries: TimelineEntry[]; expanded: Set<string> }>();
const emit = defineEmits<{ toggle: [eventId: string]; select: [taskId: string] }>();

const tree = computed<TimelineNode[]>(() => buildCausalTree(props.entries));
</script>

<template>
  <TimelineNodeList
    :nodes="tree"
    :expanded="expanded"
    @toggle="(id) => emit('toggle', id)"
    @select="(id) => emit('select', id)"
  />
</template>
