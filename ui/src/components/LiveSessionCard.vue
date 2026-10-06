<script setup lang="ts">
// One live CLI session on Home (ds-spec.md §4.1 item 1a): title, status, a
// Now line per working agent, a Next line. Presentational; what each line
// says is decided by lib/liveSessions.ts.
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { useViewport } from '../composables/useViewport.js';
import { type LiveCard, liveCardView } from '../lib/liveSessions.js';
import Card from './kit/Card.vue';
import RelativeTime from './kit/RelativeTime.vue';
import Tag from './kit/Tag.vue';

const props = defineProps<{ card: LiveCard }>();

const { isPhoneWidth } = useViewport();
const expanded = ref(false);
const view = computed(() =>
  liveCardView(props.card, { phone: isPhoneWidth.value, expanded: expanded.value }),
);
</script>

<template>
  <Card class="bs-live-card">
    <div class="bs-live-card__head">
      <div class="bs-live-card__title" :title="view.titleTooltip ?? undefined">
        <RouterLink
          v-if="view.titleLink"
          :to="view.titleLink"
          class="bs-live-card__link"
          :aria-label="view.titleLabel ?? undefined"
        >{{ view.title }}</RouterLink>
        <template v-else>{{ view.title }}<span v-if="view.titleMuted" class="bs-live-card__muted">{{ view.titleMuted }}</span></template>
      </div>
      <div class="bs-live-card__status">
        <Tag :tone="view.status.tone" size="sm">{{ view.status.label }}</Tag>
        <RelativeTime v-if="view.since" :iso="view.since" />
      </div>
    </div>
    <p v-if="view.meta" class="bs-live-card__meta">{{ view.meta }}</p>
    <div v-for="(a, i) in view.now" :key="i" class="bs-live-card__line">
      <span class="bs-live-card__k">{{ i === 0 ? 'Now' : '' }}</span>
      <span class="bs-live-card__v">{{ a.role }}<template v-if="a.taskTitle"> on
        <RouterLink v-if="a.to" :to="a.to" class="bs-live-card__link" :aria-label="`Open task ${a.taskTitle}`">{{ a.taskTitle }}</RouterLink>
        <template v-else>{{ a.taskTitle }}</template></template></span>
    </div>
    <div v-if="view.moreCount > 0" class="bs-live-card__line">
      <span class="bs-live-card__k" />
      <button type="button" class="bs-btn bs-btn--link bs-btn--sm bs-live-card__more" @click="expanded = true">
        + {{ view.moreCount }} more
      </button>
    </div>
    <div v-if="view.next" class="bs-live-card__line">
      <span class="bs-live-card__k">Next</span>
      <span v-if="view.next.kind === 'task'" class="bs-live-card__v bs-live-card__v--solo">
        <RouterLink :to="view.next.to" class="bs-live-card__link" :aria-label="`Open task ${view.next.taskTitle}`">{{ view.next.taskTitle }}</RouterLink>
      </span>
      <span v-else-if="view.next.kind === 'waiting'" class="bs-live-card__v bs-live-card__wait">Waiting on you</span>
      <span v-else class="bs-live-card__v">Nothing queued</span>
    </div>
  </Card>
</template>
