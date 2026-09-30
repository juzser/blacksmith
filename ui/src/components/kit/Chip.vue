<script setup lang="ts">
// Chip (ds-spec.md §2.1 line 370: `variant: assignee|identity`, `color?`
// (identity tone index 1-6), `avatarInitial?`; states "default, hover
// (assignee chip is a link to a role/agent)"). A primitive stays dumb: the
// hash(id) -> chart-slot lookup that will assign `color` lives in
// lib/identityColor.ts for a future IdentityChip composite (§2.2, out of
// DS0 scope) to call — Chip itself only paints whichever 1-6 slot it's
// given, mirroring the old kit's IdentityChip.vue border+dot pattern
// (border-color + a decorative dot use the chart colour; the label text
// stays on --bs-text/-subtle, never the chart colour, so contrast can never
// regress with a new id).
//
// Deviation: the props/variants column lists no navigation prop, but the
// states column requires "hover (assignee chip is a link to a role/agent)"
// -- an interactive state a <span> cannot have. DS0 has no real call site to
// wire a router link against, so this adds an undocumented `href?: string`:
// when present the chip renders as an <a>, otherwise a <span>. Flagged here
// for the PR report, not a silent addition.
import { computed } from 'vue';

const props = defineProps<{
  variant: 'assignee' | 'identity';
  color?: 1 | 2 | 3 | 4 | 5 | 6;
  avatarInitial?: string;
  href?: string;
}>();

const style = computed(() => ({
  borderColor: props.color ? `var(--bs-chart-${props.color})` : 'var(--bs-border)',
}));
const dotStyle = computed(() => ({
  background: props.color ? `var(--bs-chart-${props.color})` : 'var(--bs-text-subtle)',
}));
</script>

<template>
  <component
    :is="href ? 'a' : 'span'"
    :href="href"
    class="bs-chip"
    :class="[`bs-chip--${variant}`]"
    :style="style"
  >
    <span v-if="avatarInitial" class="bs-chip__avatar">{{ avatarInitial }}</span>
    <span v-else class="bs-chip__dot" :style="dotStyle" aria-hidden="true" />
    <slot />
  </component>
</template>
