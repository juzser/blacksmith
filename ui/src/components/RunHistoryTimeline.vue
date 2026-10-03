<script setup lang="ts">
// DS3 §4.7 pattern 2 — the Task detail page's own run history: one row per
// dispatch, judge report, result or error, fed by `GET /api/tasks/:taskId/runs`
// (queries.ts's `taskRuns()`, a scoped read over the existing event-log
// projection — no new event type). Distinct from the History tab's
// `TimelineRow` list, which reads the whole-session timeline() feed instead.
import type { TaskRun } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { roleLabel } from '../lib/roleLabels.js';
import { runOutcomeKitTone } from '../lib/taxonomy.js';
import { EVENT_KIND_LABEL, type EventKind } from '../lib/timelineDisplay.js';
import Tag from './kit/Tag.vue';

defineProps<{ runs: TaskRun[] }>();

// Item 2 of the mock-conformance brief: one row style across the History tab.
// TaskRun's four kinds map onto TimelineRow's nine (kindFor() in
// timelineDisplay.ts) the same way dispatch_decision/judge-verdict/
// task-result-recorded/error-logged do there.
const KIND_FOR_RUN: Record<TaskRun['kind'], EventKind> = {
  dispatch: 'dispatch',
  'judge-report': 'feedback',
  result: 'returned',
  error: 'error',
};

function label(run: TaskRun): string {
  const parts = [
    run.agentRole ? roleLabel(run.agentRole) : null,
    run.round ? `round ${run.round}` : null,
  ];
  const name = parts.filter(Boolean).join(' · ');
  return name || run.kind;
}

function kindStyle(run: TaskRun) {
  const kind = KIND_FOR_RUN[run.kind];
  return {
    background: `var(--bs-event-${kind}-subtle)`,
    color: `var(--bs-event-${kind}-text)`,
  };
}

function rowBarColor(run: TaskRun): string {
  return `var(--bs-event-${KIND_FOR_RUN[run.kind]}-text)`;
}

const TOKEN_FORMAT = new Intl.NumberFormat('en-US');
function tokens(run: TaskRun): string | null {
  return run.tokensTotal === null ? null : `${TOKEN_FORMAT.format(run.tokensTotal)} tokens`;
}
</script>

<template>
  <ol v-if="runs.length > 0" class="bs-run-history timeline-feed">
    <li v-for="run in runs" :key="run.eventId" class="timeline-row" :style="{ borderLeftColor: rowBarColor(run) }">
      <div class="timeline-row__main">
        <div class="timeline-row__head">
          <span class="timeline-row__ktag" :style="kindStyle(run)">{{ EVENT_KIND_LABEL[KIND_FOR_RUN[run.kind]] }}</span>
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
