<script setup lang="ts">
// DS4 S3 §2 — one task card inside the current wave's WaveList. A `<button>`
// (not a `role=link` div like KanbanTaskCard): FlowNode lacks the Kanban card
// fields (dependencies, chips, comment count, PR url), so this is a smaller,
// purpose-built card rather than a reuse of KanbanTaskCard.
import { computed } from 'vue';
import { shortTaskId, taskLabel } from '../lib/format.js';
import { titleCase } from '../lib/kanban.js';
import { taskStatusKitTone } from '../lib/taxonomy.js';
import type { WaveTaskInfo } from '../lib/waveList.js';
import AgentChip from './AgentChip.vue';
import Tag from './kit/Tag.vue';

const props = defineProps<{ task: WaveTaskInfo }>();
const emit = defineEmits<{ select: [taskId: string] }>();

const shortId = computed(() => shortTaskId(props.task.taskId));
const title = computed(() => taskLabel(props.task.taskId, props.task.title ?? undefined));

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
  <button type="button" class="wave-task-card" @click="emit('select', task.taskId)">
    <span class="bs-kanban-card__id">{{ shortId }}</span>
    <span class="wave-task-card__title">{{ title }}</span>
    <Tag :tone="taskStatusKitTone(task.taskStatus)" size="sm">{{ titleCase(task.taskStatus) }}</Tag>
    <AgentChip v-if="agentChipTask" :task="agentChipTask" />
    <p v-if="task.dependencyLine" class="wave-task-card__dep muted">{{ task.dependencyLine }}</p>
  </button>
</template>
