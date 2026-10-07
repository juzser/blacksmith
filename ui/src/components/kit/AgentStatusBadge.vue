<script setup lang="ts">
// AgentStatusBadge (ds-spec.md §2.4c pattern 13, DS8 operator override Q2):
// a single workload-axis badge per agent — Working / "No result after 4h"
// (anomaly) / Done / Failed / Stopped — read off agentStatus() so the state
// mapping itself stays unit-tested in lib/agentStatus.test.ts. `now` is the
// same test seam RelativeTime.vue uses: the live clock always runs (hooks
// cannot be called conditionally), but a caller-supplied value wins.
import { computed } from 'vue';
import { useNow } from '../../composables/useNow.js';
import { agentStatus } from '../../lib/agentStatus.js';
import type { SessionAgent } from '../../lib/api.js';
import Tag from './Tag.vue';

const props = defineProps<{
  agent: Pick<SessionAgent, 'status' | 'dispatchedAt'>;
  now?: string;
}>();

const liveNow = useNow();
const status = computed(() => agentStatus(props.agent, props.now ?? liveNow.value));
</script>

<template>
  <Tag size="sm" :tone="status.tone">{{ status.label }}</Tag>
</template>
