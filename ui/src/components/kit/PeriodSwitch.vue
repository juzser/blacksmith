<script setup lang="ts">
// DS7 §4.4 / ds-review.html's technical-details list names PeriodSwitch as a
// new component. `kit/SegmentedControl.vue` is RouterLink-only (switches
// between routes, no v-model), so it cannot back a plain value like
// AnalyticsPage's `?period=` — this is the same visual shape with a value
// prop/emit pair instead of `to`.
export interface PeriodSwitchOption {
  value: string;
  label: string;
}

withDefaults(
  defineProps<{
    modelValue: string;
    options: PeriodSwitchOption[];
    label: string;
    /**
     * Opt-in: the mock's underline tab row (DS7 PR2 round 5 item 4), used by
     * AnalyticsPage's period switch at phone width only. Defaults to the
     * existing button-group form, so every other consumer stays pixel
     * identical.
     */
    variant?: 'buttons' | 'tabs';
  }>(),
  { variant: 'buttons' },
);
defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <div
    v-if="variant === 'tabs'"
    class="bs-periodswitch bs-periodswitch--tabs"
    role="group"
    :aria-label="label"
  >
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="bs-periodswitch__tab"
      :aria-current="option.value === modelValue ? 'page' : undefined"
      @click="$emit('update:modelValue', option.value)"
    >
      {{ option.label }}
    </button>
  </div>
  <div v-else class="bs-periodswitch" role="group" :aria-label="label">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="bs-periodswitch__item"
      :aria-pressed="option.value === modelValue"
      @click="$emit('update:modelValue', option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>
