<script setup lang="ts">
// NeedsYouInbox (ds-spec.md §2.2, §4.1 point 1, pattern 1): every decision
// waiting on the operator in one list, grouped by project. Presentational:
// HomePage owns the fetch and hands the rows in, so loading/error/empty are
// driven by props. Grouping, filtering and per-kind wording live in
// lib/inbox.ts, where the DOM-free unit suite can hold them to the spec.
//
// On phone each row follows ds-review.html's .mrow: title and tag, then a
// faint time line (plain: no tooltip, so no tab stop inside the row link and
// no hit box over the title); only the first row carries the Decide button,
// every other row is one whole-row link and the description stays
// desktop-only.
//
// Read state (pattern 12): a row is unread until the viewer activates one of
// its links or its Decide button; lib/inboxSeen.ts keeps that per viewer in
// localStorage. Unread is a 600 title (plus an accent dot on desktop), read
// is 500.
//
// The "Stop points" kind has no projected row yet (§4.1: ship three kinds,
// file the fourth).
import { ChevronDown, Inbox } from '@lucide/vue';
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { useViewport } from '../composables/useViewport.js';
import type { InboxRow } from '../lib/api.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import {
  filterInbox,
  groupInbox,
  INBOX_FILTERS,
  INBOX_KIND,
  type InboxFilter,
  inboxActionTarget,
  inboxCopy,
  inboxMetaPrefix,
} from '../lib/inbox.js';
import { inboxSeenId, isSeen, loadSeen, markSeen } from '../lib/inboxSeen.js';
import Banner from './kit/Banner.vue';
import Button from './kit/Button.vue';
import EmptyState from './kit/EmptyState.vue';
import RelativeTime from './kit/RelativeTime.vue';
import Skeleton from './kit/Skeleton.vue';
import Tag from './kit/Tag.vue';
import Tooltip from './kit/Tooltip.vue';

const props = defineProps<{
  /** null until the first response arrives: renders the skeleton. */
  rows: InboxRow[] | null;
  /** The last load failed. Rows already shown stay, under the banner. */
  failed: boolean;
  /** The topbar project, when one is selected. */
  project?: string;
}>();

const emit = defineEmits<{ retry: [] }>();

const { isPhoneWidth } = useViewport();
const filter = ref<InboxFilter>('all');

// Chips are dropped on phone (§3.1), so the filter must not keep hiding rows
// the operator can no longer un-filter.
const groups = computed(() => {
  const rows = props.rows ?? [];
  return groupInbox(isPhoneWidth.value ? rows : filterInbox(rows, filter.value), props.project);
});
const groupCount = computed(() => groupInbox(props.rows ?? [], props.project).length);
// Phone heading count (mock .ph-h .cnt): the rows listed, never 0.
const total = computed(() =>
  props.failed
    ? 0
    : groupInbox(props.rows ?? [], props.project).reduce((n, g) => n + g.rows.length, 0),
);

// window.localStorage can throw on access itself (private browsing), so the
// lookup stays inside the module's try/catch.
const storage = {
  getItem: (k: string) => window.localStorage.getItem(k),
  setItem: (k: string, v: string) => window.localStorage.setItem(k, v),
};
const seen = ref(loadSeen(storage));
const markRead = (id: string) => {
  seen.value = markSeen(storage, id);
};
// A middle-click opens the link in a new tab and fires auxclick, never click.
const markReadAux = (e: MouseEvent, id: string) => {
  if (e.button === 1) markRead(id);
};
</script>

<template>
  <section class="bs-inbox" aria-labelledby="inbox-heading">
    <h2 id="inbox-heading" class="bs-section-title">
      Needs you <span v-if="isPhoneWidth && total > 0" class="bs-inbox__count">{{ total }}</span>
    </h2>

    <Banner v-if="failed" show-retry @retry="emit('retry')">Could not load what needs you.</Banner>

    <div v-if="rows === null && !failed" class="bs-inbox__loading" aria-busy="true">
      <Skeleton :height="48" />
      <Skeleton :height="48" />
    </div>

    <EmptyState
      v-else-if="canClaimEmpty(rows !== null, groupCount)"
      :icon="Inbox"
      title="Nothing needs you right now."
      body="Waivers, escalations and lesson candidates that wait on your decision show up here, grouped by project."
    />

    <template v-else-if="rows !== null">
      <div v-if="!isPhoneWidth" class="bs-inbox__filters" role="group" aria-label="Filter what needs you">
        <Button
          v-for="f in INBOX_FILTERS"
          :key="f.id"
          size="sm"
          :variant="filter === f.id ? 'secondary' : 'ghost'"
          :aria-pressed="filter === f.id ? 'true' : 'false'"
          @click="filter = f.id"
        >
          {{ f.label }}
        </Button>
      </div>

      <p v-if="groups.length === 0" class="bs-inbox__none">Nothing of this kind needs you.</p>

      <component
        :is="isPhoneWidth ? 'details' : 'div'"
        v-for="(g, gi) in groups"
        :key="g.project ?? ''"
        class="bs-inbox__group"
        :open="isPhoneWidth && gi === 0 ? true : undefined"
      >
        <h3 v-if="!isPhoneWidth" class="bs-inbox__group-head">{{ g.label }} · {{ g.rows.length }}</h3>
        <summary v-else class="bs-inbox__group-head">
          {{ g.label }} <span class="bs-inbox__gcount">· {{ g.rows.length }}</span>
          <ChevronDown class="bs-inbox__chev" :size="16" aria-hidden="true" />
        </summary>
        <ul class="bs-inbox__list">
          <li
            v-for="(r, ri) in g.rows"
            :key="r.id"
            class="bs-inbox__row"
            :class="{
              'bs-inbox__row--decide': isPhoneWidth && gi === 0 && ri === 0,
              'bs-inbox__row--link': isPhoneWidth && (gi > 0 || ri > 0),
              'bs-inbox__row--unread': !isSeen(seen, r),
            }"
            :data-kind="r.kind"
          >
            <!-- Phone (ds-review.html .mrow): title and tag, then a faint line
                 with the time (and the task name for an escalation); no
                 description. Every row but the Decide one is the link itself. -->
            <RouterLink
              v-if="isPhoneWidth && (gi > 0 || ri > 0)"
              class="bs-inbox__rowlink"
              :to="inboxActionTarget(r)"
              @click="markRead(inboxSeenId(r))"
              @auxclick="markReadAux($event, inboxSeenId(r))"
            >
              <span class="bs-inbox__ptitle">{{ inboxCopy(r).title }}</span>
              <Tag :tone="INBOX_KIND[r.kind].tone" size="sm">{{ INBOX_KIND[r.kind].tag }}</Tag>
              <span class="bs-inbox__pmeta"
                ><template v-if="inboxMetaPrefix(r)">{{ inboxMetaPrefix(r) }} · </template
                ><RelativeTime :iso="r.createdAt" plain
              /></span>
            </RouterLink>
            <template v-else-if="isPhoneWidth">
              <span class="bs-inbox__prow">
                <span class="bs-inbox__ptitle">{{ inboxCopy(r).title }}</span>
                <Tag :tone="INBOX_KIND[r.kind].tone" size="sm">{{ INBOX_KIND[r.kind].tag }}</Tag>
                <span class="bs-inbox__pmeta"
                  ><template v-if="inboxMetaPrefix(r)">{{ inboxMetaPrefix(r) }} · </template
                  ><RelativeTime :iso="r.createdAt" plain
                /></span>
              </span>
              <!-- §3.1: the single most urgent row (first group, first row)
                   gets one full-width --bs-touch-sized "Decide" action; it
                   is the only button in the box. -->
              <RouterLink
                class="bs-btn bs-btn--primary bs-btn--touch bs-btn--block bs-inbox__decide"
                :aria-label="`Decide: ${inboxCopy(r).title}`"
                :to="inboxActionTarget(r)"
                @click="markRead(inboxSeenId(r))"
                @auxclick="markReadAux($event, inboxSeenId(r))"
              >
                Decide
              </RouterLink>
            </template>
            <template v-else>
              <span
                class="bs-inbox__udot"
                v-bind="isSeen(seen, r) ? { 'aria-hidden': 'true' } : { role: 'img', 'aria-label': 'Unread' }"
              ></span>
              <Tag :tone="INBOX_KIND[r.kind].tone" size="sm">{{ INBOX_KIND[r.kind].tag }}</Tag>
              <div class="bs-inbox__text">
                <p class="bs-inbox__title">{{ inboxCopy(r).title }}</p>
                <Tooltip mode="describe" :text="inboxCopy(r).description">
                  <span class="bs-inbox__desc">{{ inboxCopy(r).description }}</span>
                </Tooltip>
              </div>
              <span class="bs-inbox__meta"><RelativeTime :iso="r.createdAt" /></span>
              <RouterLink
                class="bs-btn bs-btn--sm bs-btn--secondary"
                :aria-label="`${INBOX_KIND[r.kind].action}: ${inboxCopy(r).title}`"
                :to="inboxActionTarget(r)"
                @click="markRead(inboxSeenId(r))"
                @auxclick="markReadAux($event, inboxSeenId(r))"
              >
                {{ INBOX_KIND[r.kind].action }}
              </RouterLink>
            </template>
          </li>
        </ul>
      </component>
    </template>
  </section>
</template>
