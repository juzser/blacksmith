<script setup lang="ts">
// Operator directive 2 (epic/project identity), extended by operator
// directive 5 (this round): the SAME deterministic hash(value) ->
// --ds-chart-1..8 accent — colour dot + tinted border, text on text
// tokens, never a status tone — now also covers agent-role/model-tier/
// case chips wherever they appear (Kanban, Task detail, Timeline,
// Overview), not just epic/project ids. `id` is really "the value being
// distinguished", whatever descriptive dimension it comes from; status/
// severity Lozenges are UNCHANGED (still taxonomy.ts's semantic tones —
// evaluative dims never move onto the identity-accent system, design-
// spec.md §3's governing rule, extended in DESIGN.md §3's mapping notes).
//
// Fix-round (uiux S2 #1): the chart palette is tuned for data-viz contrast
// against a surface, NOT for 4.5:1 text contrast — measured 7 of 8 slots
// fail AA normal-text in at least one theme (contrast.py matrix in the PR
// description). The chart token now drives ONLY the border (a UI graphic,
// 3:1 floor — every slot passes both themes, see below) and a small
// decorative dot; the label text uses --ds-text-subtlest, which passes
// 4.5:1 in both themes (light 4.83:1, dark 7.76:1) independent of which
// chart slot is assigned, so text contrast can never regress with a new id.
//
// Operator directive (Phase 6b round 9): "add a small animation to the chip
// indicators for the agents that are actually working". `live` is opt-in
// and off by default — every other chip on the dashboard (an epic id, a
// case, a model tier) labels a *thing*, not an activity, and a chip that
// pulsed everywhere would say nothing. The caller decides, and the only
// caller that passes it is the one that can answer the question from data
// (LiveAgentGroupRow, via lib/liveness.ts's agentActivity()).
import { computed } from 'vue';
import { identityColorVar } from '../lib/identityColor.js';

const props = defineProps<{ id: string; label?: string; live?: boolean }>();

const style = computed(() => ({ borderColor: identityColorVar(props.id) }));
const dotStyle = computed(() => ({ background: identityColorVar(props.id) }));
</script>

<template>
  <span class="ds-loz ds-loz--outline identity-chip" :style="style">
    <span
      class="identity-chip__dot"
      :class="{ 'identity-chip__dot--live': live }"
      :style="dotStyle"
      aria-hidden="true"
    />
    {{ label ?? id }}
  </span>
</template>

