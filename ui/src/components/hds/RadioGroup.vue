<script setup lang="ts">
export interface RadioOption {
  value: string;
  label: string;
}

const props = defineProps<{
  modelValue: string;
  options: RadioOption[];
  name: string;
  ariaLabel: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <div class="hds-radiogroup" role="radiogroup" :aria-label="ariaLabel">
    <label v-for="opt in props.options" :key="opt.value" class="hds-radio">
      <input
        type="radio"
        :name="name"
        :value="opt.value"
        :checked="modelValue === opt.value"
        @change="emit('update:modelValue', opt.value)"
      />
      {{ opt.label }}
    </label>
  </div>
</template>
