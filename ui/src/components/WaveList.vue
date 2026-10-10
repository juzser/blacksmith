<script setup lang="ts">
// DS4 S3 §2 — WaveList: one <section> per wave (past, current, upcoming),
// each with a visible heading. Used by EpicBlock in both phase mode (behind
// the "Show waves" toggle) and epic mode (always shown, no toggle).
//
// DS4 S4 R3 — `compact` (default false): the phone layout's one-line-per-wave
// mode. `compact` false must render byte-identical to before this prop
// existed, so every new branch below only widens what already guarded
// `wave.kind === 'past'`/`'current'`, never replaces it.
import { type LiveMarks, orderLive } from '../lib/liveFocus.js';
import type { WaveInfo } from '../lib/waveList.js';
import ProgressBar from './kit/ProgressBar.vue';
import ProgressBarMini from './kit/ProgressBarMini.vue';
import Tag from './kit/Tag.vue';
import WaveTaskCard from './WaveTaskCard.vue';

withDefaults(
  defineProps<{
    waves: WaveInfo[];
    compact?: boolean;
    marks?: LiveMarks | null;
    storeId?: string;
  }>(),
  { compact: false, marks: null, storeId: undefined },
);
const emit = defineEmits<{ select: [taskId: string] }>();

/** Now and Next cards lead the wave, the rest keep their order. */
function ordered(wave: WaveInfo, marks: LiveMarks | null, storeId: string | undefined) {
  const store = storeId ? { id: storeId, label: storeId } : undefined;
  return orderLive(
    wave.tasks.map((task) => ({ ...task, store })),
    marks,
  );
}

function modifier(kind: WaveInfo['kind']): 'past' | 'cur' | 'next' {
  return kind === 'past' ? 'past' : kind === 'current' ? 'cur' : 'next';
}
</script>

<template>
  <div class="wave-list" :class="{ 'wave-list--compact': compact }">
    <section v-for="wave in waves" :key="wave.index" class="wave" :class="modifier(wave.kind)">
      <div class="whead">
        <span>
          <h3 class="wave__title">Wave {{ wave.index + 1 }} of {{ wave.total }}</h3>
          <span v-if="wave.kind !== 'upcoming'" class="muted small">
            &middot; {{ wave.doneCount }}/{{ wave.taskCount }} done
          </span>
        </span>
        <span class="tb-right">
          <ProgressBarMini
            v-if="compact || wave.kind === 'past'"
            :value="wave.doneCount"
            :max="wave.taskCount"
            tone="success"
            :label="`Wave ${wave.index + 1}, ${wave.doneCount} of ${wave.taskCount} tasks done`"
          />
          <Tag :tone="wave.kind === 'past' ? 'done' : wave.kind === 'current' ? 'progress' : 'todo'" size="sm">
            {{ wave.kind === 'past' ? 'Done' : wave.kind === 'current' ? 'Running' : 'Upcoming' }}
          </Tag>
        </span>
      </div>

      <template v-if="!compact && wave.kind === 'current'">
        <div class="barrow">
          <ProgressBar :segments="[{ tone: 'success', value: wave.pct }]" :label="`Wave ${wave.index + 1} progress`" />
          <span class="pnum bar-pct">{{ wave.pct }}%</span>
        </div>
        <div class="wave-list__cards">
          <WaveTaskCard
            v-for="task in ordered(wave, marks, storeId)"
            :key="task.taskId"
            :task="task"
            :marks="marks"
            :store-id="storeId"
            @select="emit('select', $event)"
          />
        </div>
      </template>
    </section>
  </div>
</template>
