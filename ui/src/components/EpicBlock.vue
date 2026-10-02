<script setup lang="ts">
// DS4 S2/S3 — EpicBlock. Phase mode (unchanged from S2, now with the "Show
// waves" toggle) and epic mode (new in S3, spec §1): the same `.eblock`
// region, pointed at one epic instead of a whole phase.
import { ChevronDown, ChevronUp } from '@lucide/vue';
import { reactive } from 'vue';
import type { PlanVersionOption } from '../lib/planVersion.js';
import { taskCountLabel } from '../lib/roadmapSwimlane.js';
import type { KitTone } from '../lib/taxonomy.js';
import type { WaveInfo } from '../lib/waveList.js';
import ProgressBar from './kit/ProgressBar.vue';
import ProgressBarMini from './kit/ProgressBarMini.vue';
import Select from './kit/Select.vue';
import Skeleton from './kit/Skeleton.vue';
import Tag from './kit/Tag.vue';
import WaveList from './WaveList.vue';

export interface EpicSection {
  epicId: string;
  statusTone: KitTone;
  statusLabel: string;
  /** null while that epic's own /api/flow call is in flight. */
  tasksTotal: number | null;
  tasksCompleted: number | null;
  failed?: boolean;
  /** Empty until tasksTotal resolves; feeds the "Show waves" toggle below. */
  waves: WaveInfo[];
}

/** Epic-mode payload (spec §1) — one epic, shown standalone. */
export interface EpicModeData {
  epicId: string;
  statusTone: KitTone;
  statusLabel: string;
  project: string | null;
  planVersionOptions: PlanVersionOption[];
  planVersion: string;
  loading: boolean;
  error: boolean;
  tasksTotal: number;
  tasksCompleted: number;
  waves: WaveInfo[];
}

defineProps<{
  // Phase mode.
  name?: string;
  statusTone?: KitTone;
  statusLabel?: string;
  tasksTotal?: number;
  tasksCompleted?: number;
  epics?: EpicSection[];
  // Epic mode — set instead of the phase-mode props above.
  epic?: EpicModeData;
}>();
const emit = defineEmits<{
  select: [taskId: string];
  'update:planVersion': [value: string];
}>();

// Phase mode's per-epic "Show waves" toggle (spec §2): not persisted to the
// URL, so plain local component state keyed by epicId is enough. Opened by
// default for an In-progress epic, closed for Done/To do, and never shown
// at all for a zero-task epic (`epics` loop below gates the button on that).
const openWaves = reactive<Record<string, boolean>>({});
function isOpen(epic: EpicSection): boolean {
  return openWaves[epic.epicId] ?? epic.statusLabel === 'In progress';
}
function toggle(epic: EpicSection) {
  openWaves[epic.epicId] = !isOpen(epic);
}
</script>

<template>
  <div v-if="epic" class="eblock" role="region" :aria-label="`Epic ${epic.epicId}`">
    <div class="esec-head">
      <b>{{ epic.epicId }}</b>
      <Tag :tone="epic.statusTone" size="sm">{{ epic.statusLabel }}</Tag>
      <Tag v-if="epic.project" tone="neutral" variant="outline" size="sm">{{ epic.project }}</Tag>
      <Select
        class="select-trailing"
        :model-value="epic.planVersion"
        :options="epic.planVersionOptions"
        aria-label="Plan version"
        @update:model-value="emit('update:planVersion', $event)"
      />
    </div>

    <Skeleton v-if="epic.loading" :height="120" />
    <p v-else-if="epic.error" class="card-sum muted">Could not load this epic's tasks.</p>
    <p v-else-if="epic.tasksTotal === 0" class="card-sum muted">No tasks tracked</p>
    <template v-else>
      <div class="card-title">{{ taskCountLabel(epic.tasksTotal, epic.tasksCompleted) }}</div>
      <div class="barrow">
        <ProgressBar
          :segments="[{ tone: 'success', value: Math.round((epic.tasksCompleted / epic.tasksTotal) * 100) }]"
          :label="`${epic.epicId} progress`"
        />
        <span class="pnum bar-pct">{{ Math.round((epic.tasksCompleted / epic.tasksTotal) * 100) }}%</span>
      </div>
      <WaveList :waves="epic.waves" @select="emit('select', $event)" />
    </template>
  </div>

  <div v-else class="eblock" role="region" :aria-label="`${name}: goal and epics`">
    <div class="card-meta">
      {{ name }}
      <Tag :tone="statusTone ?? 'neutral'" size="sm">{{ statusLabel }}</Tag>
    </div>
    <template v-if="(tasksTotal ?? 0) > 0">
      <div class="card-title">{{ taskCountLabel(tasksTotal ?? 0, tasksCompleted ?? 0) }}</div>
      <div class="barrow">
        <ProgressBar
          :segments="[{ tone: 'success', value: Math.round(((tasksCompleted ?? 0) / (tasksTotal ?? 1)) * 100) }]"
          :label="`${name} progress`"
        />
        <span class="pnum bar-pct">{{ Math.round(((tasksCompleted ?? 0) / (tasksTotal ?? 1)) * 100) }}%</span>
      </div>
    </template>
    <p v-else class="card-sum muted">No tasks tracked</p>

    <div v-for="sec in epics" :key="sec.epicId" class="esec">
      <div class="esec-head">
        <b>{{ sec.epicId }}</b>
        <Tag :tone="sec.statusTone" size="sm">{{ sec.statusLabel }}</Tag>
        <template v-if="sec.tasksTotal === null">
          <!-- ds-allow-hardcode: placeholder width for the "N of M tasks done"
               label while loading, not a layout/spacing token (same exception
               as KanbanPage's skeleton column width). -->
          <Skeleton width="140px" :height="14" /><!-- ds-allow-hardcode -->
        </template>
        <template v-else-if="sec.failed">
          <span class="muted small">Could not load this epic's tasks.</span>
        </template>
        <template v-else-if="sec.tasksTotal === 0">
          <span class="muted small">No tasks tracked</span>
        </template>
        <template v-else>
          <span class="muted small">{{ taskCountLabel(sec.tasksTotal, sec.tasksCompleted ?? 0) }}</span>
          <ProgressBarMini
            :value="sec.tasksCompleted ?? 0"
            :max="sec.tasksTotal"
            tone="success"
            :label="`${sec.epicId}, ${taskCountLabel(sec.tasksTotal, sec.tasksCompleted ?? 0)}`"
          />
          <button
            class="linkbtn"
            type="button"
            :aria-expanded="isOpen(sec)"
            :aria-controls="`waves-${sec.epicId}`"
            @click="toggle(sec)"
          >
            {{ isOpen(sec) ? 'Hide waves' : 'Show waves' }}
            <ChevronUp v-if="isOpen(sec)" :size="14" aria-hidden="true" />
            <ChevronDown v-else :size="14" aria-hidden="true" />
          </button>
        </template>
      </div>
      <WaveList
        v-if="sec.tasksTotal && sec.tasksTotal > 0 && isOpen(sec)"
        :id="`waves-${sec.epicId}`"
        :waves="sec.waves"
        @select="emit('select', $event)"
      />
    </div>
  </div>
</template>
