<script setup lang="ts">
// ds-spec.md §2.1: `iso`, `now?` (test seam), `duration?` ("for 12 min"); renders "5 min ago" / "2 h ago"
// / "3 d ago" inside a `<time datetime>`; the absolute time
// ("30 Sep 2026, 14:07:12") in a Tooltip (describe mode, the element is
// focusable), not a title attribute — the single implementation for every
// relative-time surface named in the brief. formatRelativeVerbose/
// formatAbsolute (lib/format.ts) carry the actual formatting and have their
// own full test coverage; this component only wires them to a live clock and
// to Tooltip. The `now` prop is the test seam: when a caller supplies it the
// live clock (useNow) still runs (composables cannot be called
// conditionally), but its ticking value is simply never read.
import { computed } from 'vue';
import { useNow } from '../../composables/useNow.js';
import { formatAbsolute, formatRelativeVerbose, formatSinceVerbose } from '../../lib/format.js';
import Tooltip from './Tooltip.vue';

const props = defineProps<{
  iso: string;
  now?: string;
  duration?: boolean;
}>();

const liveNow = useNow();
const effectiveNow = computed(() => props.now ?? liveNow.value);
const relative = computed(() =>
  props.duration
    ? formatSinceVerbose(props.iso, effectiveNow.value)
    : formatRelativeVerbose(props.iso, effectiveNow.value),
);
const absolute = computed(() => formatAbsolute(props.iso));
</script>

<template>
  <Tooltip class="bs-reltime" mode="describe" :text="absolute" placement="top">
    <time :datetime="iso">{{ relative }}</time>
  </Tooltip>
</template>
