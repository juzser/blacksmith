<script setup lang="ts">
// Lessons — ds-spec.md §4.5, rebuilt on the kit. kit Tabs (all four counted,
// ds-spec.md §4.5's own audit item) replace the raw filter buttons; kit
// LessonCard replaces the Table's raw lessonType/lessonScope/timesPrevented
// cells with the three sentences the spec calls for, both in the list and
// inside the detail Dialog. The page only reads: a lesson is approved,
// rejected or edited through `/bs lessons`, so a pending lesson shows its
// status (its tab) and nothing to press.
import { CircleCheck, GraduationCap, RefreshCw } from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';
import Banner from '../components/kit/Banner.vue';
import Button from '../components/kit/Button.vue';
import Dialog from '../components/kit/Dialog.vue';
import EmptyState from '../components/kit/EmptyState.vue';
import LessonCard from '../components/kit/LessonCard.vue';
import PageHeader from '../components/kit/PageHeader.vue';
import Skeleton from '../components/kit/Skeleton.vue';
import type { TabItem } from '../components/kit/Tabs.vue';
import Tabs from '../components/kit/Tabs.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { useViewport } from '../composables/useViewport.js';
import { fetchLessons, type LessonRecord } from '../lib/api.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import { LESSON_FILTERS, type LessonFilter, visibleLessons } from '../lib/lessonFilters.js';
import { pendingEmptyBody } from '../lib/lessonLabels.js';

const { setBreadcrumb } = useBreadcrumb();
setBreadcrumb([{ label: 'Lessons' }]);
const { isPhoneWidth } = useViewport();

const pending = ref<LessonRecord[]>([]);
const approved = ref<LessonRecord[]>([]);
/** Rejected, superseded, and invalidated lessons — closed, but still shown (D-220). */
const closed = ref<LessonRecord[]>([]);
/** The ts of the latest lessons-pass-completed event, or null if dream() has never run. */
const lastCheckedAt = ref<string | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);
const statusFilter = ref<LessonFilter>('pending');
/**
 * Written in the success path and nowhere else. Three payload refs share one
 * fetch here, so there is no single null-until-loaded value to read instead.
 */
const loaded = ref(false);

async function load() {
  error.value = null;
  // Only while there is nothing on screen to keep. design-spec.md §8 gives
  // this page manual refresh precisely so a list does not re-sort under the
  // operator's cursor -- so a refresh that swaps the whole page for a
  // skeleton is worse than the re-sort it was meant to avoid.
  loading.value = !loaded.value;
  try {
    const result = await fetchLessons();
    pending.value = result.pending;
    approved.value = result.approved;
    closed.value = result.closed;
    lastCheckedAt.value = result.lastCheckedAt;
    loaded.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function visibleFor(filter: LessonFilter): LessonRecord[] {
  return visibleLessons(
    {
      pending: pending.value,
      approved: approved.value,
      closed: closed.value,
      lastCheckedAt: lastCheckedAt.value,
    },
    filter,
  );
}

const FILTER_LABEL: Record<LessonFilter, string> = {
  pending: 'Pending review',
  approved: 'Approved',
  closed: 'Closed',
  all: 'All',
};

/** All four tabs carry a count (ds-spec.md §4.5's own audit item). */
const tabs = computed<TabItem[]>(() =>
  LESSON_FILTERS.map((id) => ({ id, label: FILTER_LABEL[id], count: visibleFor(id).length })),
);

/** "Nothing to review." plus what this tab is for, plus when the last pass ran, if ever. */
const pendingEmptyBodyText = computed(() => pendingEmptyBody(lastCheckedAt.value));

/** The lesson whose detail Dialog is open, or null. Read-only. */
const viewing = ref<LessonRecord | null>(null);

function openLesson(row: LessonRecord) {
  viewing.value = row;
}

function closeLesson() {
  viewing.value = null;
}
</script>

<template>
  <div class="app-page">
    <PageHeader title="Lessons">
      <!-- Phone has no Refresh button (ds-review.html's phone frame carries
           no actions row either), so the slot itself is withheld rather than
           passed empty -- PageHeader.vue's isEmpty check only sees whether
           the slot exists, not whether it rendered nothing, so an always-on
           template left the actions band's padding/gap reserved on phone. -->
      <template v-if="!isPhoneWidth" #actions>
        <Button variant="ghost" size="sm" :icon="RefreshCw" @click="load"> Refresh </Button>
      </template>
    </PageHeader>

    <Banner v-if="error" tone="danger" show-retry @retry="load">{{ error }}</Banner>
    <Skeleton v-else-if="loading" :height="240" />

    <Tabs v-else v-model="statusFilter" :tabs="tabs" aria-label="Lesson status">
      <template v-for="tab in tabs" :key="tab.id" #[tab.id]>
        <EmptyState
          v-if="tab.id === 'pending' && canClaimEmpty(loaded, visibleFor('pending').length)"
          :icon="CircleCheck"
          title="Nothing to review."
          :body="pendingEmptyBodyText"
        />
        <EmptyState
          v-else-if="canClaimEmpty(loaded, visibleFor(tab.id).length)"
          :icon="GraduationCap"
          title="No lessons here yet."
          body="Lessons appear here after a dreaming pass finds and reviews them."
        />
        <ul
          v-else
          class="bs-lessoncard-list"
          :class="{ 'bs-lessoncard-list--compact': isPhoneWidth }"
        >
          <li v-for="lesson in visibleFor(tab.id)" :key="lesson.lessonId">
            <LessonCard
              :lesson="lesson"
              clickable
              :compact="isPhoneWidth"
              @click="openLesson(lesson)"
            />
          </li>
        </ul>
      </template>
    </Tabs>

    <!-- Read-only: the same LessonCard as the list, with no footer. -->
    <Dialog :open="!!viewing" title="Lesson" @close="closeLesson">
      <LessonCard v-if="viewing" :lesson="viewing" />
    </Dialog>
  </div>
</template>
