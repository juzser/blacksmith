<script setup lang="ts">
import { computed } from 'vue';
import type { TimelineEntry } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { roleLabel } from '../lib/roleLabels.js';
import { findingStatusTone, severityTone } from '../lib/taxonomy.js';
import {
  EVENT_KIND_LABEL,
  kindFor,
  metaFor,
  titleFor,
  verdictOutcome,
} from '../lib/timelineDisplay.js';
import Icon from './ds/Icon.vue';
import Lozenge from './ds/Lozenge.vue';

const props = withDefaults(
  defineProps<{
    entry: TimelineEntry;
    hasChildren: boolean;
    expanded: boolean;
    /**
     * False where the row's task is the page the operator is already on, so
     * the title has nowhere to go -- see the `clickable` computed below.
     */
    selectable?: boolean;
  }>(),
  { selectable: true },
);
const emit = defineEmits<{ toggle: []; select: [taskId: string] }>();

// Item 1 of the mock-conformance brief: a text kind tag plus a left colour
// bar, drawn from the `--bs-event-<kind>-text/subtle` tokens, replace the
// old icon+tint pair. k-prompt is the mock's one asymmetric case: its left
// bar uses the *subtle* tone rather than the bold text tone every other
// kind uses, so the bar reads as a tint, not a line (ds-review.html).
const kind = computed(() => kindFor(props.entry));
const kindLabel = computed(() => EVENT_KIND_LABEL[kind.value]);
const kindStyle = computed(() => ({
  background: `var(--bs-event-${kind.value}-subtle)`,
  color: `var(--bs-event-${kind.value}-text)`,
}));
const rowBarColor = computed(() =>
  kind.value === 'prompt' ? `var(--bs-event-prompt-subtle)` : `var(--bs-event-${kind.value}-text)`,
);
const title = computed(() => titleFor(props.entry));
const meta = computed(() => metaFor(props.entry));
const verdict = computed(() => verdictOutcome(props.entry));
const isPrompt = computed(() => kind.value === 'prompt');

const severity = computed(() => {
  const p = props.entry.payload as { severity?: string };
  return p.severity ?? null;
});
const findingStatus = computed(() => {
  const p = props.entry.payload as { finding_status?: string; to_status?: string };
  return (
    p.finding_status ??
    (props.entry.eventType === 'finding-transitioned' ? p.to_status : null) ??
    null
  );
});

// Item 6 of the mock-conformance brief: the mock has no trailing IdentityChip
// on a dispatch row, so the role/model move into the meta line as plain text
// instead (Kanban and Task detail still use the chip; only this row dropped
// it — nothing else in TimelineRow depended on it).
const dispatchAgent = computed(() => {
  if (props.entry.eventType !== 'dispatch_decision') return null;
  const p = props.entry.payload as { agent_role?: string; model_tier?: string };
  if (!p.agent_role) return null;
  return {
    label: p.model_tier ? `${roleLabel(p.agent_role)} · ${p.model_tier}` : roleLabel(p.agent_role),
  };
});

// A title is a button only when clicking it can actually take the operator
// somewhere. Task detail's History tab fetches with `{ task: <this task> }` and
// timeline() filters that column with a strict eq, so every row there names the
// route already on screen: the push was a duplicated navigation vue-router
// discards, under a pointer cursor promising otherwise (D-231).
const clickable = computed(
  () => props.selectable && Boolean(props.entry.taskId) && props.entry.eventType !== 'user_prompt',
);
</script>

<template>
  <div class="timeline-row" :class="{ 'timeline-row--prompt': isPrompt }" :style="{ borderLeftColor: rowBarColor }">
    <button
      v-if="hasChildren"
      type="button"
      class="ds-btn ds-btn--ghost ds-btn--icon-xs"
      :aria-expanded="expanded"
      :aria-controls="`tl-group-${entry.eventId}`"
      :aria-label="expanded ? 'Collapse' : 'Expand'"
      style="margin-top: var(--ds-space-1)"
      @click="emit('toggle')"
    >
      <Icon :name="expanded ? 'chevron-down' : 'chevron-right'" :size="14" />
    </button>
    <span v-else style="width: var(--ds-control-height-sm); flex-shrink: 0" aria-hidden="true" />
    <div class="timeline-row__main">
      <div class="timeline-row__head">
        <span class="timeline-row__ktag" :style="kindStyle">{{ kindLabel }}</span>
        <component
          v-if="!isPrompt"
          :is="clickable ? 'button' : 'span'"
          :type="clickable ? 'button' : undefined"
          class="timeline-row__title"
          :style="clickable ? 'background:transparent;border:0;padding:0;font:inherit;color:inherit;cursor:pointer;text-align:left' : undefined"
          @click="clickable && entry.taskId && emit('select', entry.taskId)"
        >
          {{ title }}
        </component>
        <Lozenge v-if="severity" :tone="severityTone(severity).tone" :variant="severityTone(severity).variant">{{ severity }}</Lozenge>
        <Lozenge v-if="findingStatus" :tone="findingStatusTone(findingStatus)">{{ findingStatus }}</Lozenge>
        <Lozenge v-if="verdict === 'pass'" tone="success">
          <Icon name="circle-check" :size="12" /> Passed
        </Lozenge>
        <Lozenge v-else-if="verdict === 'fail'" tone="danger">
          <Icon name="x" :size="12" /> Failed
        </Lozenge>
        <Lozenge v-else-if="verdict === 'errored'" tone="warning">Did not run</Lozenge>
      </div>
      <!-- The prompt text itself, verbatim, as the mock's k-prompt row quotes it
           (ds-review.html:1380) -- it is this row's whole "title", so it replaces
           the title span above rather than repeating it. -->
      <blockquote v-if="isPrompt" class="timeline-row__prompt">{{ title }}</blockquote>
      <span class="timeline-row__meta" :title="entry.taskId ?? undefined"
        >{{ formatDateTime(entry.ts) }} · {{ meta }}<template v-if="dispatchAgent"> · {{ dispatchAgent.label }}</template></span
      >
    </div>
  </div>
</template>
