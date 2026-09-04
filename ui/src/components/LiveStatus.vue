<script setup lang="ts">
// "Is what I'm looking at actually current?" — the freshness indicator for a
// polled page (operator directive, Phase 6b round 7: "a kind of real-time
// update"). Overview has polled every 5s since 6a, but nothing on screen said
// so: a dashboard whose server had died looked identical to a quiet factory.
// This shows the state AND the age behind it (lib/liveness.ts), plus a manual
// Refresh for when the operator doesn't want to wait out the interval.
//
// a11y: deliberately NOT aria-live. The label re-renders every second (the
// useNow tick), and a polite live region would queue an announcement each
// time, burying everything else on the page. It is plain readable text with a
// full timestamp in its tooltip; the Refresh button is the interactive part
// and carries its own accessible name.
import { computed } from 'vue';
import { formatDateTime } from '../lib/format.js';
import { livenessLabel, livenessLevel } from '../lib/liveness.js';
import Button from './ds/Button.vue';

const props = defineProps<{
  /** ISO timestamp of the last SUCCESSFUL load — not of the last attempt. */
  lastUpdatedAt: string | null;
  /** Ticking clock (composables/useNow.ts) so the age counts up between polls. */
  now: string;
  /** The page's poll interval, which is what "on time" is measured against. */
  intervalMs: number;
}>();

defineEmits<{ refresh: [] }>();

const level = computed(() => livenessLevel(props.lastUpdatedAt, props.now, props.intervalMs));
const label = computed(() => livenessLabel(props.lastUpdatedAt, props.now, props.intervalMs));
</script>

<template>
  <div class="live-status" :class="`live-status--${level}`">
    <span class="live-status__dot" aria-hidden="true" />
    <span
      class="live-status__label"
      :title="lastUpdatedAt ? `Last successful load: ${formatDateTime(lastUpdatedAt)}` : undefined"
      >{{ label }}</span
    >
    <Button variant="ghost" size="sm" icon="refresh-cw" aria-label="Refresh now" @click="$emit('refresh')">
      Refresh
    </Button>
  </div>
</template>
