<script setup lang="ts">
// ds-spec.md §2.1 line 372: Select keeps the old kit's unchanged contract
// (native <select> IS the WAI-ARIA-correct listbox primitive for a plain
// single-choice picker); ported, re-styled to new tokens.
export interface SelectOption {
  value: string;
  label: string;
}

const props = defineProps<{
  modelValue: string;
  options: SelectOption[];
  ariaLabel: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

function onChange(e: Event) {
  emit('update:modelValue', (e.target as HTMLSelectElement).value);
}
</script>

<template>
  <select class="bs-select" :aria-label="ariaLabel" :value="modelValue" :disabled="disabled" @change="onChange">
    <option v-for="opt in props.options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
  </select>
</template>
