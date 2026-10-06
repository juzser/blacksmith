<script setup lang="ts">
// DS4 S2/S3 — EpicBlock. Phase mode (unchanged from S2, now with the "Show
// waves" toggle) and epic mode (new in S3, spec §1): the same `.eblock`
// region, pointed at one epic instead of a whole phase.
import { ChevronDown, ChevronUp, Copy, ExternalLink } from '@lucide/vue';
import { reactive, watch } from 'vue';
import { useCopyFeedback } from '../composables/useCopyFeedback.js';
import { useViewport } from '../composables/useViewport.js';
import type { RequestQuote as RequestQuoteData, StatusCounts } from '../lib/api.js';
import { copyToClipboard } from '../lib/clipboard.js';
import type { PlanVersionOption } from '../lib/planVersion.js';
import { taskCountLabel } from '../lib/roadmapSwimlane.js';
import type { KitTone } from '../lib/taxonomy.js';
import {
  isHttpsUrl,
  mobileEpicStatusLine,
  statusCountsBar,
  type WaveInfo,
} from '../lib/waveList.js';
import IconButton from './kit/IconButton.vue';
import ProgressBar from './kit/ProgressBar.vue';
import ProgressBarMini from './kit/ProgressBarMini.vue';
import ProgressRing from './kit/ProgressRing.vue';
import Select from './kit/Select.vue';
import Skeleton from './kit/Skeleton.vue';
import Tag from './kit/Tag.vue';
import Tooltip from './kit/Tooltip.vue';
import RequestQuote from './RequestQuote.vue';
import WaveList from './WaveList.vue';

const { isPhoneWidth } = useViewport();

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
  /** DS4 S4 R1 — the phase that lists this epic, for the phone back link. */
  phase: { milestoneId: string; name: string } | null;
  /** DS4 S5c §1 — server-computed task counts; falls back to the single
   *  done/total bar below when absent. */
  statusCounts?: StatusCounts;
  /** DS4 S5c §4 — only an https URL renders the "Open ... PR" button. */
  prUrl?: string | null;
  /** DS4 S5c §3 — the "Epic started from" quote; nothing renders when null. */
  sourcePrompt?: RequestQuoteData | null;
}

const props = defineProps<{
  // Phase mode.
  name?: string;
  statusTone?: KitTone;
  statusLabel?: string;
  tasksTotal?: number;
  tasksCompleted?: number;
  epics?: EpicSection[];
  /** DS4 S5c §1 — phase-mode's own stacked bar, same server data. */
  statusCounts?: StatusCounts;
  // Epic mode — set instead of the phase-mode props above.
  epic?: EpicModeData;
  /** Epic id -> "idle 18d", for the idle epics only. */
  idleLabels: Record<string, string>;
}>();

/** DS4 S5c §1 — statusCounts-aware segments/aria-label, falling back to the
 *  existing single done/total bar when the server gives no counts. */
function progressBar(counts: StatusCounts | undefined, completed: number, total: number) {
  if (counts) return statusCountsBar(counts);
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return {
    segments: [{ tone: 'success' as const, value: pct }],
    ariaLabel: `${completed} of ${total} tasks done (${pct}%)`,
  };
}

// DS4 S5c §4 — "Copy epic id" feedback: flips the IconButton's label to
// "Copied" for a beat on success, stays put (no "Copied") on rejection.
// DS4 S5c fix round 1, fix 8 — useCopyFeedback owns the timeout id so it is
// cleared on unmount and before re-arming; the watch below resets the idle
// label (and cancels a pending flash) when the epic id itself changes.
const {
  label: copyLabel,
  flash: flashCopied,
  reset: resetCopyLabel,
} = useCopyFeedback('Copy epic id');
async function onCopyEpicId(epicId: string) {
  const ok = await copyToClipboard(epicId);
  if (!ok) return;
  flashCopied();
}
watch(
  () => props.epic?.epicId,
  () => resetCopyLabel('Copy epic id'),
);
// `selectEpic` (DS4 S4 R6): a phone phase-mode row tap. `backToPhase` (R1):
// the phone epic-mode back link — imperative, not a RouterLink, because the
// page's selected-phase/selected-epic state is local refs that only react
// to a route change at mount, not to later URL edits.
const emit = defineEmits<{
  select: [taskId: string];
  'update:planVersion': [value: string];
  selectEpic: [epicId: string];
  backToPhase: [phaseId: string];
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
    <!-- DS4 S4 R1 — phone back link, above the header, only when the phase
         for this epic is known. -->
    <button
      v-if="isPhoneWidth && epic.phase"
      type="button"
      class="bs-roadmap-mobile__back"
      @click="emit('backToPhase', epic.phase.milestoneId)"
    >
      &larr; {{ epic.phase.name }}
    </button>

    <div class="esec-head">
      <b>{{ epic.epicId }}</b>
      <Tag v-if="idleLabels[epic.epicId]" tone="neutral" variant="outline" size="sm">{{
        idleLabels[epic.epicId]
      }}</Tag>
      <IconButton
        :icon="Copy"
        :label="copyLabel"
        size="sm"
        @click="onCopyEpicId(epic.epicId)"
      />
      <Tooltip v-if="epic.prUrl && isHttpsUrl(epic.prUrl)" mode="describe" text="Open integration PR on GitHub">
        <a
          :href="epic.prUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="bs-iconbtn bs-iconbtn--sm"
          aria-label="Open integration PR on GitHub"
        >
          <ExternalLink :size="16" aria-hidden="true" />
        </a>
      </Tooltip>
      <Tag v-if="epic.project" tone="neutral" variant="outline" size="sm" class="eh-project">{{
        epic.project
      }}</Tag>
      <Tag :tone="epic.statusTone" size="sm">{{ epic.statusLabel }}</Tag>
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
          :segments="progressBar(epic.statusCounts, epic.tasksCompleted, epic.tasksTotal).segments"
          :label="progressBar(epic.statusCounts, epic.tasksCompleted, epic.tasksTotal).ariaLabel"
        />
        <span class="pnum bar-pct">{{ Math.round((epic.tasksCompleted / epic.tasksTotal) * 100) }}%</span>
      </div>
      <RequestQuote v-if="epic.sourcePrompt" :quote="epic.sourcePrompt" />
      <!-- DS4 S4 R3 — epic mode always shows WaveList in compact form on
           phone: past, current and upcoming, one line each. -->
      <WaveList :waves="epic.waves" :compact="isPhoneWidth" @select="emit('select', $event)" />
    </template>
  </div>

  <div v-else class="eblock" role="region" :aria-label="`${name}: goal and epics`">
    <!-- DS4 S4 §1 — phone phase mode: a stacked list, no swimlane, no bar
         chart. Hidden entirely on desktop/tablet. -->
    <template v-if="isPhoneWidth">
      <div class="card-meta">
        {{ name }}
        <Tag :tone="statusTone ?? 'neutral'" size="sm">{{ statusLabel }}</Tag>
      </div>
      <div v-if="(tasksTotal ?? 0) > 0" class="bs-roadmap-mobile__summary">
        <div class="bs-roadmap-mobile__summary-cell">
          <span class="muted small">Tasks done</span>
          <span class="bs-roadmap-mobile__summary-value">{{ tasksCompleted ?? 0 }} of {{ tasksTotal }}</span>
        </div>
        <div class="bs-roadmap-mobile__summary-cell">
          <span class="muted small">Progress</span>
          <ProgressRing
            :value="tasksCompleted ?? 0"
            :max="tasksTotal ?? 1"
            :label="`${name} progress`"
          />
        </div>
      </div>
      <p v-else class="card-sum muted">No tasks tracked</p>

      <ul class="bs-roadmap-mobile__list" role="list">
        <li v-for="sec in epics" :key="sec.epicId" class="bs-roadmap-mobile__item">
          <button type="button" class="bs-roadmap-mobile__row" @click="emit('selectEpic', sec.epicId)">
            <span class="bs-roadmap-mobile__row-id" :title="sec.epicId">{{ sec.epicId }}</span>
            <Tag v-if="idleLabels[sec.epicId]" tone="neutral" variant="outline" size="sm">{{
              idleLabels[sec.epicId]
            }}</Tag>
            <ProgressBarMini
              v-if="sec.tasksTotal"
              :value="sec.tasksCompleted ?? 0"
              :max="sec.tasksTotal"
              tone="success"
              :label="`${sec.epicId}, ${taskCountLabel(sec.tasksTotal, sec.tasksCompleted ?? 0)}`"
            />
            <Tag v-else tone="todo" size="sm">Todo</Tag>
            <span class="bs-roadmap-mobile__row-status muted small">{{ mobileEpicStatusLine(sec) }}</span>
          </button>
          <details v-if="sec.tasksTotal" class="bs-roadmap-mobile__waves" :open="isOpen(sec)">
            <summary>
              Waves of {{ sec.epicId }} &middot; {{ sec.waves.length }}
              <ChevronDown class="bs-roadmap-mobile__chev" :size="16" aria-hidden="true" />
            </summary>
            <div class="bs-roadmap-mobile__waves-body">
              <WaveList
                :waves="sec.waves.filter((w) => w.kind === 'current')"
                compact
                @select="emit('select', $event)"
              />
            </div>
          </details>
        </li>
      </ul>
    </template>

    <template v-else>
      <div class="card-meta">
        {{ name }}
        <Tag :tone="statusTone ?? 'neutral'" size="sm">{{ statusLabel }}</Tag>
      </div>
      <template v-if="(tasksTotal ?? 0) > 0">
        <div class="card-title">{{ taskCountLabel(tasksTotal ?? 0, tasksCompleted ?? 0) }}</div>
        <div class="barrow">
          <ProgressBar
            :segments="progressBar(statusCounts, tasksCompleted ?? 0, tasksTotal ?? 0).segments"
            :label="progressBar(statusCounts, tasksCompleted ?? 0, tasksTotal ?? 0).ariaLabel"
          />
          <span class="pnum bar-pct">{{ Math.round(((tasksCompleted ?? 0) / (tasksTotal ?? 1)) * 100) }}%</span>
        </div>
      </template>
      <p v-else class="card-sum muted">No tasks tracked</p>

      <div v-for="sec in epics" :key="sec.epicId" class="esec">
        <div class="esec-head">
          <b>{{ sec.epicId }}</b>
          <Tag v-if="idleLabels[sec.epicId]" tone="neutral" variant="outline" size="sm">{{
            idleLabels[sec.epicId]
          }}</Tag>
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
    </template>
  </div>
</template>
