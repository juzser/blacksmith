<script setup lang="ts">
defineProps<{ title?: string; meta?: string; clickable?: boolean; ariaLabel?: string }>();
const emit = defineEmits<{ activate: [] }>();
</script>

<template>
  <li>
    <button v-if="clickable" type="button" class="ds-row ds-row--button" :aria-label="ariaLabel" @click="emit('activate')">
      <slot>
        <span class="ds-row__main">
          <span class="ds-row__title">{{ title }}</span>
          <span v-if="meta" class="ds-row__meta">{{ meta }}</span>
        </span>
        <span v-if="$slots.trailing" class="ds-row__trail"><slot name="trailing" /></span>
      </slot>
    </button>
    <div v-else class="ds-row">
      <slot>
        <span class="ds-row__main">
          <span class="ds-row__title">{{ title }}</span>
          <span v-if="meta" class="ds-row__meta">{{ meta }}</span>
        </span>
        <span v-if="$slots.trailing" class="ds-row__trail"><slot name="trailing" /></span>
      </slot>
    </div>
  </li>
</template>
