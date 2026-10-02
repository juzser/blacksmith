<script setup lang="ts">
// DS4 S2 — the roadmap swimlane (signed-off spec §1). Plain horizontal
// tracks, no VueFlow: one `.lrow` button per phase (`?phase=`), one indented
// `.lrow.sub` button per epic (`?epic=`), always visible — the "Show waves"
// collapse is S3, not this slice. `rm-scroll` is the only region that
// scrolls sideways; the page around it never does.
import type { Swimlane } from '../lib/roadmapSwimlane.js';

defineProps<{
  swimlane: Swimlane;
  selectedPhase: string | null;
  selectedEpic: string | null;
}>();

const emit = defineEmits<{ selectPhase: [string]; selectEpic: [string] }>();
</script>

<template>
  <div class="rm-scroll" tabindex="0" role="region" aria-label="Roadmap, scrolls sideways">
    <div class="lane" aria-label="Roadmap">
      <span class="nowline" aria-hidden="true" :style="{ left: `${swimlane.nowOffset}%` }" />
      <template v-for="row in swimlane.rows" :key="`${row.kind}:${row.id}`">
        <button
          type="button"
          class="lrow"
          :class="{
            sub: row.kind === 'epic',
            sel: row.kind === 'phase' ? selectedPhase === row.id : selectedEpic === row.id,
          }"
          :aria-current="
            (row.kind === 'phase' ? selectedPhase === row.id : selectedEpic === row.id) ? 'true' : undefined
          "
          @click="row.kind === 'phase' ? emit('selectPhase', row.id) : emit('selectEpic', row.id)"
        >
          <span class="lname">{{ row.label }}</span>
          <div class="track">
            <span
              v-if="row.bar"
              class="lbar"
              :class="row.bar.state === 'upcoming' ? 'up' : row.bar.state"
              :style="{ left: `${row.bar.left}%`, width: `${row.bar.width}%` }"
            />
            <span v-else class="lbar-unscheduled">Not scheduled</span>
          </div>
        </button>
      </template>
    </div>
  </div>
</template>
