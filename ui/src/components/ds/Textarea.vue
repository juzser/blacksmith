<script setup lang="ts">
const props = defineProps<{ modelValue: string; ariaLabel: string; rows?: number }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value);
}
</script>

<template>
  <textarea
    class="ds-textarea"
    :aria-label="ariaLabel"
    :rows="props.rows ?? 4"
    :value="modelValue"
    @input="onInput"
  />
</template>
