<script setup lang="ts">
// DS3 §4.7/§2.2 pattern — the operator prompt behind a task (or, via the
// `source: 'epic'` fallback, the epic it belongs to), shown on
// `TaskPeekPanel` and the Task detail page.
import { ref } from 'vue';
import { RouterLink } from 'vue-router';
import type { RequestQuote } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';

defineProps<{ quote: RequestQuote | null }>();

const expanded = ref(false);
</script>

<template>
  <section class="bs-request-quote">
    <h4 class="bs-request-quote__label">
      {{ quote?.source === 'epic' ? 'Epic started from' : 'Request' }}
    </h4>
    <template v-if="quote">
      <span class="bs-request-quote__ts">{{ formatDateTime(quote.ts) }}</span>
      <blockquote
        class="bs-request-quote__text"
        :class="{
          'bs-request-quote__text--origin': quote.source === 'epic',
          'bs-request-quote__text--clamped': !expanded,
        }"
      >
        {{ quote.prompt }}
      </blockquote>
      <button
        type="button"
        class="bs-request-quote__toggle"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? 'Show less' : 'Show more' }}
      </button>
      <RouterLink to="/timeline" class="bs-request-quote__link">View in timeline</RouterLink>
    </template>
    <p v-else class="bs-request-quote__empty">No request recorded for this task.</p>
  </section>
</template>
