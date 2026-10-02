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
import { useViewport } from '../composables/useViewport.js';
import type { KanbanTask } from '../lib/api.js';
import { KANBAN_VIRTUALIZE_THRESHOLD } from '../lib/constants.js';
import {
  capColumn,
  columnTone,
  defaultMobileColumnKey,
  type GroupableTask,
  groupByKanban,
  isDoneStatus,
  isInteractiveDescendant,
  type KanbanGroupBy,
} from '../lib/kanban.js';
import {
  DEFAULT_KANBAN_DISPLAY_OPTIONS,
  type KanbanDisplayOptionsStorage,
  loadKanbanDisplayOptions,
  saveKanbanDisplayOptions,
} from '../lib/kanbanDisplayOptions.js';
import KanbanDisplayOptions from './KanbanDisplayOptions.vue';
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

const props = withDefaults(defineProps<{ tasks: KanbanTask[]; showAll?: boolean }>(), {
  showAll: false,
});
const emit = defineEmits<{ select: [taskId: string] }>();

const { isPhoneWidth } = useViewport();

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
function persist() {
  if (browserStorage) saveKanbanDisplayOptions(browserStorage, options.value);
}

const optionsOpen = ref(false);
function setGroupBy(groupBy: KanbanGroupBy) {
  options.value = { ...options.value, groupBy };
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
  groupByKanban(props.tasks as GroupableTask[], options.value.groupBy, props.showAll).filter(
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
    const active = col.tasks.filter((t) => !isDoneStatus(t.taskStatus));
    const done = col.tasks.filter((t) => isDoneStatus(t.taskStatus));
    const showDone = expandedDone.value[col.key] ?? false;
    const visible = showDone ? [...active, ...done] : active;
    // A simple windowed slice rather than a scroll-driven virtualizer: past
    // KANBAN_VIRTUALIZE_THRESHOLD the column reuses the same capColumn()/
    // "view more" control the rest of the board already has, so a very
    // large column stays DOM-light without a second rendering strategy.
    const windowed = visible.length > KANBAN_VIRTUALIZE_THRESHOLD;
    const page = capColumn(visible, revealed.value[col.key] ?? 0);
    return { ...col, done, showDone, windowed, ...page, total: visible.length };
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
// drag-and-drop. Cards are plain focusable elements (KanbanTaskCard sets its
// own tabindex); this only moves focus between them and opens/closes the
// peek panel. Escape restores focus to the card that opened the panel.
const boardEl = ref<HTMLElement | null>(null);
const peekTaskId = ref<string | null>(null);
let lastFocusedCard: HTMLElement | null = null;

function cardEls(): HTMLElement[] {
  if (!boardEl.value) return [];
  return Array.from(boardEl.value.querySelectorAll<HTMLElement>('.bs-kanban-card'));
}

function openPeek(taskId: string, trigger: HTMLElement | null) {
  lastFocusedCard = trigger;
  peekTaskId.value = taskId;
}
function onCardSelect(taskId: string) {
  // ds-spec.md §3.1 Work/Kanban row: tapping a card on phone opens the task
  // page directly — no card menu, copy id or quick-look peek panel there.
  if (isPhoneWidth.value) {
    emit('select', taskId);
    return;
  }
  openPeek(taskId, document.activeElement as HTMLElement | null);
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

function onCardKeydown(event: KeyboardEvent, taskId: string) {
  // S2 review fix: a keydown that started on a focusable descendant (e.g.
  // the footer's "Open PR" link) must keep its own native behaviour instead
  // of being swallowed by the card's own Enter/Space/arrow handling.
  if (isInteractiveDescendant(event.target as HTMLElement | null, event.currentTarget)) return;
  const current = event.target as HTMLElement;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openPeek(taskId, current);
    return;
  }
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const cards = cardEls();
  const index = cards.indexOf(current);
  if (index === -1 || cards.length === 0) return;
  // Up/Down and Left/Right both step through the same flat, DOM-order list
  // of cards: with cards laid out column-by-column this already reads as
  // "down the column" for Up/Down and "across columns" for Left/Right
  // without a 2D grid model.
  const step = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1;
  const next = cards[(index + step + cards.length) % cards.length];
  next?.focus();
}

function onBoardKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && peekTaskId.value) closePeek();
}

async function focusFirstCard() {
  await nextTick();
  cardEls()[0]?.focus();
}
defineExpose({ focusFirstCard });
</script>

<template>
  <div ref="boardEl" class="bs-kanban-board" @keydown="onBoardKeydown">
    <div v-if="!isPhoneWidth" class="bs-kanban-board__toolbar">
      <KanbanDisplayOptions
        :open="optionsOpen"
        :summary="options.summary"
        :group-by="options.groupBy"
        :hidden="options.hidden"
        @open="optionsOpen = true"
        @close="optionsOpen = false"
        @update:summary="setSummary"
        @update:group-by="setGroupBy"
        @restore="restoreColumn"
      />
    </div>
    <!-- ds-spec.md §3.1 Work/Kanban row: the display-options trigger moves
         into the MobileTopBar overflow menu on phone, via the same Teleport
         mechanism the kit's own overlay components already use. -->
    <Teleport v-if="isPhoneWidth" to="#bs-mtopbar-overflow-extra">
      <KanbanDisplayOptions
        as-menu-item
        :open="optionsOpen"
        :summary="options.summary"
        :group-by="options.groupBy"
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
            :is="TONE_ICON[columnTone(options.groupBy, col.key)]"
            :size="16"
            :stroke-width="1.75"
            class="bs-kanban-col__icon"
            :style="{ color: `var(--bs-tone-${columnTone(options.groupBy, col.key)}-text)` }"
            aria-hidden="true"
          />
          <h3 class="bs-kanban-col__title">{{ col.label }}</h3>
          <Tag class="bs-kanban-col__count" tone="neutral" variant="outline" size="sm">{{ col.total }}</Tag>
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
          <li v-for="task in col.visible" :key="task.taskId">
            <KanbanTaskCard
              :task="task"
              :group-by="options.groupBy"
              :summary-enabled="options.summary"
              :compact="isPhoneWidth"
              @select="onCardSelect"
              @keydown="onCardKeydown($event, task.taskId)"
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
    <TaskPeekPanel v-if="peekTaskId" :task-id="peekTaskId" @close="closePeek" @open-full="(id) => emit('select', id)" />
  </div>
</template>
