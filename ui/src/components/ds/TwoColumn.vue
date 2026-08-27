<template>
  <div class="ds-2col">
    <div class="ds-2col__main">
      <slot />
    </div>
    <div v-if="$slots.rail" class="ds-2col__rail">
      <slot name="rail" />
    </div>
  </div>
</template>
