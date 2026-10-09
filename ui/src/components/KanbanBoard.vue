<script setup lang="ts">
// DS3 patterns 7 + 9 (ds-spec.md §2.4/§4.2) — the Kanban board: switchable
// group-by, hidden-columns control, per-column virtualization past
// KANBAN_VIRTUALIZE_THRESHOLD, and arrow-key/Space/Enter/Escape card
// navigation. No drag-and-drop — a deliberate omission (§2.4b pattern 9),
// not an oversight: the board is read-only, click/keyboard-to-navigate.
import {
  Ban,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleX,
  Ellipsis,
  Eye,
  Loader,
  TriangleAlert,
} from '@lucide/vue';
import { computed, nextTick, ref, watch } from 'vue';
import { useProjectContext } from '../composables/useProjectContext.js';
import { useViewport } from '../composables/useViewport.js';
import type { KanbanTask } from '../lib/api.js';
import { KANBAN_VIRTUALIZE_THRESHOLD } from '../lib/constants.js';
import { loadExpanded, saveExpanded, toggleExpanded } from '../lib/expandedRows.js';
import { parentLabel } from '../lib/format.js';
import {
  capColumn,
  columnTone,
  defaultMobileColumnKey,
  findGroupMember,
  type GroupableTask,
  groupByKanban,
  groupFollowups,
  isDoneStatus,
  type KanbanGroupBy,
} from '../lib/kanban.js';
import {
  DEFAULT_KANBAN_DISPLAY_OPTIONS,
  hasSavedKanbanDisplayOptions,
  type KanbanDisplayOptionsStorage,
  loadKanbanDisplayOptions,
  saveKanbanDisplayOptions,
} from '../lib/kanbanDisplayOptions.js';
import { type LiveMarks, markFor, orderLive } from '../lib/liveFocus.js';
import KanbanDisplayOptions from './KanbanDisplayOptions.vue';
import KanbanFollowupGroup from './KanbanFollowupGroup.vue';
import KanbanTaskCard from './KanbanTaskCard.vue';
import IconButton from './kit/IconButton.vue';
import Popover from './kit/Popover.vue';
import Tag from './kit/Tag.vue';
import TaskPeekPanel from './TaskPeekPanel.vue';

// ds-spec.md §2.2 KanbanBoard row — one decorative Lucide icon per column
// tone (§2.2's "status icon ... coloured by the column's tone"). The tone
// itself is columnTone() (lib/kanban.js), kept testable without a DOM.
const TONE_ICON = {
  done: CircleCheck,
  review: Eye,
  progress: Loader,
  todo: Circle,
  blocked: Ban,
  danger: CircleX,
  warning: TriangleAlert,
  neutral: CircleDashed,
} as const;

const props = withDefaults(
  defineProps<{
    tasks: KanbanTask[];
    showAll?: boolean;
    /** What live sessions work on and do next; null marks nothing. */
    live?: LiveMarks | null;
    /** Group by to use until the operator saves their own. */
    defaultGroupBy?: KanbanGroupBy | null;
  }>(),
  { showAll: false, live: null, defaultGroupBy: null },
);
const emit = defineEmits<{ select: [taskId: string, storeId?: string] }>();

const { isPhoneWidth } = useViewport();
const { project } = useProjectContext();

// Which follow-up groups are open, per browser tab (sessionStorage, via
// expandedRows.ts). Keyed `{column}:{parentTaskId}`, never by position, so it
// survives the polling refresh; a group that falls under two members renders
// as a plain card and its stored flag is simply never read.
const groupScope = computed(() => `kanban-groups:${project.value ?? 'all'}`);
const browserSession: Storage | null =
  typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
const openGroups = ref<Set<string>>(
  browserSession ? loadExpanded(browserSession, groupScope.value) : new Set(),
);
watch(groupScope, (scope) => {
  openGroups.value = browserSession ? loadExpanded(browserSession, scope) : new Set();
});
function toggleGroup(key: string) {
  openGroups.value = toggleExpanded(openGroups.value, key);
  if (browserSession) saveExpanded(browserSession, groupScope.value, openGroups.value);
}

// `localStorage` is only ever reached through this one guarded accessor so a
// SSR/private-browsing/no-storage environment degrades to the hardcoded
// default rather than throwing — the storage module itself is already
// try/catch-guarded (pattern 8); the browser-only global lives here, behind
// an availability check, so unit tests never need a DOM for this file.
const browserStorage: KanbanDisplayOptionsStorage | null =
  typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;

const options = ref(
  browserStorage ? loadKanbanDisplayOptions(browserStorage) : DEFAULT_KANBAN_DISPLAY_OPTIONS,
);
const groupBySaved = ref(browserStorage ? hasSavedKanbanDisplayOptions(browserStorage) : false);
// A saved Group by wins; otherwise the page's default (if any) applies.
const groupBy = computed<KanbanGroupBy>(() =>
  groupBySaved.value ? options.value.groupBy : (props.defaultGroupBy ?? options.value.groupBy),
);
function persist() {
  if (browserStorage) saveKanbanDisplayOptions(browserStorage, options.value);
}

const optionsOpen = ref(false);
function setGroupBy(value: KanbanGroupBy) {
  options.value = { ...options.value, groupBy: value };
  groupBySaved.value = true;
  persist();
}
function setSummary(summary: boolean) {
  options.value = { ...options.value, summary };
  persist();
}
function hideColumn(key: string) {
  if (options.value.hidden.includes(key)) return;
  options.value = { ...options.value, hidden: [...options.value.hidden, key] };
  persist();
}
function restoreColumn(key: string) {
  options.value = { ...options.value, hidden: options.value.hidden.filter((h) => h !== key) };
  persist();
}

// One column menu open at a time (ds-spec.md §2.2's "a column menu behind a
// sm IconButton Ellipsis 'Column menu'"), same Popover-as-menu pattern
// KanbanDisplayOptions already uses for its own trigger+panel.
const openColumnMenu = ref<string | null>(null);
function toggleColumnMenu(key: string) {
  openColumnMenu.value = openColumnMenu.value === key ? null : key;
}
function hideColumnFromMenu(key: string) {
  hideColumn(key);
  openColumnMenu.value = null;
}

const grouped = computed(() =>
  groupByKanban(props.tasks as GroupableTask[], groupBy.value, props.showAll).filter(
    (col) => !options.value.hidden.includes(col.key),
  ),
);

/** Finished tasks collapse behind a "show" toggle in every column (§4.2), whatever the grouping. */
const expandedDone = ref<Record<string, boolean>>({});
function toggleDone(key: string) {
  expandedDone.value = { ...expandedDone.value, [key]: !expandedDone.value[key] };
}

const revealed = ref<Record<string, number>>({});
function revealMore(key: string) {
  revealed.value = { ...revealed.value, [key]: (revealed.value[key] ?? 0) + 1 };
}

const columns = computed(() =>
  grouped.value.map((col) => {
    // Marked cards lead the column, before the done split and the cap below.
    const ordered = props.live ? orderLive(col.tasks, props.live) : col.tasks;
    const active = ordered.filter((t) => !isDoneStatus(t.taskStatus));
    const done = ordered.filter((t) => isDoneStatus(t.taskStatus));
    const showDone = expandedDone.value[col.key] ?? false;
    // Follow-ups of one parent stack into a single item; the stack counts as
    // one toward the cap below, while `total` stays the task count.
    const visibleTasks = showDone ? [...active, ...done] : active;
    const visible = groupFollowups(visibleTasks, col.key);
    // A simple windowed slice rather than a scroll-driven virtualizer: past
    // KANBAN_VIRTUALIZE_THRESHOLD the column reuses the same capColumn()/
    // "view more" control the rest of the board already has, so a very
    // large column stays DOM-light without a second rendering strategy.
    const windowed = visibleTasks.length > KANBAN_VIRTUALIZE_THRESHOLD;
    const page = capColumn(visible, revealed.value[col.key] ?? 0);
    // `items` is the uncapped grouped list: a quick-look target may sit past the page.
    return {
      ...col,
      done,
      showDone,
      windowed,
      items: visible,
      ...page,
      total: visibleTasks.length,
    };
  }),
);

// ds-spec.md §3.1 Work/Kanban row — phone width shows one column at a time,
// picked by a tab row, defaulting to the first non-empty column. Desktop
// keeps every column, unchanged.
const mobileActiveKey = ref<string | null>(null);
watch(
  columns,
  (cols) => {
    if (cols.some((c) => c.key === mobileActiveKey.value)) return;
    mobileActiveKey.value = defaultMobileColumnKey(cols);
  },
  { immediate: true },
);
// v-show rather than filtering the list: swapping which section is mounted
// tore down/rebuilt every card in the outgoing column on every tab click,
// which crashed on an emit reaching an already-unmounted KanbanTaskCard
// instance. Toggling display: none leaves every column mounted, so a click
// only flips the attribute — no teardown, no crash.
function isColumnVisible(key: string): boolean {
  return !isPhoneWidth.value || key === mobileActiveKey.value;
}
function selectMobileTab(key: string) {
  mobileActiveKey.value = key;
}
function onMobileTabKeydown(event: KeyboardEvent) {
  const keys = columns.value.map((c) => c.key);
  const idx = keys.indexOf(mobileActiveKey.value ?? '');
  if (idx === -1) return;
  let next = idx;
  if (event.key === 'ArrowRight') next = (idx + 1) % keys.length;
  else if (event.key === 'ArrowLeft') next = (idx - 1 + keys.length) % keys.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = keys.length - 1;
  else return;
  event.preventDefault();
  const nextKey = keys[next];
  if (nextKey === undefined) return;
  mobileActiveKey.value = nextKey;
  document.getElementById(`bs-kanban-tab-${nextKey}`)?.focus();
}

// Pattern 9 — arrow-key card navigation + Space/Enter/Escape, no
// drag-and-drop. A card's stop is its native open button (KanbanTaskCard); this
// only moves focus between those and closes the peek panel. Escape restores
// focus to the open button that opened the panel.
const boardEl = ref<HTMLElement | null>(null);
const peekTaskId = ref<string | null>(null);
// The store a foreign card's task lives in; undefined for the served store.
const peekStoreId = ref<string | undefined>(undefined);
// Spec 1.4: a quick-look that targets a fix opens the group holding it. Only
// the peek changing triggers this, so closing the group afterwards sticks.
watch([peekTaskId, peekStoreId], ([id, storeId]) => {
  for (const col of columns.value) {
    const hit = findGroupMember(col.items, id, storeId);
    if (hit && !openGroups.value.has(hit.key)) toggleGroup(hit.key);
  }
});
let lastFocusedCard: HTMLElement | null = null;

function cardEls(): HTMLElement[] {
  if (!boardEl.value) return [];
  // A follow-up group is one stop (its summary) plus, once open, each fix row:
  // the rows of a closed group stay in the DOM but cannot take focus.
  return Array.from(
    boardEl.value.querySelectorAll<HTMLElement>(
      '.bs-kanban-card__open, .bs-kanban-group__summary, .bs-kanban-group[open] .bs-kanban-group__row-open',
    ),
  );
}

function openPeek(taskId: string, storeId: string | undefined, trigger: HTMLElement | null) {
  lastFocusedCard = trigger;
  peekStoreId.value = storeId;
  peekTaskId.value = taskId;
}
function onCardSelect(taskId: string, storeId?: string) {
  // ds-spec.md §3.1 Work/Kanban row: tapping a card on phone opens the task
  // page directly — no card menu, copy id or quick-look peek panel there.
  if (isPhoneWidth.value) {
    emit('select', taskId, storeId);
    return;
  }
  openPeek(taskId, storeId, document.activeElement as HTMLElement | null);
}
async function closePeek() {
  const card = lastFocusedCard;
  peekTaskId.value = null;
  // TaskPeekPanel's Dialog is always mounted already-open (`:open="true"`,
  // gated by this `v-if` instead), so `useModalFocus`'s own close branch
  // never runs for it — its `useInertBackground().release()` only fires
  // from `onBeforeUnmount` once Vue actually unmounts the Dialog, which
  // happens on the next render flush, not synchronously here. Focusing the
  // card before that flush lands on a still-`inert` `#app` and silently
  // fails (inert subtrees refuse focus), leaving focus on <body> once the
  // unmount runs moments later (found via e2e). Awaiting a tick lets that
  // flush — and the inert release — happen first.
  await nextTick();
  card?.focus();
}

function moveFocus(event: KeyboardEvent, current: HTMLElement) {
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  const cards = cardEls();
  const index = cards.indexOf(current);
  if (index === -1 || cards.length === 0) return;
  event.preventDefault();
  // Up/Down and Left/Right both step through the same flat, DOM-order list
  // of cards: with cards laid out column-by-column this already reads as
  // "down the column" for Up/Down and "across columns" for Left/Right
  // without a 2D grid model.
  const step = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1;
  const next = cards[(index + step + cards.length) % cards.length];
  next?.focus();
}
// Enter/Space are native on every stop (a card's open button, a fix row's open
// button, a group summary's toggle), so a keydown here only ever means arrows.
// moveFocus ignores a target that is not one of the stops (a copy-id button,
// the "Open PR" link), which keep their own keys.
function onNavKeydown(event: KeyboardEvent) {
  moveFocus(event, event.target as HTMLElement);
}

function onBoardKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && peekTaskId.value) closePeek();
}

async function focusFirstCard() {
  await nextTick();
  cardEls()[0]?.focus();
}
defineExpose({ focusFirstCard });

// "<project> · <epic>" for a marked card on a board not grouped by epic.
function captionFor(task: KanbanTask): string | null {
  if (!props.live || !markFor(props.live, task) || !task.epicLabel) return null;
  return task.epicLabel.replace(': ', ' · ');
}
</script>

<template>
  <div ref="boardEl" class="bs-kanban-board" @keydown="onBoardKeydown">
    <!-- The display-options trigger has no row of its own: it teleports into
         whichever toolbar owns this width — KanbanPage's page toolbar on
         desktop (sharing a row with the Epic select and Refresh, per the
         ds-review.html Work/Kanban desktop frame), the MobileTopBar overflow
         menu on phone (`as-menu-item`, the same Teleport mechanism the kit's
         own overlay components already use). KanbanBoard keeps owning the
         display-options state either way — only the mount point moves. -->
    <Teleport :to="isPhoneWidth ? '#bs-mtopbar-overflow-extra' : '#bs-kanban-page-toolbar-extra'">
      <KanbanDisplayOptions
        :as-menu-item="isPhoneWidth"
        :open="optionsOpen"
        :summary="options.summary"
        :group-by="groupBy"
        :hidden="options.hidden"
        @open="optionsOpen = true"
        @close="optionsOpen = false"
        @update:summary="setSummary"
        @update:group-by="setGroupBy"
        @restore="restoreColumn"
      />
    </Teleport>
    <div
      v-if="isPhoneWidth"
      role="tablist"
      class="bs-kanban-tabs"
      aria-label="Kanban columns"
      @keydown="onMobileTabKeydown"
    >
      <button
        v-for="col in columns"
        :id="`bs-kanban-tab-${col.key}`"
        :key="col.key"
        type="button"
        role="tab"
        class="bs-kanban-tabs__tab"
        :aria-selected="mobileActiveKey === col.key"
        :aria-controls="`bs-kanban-panel-${col.key}`"
        :tabindex="mobileActiveKey === col.key ? 0 : -1"
        @click="selectMobileTab(col.key)"
      >
        {{ col.label }} ({{ col.total }})
      </button>
    </div>
    <div class="bs-kanban-board__columns">
      <section
        v-for="col in columns"
        v-show="isColumnVisible(col.key)"
        :id="`bs-kanban-panel-${col.key}`"
        :key="col.key"
        class="bs-kanban-col"
        :aria-label="`${col.label} column`"
        :role="isPhoneWidth && mobileActiveKey === col.key ? 'tabpanel' : undefined"
        :aria-labelledby="isPhoneWidth && mobileActiveKey === col.key ? `bs-kanban-tab-${col.key}` : undefined"
      >
        <div v-if="!isPhoneWidth" class="bs-kanban-col__head">
          <component
            :is="TONE_ICON[columnTone(groupBy, col.key)]"
            :size="16"
            :stroke-width="1.75"
            class="bs-kanban-col__icon"
            :style="{ color: `var(--bs-tone-${columnTone(groupBy, col.key)}-text)` }"
            aria-hidden="true"
          />
          <h3 class="bs-kanban-col__title">{{ col.label }}</h3>
          <Tag class="bs-kanban-col__count" tone="neutral" variant="subtle" size="sm">{{ col.total }}</Tag>
          <Popover
            :open="openColumnMenu === col.key"
            :label="`${col.label} column menu`"
            @close="openColumnMenu = null"
          >
            <template #trigger>
              <IconButton
                :icon="Ellipsis"
                label="Column menu"
                size="sm"
                @click="toggleColumnMenu(col.key)"
              />
            </template>
            <button type="button" class="bs-kanban-col__hide" @click="hideColumnFromMenu(col.key)">
              Hide column
            </button>
          </Popover>
        </div>
        <p v-if="col.total === 0" class="bs-kanban-col__empty">No tasks in {{ col.label }}.</p>
        <ul role="list" class="bs-kanban-col__list">
          <li v-for="item in col.visible" :key="item.key">
            <KanbanFollowupGroup
              v-if="item.kind === 'group'"
              :members="item.members"
              :parent-label="parentLabel(item.parentTaskId, item.parentTitle)"
              :open="openGroups.has(item.key)"
              :status-in-column="groupBy === 'status' && !showAll"
              :compact="isPhoneWidth"
              :reveal-task-id="peekTaskId"
              :reveal-store-id="peekStoreId"
              @toggle="toggleGroup(item.key)"
              @select="onCardSelect"
              @keydown="onNavKeydown"
            />
            <KanbanTaskCard
              v-else
              :task="item.task"
              :group-by="groupBy"
              :summary-enabled="options.summary"
              :mark="live ? markFor(live, item.task) : null"
              :caption="live && groupBy !== 'epic' ? captionFor(item.task) : null"
              :compact="isPhoneWidth"
              @select="onCardSelect"
              @keydown="onNavKeydown"
            />
          </li>
        </ul>
        <button v-if="col.hidden > 0" type="button" class="bs-kanban-col__more" @click="revealMore(col.key)">
          View {{ col.nextStep }} more ({{ col.hidden }} left)
        </button>
        <button
          v-if="col.done.length > 0 && !col.showDone"
          type="button"
          class="bs-kanban-col__more"
          @click="toggleDone(col.key)"
        >
          Show {{ col.done.length }} completed
        </button>
        <button
          v-else-if="col.done.length > 0 && col.showDone"
          type="button"
          class="bs-kanban-col__more"
          @click="toggleDone(col.key)"
        >
          Hide completed
        </button>
      </section>
    </div>
    <TaskPeekPanel
      v-if="peekTaskId"
      :task-id="peekTaskId"
      :store-id="peekStoreId"
      @close="closePeek"
      @open-full="(id) => emit('select', id, peekStoreId)"
    />
  </div>
</template>
