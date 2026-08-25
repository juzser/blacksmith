<script setup lang="ts">
import Icon from './Icon.vue';

// `inline` mirrors the kit's EmptyState.jsx (HDS components/feedback/
// EmptyState.jsx): a compact, left-aligned, icon-less line for use inside
// a RowList/rail card row, vs. the default centered icon+text+action
// block. Was previously accepted as a passthrough HTML attribute with no
// effect (uiux review finding) — now a real prop with the kit's own
// `.hds-empty--inline` CSS branch.
withDefaults(defineProps<{ icon?: string; illustrationSrc?: string; inline?: boolean }>(), {
  icon: 'inbox',
  inline: false,
});
</script>

<template>
  <div class="hds-empty" :class="{ 'hds-empty--inline': inline }">
    <template v-if="!inline">
      <img v-if="illustrationSrc" :src="illustrationSrc" alt="" width="96" height="96" />
      <Icon v-else :name="icon" :size="24" style="color: var(--ds-text-subtlest)" />
    </template>
    <p class="hds-empty__text"><slot /></p>
    <slot name="action" />
  </div>
</template>
