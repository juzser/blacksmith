<script setup lang="ts">
// ds-spec.md §2.1 / §2.5. label is required, not `label?:` — it is both the
// accessible name (aria-label) and the tooltip text, so an icon-only button
// can never end up with neither. aria-disabled rather than the native
// `disabled` attribute: a disabled control that cannot take focus can also
// never show its tooltip, and the tooltip is the only way a mouse user finds
// out what the button would have done (§2.1: "disabled? ... renders
// aria-disabled=true so the tooltip still shows on focus").
import type { Component } from 'vue';
import Icon from './Icon.vue';
import Tooltip from './Tooltip.vue';

const props = withDefaults(
  defineProps<{
    icon: Component;
    label: string;
    size?: 'sm' | 'md';
    disabled?: boolean;
  }>(),
  { size: 'md' },
);

const emit = defineEmits<{ click: [MouseEvent] }>();

function onClick(event: MouseEvent) {
  if (props.disabled) return;
  emit('click', event);
}
</script>

<template>
  <Tooltip mode="label" :text="label">
    <button
      type="button"
      class="bs-iconbtn"
      :class="`bs-iconbtn--${size}`"
      :aria-label="label"
      :aria-disabled="disabled ? 'true' : undefined"
      @click="onClick"
    >
      <Icon :icon="icon" :size="16" />
    </button>
  </Tooltip>
</template>
