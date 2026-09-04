<script setup lang="ts">
// Gap component (design-spec.md §6.2.2): built from Card-style column wells
// (bg-surface-sunken) inside a labelled lane, horizontal scroll, no drag
// (read-only, click-to-navigate). Milestone lanes are §5.3's PROVISIONAL
// piece (no kanban-by-milestone query exists — see this file's sibling
// TaskCard.vue comment) — 6a renders one lane for the selected epic.
//
// Operator directive (Phase 10): "cap each column at ten tasks, with a view
// more after that -- avoid having to scroll a very long way." The cap and the
// remainder are
// lib/kanban.ts's capColumn() so they are unit-tested under the node
// environment; this file only paints the control and holds which columns the
// reader has expanded.
import { computed, ref, watch } from 'vue';
import type { KanbanColumn } from '../lib/api.js';
import { capColumn, foldIntoColumns, subStatusSummary } from '../lib/kanban.js';
import Button from './ds/Button.vue';
import TaskCard from './TaskCard.vue';

const props = withDefaults(
  defineProps<{ columns: KanbanColumn[]; showAll?: boolean; laneLabel?: string }>(),
  {
    showAll: false,
    laneLabel: 'Tasks',
  },
);
const emit = defineEmits<{ select: [taskId: string] }>();

const flatTasks = computed(() => props.columns.flatMap((c) => c.tasks));
const folded = computed(() => foldIntoColumns(flatTasks.value, props.showAll));

/**
 * Extra pages revealed, per column name. Reset whenever the payload changes:
 * "show 30 of 212 Completed" is an answer about one epic or one project, and
 * carrying it across a switch would silently apply it to a different board.
 */
const revealed = ref<Record<string, number>>({});
watch(
  () => props.columns,
  () => {
    revealed.value = {};
  },
);

const capped = computed(() =>
  folded.value.map((col) => {
    const slice = capColumn(col.tasks, revealed.value[col.name] ?? 0);
    // `tasks` stays whole. Everything the column SAYS about itself -- the
    // count, the sub-status breakdown -- describes the column; only `visible`
    // describes the draw. A breakdown taken from the slice would sum to ten
    // beside a header reading two hundred (D-242).
    return { ...col, total: col.tasks.length, ...slice };
  }),
);

function revealMore(name: string) {
  revealed.value = { ...revealed.value, [name]: (revealed.value[name] ?? 0) + 1 };
}

function collapse(name: string) {
  const { [name]: _dropped, ...rest } = revealed.value;
  revealed.value = rest;
}
</script>

<template>
  <div class="kanban-board">
    <section class="kanban-lane" :aria-label="`${laneLabel} lane`">
      <h3 class="ds-sh__t">{{ laneLabel }}</h3>
      <div class="kanban-lane__columns">
        <div v-for="col in capped" :key="col.name" class="kanban-col">
          <div class="kanban-col__head">
            <!-- The header still counts the whole column. The cap changes how
                 much is drawn, never how much there is. -->
            <h4 class="ds-card__title">{{ col.name }}</h4>
            <span class="kanban-col__count">{{ col.total }}</span>
          </div>
          <div v-if="subStatusSummary(col.tasks)" class="kanban-col__substatus">
            {{ subStatusSummary(col.tasks) }}
          </div>
          <ul role="list" class="kanban-col__list">
            <li v-for="task in col.visible" :key="task.taskId" role="listitem">
              <TaskCard :task="task" @select="(id) => emit('select', id)" />
            </li>
          </ul>
          <!-- aria-label carries the column name because the visible label
               cannot: five "View more" buttons on one board are five
               identical entries in a screen reader's element list. -->
          <Button
            v-if="col.hidden > 0"
            class="kanban-col__more"
            variant="ghost"
            size="sm"
            :aria-label="`View ${col.nextStep} more of the ${col.hidden} remaining ${col.name} tasks`"
            @click="revealMore(col.name)"
          >
            View {{ col.nextStep }} more ({{ col.hidden }} left)
          </Button>
          <Button
            v-else-if="(revealed[col.name] ?? 0) > 0"
            class="kanban-col__more"
            variant="ghost"
            size="sm"
            :aria-label="`Collapse the ${col.name} column back to its first page`"
            @click="collapse(col.name)"
          >
            Show less
          </Button>
        </div>
      </div>
    </section>
  </div>
</template>
