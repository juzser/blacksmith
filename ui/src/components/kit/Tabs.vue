<script setup lang="ts">
// Tabs (WAI-ARIA Tabs pattern) — roving tabindex, Left/Right (and Home/End)
// move focus AND selection between tabs.
import { nextTick, ref, watch } from 'vue';
import { nextRovingTabId } from '../../lib/rovingTabs.js';

export interface TabItem {
  id: string;
  label: string;
  /** DS8 PR2: Lessons' "Pending review (0)" / "Closed (28)" tabs. */
  count?: number;
}

const props = defineProps<{ modelValue: string; tabs: TabItem[]; ariaLabel: string }>();
const emit = defineEmits<{ 'update:modelValue': [id: string] }>();

const list = ref<HTMLElement | null>(null);

// A selection changed from outside must not leave the strip scrolled past it.
// Only the list's own scrollLeft moves: scrollIntoView would scroll every
// scrollable ancestor too, jumping the page when the strip is off-screen.
watch(
  () => props.modelValue,
  async (id) => {
    await nextTick();
    const box = list.value;
    const tab = document.getElementById(`tab-${id}`);
    if (!box || !tab) return;
    const b = box.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    if (t.left < b.left) box.scrollLeft += t.left - b.left;
    else if (t.right > b.right) box.scrollLeft += t.right - b.right;
  },
);

function select(id: string) {
  emit('update:modelValue', id);
}

function onKeydown(e: KeyboardEvent) {
  const ids = props.tabs.map((t) => t.id);
  const nextId = nextRovingTabId(e, ids, props.modelValue);
  if (nextId === null) return;
  select(nextId);
  const el = document.getElementById(`tab-${nextId}`);
  el?.focus();
}
</script>

<template>
  <div>
    <div ref="list" class="bs-tabs__list" role="tablist" :aria-label="ariaLabel" @keydown="onKeydown">
      <button
        v-for="tab in tabs"
        :id="`tab-${tab.id}`"
        :key="tab.id"
        type="button"
        role="tab"
        class="bs-tabs__tab"
        :aria-selected="modelValue === tab.id"
        :aria-controls="`panel-${tab.id}`"
        :tabindex="modelValue === tab.id ? 0 : -1"
        @click="select(tab.id)"
      >
        {{ tab.label }}
        <span v-if="tab.count !== undefined" class="bs-tabs__count">{{ tab.count }}</span>
      </button>
    </div>
    <div
      v-for="tab in tabs"
      v-show="modelValue === tab.id"
      :id="`panel-${tab.id}`"
      :key="tab.id"
      class="bs-tabs__panel"
      role="tabpanel"
      :aria-labelledby="`tab-${tab.id}`"
      tabindex="0"
    >
      <slot :name="tab.id" />
    </div>
  </div>
</template>
