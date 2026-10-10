<script setup lang="ts">
// UI spec Part 2 — one project's slice of the Roadmap: an h2 head (the
// NeedsYouInbox group-head look, one level up) with the muted done count, the
// windowed swimlane (1 lane before the current one, the current one, 2 after)
// and the "Show N earlier/later lanes" disclosures. The window and the
// current-lane rule are roadmapWindow.ts; the expand state is the page's
// (expandedRows.ts, sessionStorage), so a deep link can open a side too. The
// page sets the selection's EpicBlock right after the section holding it.
//
// Below 640px the section is a <details> with a 44px <summary> (the page opens
// the running one and the one holding the selection), the swimlane gives way
// to a picker over the shown lanes, and the disclosures widen that picker's
// options, so on phone they name the picker in `aria-controls`.
import { computed } from 'vue';
import { useViewport } from '../composables/useViewport.js';
import { pickerSelection, withIdleLabels } from '../lib/epicPicker.js';
import {
  disclosureLabel,
  type LiveEpics,
  laneOptions,
  type RoadmapSection,
  sectionSwimlane,
  type WindowSide,
  windowPickerId,
  windowRegionId,
} from '../lib/roadmapWindow.js';
import Select from './kit/Select.vue';
import RoadmapLegend from './RoadmapLegend.vue';
import RoadmapSwimlane from './RoadmapSwimlane.vue';

const props = defineProps<{
  section: RoadmapSection;
  /** False when the page is scoped to one project: the topbar names it already. */
  showHeading: boolean;
  expanded: { earlier: boolean; later: boolean };
  selectedPhase: string | null;
  selectedEpic: string | null;
  /** The selection's lane is in this section, shown or hidden: open on phone. */
  hostsSelection: boolean;
  pickerLabel: string;
  /** The page's one status legend sits under this section. */
  showLegend?: boolean;
  /** Epic id -> "idle 18d", for the idle epics only. */
  idleLabels: Record<string, string>;
  /** The epics a live session is on; each reads Current. */
  live?: LiveEpics | null;
  /** A live epic's block sits under this section: open on phone. */
  hasLiveBlock?: boolean;
  /** Some epic on the page is live (`pageHasLive`): only live lanes are marked, here too. */
  pageLive?: boolean;
}>();

// selectPhase/selectEpic carry the picked id and the id of the store the
// section reads from (undefined on a single-store payload). openChange: the
// phone <details> opened or closed; what sits under the section follows it.
const emit = defineEmits<{
  toggle: [WindowSide];
  selectPhase: [string, string | undefined];
  selectEpic: [string, string | undefined];
  openChange: [boolean];
}>();

const { isPhoneWidth } = useViewport();

const view = computed(() =>
  sectionSwimlane(props.section, props.expanded, new Date(), props.live, props.pageLive),
);

// DS4 S4 R4 — phase mode only: with an epic of this section selected, the
// EpicBlock's back link stands in for the picker. A phase-less section's
// lanes are epics, so its picker stays.
const showPicker = computed(
  () => props.section.kind === 'epic' || !(props.hostsSelection && props.selectedEpic !== null),
);
const pickerValue = computed(
  () => (props.section.kind === 'phase' ? props.selectedPhase : props.selectedEpic) ?? '',
);
const pickerOptions = computed(() => {
  const options = withIdleLabels(
    laneOptions(view.value.regions, view.value.currentLanes),
    props.idleLabels,
  );
  if (pickerSelection(pickerValue.value, options) !== '') return options;
  // The selection lives in another section (or nowhere): a placeholder, so
  // the select never silently shows a lane that is not selected.
  return [
    { value: '', label: props.section.kind === 'phase' ? 'Pick a phase' : 'Pick an epic' },
    ...options,
  ];
});

const effectivePickerValue = computed(() =>
  pickerSelection(pickerValue.value, pickerOptions.value),
);

function onPick(value: string) {
  if (value === '') return;
  if (props.section.kind === 'phase') emit('selectPhase', value, props.section.store?.id);
  else emit('selectEpic', value, props.section.store?.id);
}

function onToggle(e: Event) {
  if (e.target === e.currentTarget) emit('openChange', (e.target as HTMLDetailsElement).open);
}

/** A side's disclosure, absent when that side hides nothing (or the picker is out). */
function disclosure(side: WindowSide) {
  const hidden = props.section.window[side].length;
  if (hidden === 0 || (isPhoneWidth.value && !showPicker.value)) return null;
  return {
    expanded: props.expanded[side],
    controls: isPhoneWidth.value
      ? windowPickerId(props.section.key)
      : windowRegionId(props.section.key, side),
    label: disclosureLabel(side, hidden, props.expanded[side]),
  };
}
const earlier = computed(() => disclosure('earlier'));
const later = computed(() => disclosure('later'));
</script>

<template>
  <component
    :is="isPhoneWidth && showHeading ? 'details' : 'section'"
    class="bs-inbox__group rm-section"
    :open="isPhoneWidth && showHeading ? section.running || hostsSelection || hasLiveBlock : undefined"
    @toggle="onToggle"
  >
    <component
      :is="isPhoneWidth ? 'summary' : 'h2'"
      v-if="showHeading"
      class="bs-inbox__group-head rm-section__head"
    >
      {{ section.title }}
      <span v-if="section.countLabel" class="rm-section__count">{{ section.countLabel }}</span>
    </component>

    <button
      v-if="earlier"
      type="button"
      class="bs-kanban-col__more rm-window__more"
      :aria-expanded="earlier.expanded"
      :aria-controls="earlier.controls"
      @click="emit('toggle', 'earlier')"
    >
      {{ earlier.label }}
    </button>

    <RoadmapSwimlane
      v-if="!isPhoneWidth"
      :swimlane="view.swimlane"
      :regions="view.regions"
      :current-lanes="view.currentLanes"
      :live-epics="view.liveEpics"
      :project="showHeading ? section.title : undefined"
      :selected-phase="selectedPhase"
      :selected-epic="selectedEpic"
      :idle-labels="idleLabels"
      @select-phase="(id) => emit('selectPhase', id, section.store?.id)"
      @select-epic="(id) => emit('selectEpic', id, section.store?.id)"
    />
    <Select
      v-else-if="showPicker"
      :id="windowPickerId(section.key)"
      class="bs-roadmap-mobile__phase-select"
      :model-value="effectivePickerValue"
      :options="pickerOptions"
      :aria-label="pickerLabel"
      @update:model-value="onPick"
    />

    <button
      v-if="later"
      type="button"
      class="bs-kanban-col__more rm-window__more"
      :aria-expanded="later.expanded"
      :aria-controls="later.controls"
      @click="emit('toggle', 'later')"
    >
      {{ later.label }}
    </button>

    <RoadmapLegend v-if="showLegend" />
  </component>
</template>
