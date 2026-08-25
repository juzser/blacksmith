<script setup lang="ts">
// Tabs (WAI-ARIA Tabs pattern, aria-patterns.md #12) — roving tabindex,
// Left/Right (and Home/End) move focus AND selection between tabs.
export interface TabItem {
  id: string;
  label: string;
}

const props = defineProps<{ modelValue: string; tabs: TabItem[]; ariaLabel: string }>();
const emit = defineEmits<{ 'update:modelValue': [id: string] }>();

function select(id: string) {
  emit('update:modelValue', id);
}

function onKeydown(e: KeyboardEvent) {
  const ids = props.tabs.map((t) => t.id);
  const idx = ids.indexOf(props.modelValue);
  if (idx === -1) return;
  let next = idx;
  if (e.key === 'ArrowRight') next = (idx + 1) % ids.length;
  else if (e.key === 'ArrowLeft') next = (idx - 1 + ids.length) % ids.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = ids.length - 1;
  else return;
  e.preventDefault();
  const nextId = ids[next];
  if (nextId === undefined) return;
  select(nextId);
  const el = document.getElementById(`tab-${nextId}`);
  el?.focus();
}
</script>

<template>
  <div>
    <div class="hds-tabs__list" role="tablist" :aria-label="ariaLabel" @keydown="onKeydown">
      <button
        v-for="tab in tabs"
        :id="`tab-${tab.id}`"
        :key="tab.id"
        type="button"
        role="tab"
        class="hds-tabs__tab"
        :aria-selected="modelValue === tab.id"
        :aria-controls="`panel-${tab.id}`"
        :tabindex="modelValue === tab.id ? 0 : -1"
        @click="select(tab.id)"
      >
        {{ tab.label }}
      </button>
    </div>
    <div
      v-for="tab in tabs"
      v-show="modelValue === tab.id"
      :id="`panel-${tab.id}`"
      :key="tab.id"
      class="hds-tabs__panel"
      role="tabpanel"
      :aria-labelledby="`tab-${tab.id}`"
      tabindex="0"
    >
      <slot :name="tab.id" />
    </div>
  </div>
</template>
