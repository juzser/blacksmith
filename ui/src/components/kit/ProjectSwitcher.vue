<script setup lang="ts">
// Topbar project scope picker (ds-spec.md §2.2 `ProjectSwitcher`) — same
// contract the inline <Select aria-label="Project"> in the old App.vue used
// (modelValue/options, update:modelValue), restyled as its own named
// component so the shell reads as "here is the project switcher" rather
// than an anonymous Select.
import Select from './Select.vue';

defineProps<{ modelValue: string; options: { value: string; label: string }[] }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <Select
    class="bs-project-switcher"
    :model-value="modelValue"
    :options="options"
    aria-label="Project"
    @update:model-value="emit('update:modelValue', $event)"
  />
</template>
