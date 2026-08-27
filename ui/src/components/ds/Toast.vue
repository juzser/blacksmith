<script setup lang="ts">
import { useToast } from '../../composables/useToast.js';
import Icon from './Icon.vue';

const { toasts, dismiss } = useToast();
</script>

<template>
  <Teleport to="body">
    <div class="ds-toast-region" role="status" aria-live="polite">
      <div v-for="t in toasts" :key="t.id" class="ds-toast">
        <span>{{ t.message }}</span>
        <button
          type="button"
          class="ds-toast__dismiss"
          aria-label="Dismiss"
          @click="dismiss(t.id)"
        >
          <Icon name="x" :size="14" />
        </button>
      </div>
    </div>
  </Teleport>
</template>
