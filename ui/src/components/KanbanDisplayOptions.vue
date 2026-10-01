<script setup lang="ts">
// DS3 pattern 8 (ds-spec.md §2.4b) — the Kanban board's display-options
// control: summary on/off, group-by, and restoring hidden columns. A
// Popover (not a Dialog): this is a low-stakes, non-modal adjustment, the
// same register as a single-step confirm.
import { SlidersHorizontal } from '@lucide/vue';
import type { KanbanGroupBy } from '../lib/kanban.js';
import IconButton from './kit/IconButton.vue';
import Popover from './kit/Popover.vue';
import Select, { type SelectOption } from './kit/Select.vue';

const props = defineProps<{
  open: boolean;
  summary: boolean;
  groupBy: KanbanGroupBy;
  hidden: string[];
}>();
const emit = defineEmits<{
  close: [];
  open: [];
  'update:summary': [boolean];
  'update:groupBy': [KanbanGroupBy];
  restore: [string];
}>();

const GROUP_BY_OPTIONS: SelectOption[] = [
  { value: 'status', label: 'Status' },
  { value: 'project', label: 'Project' },
  { value: 'epic', label: 'Epic' },
  { value: 'role', label: 'Role' },
];

function onGroupByChange(value: string) {
  emit('update:groupBy', value as KanbanGroupBy);
}
</script>

<template>
  <Popover :open="open" label="Kanban display options" @close="emit('close')">
    <template #trigger>
      <IconButton
        :icon="SlidersHorizontal"
        label="Display options"
        @click="open ? emit('close') : emit('open')"
      />
    </template>
    <div class="bs-kanban-display-options">
      <label class="bs-kanban-display-options__row">
        <input
          type="checkbox"
          :checked="summary"
          @change="emit('update:summary', ($event.target as HTMLInputElement).checked)"
        />
        Show summary
      </label>
      <label class="bs-kanban-display-options__row">
        Group by
        <Select
          :model-value="groupBy"
          :options="GROUP_BY_OPTIONS"
          aria-label="Group by"
          @update:model-value="onGroupByChange"
        />
      </label>
      <div v-if="hidden.length > 0" class="bs-kanban-display-options__hidden">
        <p>Hidden columns</p>
        <ul role="list">
          <li v-for="name in hidden" :key="name">
            {{ name }}
            <button type="button" class="bs-kanban-display-options__restore" @click="emit('restore', name)">
              Show
            </button>
          </li>
        </ul>
      </div>
    </div>
  </Popover>
</template>
