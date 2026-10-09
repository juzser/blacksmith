<script setup lang="ts">
// DS3 pattern 6 (ds-spec.md §2.4/§4.2) — the Kanban board's fixed five-row
// card. A new component rather than an edit to the old `TaskCard.vue`: that
// file is still the only card `RoadmapPage.vue` (DS4) and `TaskDetailPage.vue`
// (DS3 Slice C) render, neither of which is in this slice's claim.
//
// Row 3 (review round 2, S3 "dead control" fix): `KanbanTask` still carries
// no planner-written `summary` field, but it does carry `requestFirstLine` —
// the same linked-request first line (the row-1 request icon is gone, operator
// fix 2026-10-06) — which reads as a summary-like field per the spec's own
// alternative ("or the planner-written `summary` field once it exists").
// Wired to that rather than removed, gated behind `summaryEnabled` so the
// toolbar's "Show summary" option actually does something again.

import { Clock, Link } from '@lucide/vue';
import { computed, ref } from 'vue';
import { useCopyFeedback } from '../composables/useCopyFeedback.js';
import { useFittedTitle } from '../composables/useFittedTitle.js';
import type { KanbanTask } from '../lib/api.js';
import { copyToClipboard } from '../lib/clipboard.js';
import { boardTitle, parentLabel } from '../lib/format.js';
import {
  agentChip,
  attemptLabel,
  cardChips,
  dependencyChainText,
  hasWaitingDependency,
  type KanbanGroupBy,
} from '../lib/kanban.js';
import {
  markText as markTagText,
  markLabel as markWords,
  type TaskMark,
} from '../lib/liveFocus.js';
import { roleLabel } from '../lib/roleLabels.js';
import { foreignStoreId } from '../lib/storeKey.js';
import AgentChip from './AgentChip.vue';
import KanbanMarkTag from './KanbanMarkTag.vue';
import Icon from './kit/Icon.vue';
import IconButton from './kit/IconButton.vue';
import RelativeTime from './kit/RelativeTime.vue';
import Tag from './kit/Tag.vue';

const props = defineProps<{
  task: KanbanTask;
  groupBy: KanbanGroupBy;
  summaryEnabled?: boolean;
  /** ds-spec.md §3.1 Work/Kanban row — phone cards show only title, one tag, one meta line. */
  compact?: boolean;
  /** A live session's mark: Now replaces the agent chip, Next takes its slot. */
  mark?: TaskMark | null;
  /** "<project> · <epic>", shown beside the time on a marked card when the board is not grouped by epic. */
  caption?: string | null;
}>();
const emit = defineEmits<{ select: [taskId: string, storeId?: string] }>();

const title = computed(() =>
  boardTitle(
    props.task.taskId,
    props.task.title,
    parentLabel(props.task.parentTaskId, props.task.parentTitle),
  ),
);
// Measured two-line fit (shared with the follow-up group): see useFittedTitle.
const titleEl = ref<HTMLElement | null>(null);
const { fitted, titleHead, titleTail } = useFittedTitle(titleEl, title);
const chips = computed(() => cardChips(props.task, props.groupBy));
// Audit finding 5: the meta-row role label duplicated the same role
// AgentChip already shows ("Finding checker" next to "Finding checker ·
// working"). Gate on the same agentChip() AgentChip.vue itself renders from,
// so the label only shows when there is no chip to carry the role.
const chip = computed(() => agentChip(props.task));
const showRoleLabel = computed(
  () => props.groupBy !== 'role' && !!props.task.agentRole && !chip.value,
);
const markText = computed(() =>
  props.mark ? markTagText(props.mark, props.task.agentActivity) : null,
);
const markLabel = computed(() => markWords(props.mark ?? null));
const footerDependency = computed(() => dependencyChainText(props.task.dependencies));
const hasWaiting = computed(() => hasWaitingDependency(props.task.dependencies));
const showSummary = computed(() => !!props.summaryEnabled && !!props.task.requestFirstLine);
const attemptLabelText = computed(() => attemptLabel(props.task));

// Operator fix 2026-10-05: row 1's id text + copy button are gone (the full
// id is unreadable there anyway); a link icon right after the title copies
// it instead. It sits above the open button's overlay, not inside it, so its
// click never reaches the open button and needs no click-stopping.
const copyIdTooltip = computed(() => `${props.task.taskId} (click to copy)`);
const { label: copyIdLabel, flash: flashIdCopied } = useCopyFeedback(copyIdTooltip.value, 'Copied');
async function onCopyTaskId() {
  const ok = await copyToClipboard(props.task.taskId);
  if (!ok) return;
  flashIdCopied();
}

// The open button is an empty overlay covering the whole card, so a click
// anywhere opens it. Focusing it first keeps `closePeek`'s focus return
// working in browsers that do not focus a button on click.
const openEl = ref<HTMLElement | null>(null);
function onSelect() {
  openEl.value?.focus();
  emit('select', props.task.taskId, foreignStoreId(props.task));
}
// The overlay cannot cover what needs hover (the time tooltip, chip and
// dependency titles), so those sit above it. A click that lands on one of them
// reaches the card and opens it like a click on the overlay. Buttons and links
// keep their own click: this skips the overlay's own click (it opens itself, so
// it must not fire twice), copy-id and "Open PR". Mouse only; keyboard users
// use the open button.
function onCardClick(event: MouseEvent) {
  if ((event.target as Element).closest('button, a')) return;
  onSelect();
}
</script>

<template>
  <div class="bs-kanban-card" @click="onCardClick">
    <button
      ref="openEl"
      type="button"
      class="bs-kanban-card__open"
      :aria-label="`${title}${markLabel}, opens task detail`"
      :title="fitted ? title : undefined"
      @click="onSelect"
    ></button>
    <div v-if="!compact && (markText || chip)" class="bs-kanban-card__row bs-kanban-card__row--1">
      <KanbanMarkTag v-if="mark && markText" :mark="mark" :text="markText" />
      <AgentChip v-else :task="{ ...task, updatedAt: task.updatedAt }" />
    </div>

    <p ref="titleEl" class="bs-kanban-card__title">{{ titleHead }}<span class="bs-kanban-card__title-tail">{{ titleTail }}<IconButton
        :icon="Link"
        :label="copyIdLabel"
        size="sm"
        class="bs-kanban-card__title-copy"
        @click="onCopyTaskId"
      /></span></p>

    <p v-if="showSummary && !compact" class="bs-kanban-card__summary">{{ task.requestFirstLine }}</p>

    <div v-if="compact && mark && markText" class="bs-kanban-card__row bs-kanban-card__chips">
      <KanbanMarkTag :mark="mark" :text="markText" />
    </div>
    <div v-else-if="chips.chips.length > 0" class="bs-kanban-card__row bs-kanban-card__chips">
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
      <span v-if="caption && !compact" class="bs-kanban-card__caption">{{ caption }}</span>
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
      v-if="!compact && (hasWaiting || task.commentCount > 0 || task.prUrl)"
      class="bs-kanban-card__footer"
    >
      <span
        v-if="hasWaiting"
        class="bs-kanban-card__footer-dep"
        :title="footerDependency"
        >{{ footerDependency }}</span
      >
      <span v-if="task.commentCount > 0">{{ task.commentCount }} comment{{ task.commentCount === 1 ? '' : 's' }}</span>
      <a v-if="task.prUrl" :href="task.prUrl" target="_blank" rel="noopener">Open PR</a>
    </div>
  </div>
</template>
