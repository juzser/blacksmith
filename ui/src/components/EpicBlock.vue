<script setup lang="ts">
// DS4 S2 — EpicBlock, phase mode only (signed-off spec §3). Epic mode and the
// WaveList are S3. Header is a Card-like block: phase name + status Tag +
// "N of M tasks done" + a single `done` ProgressBar segment (no stacked
// breakdown until S5). Below it, one section per epic in `epicIds` order:
// name + status Tag + "N of M tasks done" + ProgressBarMini, or a Skeleton
// while that epic's own `/api/flow` call is still in flight, or "No tasks
// tracked" for a zero-task epic (audit item 6 — no bar for it either).

import { taskCountLabel } from '../lib/roadmapSwimlane.js';
import type { KitTone } from '../lib/taxonomy.js';
import ProgressBar from './kit/ProgressBar.vue';
import ProgressBarMini from './kit/ProgressBarMini.vue';
import Skeleton from './kit/Skeleton.vue';
import Tag from './kit/Tag.vue';

export interface EpicSection {
  epicId: string;
  statusTone: KitTone;
  statusLabel: string;
  /** null while that epic's own /api/flow call is in flight. */
  tasksTotal: number | null;
  tasksCompleted: number | null;
  failed?: boolean;
}

defineProps<{
  name: string;
  statusTone: KitTone;
  statusLabel: string;
  tasksTotal: number;
  tasksCompleted: number;
  epics: EpicSection[];
}>();
</script>

<template>
  <div class="eblock" role="region" :aria-label="`${name}: goal and epics`">
    <div class="card-meta">
      {{ name }}
      <Tag :tone="statusTone" size="sm">{{ statusLabel }}</Tag>
    </div>
    <template v-if="tasksTotal > 0">
      <div class="card-title">{{ taskCountLabel(tasksTotal, tasksCompleted) }}</div>
      <div class="barrow">
        <ProgressBar
          :segments="[{ tone: 'success', value: Math.round((tasksCompleted / tasksTotal) * 100) }]"
          :label="`${name} progress`"
        />
        <span class="pnum bar-pct">{{ Math.round((tasksCompleted / tasksTotal) * 100) }}%</span>
      </div>
    </template>
    <p v-else class="card-sum muted">No tasks tracked</p>

    <div v-for="epic in epics" :key="epic.epicId" class="esec">
      <div class="esec-head">
        <b>{{ epic.epicId }}</b>
        <Tag :tone="epic.statusTone" size="sm">{{ epic.statusLabel }}</Tag>
        <template v-if="epic.tasksTotal === null">
          <!-- ds-allow-hardcode: placeholder width for the "N of M tasks done"
               label while loading, not a layout/spacing token (same exception
               as KanbanPage's skeleton column width). -->
          <Skeleton width="140px" :height="14" /><!-- ds-allow-hardcode -->
        </template>
        <template v-else-if="epic.failed">
          <span class="muted small">Could not load this epic's tasks.</span>
        </template>
        <template v-else-if="epic.tasksTotal === 0">
          <span class="muted small">No tasks tracked</span>
        </template>
        <template v-else>
          <span class="muted small">{{ taskCountLabel(epic.tasksTotal, epic.tasksCompleted ?? 0) }}</span>
          <ProgressBarMini
            :value="epic.tasksCompleted ?? 0"
            :max="epic.tasksTotal"
            tone="success"
            :label="`${epic.epicId}, ${taskCountLabel(epic.tasksTotal, epic.tasksCompleted ?? 0)}`"
          />
        </template>
      </div>
    </div>
  </div>
</template>
