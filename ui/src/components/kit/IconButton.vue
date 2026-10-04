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
    /**
     * 'inverse' is for an IconButton sitting on a deliberately inverted
     * surface (Toast's dismiss button: background: var(--bs-text); color:
     * var(--bs-surface)) — the default tone's colour/hover assume a normal
     * surface and would render as a dim grey icon on a dark background.
     * Defaults to 'default', today's only behaviour.
     */
    tone?: 'default' | 'inverse';
    /**
     * DS4 S1 round 6: the phone overflow's "..." trigger needs
     * aria-haspopup="menu" + aria-expanded (WAI-ARIA APG menu pattern). Both
     * optional — every other IconButton call site is a plain button with
     * neither.
     */
    /**
     * ariaExpanded needs an explicit `default` key below, even `undefined`
     * itself — Vue's prop resolution otherwise treats an absent
     * Boolean-typed prop as `false` rather than undefined, and every other
     * IconButton call site that never passes it would render a bogus
     * `aria-expanded="false"`.
     */
    ariaHaspopup?: 'menu';
    ariaExpanded?: boolean;
    /**
     * Same reason as ariaExpanded: Tooltip (this component's single
     * template root) itself renders two root nodes of its own, so Vue's
     * automatic attr fallthrough has nowhere single to land and silently
     * drops anything bound on an icon button call site that isn't an
     * explicit prop.
     */
    ariaControls?: string;
  }>(),
  { size: 'md', tone: 'default', ariaExpanded: undefined, ariaControls: undefined },
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
      :class="[`bs-iconbtn--${size}`, { 'bs-iconbtn--inverse': tone === 'inverse' }]"
      :aria-label="label"
      :aria-disabled="disabled ? 'true' : undefined"
      :aria-haspopup="ariaHaspopup"
      :aria-expanded="ariaExpanded"
      :aria-controls="ariaControls"
      @click="onClick"
    >
      <Icon :icon="icon" :size="16" />
    </button>
  </Tooltip>
</template>
