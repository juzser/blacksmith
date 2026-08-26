<script setup lang="ts">
import Button from './Button.vue';
import Icon from './Icon.vue';

export interface ChipOption {
  value: string;
  label: string;
  count?: number;
}

const props = defineProps<{ options: ChipOption[]; modelValue: string[] }>();
const emit = defineEmits<{ 'update:modelValue': [string[]]; clear: [] }>();

function toggle(value: string) {
  const on = props.modelValue.includes(value);
  emit(
    'update:modelValue',
    on ? props.modelValue.filter((v) => v !== value) : [...props.modelValue, value],
  );
}
</script>

<template>
  <div class="hds-chips">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      class="hds-chip"
      :aria-pressed="modelValue.includes(o.value)"
      :data-active="modelValue.includes(o.value)"
      @click="toggle(o.value)"
    >
      <Icon v-if="modelValue.includes(o.value)" name="check" :size="12" :stroke-width="3" />
      {{ o.label }}
      <span v-if="o.count != null" class="hds-chip__count">{{ o.count }}</span>
    </button>
    <!-- Ghost Button, not a bare <button>: `class="hds-chips__clear"` matched
         no rule in any of the three stylesheets, so Tailwind preflight was the
         only thing styling it -- inherited body font, no border, no padding,
         cursor: default. The secondary action rendered louder than the chips
         it clears, in a row of chip-height pills (D-229). design-spec.md 5.2 calls
         for a ghost Button here and TimelinePage already renders one for its
         own "Clear filters"; `size="xs"` is the chip anatomy exactly --
         --ds-control-height-sm tall, --ds-space-2 padding, --ds-text-xs. -->
    <Button v-if="modelValue.length > 0" variant="ghost" size="xs" @click="emit('clear')">Clear</Button>
  </div>
</template>
