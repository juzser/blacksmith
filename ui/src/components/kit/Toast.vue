<script setup lang="ts">
// Toast — module-level queue owned by useToast() (composables/useToast.ts),
// this component only renders it. Deliberately inverted surface (see
// .bs-toast's own comment in bs-primitives.css) — its dismiss IconButton
// needs tone="inverse" or it renders a dim grey icon on the dark background.
import { X } from '@lucide/vue';
import { useToast } from '../../composables/useToast.js';
import IconButton from './IconButton.vue';

const { toasts, dismiss } = useToast();
</script>

<template>
  <Teleport to="body">
    <div class="bs-toast-region" role="status" aria-live="polite">
      <div v-for="t in toasts" :key="t.id" class="bs-toast">
        <span>{{ t.message }}</span>
        <IconButton :icon="X" label="Dismiss" tone="inverse" size="sm" @click="dismiss(t.id)" />
      </div>
    </div>
  </Teleport>
</template>
