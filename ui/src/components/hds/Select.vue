<script setup lang="ts">
// Select (Phase 6b — closes the "disclosed simplification" gap in
// ui/docs/DESIGN.md; a native <select> IS the WAI-ARIA-correct listbox
// primitive for a plain single-choice picker, so this wraps it rather than
// reinventing a custom listbox widget).
export interface SelectOption {
  value: string;
  label: string;
}

const props = defineProps<{
  modelValue: string;
  options: SelectOption[];
  ariaLabel: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

function onChange(e: Event) {
  emit('update:modelValue', (e.target as HTMLSelectElement).value);
}
</script>

<template>
  <select class="hds-select" :aria-label="ariaLabel" :value="modelValue" @change="onChange">
    <option v-for="opt in props.options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
  </select>
</template>
