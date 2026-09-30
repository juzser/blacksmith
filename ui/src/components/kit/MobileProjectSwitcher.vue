<script setup lang="ts">
// The ≤640px phone topbar's compact stand-in for ProjectSwitcher.vue
// (ds-spec.md §3.1, finding 9): a native <select> reads its option list as a
// full-width control the 375px topbar has no room for, so this trades it for
// a trigger button + Popover list carrying the identical modelValue/options
// v-model contract. ProjectSwitcher.vue itself stays untouched — this is a
// second component, not a variant, so desktop keeps its native <select>.
import { ChevronDown } from '@lucide/vue';
import { computed, ref } from 'vue';
import Icon from './Icon.vue';
import Popover from './Popover.vue';

const props = defineProps<{
  modelValue: string;
  options: { value: string; label: string }[];
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const open = ref(false);
const currentLabel = computed(
  () => props.options.find((o) => o.value === props.modelValue)?.label ?? props.modelValue,
);

function select(value: string) {
  emit('update:modelValue', value);
  open.value = false;
}
</script>

<template>
  <Popover class="bs-mproject" :open="open" label="Project" @close="open = false">
    <template #trigger>
      <button
        type="button"
        class="bs-mproject__trigger"
        aria-label="Project"
        @click="open = !open"
      >
        <span class="bs-mproject__label">{{ currentLabel }}</span>
        <Icon :icon="ChevronDown" :size="14" />
      </button>
    </template>
    <ul class="bs-mproject__list">
      <li v-for="opt in options" :key="opt.value">
        <button
          type="button"
          class="bs-mproject__item"
          :aria-current="opt.value === modelValue ? 'true' : undefined"
          @click="select(opt.value)"
        >
          {{ opt.label }}
        </button>
      </li>
    </ul>
  </Popover>
</template>
