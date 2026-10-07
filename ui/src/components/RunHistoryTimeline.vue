<script setup lang="ts">
// DS3 §4.7 pattern 2 — the Task detail page's own run history: one row per
// dispatch, judge report, result or error, fed by `GET /api/tasks/:taskId/runs`
// (queries.ts's `taskRuns()`, a scoped read over the existing event-log
// projection — no new event type).
//
// DS6 PR3 r3 (ds-spec.md §2.2/§4.7): every entry renders through the shared
// kit `TimelineRow` in its `rail` variant, so this list and the History tab's
// event-level feed below it share one row look (ds-spec.md §4.7: "the
// existing event-level detail ... still renders below that, now as
// supporting detail rather than the tab's only content" — both are spec'd,
// not a duplicate to remove). `TaskRun` carries no `eventType`/`payload`, so
// it cannot drive `TimelineRow`'s own `titleFor`/`metaFor`; this component
// keeps computing its own label/meta text and passes it through as an
// override, same as it always has.
import { ref } from 'vue';
import type { TaskRun } from '../lib/api.js';
import { toggleExpanded } from '../lib/expandedRows.js';
import { formatCompactNumber } from '../lib/format.js';
import { roleLabel } from '../lib/roleLabels.js';
import { type KitTone, runOutcomeKitTone } from '../lib/taxonomy.js';
import { type ActivityEntry, EVENT_KIND_LABEL, type EventKind } from '../lib/timelineDisplay.js';
import TimelineRow from './kit/TimelineRow.vue';

defineProps<{ runs: TaskRun[] }>();

// Item 2 of the mock-conformance brief: one row style across the History tab.
// TaskRun's five kinds map onto TimelineRow's nine (kindFor() in
// timelineDisplay.ts) the same way dispatch_decision/judge-verdict/
// task-result-recorded/error-logged do there.
const KIND_FOR_RUN: Record<TaskRun['kind'], EventKind> = {
  dispatch: 'dispatch',
  'judge-report': 'feedback',
  'judge-verdict': 'feedback',
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

/** `TimelineRow` reads the kind off `entry.kind` as `EVENT_KIND_LABEL`'s
 * PascalCase string (kindFor(), timelineDisplay.ts) rather than `eventType` —
 * `TaskRun` has neither, so this is the one field the synthetic entry needs. */
function entryFor(run: TaskRun): ActivityEntry {
  return {
    eventId: run.eventId,
    ts: run.ts,
    eventType: run.kind,
    taskId: null,
    agentId: null,
    planVersion: 0,
    causalParent: null,
    payload: {},
    project: null,
    actor: null,
    kind: EVENT_KIND_LABEL[KIND_FOR_RUN[run.kind]],
  };
}

function tokens(run: TaskRun): string {
  return run.tokensTotal === null ? '' : `${formatCompactNumber(run.tokensTotal)} tokens`;
}

function outcomeTag(run: TaskRun): { tone: KitTone; label: string } | null {
  if (run.outcome === null) return null;
  return { tone: runOutcomeKitTone(run.kind, run.outcome), label: run.outcome };
}

const expanded = ref<Set<string>>(new Set());
function onToggle(eventId: string) {
  expanded.value = toggleExpanded(expanded.value, eventId);
}
</script>

<template>
  <ol v-if="runs.length > 0" class="bs-run-history timeline-feed" role="list">
    <TimelineRow
      v-for="run in runs"
      :key="run.eventId"
      :entry="entryFor(run)"
      :expanded="expanded.has(run.eventId)"
      :linkable="false"
      variant="rail"
      :title-override="label(run)"
      :meta-override="tokens(run)"
      :tag="outcomeTag(run)"
      @toggle="onToggle"
    />
  </ol>
  <p v-else class="bs-run-history__empty">No runs recorded for this task yet.</p>
</template>
