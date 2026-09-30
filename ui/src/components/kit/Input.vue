<script setup lang="ts">
// Input (ds-spec.md §2.1 line 372: "Input / Textarea / Select / RadioGroup
// | unchanged contract from the old kit (native-element wrappers); ported,
// re-styled to new tokens"). The old kit has no Input.vue to port — modelled
// on Textarea.vue's native-wrapper shape (a single controlled DOM element,
// modelValue + ariaLabel, update:modelValue on input), narrowed to
// <input>'s own `type` and `placeholder`.
withDefaults(
  defineProps<{
    modelValue: string;
    ariaLabel: string;
    type?: 'text' | 'email' | 'number' | 'search' | 'password';
    placeholder?: string;
  }>(),
  { type: 'text' },
);
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).value);
}
</script>

<template>
  <input
    class="bs-input"
    :type="type"
    :aria-label="ariaLabel"
    :placeholder="placeholder"
    :value="modelValue"
    @input="onInput"
  />
</template>
