<script setup lang="ts">
// ds-spec.md §2.1 line 372: Textarea keeps the old kit's unchanged contract
// (native-element wrapper); ported, re-styled to new tokens.
const props = defineProps<{ modelValue: string; ariaLabel: string; rows?: number }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value);
}
</script>

<template>
  <textarea
    class="bs-textarea"
    :aria-label="ariaLabel"
    :rows="props.rows ?? 4"
    :value="modelValue"
    @input="onInput"
  />
</template>
