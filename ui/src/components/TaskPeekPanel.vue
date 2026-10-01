<script setup lang="ts">
// DS3 pattern 4 (ds-spec.md §2.4) — the Kanban card's peek panel. Built on
// the kit `Dialog` (always modal, focus-trapped) rather than the spec's
// literal >=1024px non-modal anchored panel: Dialog/Popover don't offer a
// non-modal, focus-trappable middle ground out of the box, and a modal
// panel degrades safely everywhere a non-modal one would not (deliberate
// scope-narrowing, flagged in the task report).
import { onMounted, ref, watch } from 'vue';
import { fetchTaskDetail, type TaskDetail } from '../lib/api.js';
import { taskLabel } from '../lib/format.js';
import { roleLabel } from '../lib/roleLabels.js';
import { taskStatusKitTone } from '../lib/taxonomy.js';
import Dialog from './kit/Dialog.vue';
import Tag from './kit/Tag.vue';

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

const latestAgent = () =>
  detail.value?.agents && detail.value.agents.length > 0 ? detail.value.agents[0] : null;
</script>

<template>
  <Dialog :open="true" :title="taskLabel(taskId, detail?.task.objective ?? undefined)" @close="emit('close')">
    <p v-if="loadError">Could not load this task: {{ loadError }}</p>
    <template v-else-if="detail">
      <div class="bs-task-peek__meta">
        <Tag :tone="taskStatusKitTone(detail.task.taskStatus)" variant="subtle" size="sm">
          {{ detail.task.taskStatus }}
        </Tag>
        <span v-if="latestAgent()" class="bs-task-peek__agent">{{ roleLabel(latestAgent()!.agentRole) }}</span>
      </div>
      <section class="bs-task-peek__request">
        <h4>Request</h4>
        <blockquote v-if="detail.requestQuote" class="bs-task-peek__quote">
          {{ detail.requestQuote.prompt }}
        </blockquote>
        <p v-else class="bs-task-peek__empty">No request recorded for this task.</p>
      </section>
      <a href="#" class="bs-task-peek__full" @click.prevent="emit('openFull', taskId)">Open full page</a>
    </template>
    <p v-else>Loading…</p>
  </Dialog>
</template>
