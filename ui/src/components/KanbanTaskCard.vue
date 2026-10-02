<script setup lang="ts">
// DS3 pattern 6 (ds-spec.md §2.4/§4.2) — the Kanban board's fixed five-row
// card. A new component rather than an edit to the old `TaskCard.vue`: that
// file is still the only card `RoadmapPage.vue` (DS4) and `TaskDetailPage.vue`
// (DS3 Slice C) render, neither of which is in this slice's claim.
//
// Row 3 (review round 2, S3 "dead control" fix): `KanbanTask` still carries
// no planner-written `summary` field, but it does carry `requestFirstLine` —
// the same linked-request first line already shown in the row-1 Quote
// tooltip — which reads as a summary-like field per the spec's own
// alternative ("or the planner-written `summary` field once it exists").
// Wired to that rather than removed, gated behind `summaryEnabled` so the
// toolbar's "Show summary" option actually does something again.

import { Clock, Quote } from '@lucide/vue';
import { computed } from 'vue';
import type { KanbanTask } from '../lib/api.js';
import { shortTaskId, taskLabel } from '../lib/format.js';
import {
  agentChip,
  attemptLabel,
  cardChips,
  dependencyChainText,
  isInteractiveDescendant,
  type KanbanGroupBy,
} from '../lib/kanban.js';
import { roleLabel } from '../lib/roleLabels.js';
import AgentChip from './AgentChip.vue';
import Icon from './kit/Icon.vue';
import RelativeTime from './kit/RelativeTime.vue';
import Tag from './kit/Tag.vue';
import Tooltip from './kit/Tooltip.vue';

const props = defineProps<{
  task: KanbanTask;
  groupBy: KanbanGroupBy;
  summaryEnabled?: boolean;
  /** ds-spec.md §3.1 Work/Kanban row — phone cards show only title, one tag, one meta line. */
  compact?: boolean;
}>();
const emit = defineEmits<{ select: [taskId: string] }>();

const shortId = computed(() => shortTaskId(props.task.taskId));
const title = computed(() => taskLabel(props.task.taskId, props.task.title ?? undefined));
const chips = computed(() => cardChips(props.task, props.groupBy));
// Audit finding 5: the meta-row role label duplicated the same role
// AgentChip already shows ("Finding checker" next to "Finding checker ·
// working"). Gate on the same agentChip() AgentChip.vue itself renders from,
// so the label only shows when there is no chip to carry the role.
const chip = computed(() => agentChip(props.task));
const showRoleLabel = computed(
  () => props.groupBy !== 'role' && !!props.task.agentRole && !chip.value,
);
const footerDependency = computed(() => dependencyChainText(props.task.dependencies));
const showSummary = computed(() => !!props.summaryEnabled && !!props.task.requestFirstLine);
const attemptLabelText = computed(() => attemptLabel(props.task));

function onSelect() {
  emit('select', props.task.taskId);
}

// S2 review fix: ignore Enter/Space that started on a focusable descendant
// (the footer's "Open PR" link today, any future focusable child tomorrow)
// so it keeps its own native keyboard behaviour instead of the card
// hijacking the keystroke to select/open itself.
function onKeydown(event: KeyboardEvent) {
  if (isInteractiveDescendant(event.target as HTMLElement | null, event.currentTarget)) return;
  if (event.key === 'Enter') {
    onSelect();
  } else if (event.key === ' ') {
    event.preventDefault();
    onSelect();
  }
}
</script>

<template>
  <div
    class="bs-kanban-card"
    role="link"
    tabindex="0"
    :aria-label="`${title}, opens task detail`"
    @click="onSelect"
    @keydown="onKeydown"
  >
    <div v-if="!compact" class="bs-kanban-card__row bs-kanban-card__row--1">
      <span class="bs-kanban-card__id">{{ shortId }}</span>
      <AgentChip :task="{ ...task, updatedAt: task.updatedAt }" />
      <Tooltip v-if="task.hasRequest" mode="describe" :text="task.requestFirstLine ?? 'Linked request'">
        <Icon :icon="Quote" :size="14" label="Has a linked request" />
      </Tooltip>
    </div>

    <p class="bs-kanban-card__title">{{ title }}</p>

    <p v-if="showSummary && !compact" class="bs-kanban-card__summary">{{ task.requestFirstLine }}</p>

    <div v-if="chips.chips.length > 0" class="bs-kanban-card__row bs-kanban-card__chips">
      <Tag
        v-for="cardChip in chips.chips.slice(0, compact ? 1 : 2)"
        :key="cardChip.text"
        :tone="cardChip.tone ?? 'neutral'"
        size="sm"
      >
        {{ cardChip.text }}
      </Tag>
      <span v-if="!compact && chips.overflow > 0" class="bs-kanban-card__overflow">+{{ chips.overflow }}</span>
    </div>

    <div class="bs-kanban-card__row bs-kanban-card__row--5">
      <span v-if="showRoleLabel && !compact" class="bs-kanban-card__role">{{ roleLabel(task.agentRole as string) }}</span>
      <span class="bs-kanban-card__meta">
        <template v-if="attemptLabelText">
          {{ attemptLabelText }}
        </template>
        <template v-else>
          <Icon :icon="Clock" :size="14" />
          <RelativeTime :iso="task.updatedAt" />
        </template>
      </span>
    </div>

    <div
      v-if="!compact && (task.dependencies.length > 0 || task.commentCount > 0 || task.prUrl)"
      class="bs-kanban-card__footer"
    >
      <span>{{ footerDependency }}</span>
      <span v-if="task.commentCount > 0">{{ task.commentCount }} comment{{ task.commentCount === 1 ? '' : 's' }}</span>
      <a v-if="task.prUrl" :href="task.prUrl" target="_blank" rel="noopener" @click.stop>Open PR</a>
    </div>
  </div>
</template>
