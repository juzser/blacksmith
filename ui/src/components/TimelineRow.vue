<script setup lang="ts">
import { computed } from 'vue';
import type { TimelineEntry } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { findingStatusTone, severityTone } from '../lib/taxonomy.js';
import { iconFor, metaFor, tintFor, titleFor } from '../lib/timelineDisplay.js';
import Icon from './hds/Icon.vue';
import Lozenge from './hds/Lozenge.vue';
import IdentityChip from './IdentityChip.vue';

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

const TINT_STYLE: Record<string, { bg: string; fg: string }> = {
  blue: { bg: 'var(--ds-tint-blue)', fg: 'var(--ds-tint-blue-text)' },
  slate: { bg: 'var(--ds-tint-slate)', fg: 'var(--ds-tint-slate-text)' },
  lilac: { bg: 'var(--ds-tint-lilac)', fg: 'var(--ds-tint-lilac-text)' },
};

const icon = computed(() => iconFor(props.entry));
const tint = computed(() => TINT_STYLE[tintFor(props.entry)] ?? TINT_STYLE.blue);
const title = computed(() => titleFor(props.entry));
const meta = computed(() => metaFor(props.entry));

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

// Operator directive 5 (Phase 6b round 3): dispatch_decision is the one
// Timeline event type carrying an agent role/model tier — same combined
// "role · tier" IdentityChip as Kanban (directive 2) and Task detail.
const dispatchAgent = computed(() => {
  if (props.entry.eventType !== 'dispatch_decision') return null;
  const p = props.entry.payload as { agent_role?: string; model_tier?: string };
  if (!p.agent_role) return null;
  return {
    role: p.agent_role,
    label: p.model_tier ? `${p.agent_role} · ${p.model_tier}` : p.agent_role,
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
  <div class="timeline-row">
    <button
      v-if="hasChildren"
      type="button"
      class="hds-btn hds-btn--ghost hds-btn--icon-xs"
      :aria-expanded="expanded"
      :aria-controls="`tl-group-${entry.eventId}`"
      :aria-label="expanded ? 'Collapse' : 'Expand'"
      style="margin-top: var(--ds-space-1)"
      @click="emit('toggle')"
    >
      <Icon :name="expanded ? 'chevron-down' : 'chevron-right'" :size="14" />
    </button>
    <span v-else style="width: var(--ds-control-height-sm); flex-shrink: 0" aria-hidden="true" />
    <span class="timeline-row__icon" :style="{ background: tint.bg, color: tint.fg }">
      <Icon :name="icon" :size="14" />
    </span>
    <div class="timeline-row__main">
      <div class="timeline-row__head">
        <component
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
        <IdentityChip v-if="dispatchAgent" :id="dispatchAgent.role" :label="dispatchAgent.label" />
      </div>
      <span class="timeline-row__meta">{{ formatDateTime(entry.ts) }} · {{ meta }}</span>
    </div>
  </div>
</template>
