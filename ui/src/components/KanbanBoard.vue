<script setup lang="ts">
// Gap component (design-spec.md §6.2.2): built from Card-style column wells
// (bg-surface-sunken) inside a labelled lane, horizontal scroll, no drag
// (read-only, click-to-navigate). Milestone lanes are §5.3's PROVISIONAL
// piece (no kanban-by-milestone query exists — see this file's sibling
// TaskCard.vue comment) — 6a renders one lane for the selected epic.
import { computed } from 'vue';
import type { KanbanColumn } from '../lib/api.js';
import { foldIntoColumns, subStatusSummary } from '../lib/kanban.js';
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
</script>

<template>
  <div class="kanban-board">
    <section class="kanban-lane" :aria-label="`${laneLabel} lane`">
      <h3 class="ds-sh__t">{{ laneLabel }}</h3>
      <div class="kanban-lane__columns">
        <div v-for="col in folded" :key="col.name" class="kanban-col">
          <div class="kanban-col__head">
            <h4 class="ds-card__title">{{ col.name }}</h4>
            <span class="kanban-col__count">{{ col.tasks.length }}</span>
          </div>
          <div v-if="subStatusSummary(col.tasks)" class="kanban-col__substatus">
            {{ subStatusSummary(col.tasks) }}
          </div>
          <ul role="list" class="kanban-col__list">
            <li v-for="task in col.tasks" :key="task.taskId" role="listitem">
              <TaskCard :task="task" @select="(id) => emit('select', id)" />
            </li>
          </ul>
        </div>
      </div>
    </section>
  </div>
</template>
