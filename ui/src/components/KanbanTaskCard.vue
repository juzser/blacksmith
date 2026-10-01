<script setup lang="ts">
// DS3 pattern 6 (ds-spec.md §2.4/§4.2) — the Kanban board's fixed five-row
// card. A new component rather than an edit to the old `TaskCard.vue`: that
// file is still the only card `RoadmapPage.vue` (DS4) and `TaskDetailPage.vue`
// (DS3 Slice C) render, neither of which is in this slice's claim.
//
// Row 3 (an optional one-line summary per the spec) is omitted outright:
// `KanbanTask` (queries.ts, Slice A) carries no `summary` field at all, so
// there is nothing to render — flagged as a data-gap deviation in the task
// report rather than invented here.
import { computed } from 'vue';
import { Clock, Quote } from '@lucide/vue';
import type { KanbanTask } from '../lib/api.js';
import { cardChips, dependencyChainText, type KanbanGroupBy } from '../lib/kanban.js';
import { roleLabel } from '../lib/roleLabels.js';
import { taskLabel } from '../lib/format.js';
import AgentChip from './AgentChip.vue';
import Icon from './kit/Icon.vue';
import RelativeTime from './kit/RelativeTime.vue';
import Tag from './kit/Tag.vue';
import Tooltip from './kit/Tooltip.vue';

const props = defineProps<{ task: KanbanTask; groupBy: KanbanGroupBy }>();
const emit = defineEmits<{ select: [taskId: string] }>();

const shortId = computed(() => props.task.taskId.split('/').pop() ?? props.task.taskId);
const title = computed(() => taskLabel(props.task.taskId, props.task.title ?? undefined));
const chips = computed(() => cardChips(props.task, props.groupBy));
const showRoleLabel = computed(() => props.groupBy !== 'role' && props.task.agentRole);
const footerDependency = computed(() => dependencyChainText(props.task.dependencies));

function onSelect() {
  emit('select', props.task.taskId);
}
</script>

<template>
  <div
    class="bs-kanban-card"
    role="link"
    tabindex="0"
    :aria-label="`${title}, opens task detail`"
    @click="onSelect"
    @keydown.enter="onSelect"
    @keydown.space.prevent="onSelect"
  >
    <div class="bs-kanban-card__row bs-kanban-card__row--1">
      <span class="bs-kanban-card__id">{{ shortId }}</span>
      <AgentChip :task="{ ...task, updatedAt: task.updatedAt }" />
      <Tooltip v-if="task.hasRequest" mode="describe" :text="task.requestFirstLine ?? 'Linked request'">
        <Icon :icon="Quote" :size="14" label="Has a linked request" />
      </Tooltip>
    </div>

    <p class="bs-kanban-card__title">{{ title }}</p>

    <div v-if="chips.chips.length > 0" class="bs-kanban-card__row bs-kanban-card__chips">
      <Tag v-for="chip in chips.chips" :key="chip.text" :tone="chip.tone ?? 'neutral'" variant="outline" size="sm">
        {{ chip.text }}
      </Tag>
      <span v-if="chips.overflow > 0" class="bs-kanban-card__overflow">+{{ chips.overflow }}</span>
    </div>

    <div class="bs-kanban-card__row bs-kanban-card__row--5">
      <span v-if="showRoleLabel" class="bs-kanban-card__role">{{ roleLabel(task.agentRole as string) }}</span>
      <span class="bs-kanban-card__meta">
        <template v-if="task.attemptCount > 1 || task.judgeRound">
          Attempt {{ task.judgeRound ?? task.attemptCount }}
        </template>
        <template v-else>
          <Icon :icon="Clock" :size="14" />
          <RelativeTime :iso="task.updatedAt" />
        </template>
      </span>
    </div>

    <div v-if="task.dependencies.length > 0 || task.commentCount > 0 || task.prUrl" class="bs-kanban-card__footer">
      <span>{{ footerDependency }}</span>
      <span v-if="task.commentCount > 0">{{ task.commentCount }} comment{{ task.commentCount === 1 ? '' : 's' }}</span>
      <a v-if="task.prUrl" :href="task.prUrl" target="_blank" rel="noopener" @click.stop>Open PR</a>
    </div>
  </div>
</template>

<style scoped>
.bs-kanban-card {
  display: flex;
  flex-direction: column;
  gap: var(--bs-space-2);
  padding: var(--bs-space-3);
  border: 1px solid var(--bs-border);
  border-radius: var(--bs-radius-md, 8px);
  background: var(--bs-surface);
  cursor: pointer;
}

.bs-kanban-card:focus-visible {
  outline: 2px solid var(--bs-focus-ring, currentColor);
  outline-offset: 2px;
}

.bs-kanban-card__row {
  display: flex;
  align-items: center;
  gap: var(--bs-space-2);
}

.bs-kanban-card__id {
  color: var(--bs-text-muted);
  font-size: 0.75rem;
}

.bs-kanban-card__title {
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.bs-kanban-card__chips {
  flex-wrap: wrap;
}

.bs-kanban-card__overflow {
  color: var(--bs-text-muted);
  font-size: 0.75rem;
}

.bs-kanban-card__row--5 {
  justify-content: space-between;
  color: var(--bs-text-muted);
  font-size: 0.75rem;
}

.bs-kanban-card__meta {
  display: inline-flex;
  align-items: center;
  gap: var(--bs-space-1);
}

.bs-kanban-card__footer {
  display: flex;
  flex-direction: column;
  gap: var(--bs-space-1);
  color: var(--bs-text-muted);
  font-size: 0.75rem;
  border-top: 1px solid var(--bs-border);
  padding-top: var(--bs-space-2);
}
</style>
