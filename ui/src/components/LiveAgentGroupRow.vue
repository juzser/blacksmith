<script setup lang="ts">
// Overview's "Live agents" card (Phase 6b round 6 operator directive):
// factored out of OverviewPage.vue so the 2-column split (leftAgentGroups/
// rightAgentGroups, index-parity, NOT height-balanced — see that file's
// header comment for why) doesn't duplicate this ~20-line block twice. One
// role·tier group: a Disclosure trigger row (chevron + IdentityChip + count
// Lozenge, same aria-expanded/aria-controls pattern as
// CausalTimelineList/TimelineRow) and, when expanded, its per-agent detail
// lines directly beneath it — WITHIN this component, never spanning into
// the other column, so toggling one group never reflows the other column.
//
// Round 7 (operator directive: "để ý đến các mốc thời gian"): every line now
// carries how long that agent has been running. `dispatchedAt` was already on
// the entry but only reached the DOM as a native `title` — invisible, and a
// tooltip is not something an operator scans a column of rows with. The
// runtime is what distinguishes "8 agents working" from "1 agent wedged for
// 40 minutes", so it is rendered as text, on the group row (the longest
// runtime in the group, visible while collapsed) and on each entry.
//
// Round 9 (operator directive: "animation nhỏ cho các indicator ở chip với
// các agent đang thực sự hoạt động"). Before this round every dot on this
// card pulsed unconditionally, which made the animation decoration: an agent
// wedged since yesterday pulsed exactly like one dispatched a minute ago.
// The pulse is now spent only on `working` agents — lib/liveness.ts's
// agentActivity(), whose threshold is the factory's own DEFAULT_STALE_HOURS
// — so it means something when it moves. A `stalled` agent keeps a static
// warning-tone dot, and motion is never its only signal: the elapsed column
// beside it already reads "4h 12m".
import { computed } from 'vue';
import { agentScopeLabel } from '../lib/agentScope.js';
import type { LiveAgentEntry } from '../lib/api.js';
import { formatDateTime, formatElapsed } from '../lib/format.js';
import {
  agentActivity,
  byRuntimeDesc,
  longestRunningSince,
  workingCount,
} from '../lib/liveness.js';
import Icon from './hds/Icon.vue';
import Lozenge from './hds/Lozenge.vue';
import IdentityChip from './IdentityChip.vue';

export interface LiveAgentGroupUI {
  key: string;
  agentRole: string;
  modelTier: string;
  count: number;
  entries: LiveAgentEntry[];
}

const props = defineProps<{
  group: LiveAgentGroupUI;
  expanded: boolean;
  /** Ticking clock (composables/useNow.ts) so runtimes count up between polls. */
  now: string;
}>();
const emit = defineEmits<{ toggle: [] }>();

// Longest-running first: the stuck agent is the one worth looking at, and it
// is invisible in dispatch order (lib/liveness.ts).
const entries = computed(() => byRuntimeDesc(props.group.entries));
const oldestSince = computed(() => longestRunningSince(props.group.entries));
// Collapsed, the group chip answers for the whole group: it pulses while at
// least one agent under it is still inside the working window.
const working = computed(() => workingCount(props.group.entries, props.now));
</script>

<template>
  <div class="live-agent-group">
    <button
      type="button"
      class="live-agent-entry live-agent-group-row"
      :aria-expanded="expanded"
      :aria-controls="`live-agent-group-${group.key}`"
      @click="emit('toggle')"
    >
      <Icon :name="expanded ? 'chevron-down' : 'chevron-right'" :size="14" />
      <IdentityChip
        :id="group.agentRole"
        :label="`${group.agentRole} · ${group.modelTier}`"
        :live="working > 0"
      />
      <Lozenge variant="outline">×{{ group.count }}</Lozenge>
      <!-- Collapsed, this is the only number that says whether the group is
           healthy: how long its oldest agent has been running. -->
      <span v-if="oldestSince" class="live-agent-entry__elapsed" :title="`oldest started ${formatDateTime(oldestSince)}`">
        {{ formatElapsed(oldestSince, now) }}
      </span>
    </button>
    <!-- Present while collapsed too, so the chevron's aria-controls always
         resolves (D-227); `hidden` keeps it out of layout and out of the a11y
         tree. It beats this class's own `display: flex` because Tailwind's
         preflight ships the [hidden] rule with `!important` -- the UA
         stylesheet alone would have lost to the class. -->
    <div
      :id="`live-agent-group-${group.key}`"
      role="group"
      class="live-agent-group-detail"
      :hidden="!expanded"
    >
      <component
        :is="a.taskId ? 'router-link' : 'div'"
        v-for="a in entries"
        :key="a.id"
        :to="a.taskId ? `/tasks/${encodeURIComponent(a.taskId)}` : undefined"
        class="live-agent-entry"
        :title="`started ${formatDateTime(a.dispatchedAt)}`"
        :aria-label="
          a.taskId
            ? `working on ${a.taskId}, running ${formatElapsed(a.dispatchedAt, now)}, opens task detail`
            : undefined
        "
      >
        <span
          class="live-agent-entry__dot"
          :class="`live-agent-entry__dot--${agentActivity(a, now)}`"
          aria-hidden="true"
        />
        <span class="live-agent-entry__task">{{ agentScopeLabel(a) }}</span>
        <span class="live-agent-entry__elapsed">{{ formatElapsed(a.dispatchedAt, now) }}</span>
      </component>
    </div>
  </div>
</template>
