<script setup lang="ts">
defineProps<{ title?: string; meta?: string; clickable?: boolean; ariaLabel?: string }>();
const emit = defineEmits<{ activate: [] }>();
</script>

<template>
  <li>
    <button v-if="clickable" type="button" class="hds-row hds-row--button" :aria-label="ariaLabel" @click="emit('activate')">
      <slot>
        <span class="hds-row__main">
          <span class="hds-row__title">{{ title }}</span>
          <span v-if="meta" class="hds-row__meta">{{ meta }}</span>
        </span>
        <span v-if="$slots.trailing" class="hds-row__trail"><slot name="trailing" /></span>
      </slot>
    </button>
    <div v-else class="hds-row">
      <slot>
        <span class="hds-row__main">
          <span class="hds-row__title">{{ title }}</span>
          <span v-if="meta" class="hds-row__meta">{{ meta }}</span>
        </span>
        <span v-if="$slots.trailing" class="hds-row__trail"><slot name="trailing" /></span>
      </slot>
    </div>
  </li>
</template>
