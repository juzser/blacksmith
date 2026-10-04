<script setup lang="ts">
// DS3 §4.7/§2.2 pattern — the operator prompt behind a task (or, via the
// `source: 'epic'` fallback, the epic it belongs to), shown on
// `TaskPeekPanel` and the Task detail page.
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { RequestQuote } from '../lib/api.js';
import { isTextClamped } from '../lib/clamp.js';
import { formatShortDateTime } from '../lib/format.js';

const props = defineProps<{ quote: RequestQuote | null }>();

const expanded = ref(false);
// DS4 S5c fix round 1, fix 2 — the toggle only renders when the quote text
// actually overflows its 3-line clamp, not unconditionally.
const isClamped = ref(false);
const textEl = ref<HTMLElement | null>(null);
let observer: ResizeObserver | undefined;

function measure() {
  // Measured only while the clamp class is in effect: once expanded the box
  // grows to fit the text, so scrollHeight === clientHeight always — that
  // would wrongly flip isClamped to false instead of leaving the toggle's
  // prior (correct) verdict in place.
  if (expanded.value || !textEl.value) return;
  isClamped.value = isTextClamped(textEl.value.scrollHeight, textEl.value.clientHeight);
}

watch(textEl, (el) => {
  observer?.disconnect();
  observer = undefined;
  if (!el) return;
  measure();
  if (typeof ResizeObserver === 'undefined') return;
  observer = new ResizeObserver(() => measure());
  observer.observe(el);
});

// A new quote swaps the text under the same element: collapse back (so the
// clamp class is back in effect) and re-measure against the new content.
watch(
  () => props.quote?.prompt,
  async () => {
    expanded.value = false;
    await nextTick();
    measure();
  },
);

onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <section class="bs-request-quote">
    <div class="bs-request-quote__head">
      <h4 class="bs-request-quote__label">
        {{ quote?.source === 'epic' ? 'Epic started from' : 'Request' }}
      </h4>
      <span v-if="quote" class="bs-request-quote__ts">{{ formatShortDateTime(quote.ts) }}</span>
    </div>
    <template v-if="quote">
      <blockquote
        ref="textEl"
        class="bs-request-quote__text"
        :class="{
          'bs-request-quote__text--origin': quote.source === 'epic',
          'bs-request-quote__text--clamped': !expanded,
        }"
      >
        {{ quote.prompt }}
      </blockquote>
      <button
        v-if="isClamped"
        type="button"
        class="bs-request-quote__toggle"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? 'Show less' : 'Show more' }}
      </button>
      <RouterLink to="/activity" class="bs-request-quote__link">View in timeline</RouterLink>
    </template>
    <p v-else class="bs-request-quote__empty">No request recorded for this task.</p>
  </section>
</template>
