<script setup lang="ts">
import type { TableColumn } from './types.js';

withDefaults(
  defineProps<{
    columns: TableColumn[];
    rows: Array<Record<string, unknown>>;
    rowKey?: string;
    empty?: string;
    clickable?: boolean;
    bordered?: boolean;
    /**
     * Tightens cell padding (bs-primitives.css's .bs-table--compact).
     * ds-spec.md §2.3 line 449 folds Row/RowList's density switch into
     * Table itself ("two components doing one job") — this prop is that
     * absorption, not a new density concept of its own.
     */
    compact?: boolean;
  }>(),
  { rowKey: 'id', empty: 'No results.', clickable: false, bordered: true, compact: false },
);
const emit = defineEmits<{ rowClick: [row: Record<string, unknown>] }>();
</script>

<template>
  <div :class="bordered ? 'bs-tablewrap' : undefined">
    <table class="bs-table" :class="{ 'bs-table--compact': compact }">
      <thead>
        <tr>
          <th
            v-for="c in columns"
            :key="c.key"
            :data-numeric="c.numeric || undefined"
            :style="c.width ? { width: c.width } : undefined"
          >
            {{ c.label }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="rows.length === 0">
          <td class="bs-table__empty" :colspan="columns.length">{{ empty }}</td>
        </tr>
        <tr
          v-for="row in rows"
          :key="String(row[rowKey])"
          :data-clickable="clickable || undefined"
          :tabindex="clickable ? 0 : undefined"
          @click="clickable && emit('rowClick', row)"
          @keydown.enter="clickable && emit('rowClick', row)"
        >
          <td v-for="c in columns" :key="c.key" :data-numeric="c.numeric || undefined">
            <slot name="cell" :column="c" :row="row">{{ row[c.key] }}</slot>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
