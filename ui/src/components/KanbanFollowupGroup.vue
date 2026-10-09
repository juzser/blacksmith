<script setup lang="ts">
// One stacked Kanban card for the follow-up fixes of a single parent task in
// one column (ds-spec.md Work/Kanban row, "Collapse, don't cram"). Built from
// the board's existing parts: a native <details>/<summary> disclosure, the
// kit Tag, AgentChip, RelativeTime and the card chrome of KanbanTaskCard.
// The open state is owned by KanbanBoard (stored through expandedRows.ts): the
// <details> is driven by `open` and keeps its native toggle (so find-in-page
// can open it); the `toggle` event is forwarded only when the browser changed
// the state, never when it merely echoes the prop.
//
// There is no copy-id icon on the group (it has no single id) and no id text
// anywhere: each fix row carries the small inline copy icon of its own task.

import { ChevronDown, Clock, Link } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { useCopyFeedback } from '../composables/useCopyFeedback.js';
import { useFittedTitle } from '../composables/useFittedTitle.js';
import type { KanbanTask } from '../lib/api.js';
import { copyToClipboard } from '../lib/clipboard.js';
import { boardTitle } from '../lib/format.js';
import { agentChip, titleCase } from '../lib/kanban.js';
import {
  groupMark,
  type LiveMarks,
  markFor,
  markLabel,
  markText,
  orderLive,
  type TaskMark,
} from '../lib/liveFocus.js';
import { foreignStoreId, storeKey } from '../lib/storeKey.js';
import { taskStatusKitTone } from '../lib/taxonomy.js';
import AgentChip from './AgentChip.vue';
import KanbanMarkTag from './KanbanMarkTag.vue';
import Icon from './kit/Icon.vue';
import IconButton from './kit/IconButton.vue';
import RelativeTime from './kit/RelativeTime.vue';
import Tag from './kit/Tag.vue';

/** Rows shown before "Show N more" (ds-spec follow-up group: capped at 5). */
const ROW_CAP = 5;

const props = defineProps<{
  /** Members newest first (groupFollowups' order). */
  members: KanbanTask[];
  /** The parent's readable title, or null when unknown. */
  parentLabel: string | null;
  open: boolean;
  /** The column is a status column: a row's status tag would repeat it. */
  statusInColumn: boolean;
  /** Phone cards keep to title and one meta line. */
  compact?: boolean;
  /** A task a quick-look targets: a row hidden past the cap is revealed for it. */
  revealTaskId?: string | null;
  revealStoreId?: string;
  /** What live sessions work on and do next; a marked fix carries its tag. */
  live?: LiveMarks | null;
  /** The board is not grouped by epic: the marked fix's "<project> · <epic>" shows beside the time. */
  showCaption?: boolean;
}>();
const emit = defineEmits<{
  toggle: [];
  select: [taskId: string, storeId?: string];
}>();

const count = computed(() => props.members.length);
const title = computed(() =>
  props.parentLabel ? `${count.value} fixes · ${props.parentLabel}` : `${count.value} fixes`,
);
const marked = computed(() => groupMark(props.live ?? null, props.members));
const summaryMark = computed(() => marked.value?.mark ?? null);
const summaryText = computed(() =>
  marked.value ? markText(marked.value.mark, marked.value.task.agentActivity) : null,
);
const summaryCaption = computed(() => {
  const label = marked.value?.task.epicLabel;
  return props.showCaption && !props.compact && label ? label.replace(': ', ' · ') : null;
});
const ariaName = computed(() =>
  props.parentLabel
    ? `${count.value} fixes for ${props.parentLabel}${markLabel(summaryMark.value)}, expand/collapse`
    : `${count.value} fixes${markLabel(summaryMark.value)}, expand/collapse`,
);

// Marked fixes lead the rows, so the row cap never hides one.
const orderedMembers = computed(() => orderLive(props.members, props.live ?? null));
function rowMark(task: KanbanTask): TaskMark | null {
  return markFor(props.live ?? null, task);
}

const newest = computed(() => props.members[0]);
const liveMembers = computed(() => props.members.filter((m) => agentChip(m)?.live));
const liveChipTask = computed(() => liveMembers.value[0] ?? null);

const titleEl = ref<HTMLElement | null>(null);
const { fitted, titleHead, titleTail } = useFittedTitle(titleEl, title);

function onToggle(event: Event) {
  if ((event.target as HTMLDetailsElement).open !== props.open) emit('toggle');
}

const showAllRows = ref(false);
watch(
  () => props.revealTaskId,
  (id) => {
    const index = orderedMembers.value.findIndex(
      (m) => m.taskId === id && foreignStoreId(m) === props.revealStoreId,
    );
    if (index >= ROW_CAP) showAllRows.value = true;
  },
  { immediate: true },
);
const rows = computed(() =>
  showAllRows.value ? orderedMembers.value : orderedMembers.value.slice(0, ROW_CAP),
);
const hiddenRows = computed(() => Math.max(0, props.members.length - ROW_CAP));

function rowTitle(task: KanbanTask): string {
  return boardTitle(task.taskId, task.title);
}
function showStatus(): boolean {
  return !props.statusInColumn;
}

// One copy label for the whole group: only the row just copied reads "Copied".
const { label: copiedLabel, flash } = useCopyFeedback('Copy task id', 'Copied');
const copiedTaskId = ref<string | null>(null);
function copyLabel(taskId: string): string {
  return copiedTaskId.value === taskId ? copiedLabel.value : 'Copy task id';
}
async function onCopyTaskId(taskId: string) {
  if (!(await copyToClipboard(taskId))) return;
  copiedTaskId.value = taskId;
  flash();
}

// The row's open button is an empty overlay covering the whole row. Focusing it
// first keeps the board's focus return working in browsers that do not focus
// a button on click.
function onRowSelect(event: MouseEvent, task: KanbanTask) {
  const row = (event.currentTarget as HTMLElement).closest('.bs-kanban-group__row');
  row?.querySelector<HTMLElement>('.bs-kanban-group__row-open')?.focus();
  emit('select', task.taskId, foreignStoreId(task));
}
// The overlay cannot cover what needs hover (the time tooltip and the chip), so
// those sit above it. A click on one of them reaches the row and opens it like a
// click on the overlay. Buttons and links keep their own click: this skips the
// overlay's own click (it opens itself, so it must not fire twice) and copy-id.
// Mouse only; keyboard users use the open button.
function onRowClick(event: MouseEvent, task: KanbanTask) {
  if ((event.target as Element).closest('button, a')) return;
  onRowSelect(event, task);
}
</script>

<template>
  <details class="bs-kanban-group" :open="open" @toggle="onToggle">
    <summary
      class="bs-kanban-group__summary"
      :aria-label="ariaName"
    >
      <span class="bs-kanban-group__head">
        <span ref="titleEl" class="bs-kanban-group__title" :title="fitted ? title : undefined">{{ titleHead }}<span class="bs-kanban-card__title-tail">{{ titleTail }}</span></span>
        <Icon :icon="ChevronDown" :size="16" class="bs-kanban-group__chev" />
      </span>
      <span class="bs-kanban-group__meta">
        <KanbanMarkTag v-if="summaryMark && summaryText" :mark="summaryMark" :text="summaryText" />
        <AgentChip v-else-if="liveChipTask && !compact" :task="liveChipTask" />
        <span v-if="!summaryMark && liveMembers.length > 1 && !compact" class="bs-kanban-card__overflow">+{{ liveMembers.length - 1 }}</span>
        <span v-if="summaryCaption" class="bs-kanban-card__caption">{{ summaryCaption }}</span>
        <span v-if="newest" class="bs-kanban-card__meta">
          <Icon :icon="Clock" :size="14" />
          <RelativeTime :iso="newest.updatedAt" />
        </span>
      </span>
    </summary>
    <ul role="list" class="bs-kanban-group__rows">
      <li v-for="task in rows" :key="storeKey(task, task.taskId)">
        <div class="bs-kanban-group__row" @click="onRowClick($event, task)">
          <button
            type="button"
            class="bs-kanban-group__row-open"
            :aria-label="`${rowTitle(task)}${markLabel(rowMark(task))}, opens task detail`"
            :title="compact ? undefined : rowTitle(task)"
            @click="onRowSelect($event, task)"
          ></button>
          <p class="bs-kanban-group__row-title">
            <span class="bs-kanban-group__row-text">{{ rowTitle(task) }}</span>
            <IconButton
              :icon="Link"
              :label="copyLabel(task.taskId)"
              size="sm"
              class="bs-kanban-card__title-copy"
              @click="onCopyTaskId(task.taskId)"
            />
          </p>
          <span class="bs-kanban-group__row-meta">
            <Tag v-if="showStatus()" :tone="taskStatusKitTone(task.taskStatus)" size="sm">
              {{ titleCase(task.taskStatus) }}
            </Tag>
            <KanbanMarkTag
              v-if="rowMark(task)"
              :mark="rowMark(task) as TaskMark"
              :text="markText(rowMark(task) as TaskMark, task.agentActivity)"
            />
            <AgentChip v-else-if="agentChip(task)?.live" :task="task" />
            <span v-else class="bs-kanban-card__meta">
              <Icon :icon="Clock" :size="14" />
              <RelativeTime :iso="task.updatedAt" />
            </span>
          </span>
        </div>
      </li>
    </ul>
    <button
      v-if="open && hiddenRows > 0"
      type="button"
      class="bs-kanban-col__more bs-kanban-group__more"
      @click="showAllRows = !showAllRows"
    >
      {{ showAllRows ? 'Show fewer' : `Show ${hiddenRows} more` }}
    </button>
  </details>
</template>
