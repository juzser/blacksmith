<script setup lang="ts">
// DS4 S3 §2 — one task card inside the current wave's WaveList. A `<button>`
// (not a `role=link` div like KanbanTaskCard): FlowNode lacks the Kanban card
// fields (dependencies, chips, comment count, PR url), so this is a smaller,
// purpose-built card rather than a reuse of KanbanTaskCard.
import { computed } from 'vue';
import { shortTaskId, shortTaskName } from '../lib/format.js';
import { titleCase } from '../lib/kanban.js';
import { type LiveMarks, markFor, markLabel, markText } from '../lib/liveFocus.js';
import { taskStatusKitTone } from '../lib/taxonomy.js';
import type { WaveTaskInfo } from '../lib/waveList.js';
import AgentChip from './AgentChip.vue';
import KanbanMarkTag from './KanbanMarkTag.vue';
import Tag from './kit/Tag.vue';

// `marks` are the live sessions' Now / Next marks; `storeId` names the store
// the wave's epic lives in, since a task id repeats between stores.
const props = defineProps<{ task: WaveTaskInfo; marks?: LiveMarks | null; storeId?: string }>();
const emit = defineEmits<{ select: [taskId: string] }>();

const shortId = computed(() => shortTaskId(props.task.taskId));
// Named from `taskTitle`, never `task.title`: on a flow node that is the task's whole objective.
const title = computed(() => shortTaskName(props.task.taskId, props.task.taskTitle));
// The objective is the hover text, as on the Kanban card; absent when there is none.
const objective = computed(() => props.task.title?.trim() || undefined);
// A bare id ("task-2") humanizes to the very name shown beside it: show one.
const showId = computed(
  () => shortId.value.replace(/-/g, ' ').toLowerCase() !== title.value.toLowerCase(),
);
const mark = computed(() =>
  markFor(props.marks ?? null, {
    store: props.storeId ? { id: props.storeId, label: props.storeId } : undefined,
    taskId: props.task.taskId,
    taskStatus: props.task.taskStatus,
  }),
);

// AgentChip needs an AgentChipLike + updatedAt. FlowNode carries no model
// tier or updatedAt, and `workingAgentRole` already means "live within the
// 4h window" (api.ts's own comment on the field), so the chip always reads
// as `working` here — `agentActivity: 'stalled'` (the only state that reads
// `updatedAt`) never applies, so the placeholder timestamp is never used.
const agentChipTask = computed(() =>
  props.task.workingAgentRole
    ? {
        taskStatus: props.task.taskStatus,
        agentRole: props.task.workingAgentRole,
        agentModelTier: null,
        agentActivity: 'working' as const,
        updatedAt: new Date(0).toISOString(),
      }
    : null,
);
</script>

<template>
  <button
    type="button"
    class="wave-task-card"
    :aria-label="`${title}${markLabel(mark)}, opens task detail`"
    :title="objective"
    @click="emit('select', task.taskId)"
  >
    <span v-if="showId" class="bs-kanban-card__id">{{ shortId }}</span>
    <span class="wave-task-card__title">{{ title }}</span>
    <Tag :tone="taskStatusKitTone(task.taskStatus)" size="sm">{{ titleCase(task.taskStatus) }}</Tag>
    <KanbanMarkTag v-if="mark" :mark="mark" :text="markText(mark, null)" />
    <AgentChip v-else-if="agentChipTask" :task="agentChipTask" />
    <p v-if="task.dependencyLine" class="wave-task-card__dep muted">{{ task.dependencyLine }}</p>
  </button>
</template>
