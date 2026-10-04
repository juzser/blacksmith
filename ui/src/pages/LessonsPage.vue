<script setup lang="ts">
// Lessons — ds-spec.md §4.5, rebuilt on the kit. kit Tabs (all four counted,
// ds-spec.md §4.5's own audit item) replace the raw filter buttons; kit
// LessonCard replaces the Table's raw lessonType/lessonScope/timesPrevented
// cells with the three sentences the spec calls for, both in the list and
// (read-only) inside the review Dialog. Approve/edit/reject + the
// lessons.edit-not-novel override flow (P9-34/P9-36) are unchanged.
import { CircleCheck, GraduationCap, RefreshCw } from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import AlertDialog from '../components/kit/AlertDialog.vue';
import Banner from '../components/kit/Banner.vue';
import Button from '../components/kit/Button.vue';
import Dialog from '../components/kit/Dialog.vue';
import EmptyState from '../components/kit/EmptyState.vue';
import LessonCard from '../components/kit/LessonCard.vue';
import PageHeader from '../components/kit/PageHeader.vue';
import RadioGroup from '../components/kit/RadioGroup.vue';
import Skeleton from '../components/kit/Skeleton.vue';
import type { TabItem } from '../components/kit/Tabs.vue';
import Tabs from '../components/kit/Tabs.vue';
import Textarea from '../components/kit/Textarea.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { useToast } from '../composables/useToast.js';
import { useViewport } from '../composables/useViewport.js';
import {
  ApiError,
  approveLesson,
  editLesson,
  fetchLessons,
  type LessonRecord,
  type LessonWriteResult,
  rejectLesson,
} from '../lib/api.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import {
  lessonActions,
  lessonActionsNote,
  type NoveltyNotice,
  noveltyNotice,
} from '../lib/lessonActions.js';
import { LESSON_FILTERS, type LessonFilter, visibleLessons } from '../lib/lessonFilters.js';
import { pendingEmptyBody } from '../lib/lessonLabels.js';

const { setBreadcrumb } = useBreadcrumb();
setBreadcrumb([{ label: 'Lessons' }]);
const { show: showToast } = useToast();
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

const reviewing = ref<LessonRecord | null>(null);
const editMode = ref(false);
const editStatement = ref('');
const editType = ref('');
const rejectConfirm = ref(false);
const saving = ref(false);
/** The novelty gate's verdict on the last write, surfaced instead of dropped (P9-36). */
const notice = ref<NoveltyNotice | null>(null);
/**
 * Set when the gate refused an edited statement as a duplicate. The refusal
 * is recoverable — `acceptDuplicate` records the override — so the Dialog
 * stays open and offers it, rather than closing over a red Banner whose only
 * stated remedy is a CLI flag.
 */
const duplicateBlock = ref<string | null>(null);

/**
 * Which footer buttons this lesson's status legally allows (architecture
 * §9.4). Edit is also hidden on phone (ds-spec.md shell table: Lessons
 * drops bulk editing there).
 */
const actions = computed(() =>
  lessonActions(reviewing.value?.lessonStatus ?? 'unknown-lesson-status'),
);
/** Said out loud, so a missing button reads as a rule and not as a broken page. */
const actionsNote = computed(() =>
  reviewing.value ? lessonActionsNote(reviewing.value.lessonStatus) : null,
);

function openReview(row: LessonRecord) {
  reviewing.value = row;
  editMode.value = false;
  editStatement.value = row.statement;
  editType.value = row.lessonType;
  duplicateBlock.value = null;
}

function closeReview() {
  reviewing.value = null;
  duplicateBlock.value = null;
}

// Retype the statement and the refusal no longer describes it — the override
// offer has to go with it, or "Approve anyway" would carry a decision the
// operator made about different text.
watch(editStatement, () => {
  duplicateBlock.value = null;
});

/** Every successful write lands here, so no path can drop the review again. */
async function afterWrite(result: LessonWriteResult, toast: string) {
  showToast(toast);
  notice.value = noveltyNotice(result.novelty);
  reviewing.value = null;
  duplicateBlock.value = null;
  await load();
}

const LESSON_TYPE_OPTIONS = [
  { value: 'fact', label: 'Fact' },
  { value: 'event', label: 'Event' },
  { value: 'rule', label: 'Rule' },
];

async function approve() {
  if (!reviewing.value || saving.value) return;
  saving.value = true;
  try {
    await afterWrite(
      await approveLesson(reviewing.value.sessionId, reviewing.value.lessonId),
      'Lesson approved.',
    );
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

/**
 * `acceptDuplicate` is only ever true on a retry the operator asked for, and
 * only for the statement they were just shown the score of — never defaulted
 * on. transitionLesson records the override on the `lesson-edited` payload,
 * so a duplicate in memory always says who let it in (P9-34).
 */
async function saveAndApprove(acceptDuplicate = false) {
  if (!reviewing.value || saving.value) return;
  saving.value = true;
  try {
    await afterWrite(
      await editLesson(reviewing.value.sessionId, reviewing.value.lessonId, {
        statement: editStatement.value,
        lessonType: editType.value,
        ...(acceptDuplicate ? { acceptDuplicate: true } : {}),
      }),
      acceptDuplicate ? 'Lesson approved as a duplicate override.' : 'Lesson edited and approved.',
    );
  } catch (e) {
    // The one recoverable refusal: the operator can still choose to keep the
    // statement. Anything else is a hard error and closes nothing.
    if (e instanceof ApiError && e.code === 'lessons.edit-not-novel') {
      duplicateBlock.value = e.message;
    } else {
      error.value = e instanceof Error ? e.message : String(e);
    }
  } finally {
    saving.value = false;
  }
}

async function reject() {
  if (!reviewing.value || saving.value) return;
  saving.value = true;
  try {
    const result = await rejectLesson(reviewing.value.sessionId, reviewing.value.lessonId);
    rejectConfirm.value = false;
    await afterWrite(result, 'Lesson rejected.');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="app-page">
    <PageHeader title="Lessons">
      <template #actions>
        <Button v-if="!isPhoneWidth" variant="ghost" size="sm" :icon="RefreshCw" @click="load">
          Refresh
        </Button>
      </template>
    </PageHeader>

    <!-- What the novelty gate found on the way in. It outlives the toast on
         purpose: a near-duplicate is now injected at every dispatch, and the
         operator is the only one who can go supersede one of the two. -->
    <Banner
      v-if="notice"
      :tone="notice.tone"
      show-retry
      retry-label="Dismiss"
      @retry="notice = null"
    >
      {{ notice.text }}
    </Banner>

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
        <ul v-else class="bs-lessoncard-list">
          <li v-for="lesson in visibleFor(tab.id)" :key="lesson.lessonId">
            <LessonCard
              :lesson="lesson"
              clickable
              :compact="isPhoneWidth"
              @click="openReview(lesson)"
            />
          </li>
        </ul>
      </template>
    </Tabs>

    <Dialog :open="!!reviewing && !rejectConfirm" title="Review lesson" @close="closeReview">
      <template v-if="reviewing">
        <template v-if="!editMode">
          <LessonCard :lesson="reviewing" />
        </template>
        <template v-else>
          <Textarea v-model="editStatement" aria-label="Lesson statement" />
          <RadioGroup
            v-model="editType"
            :options="LESSON_TYPE_OPTIONS"
            name="lesson-type"
            aria-label="Lesson type"
          />
        </template>
        <Banner v-if="actionsNote" tone="info">{{ actionsNote }}</Banner>
        <!-- The gate refused this edit as a duplicate. Recoverable, so the
             Dialog stays open with the statement intact and offers the
             override the server's message could only name as a CLI flag. -->
        <Banner v-if="duplicateBlock" tone="warning">{{ duplicateBlock }}</Banner>
      </template>
      <template #footer>
        <Button
          v-if="actions.reject"
          variant="danger"
          size="sm"
          :disabled="saving"
          @click="rejectConfirm = true"
        >
          Reject
        </Button>
        <Button
          v-if="actions.edit && !isPhoneWidth"
          variant="secondary"
          size="sm"
          :disabled="saving"
          @click="editMode = !editMode"
        >
          {{ editMode ? 'Cancel edit' : 'Edit' }}
        </Button>
        <Button v-if="actions.approve && !editMode" size="sm" :disabled="saving" @click="approve()">
          Approve
        </Button>
        <Button
          v-else-if="actions.approve"
          size="sm"
          :disabled="saving"
          @click="saveAndApprove()"
        >
          Save & approve
        </Button>
        <Button
          v-if="duplicateBlock"
          variant="secondary"
          size="sm"
          :disabled="saving"
          @click="saveAndApprove(true)"
        >
          Approve anyway (record override)
        </Button>
      </template>
    </Dialog>

    <AlertDialog
      :open="rejectConfirm"
      title="Reject this lesson?"
      description="This candidate won't be compiled into agent prompts."
      confirm-label="Reject"
      @close="rejectConfirm = false"
      @confirm="reject"
    />
  </div>
</template>
