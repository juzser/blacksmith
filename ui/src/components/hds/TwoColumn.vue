<template>
  <div class="hds-2col">
    <div class="hds-2col__main">
      <slot />
    </div>
    <div v-if="$slots.rail" class="hds-2col__rail">
      <slot name="rail" />
    </div>
  </div>
</template>
