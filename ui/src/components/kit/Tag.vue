<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    tone?: 'done' | 'review' | 'progress' | 'todo' | 'blocked' | 'danger' | 'warning' | 'neutral';
    variant?: 'subtle' | 'bold' | 'outline';
    size?: 'sm' | 'md';
  }>(),
  { tone: 'neutral', variant: 'subtle', size: 'md' },
);

// bs-tokens.css has no third "-bold"-fill tier (the old kit's Lozenge read a
// --ds-<tone>-bold background plus --ds-text-on-bold/-ds-warning-on-bold
// foreground pair, neither of which this palette carries — see
// bs-primitives.css's .bs-btn--danger comment for the same gap on Button).
// `bold` reuses the same two tokens as `subtle`/`outline` in a third
// geometric role instead: solid fill using the tone's own -text colour as
// background, with the -subtle tint (already a pale version of that same
// hue) as the foreground — monochromatic, not a new hex.
const style = computed(() => {
  const text = `var(--bs-tone-${props.tone}-text)`;
  const subtle = `var(--bs-tone-${props.tone}-subtle)`;
  if (props.variant === 'bold') return { background: text, color: subtle };
  if (props.variant === 'outline') return { background: 'transparent', color: text, borderColor: text };
  return { background: subtle, color: text };
});
</script>

<template>
  <span class="bs-tag" :class="[`bs-tag--${variant}`, `bs-tag--${size}`]" :style="style">
    <slot />
  </span>
</template>
