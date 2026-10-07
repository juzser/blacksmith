<script setup lang="ts">
// AgentBlock (ds-spec.md §4.6, pattern table row 412): one block per role
// inside a session's detail view, replacing the Sessions VueFlow node and
// the canvas entirely. Pulls in no `@vue-flow/core` dependency anywhere on
// this page.
import { computed } from 'vue';
import { useNow } from '../../composables/useNow.js';
import { lastStepLabel, tokenDisplay } from '../../lib/agentStatus.js';
import type { SessionAgent } from '../../lib/api.js';
import { roleLabel } from '../../lib/roleLabels.js';
import AgentStatusBadge from './AgentStatusBadge.vue';
import CompactNumber from './CompactNumber.vue';
import RelativeTime from './RelativeTime.vue';

const props = defineProps<{
  agentRole: string;
  agents: SessionAgent[];
  /** Test seam, threaded down to RelativeTime/AgentStatusBadge. */
  now?: string;
}>();

const liveNow = useNow();

// Computed once per agent rather than re-reading tokenDisplay()/
// lastStepLabel() from the template on every access.
const rows = computed(() =>
  props.agents.map((agent) => ({
    agent,
    doing: lastStepLabel(agent.lastEventType),
    tokens: tokenDisplay(agent, props.now ?? liveNow.value),
  })),
);
</script>

<template>
  <section class="bs-agentblock">
    <h3 class="bs-agentblock__role">{{ roleLabel(agentRole) }}</h3>
    <ul class="bs-agentblock__list">
      <li v-for="row in rows" :key="row.agent.id" class="bs-agentblock__row">
        <span class="bs-agentblock__doing">{{ row.doing }}</span>
        <div class="bs-agentblock__meta">
          <RelativeTime :iso="row.agent.dispatchedAt" :now="now" />
          <span class="bs-agentblock__tokens">
            <template v-if="row.tokens.kind === 'measured'">
              <CompactNumber :value="row.tokens.input" unit="tok" /> in /
              <CompactNumber :value="row.tokens.output" unit="tok" /> out
            </template>
            <template v-else-if="row.tokens.kind === 'text'">{{ row.tokens.text }}</template>
          </span>
          <AgentStatusBadge :agent="row.agent" :now="now" />
        </div>
      </li>
    </ul>
  </section>
</template>
