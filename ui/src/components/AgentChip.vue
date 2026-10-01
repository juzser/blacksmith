<script setup lang="ts">
// DS3 pattern 3 (ds-spec.md §2.4/§2.4b/§4.2) — a small chip naming a task's
// current role + activity state (working/reviewing/waiting/idle). Built on
// the kit's Tag for the tone pill (reusing --bs-tone-* exactly as the state
// dot the spec asks for) rather than a bespoke dot, since Tag already owns
// that token mapping and contrast floor.
//
// `agentWaitingThresholdMs` (constants.ts) gates the "— a nudge may help"
// suffix: the server's `agentActivity: "stalled"` already names the
// "waiting" state (kanban.ts's agentState()); the constant only decides
// whether the elapsed time since `updatedAt` is long enough to suggest
// doing something about it, per pattern 3's worked example (ds-spec.md
// §4.2: "Coder · waiting — a nudge may help").

import { Bot } from '@lucide/vue';
import { computed } from 'vue';
import { type AgentChipLike, type AgentState, agentChip, agentNudgeDue } from '../lib/kanban.js';
import { roleLabel } from '../lib/roleLabels.js';
import Icon from './kit/Icon.vue';
import Tag from './kit/Tag.vue';

const props = defineProps<{ task: AgentChipLike & { updatedAt: string } }>();

const chip = computed(() => agentChip(props.task));

const TONE_FOR_STATE: Record<AgentState, 'progress' | 'review' | 'warning' | 'neutral'> = {
  working: 'progress',
  reviewing: 'review',
  waiting: 'warning',
  idle: 'neutral',
};

const tone = computed(() => (chip.value ? TONE_FOR_STATE[chip.value.state] : 'neutral'));

const text = computed(() => {
  if (!chip.value || !props.task.agentRole) return null;
  const role = roleLabel(props.task.agentRole);
  if (chip.value.state === 'waiting' && agentNudgeDue(props.task.updatedAt)) {
    return `${role} · waiting - a nudge may help`;
  }
  return `${role} · ${chip.value.state}`;
});
</script>

<template>
  <Tag v-if="chip && text" class="bs-agent-chip" :tone="tone" variant="subtle" size="sm" :title="chip.title">
    <Icon :icon="Bot" :size="14" />
    {{ text }}
  </Tag>
</template>
