<script setup lang="ts">
// Lessons — design-spec.md §5.6. Status toggle Buttons, table, review
// Dialog (RadioGroup in edit mode, Approve primary / Edit outline / Reject
// destructive -> AlertDialog).
import { computed, onMounted, ref, watch } from 'vue';
import AlertDialog from '../components/hds/AlertDialog.vue';
import Banner from '../components/hds/Banner.vue';
import Button from '../components/hds/Button.vue';
import Dialog from '../components/hds/Dialog.vue';
import EmptyState from '../components/hds/EmptyState.vue';
import Lozenge from '../components/hds/Lozenge.vue';
import PageHeader from '../components/hds/PageHeader.vue';
import RadioGroup from '../components/hds/RadioGroup.vue';
import Skeleton from '../components/hds/Skeleton.vue';
import Table from '../components/hds/Table.vue';
import Textarea from '../components/hds/Textarea.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { useToast } from '../composables/useToast.js';
import {
  ApiError,
  approveLesson,
  editLesson,
  fetchLessons,
  type LessonRecord,
  type LessonWriteResult,
  rejectLesson,
} from '../lib/api.js';
import {
  lessonActions,
  lessonActionsNote,
  type NoveltyNotice,
  noveltyNotice,
} from '../lib/lessonActions.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import { type LessonFilter, visibleLessons } from '../lib/lessonFilters.js';
import { lessonStatusTone } from '../lib/taxonomy.js';

const { setBreadcrumb } = useBreadcrumb();
setBreadcrumb([{ label: 'Lessons' }]);
const { show: showToast } = useToast();

const pending = ref<LessonRecord[]>([]);
const approved = ref<LessonRecord[]>([]);
/** Rejected, superseded, and invalidated lessons — closed, but still shown (D-220). */
const closed = ref<LessonRecord[]>([]);
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
  // skeleton is worse than the re-sort it was meant to avoid. TimelinePage
  // and KanbanPage already read this way; a retry after a failed fetch still
  // gets its skeleton, because there the page really is empty (D-243).
  loading.value = !loaded.value;
  try {
    const result = await fetchLessons();
    pending.value = result.pending;
    approved.value = result.approved;
    closed.value = result.closed;
    loaded.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const visible = computed(() =>
  visibleLessons(
    { pending: pending.value, approved: approved.value, closed: closed.value },
    statusFilter.value,
  ),
);

const columns = [
  { key: 'lessonType', label: 'Type' },
  { key: 'lessonScope', label: 'Scope' },
  { key: 'statement', label: 'Summary' },
  { key: 'lessonStatus', label: 'Status' },
  { key: 'timesPrevented', label: 'Times prevented', numeric: true },
];

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
 * §9.4). The page renders the `approved` bucket under its Approved/All
 * filters, and `approved` may only move to superseded or invalidated — so
 * Approve there could never do anything but fail.
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
        <Button variant="ghost" size="sm" icon="refresh-cw" @click="load">Refresh</Button>
      </template>
    </PageHeader>

    <div style="display: flex; gap: var(--ds-space-2)">
      <Button :variant="statusFilter === 'pending' ? 'secondary' : 'outline'" size="sm" @click="statusFilter = 'pending'">
        Pending review ({{ pending.length }})
      </Button>
      <Button :variant="statusFilter === 'approved' ? 'secondary' : 'outline'" size="sm" @click="statusFilter = 'approved'">
        Approved
      </Button>
      <!-- Rejected/superseded/invalidated. Without this the page's own Reject
           button made a row disappear from every filter it had, so "rejected"
           and "lost" looked identical to the operator (D-220). -->
      <Button :variant="statusFilter === 'closed' ? 'secondary' : 'outline'" size="sm" @click="statusFilter = 'closed'">
        Closed ({{ closed.length }})
      </Button>
      <Button :variant="statusFilter === 'all' ? 'secondary' : 'outline'" size="sm" @click="statusFilter = 'all'">
        All
      </Button>
    </div>

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
    <Skeleton v-else-if="loading" height="240" />

    <EmptyState v-else-if="canClaimEmpty(loaded, visible.length) && statusFilter === 'pending'" icon="circle-check">
      Nothing waiting. New candidates appear after the next dreaming pass.
    </EmptyState>
    <EmptyState v-else-if="canClaimEmpty(loaded, visible.length)" icon="graduation-cap">No lessons here yet.</EmptyState>

    <Table
      v-else
      :columns="columns"
      :rows="visible"
      row-key="lessonId"
      clickable
      @row-click="(row) => openReview(row as never as LessonRecord)"
    >
      <template #cell="{ column, row }">
        <Lozenge v-if="column.key === 'lessonType' || column.key === 'lessonScope'" variant="outline">{{ row[column.key] }}</Lozenge>
        <Lozenge v-else-if="column.key === 'lessonStatus'" :tone="lessonStatusTone(String(row.lessonStatus))">{{ row.lessonStatus }}</Lozenge>
        <template v-else>{{ row[column.key] }}</template>
      </template>
    </Table>

    <Dialog :open="!!reviewing && !rejectConfirm" title="Review lesson" @close="closeReview">
      <template v-if="reviewing">
        <div v-if="!editMode">
          <p>{{ reviewing.statement }}</p>
          <Lozenge variant="outline">{{ reviewing.lessonScope }}</Lozenge>
        </div>
        <template v-else>
          <Textarea v-model="editStatement" aria-label="Lesson statement" />
          <RadioGroup v-model="editType" :options="LESSON_TYPE_OPTIONS" name="lesson-type" aria-label="Lesson type" />
        </template>
        <Banner v-if="actionsNote" tone="info">{{ actionsNote }}</Banner>
        <!-- The gate refused this edit as a duplicate. Recoverable, so the
             Dialog stays open with the statement intact and offers the
             override the server's message could only name as a CLI flag. -->
        <Banner v-if="duplicateBlock" tone="warning">{{ duplicateBlock }}</Banner>
      </template>
      <template #footer>
        <Button v-if="actions.reject" variant="destructive" size="sm" :disabled="saving" @click="rejectConfirm = true">Reject</Button>
        <Button v-if="actions.edit" variant="outline" size="sm" :disabled="saving" @click="editMode = !editMode">
          {{ editMode ? 'Cancel edit' : 'Edit' }}
        </Button>
        <Button v-if="actions.approve && !editMode" size="sm" :disabled="saving" @click="approve()">Approve</Button>
        <Button v-else-if="actions.approve" size="sm" :disabled="saving" @click="saveAndApprove()">Save & approve</Button>
        <Button
          v-if="duplicateBlock"
          variant="outline"
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
