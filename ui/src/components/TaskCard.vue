<script setup lang="ts">
// Kanban TaskCard (design-spec.md §5.3, operator directive 1 cleanup pass
// Phase 6b, extended by operator directive 2 in round 3): title + task_id
// (mono caption) + AT MOST 3 chips — severity (colour Lozenge) keeps
// priority whenever an open finding exists; the current/last dispatched
// agent's "role · model-tier" (IdentityChip, colour-accented per role, round
// 3 directive 2) fills the next slot when the task has ever been dispatched;
// case (outline pill) fills the last slot if there's still room. kanban()
// now returns title/agentRole/agentModelTier/milestoneId (closes the 6a
// DESIGN.md deviation — those fields were previously unavailable from the
// API at all).
import { computed } from 'vue';
import type { KanbanTask } from '../lib/api.js';
import { severityTone } from '../lib/taxonomy.js';
import Lozenge from './ds/Lozenge.vue';
import IdentityChip from './IdentityChip.vue';

const props = defineProps<{ task: KanbanTask }>();
const emit = defineEmits<{ select: [taskId: string] }>();

const sev = computed(() =>
  props.task.tags.severity ? severityTone(props.task.tags.severity) : null,
);
const agentLabel = computed(() =>
  props.task.agentRole
    ? `${props.task.agentRole}${props.task.agentModelTier ? ` · ${props.task.agentModelTier}` : ''}`
    : null,
);
// Cap at 3 total chips: severity (priority) > agent·model > case.
const showCase = computed(() => (sev.value && agentLabel.value ? null : props.task.tags.case));
</script>

<template>
  <div
    class="kanban-card"
    role="link"
    tabindex="0"
    :aria-label="`${task.title ?? task.taskId}, ${task.taskStatus}, opens task detail`"
    @click="emit('select', task.taskId)"
    @keydown.enter="emit('select', task.taskId)"
  >
    <span v-if="task.title" class="kanban-card__title">{{ task.title }}</span>
    <span class="kanban-card__id">{{ task.taskId }}</span>
    <div class="kanban-card__chips">
      <Lozenge v-if="sev" :tone="sev.tone" :variant="sev.variant">{{ task.tags.severity }}</Lozenge>
      <IdentityChip v-if="agentLabel" :id="task.agentRole ?? ''" :label="agentLabel" />
      <Lozenge v-if="showCase" variant="outline">{{ showCase }}</Lozenge>
    </div>
  </div>
</template>
