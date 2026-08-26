<script setup lang="ts">
// Recursive renderer for CausalTimelineList's pre-built tree. Self-references
// via its own filename (Vue 3 <script setup> SFCs support this natively).
//
// Every level is folded through groupDispatches first, so a run of subagent
// dispatches renders as one header row that expands into the run. The fold is
// per level and lives here rather than in buildCausalTree because it is a
// display decision: the tree is the causal fact, this is how much of it fits
// on a screen. Group ids share the one `expanded` Set with row ids — they are
// namespaced (`dispatch-group-…`) so the two can't collide.
import { computed } from 'vue';
import { type TimelineNode, timelineItems } from '../lib/timelineDisplay.js';
import TimelineDispatchGroupRow from './TimelineDispatchGroupRow.vue';
import TimelineRow from './TimelineRow.vue';

const props = withDefaults(
  defineProps<{
    nodes: TimelineNode[];
    expanded: Set<string>;
    depth?: number;
    /** False only for a group's own members — see timelineItems' comment. */
    fold?: boolean;
  }>(),
  { fold: true },
);
const emit = defineEmits<{ toggle: [eventId: string]; select: [taskId: string] }>();

const items = computed(() => timelineItems(props.nodes, props.fold));
</script>

<template>
  <ol style="list-style: none; margin: 0; padding: 0">
    <template
      v-for="item in items"
      :key="item.kind === 'group' ? item.group.id : item.node.entry.eventId"
    >
      <li v-if="item.kind === 'group'">
        <TimelineDispatchGroupRow
          :group="item.group"
          :expanded="expanded.has(item.group.id)"
          @toggle="emit('toggle', item.group.id)"
        />
        <!-- Rendered whether or not it is open, `hidden` while collapsed: the
             chevron above names this id in aria-controls unconditionally, and
             collapsed is precisely when that name is the only thing an
             assistive client has to go on. Behind a v-if the IDREF resolved to
             nothing in the default state of the page (D-227). The recursion
             stays lazy -- an unopened node still renders none of its subtree. -->
        <div
          :id="`tl-group-${item.group.id}`"
          role="group"
          :hidden="!expanded.has(item.group.id)"
          style="padding-left: 1.5rem"
        >
          <TimelineNodeList
            v-if="expanded.has(item.group.id)"
            :nodes="item.group.members"
            :expanded="expanded"
            :depth="(depth ?? 0) + 1"
            :fold="false"
            @toggle="(id) => emit('toggle', id)"
            @select="(id) => emit('select', id)"
          />
        </div>
      </li>
      <li v-else>
        <TimelineRow
          :entry="item.node.entry"
          :has-children="item.node.children.length > 0"
          :expanded="expanded.has(item.node.entry.eventId)"
          @toggle="emit('toggle', item.node.entry.eventId)"
          @select="(id) => emit('select', id)"
        />
        <!-- Same trade as above, and the v-if condition tracks the trigger's:
             TimelineRow only draws a chevron when there are children, so this
             exists exactly when something references it. -->
        <div
          v-if="item.node.children.length > 0"
          :id="`tl-group-${item.node.entry.eventId}`"
          role="group"
          :hidden="!expanded.has(item.node.entry.eventId)"
          style="padding-left: 1.5rem"
        >
          <TimelineNodeList
            v-if="expanded.has(item.node.entry.eventId)"
            :nodes="item.node.children"
            :expanded="expanded"
            :depth="(depth ?? 0) + 1"
            @toggle="(id) => emit('toggle', id)"
            @select="(id) => emit('select', id)"
          />
        </div>
      </li>
    </template>
  </ol>
</template>
