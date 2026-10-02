<script setup lang="ts">
// DS4 S3 §2 — WaveList: one <section> per wave (past, current, upcoming),
// each with a visible heading. Used by EpicBlock in both phase mode (behind
// the "Show waves" toggle) and epic mode (always shown, no toggle).
//
// DS4 S4 R3 — `compact` (default false): the phone layout's one-line-per-wave
// mode. `compact` false must render byte-identical to before this prop
// existed, so every new branch below only widens what already guarded
// `wave.kind === 'past'`/`'current'`, never replaces it.
import type { WaveInfo } from '../lib/waveList.js';
import ProgressBar from './kit/ProgressBar.vue';
import ProgressBarMini from './kit/ProgressBarMini.vue';
import Tag from './kit/Tag.vue';
import WaveTaskCard from './WaveTaskCard.vue';

withDefaults(defineProps<{ waves: WaveInfo[]; compact?: boolean }>(), { compact: false });
const emit = defineEmits<{ select: [taskId: string] }>();

function modifier(kind: WaveInfo['kind']): 'past' | 'cur' | 'next' {
  return kind === 'past' ? 'past' : kind === 'current' ? 'cur' : 'next';
}
</script>

<template>
  <div class="wave-list">
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
          <WaveTaskCard v-for="task in wave.tasks" :key="task.taskId" :task="task" @select="emit('select', $event)" />
        </div>
      </template>
    </section>
  </div>
</template>
