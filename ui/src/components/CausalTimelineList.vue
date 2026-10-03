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
import {
  buildCausalTree,
  groupByDay,
  nodesOfItem,
  type TimelineNode,
  timelineItems,
  tsForItem,
} from '../lib/timelineDisplay.js';
import TimelineNodeList from './TimelineNodeList.vue';

const props = defineProps<{ entries: TimelineEntry[]; expanded: Set<string> }>();
const emit = defineEmits<{ toggle: [eventId: string]; select: [taskId: string] }>();

const tree = computed<TimelineNode[]>(() => buildCausalTree(props.entries));

// Item 3: day headers over the already-folded top-level list (ds-review.html's
// `.day` + `.feed` pairs). The split runs on the folded TimelineItems, not the
// raw tree, so a dispatch group is one unit for the split — tsForItem reads
// its newest member, and nodesOfItem hands its nodes back to TimelineNodeList
// flat, which re-folds the identical run (same nodes, same order). Nested
// disclosure children never get their own day header; only this top list does.
const dayGroups = computed(() => {
  const items = timelineItems(tree.value, true);
  const withTs = items.map((item) => ({ ts: tsForItem(item), item }));
  return groupByDay(withTs, new Date().toISOString());
});
</script>

<template>
  <template v-for="(group, gi) in dayGroups" :key="gi">
    <!-- One block per day group: the page (`.app-page`) is a flex column
         with a `gap`, which lands between flex children. Wrapping the
         header + its feed keeps that gap between day groups only, so
         `.timeline-day`'s own margin-bottom (not gap + margin) sets the
         `--ds-space-2` gap to its own feed. -->
    <div>
      <div class="timeline-day">{{ group.label }}</div>
      <div class="timeline-feed">
        <TimelineNodeList
          :nodes="group.items.flatMap((g) => nodesOfItem(g.item))"
          :expanded="expanded"
          @toggle="(id) => emit('toggle', id)"
          @select="(id) => emit('select', id)"
        />
      </div>
    </div>
  </template>
</template>
