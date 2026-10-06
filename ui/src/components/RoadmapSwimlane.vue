<script setup lang="ts">
// DS4 S2 — the roadmap swimlane (signed-off spec §1). Plain horizontal
// tracks, no VueFlow: one `.lrow` button per phase (`?phase=`), one indented
// `.lrow.sub` button per epic (`?epic=`), always visible — the "Show waves"
// collapse is S3, not this slice. `rm-scroll` is the only region that
// scrolls sideways; the page around it never does.
//
// UI spec Part 2 — rows come grouped: one `role="group"` per lane (a phase
// row and its epic rows), lanes in regions. A side region carries the id its
// disclosure's `aria-controls` names (RoadmapProjectSection.vue); the current
// lane's group reads `aria-current="step"` and its head row a "Current" Tag —
// separate from the selection's `.sel`/`aria-current="true"`.
import { computed } from 'vue';
import type { Swimlane } from '../lib/roadmapSwimlane.js';
import { groupLanes, type LaneRegion } from '../lib/roadmapWindow.js';
import Tag from './kit/Tag.vue';

const props = defineProps<{
  swimlane: Swimlane;
  selectedPhase: string | null;
  selectedEpic: string | null;
  /** Absent: every row is one region with no id (the swimlane unwindowed). */
  regions?: LaneRegion[];
  currentLane?: string | null;
  /** Names the scroll region when several swimlanes share the page. */
  project?: string;
}>();

// A mark centred on a tick near the right end overhangs the track by half its
// own width (the label is a fixed ~40px, so the narrower the track, the larger
// that share). From this percent on the label ends at its tick instead.
const AXIS_END_ALIGN_FROM = 90;

const emit = defineEmits<{ selectPhase: [string]; selectEpic: [string] }>();

const shownRegions = computed<LaneRegion[]>(
  () => props.regions ?? [{ id: null, lanes: groupLanes(props.swimlane.rows) }],
);
const scrollLabel = computed(() =>
  props.project ? `${props.project} roadmap, scrolls sideways` : 'Roadmap, scrolls sideways',
);
</script>

<template>
  <div class="rm-scroll" tabindex="0" role="region" :aria-label="scrollLabel">
    <div v-if="swimlane.months.length > 0" class="months" aria-hidden="true">
      <span />
      <div class="months-row">
        <span
          v-for="m in swimlane.months"
          :key="`${m.label}:${m.left}`"
          class="months-mark"
          :class="{ 'months-mark--end': m.left >= AXIS_END_ALIGN_FROM }"
          :style="{ left: `${m.left}%` }"
          >{{ m.label }}</span
        >
      </div>
    </div>
    <div class="lane" aria-label="Roadmap">
      <div class="now-track" aria-hidden="true">
        <span />
        <div class="now-track__col">
          <span class="nowline" :style="{ left: `${swimlane.nowOffset}%` }">
            <span class="nowline__dot" />
            <span class="nowline__label">Now</span>
          </span>
        </div>
      </div>
      <div
        v-for="(region, r) in shownRegions"
        :id="region.id ?? undefined"
        :key="region.id ?? `window-${r}`"
        class="lane-region"
      >
        <div
          v-for="group in region.lanes"
          :key="`${group.head.kind}:${group.head.id}`"
          class="lane-group"
          role="group"
          :aria-label="group.head.label"
          :aria-current="group.head.id === currentLane ? 'step' : undefined"
        >
          <button
            v-for="row in group.rows"
            :key="`${row.kind}:${row.id}`"
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
            <span class="lhead">
              <span class="lname" :title="row.label">{{ row.label }}</span>
              <Tag v-if="row === group.head && row.id === currentLane" tone="progress" size="sm">Current</Tag>
            </span>
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
        </div>
      </div>
    </div>
  </div>
</template>
