<script setup lang="ts">
// ds-spec.md §2.1: `value`, `unit?: "tok"`; renders "1.2M tokens", "127K",
// "43" — the single implementation for every token-count surface (fixes
// audit items 4, 12, Analytics). formatCompactValue (lib/format.ts) carries
// the actual formatting and has its own full test coverage; this component
// is a thin text wrapper. No hover/focus popup here: unlike RelativeTime/
// ProgressRing, this row names none — a call site that wants the exact
// figure on hover (ds-review.html's "8.3K tok" -> "8,312 tokens") composes
// one around this component itself, which is a future-PR concern outside
// DS0 (§5).
import { formatCompactValue } from '../../lib/format.js';

const props = defineProps<{
  value: number;
  unit?: 'tok';
}>();
</script>

<template>
  <span class="bs-compact-number">{{ formatCompactValue(props.value, props.unit) }}</span>
</template>
