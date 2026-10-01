<script setup lang="ts">
// DS3 pattern 4 (ds-spec.md §2.4) — the Kanban card's peek panel. Built on
// the kit `Dialog` (always modal, focus-trapped) rather than the spec's
// literal >=1024px non-modal anchored panel: Dialog/Popover don't offer a
// non-modal, focus-trappable middle ground out of the box, and a modal
// panel degrades safely everywhere a non-modal one would not (deliberate
// scope-narrowing, flagged in the task report).
import { computed, onMounted, ref, watch } from 'vue';
import { fetchTaskDetail, type TaskDetail } from '../lib/api.js';
import { taskLabel } from '../lib/format.js';
import { taskStatusKitTone } from '../lib/taxonomy.js';
import AgentChip from './AgentChip.vue';
import Dialog from './kit/Dialog.vue';
import Tag from './kit/Tag.vue';
import RequestQuote from './RequestQuote.vue';

const props = defineProps<{ taskId: string }>();
const emit = defineEmits<{ close: []; openFull: [taskId: string] }>();

const detail = ref<TaskDetail | null>(null);
const loadError = ref<string | null>(null);

async function load() {
  detail.value = null;
  loadError.value = null;
  try {
    detail.value = await fetchTaskDetail(props.taskId);
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(load);
watch(() => props.taskId, load);

// The latest dispatch, same "who was last sent" source kanban()'s own
// AgentChip reads (not the `agents` fold, which only says who is still on
// it — `detail.agentActivity` already carries that half).
const agentChipTask = computed(() => {
  if (!detail.value) return null;
  const latest = detail.value.attempts[detail.value.attempts.length - 1];
  if (!latest) return null;
  return {
    taskStatus: detail.value.task.taskStatus,
    agentRole: latest.agentRole,
    agentModelTier: latest.modelTier,
    agentActivity: detail.value.agentActivity,
    updatedAt: detail.value.task.updatedAt,
  };
});
</script>

<template>
  <Dialog :open="true" :title="taskLabel(taskId, detail?.task.objective ?? undefined)" @close="emit('close')">
    <p v-if="loadError">Could not load this task: {{ loadError }}</p>
    <template v-else-if="detail">
      <div class="bs-task-peek__meta">
        <Tag :tone="taskStatusKitTone(detail.task.taskStatus)" variant="subtle" size="sm">
          {{ detail.task.taskStatus }}
        </Tag>
        <AgentChip v-if="agentChipTask" :task="agentChipTask" />
      </div>
      <p v-if="detail.task.summary" class="bs-task-peek__summary">{{ detail.task.summary }}</p>
      <RequestQuote :quote="detail.requestQuote" />
      <a href="#" class="bs-task-peek__full" @click.prevent="emit('openFull', taskId)">Open full page</a>
    </template>
    <p v-else>Loading…</p>
  </Dialog>
</template>
