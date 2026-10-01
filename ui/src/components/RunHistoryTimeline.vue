<script setup lang="ts">
// DS3 §4.7 pattern 2 — the Task detail page's own run history: one row per
// dispatch, judge report, result or error, fed by `GET /api/tasks/:taskId/runs`
// (queries.ts's `taskRuns()`, a scoped read over the existing event-log
// projection — no new event type). Distinct from the History tab's
// `TimelineRow` list, which reads the whole-session timeline() feed instead.
import { CircleAlert, FileCheck, PlayCircle, Send } from '@lucide/vue';
import type { TaskRun } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { roleLabel } from '../lib/roleLabels.js';
import { runOutcomeKitTone } from '../lib/taxonomy.js';
import Icon from './kit/Icon.vue';
import Tag from './kit/Tag.vue';

defineProps<{ runs: TaskRun[] }>();

const ICON_FOR_KIND = {
  dispatch: Send,
  'judge-report': FileCheck,
  result: PlayCircle,
  error: CircleAlert,
} as const;

function label(run: TaskRun): string {
  const parts = [
    run.agentRole ? roleLabel(run.agentRole) : null,
    run.round ? `round ${run.round}` : null,
  ];
  const name = parts.filter(Boolean).join(' · ');
  return name || run.kind;
}

const TOKEN_FORMAT = new Intl.NumberFormat('en-US');
function tokens(run: TaskRun): string | null {
  return run.tokensTotal === null ? null : `${TOKEN_FORMAT.format(run.tokensTotal)} tokens`;
}
</script>

<template>
  <ol v-if="runs.length > 0" class="bs-run-history">
    <li v-for="run in runs" :key="run.eventId" class="bs-run-history__row">
      <span class="bs-run-history__icon" :class="`bs-run-history__icon--${run.kind}`">
        <Icon :icon="ICON_FOR_KIND[run.kind]" :size="14" />
      </span>
      <div class="bs-run-history__main">
        <div class="bs-run-history__head">
          <span class="bs-run-history__label">{{ label(run) }}</span>
          <Tag v-if="run.outcome" :tone="runOutcomeKitTone(run.kind, run.outcome)" variant="subtle" size="sm">{{ run.outcome }}</Tag>
        </div>
        <span class="bs-run-history__meta">
          {{ formatDateTime(run.ts) }}<template v-if="tokens(run)"> · {{ tokens(run) }}</template>
        </span>
      </div>
    </li>
  </ol>
  <p v-else class="bs-run-history__empty">No runs recorded for this task yet.</p>
</template>
