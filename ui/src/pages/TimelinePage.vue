<script setup lang="ts">
// Timeline — design-spec.md §5.2. Polls every 15s, paused when the tab is
// hidden (usePoll), plus a manual Refresh Button.
//
// Deviation, flagged: the Select filters (agent role / provider / event
// type) and FilterChips (case / severity / plan_version) described in §5.2
// are simplified to a text search (matches prompt text, per §5.2's own
// "Search matches prompt text and dispatch reason") plus an event-kind
// FilterChips row — timeline() doesn't expose agent/provider as separate
// filterable columns on every event kind (they're only present on
// dispatch_decision payloads), and case/severity live inside the payload's
// per-kind JSON, not a queryable top-level field. Recorded in DESIGN.md.
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import CausalTimelineList from '../components/CausalTimelineList.vue';
import Banner from '../components/ds/Banner.vue';
import Button from '../components/ds/Button.vue';
import EmptyState from '../components/ds/EmptyState.vue';
import FilterChips from '../components/ds/FilterChips.vue';
import Icon from '../components/ds/Icon.vue';
import PageHeader from '../components/ds/PageHeader.vue';
import Skeleton from '../components/ds/Skeleton.vue';
import Toolbar from '../components/ds/Toolbar.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { usePoll } from '../composables/usePoll.js';
import { useProjectContext } from '../composables/useProjectContext.js';
import { useSessionContext } from '../composables/useSessionContext.js';
import { fetchTimeline, type TimelineEntry } from '../lib/api.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import { KIND_OPTIONS, matchesKind, titleFor } from '../lib/timelineDisplay.js';

const router = useRouter();
const { setBreadcrumb } = useBreadcrumb();
setBreadcrumb([{ label: 'Timeline' }]);
const { project } = useProjectContext();
const { sessionScope, sessionKey } = useSessionContext();

/** Null until a fetch lands. That distinction is the whole guard on the empty state below. */
const entries = ref<TimelineEntry[] | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);
const search = ref('');
const kindFilter = ref<string[]>([]);
const expanded = ref<Set<string>>(new Set());
// "Decisions" lens (Phase 6b design-spec addendum): user prompts +
// operator-authored decision events — waivers, lesson status changes, and the
// operator's own notes (D-213) — + their causally-attached dispatches.
const decisionsOnly = ref(false);

async function load() {
  // Cleared on success, not on attempt. This page polls, so `load()` re-runs
  // unattended every 15s (and again the moment the tab regains focus): during
  // an outage every one of those attempts wiped the banner for the length of
  // its own flight, leaving the bare empty state in its place (D-226).
  try {
    entries.value = await fetchTimeline({
      session: sessionScope.value,
      project: project.value,
      decisionsOnly: decisionsOnly.value,
    });
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch([project, sessionKey, decisionsOnly], load);
const { refresh } = usePoll(load, 15000);

function matchesSearch(entry: TimelineEntry): boolean {
  if (!search.value.trim()) return true;
  const needle = search.value.toLowerCase();
  const p = entry.payload as { prompt?: string; text?: string; reason?: string };
  return (
    (p.prompt ?? p.text ?? '').toLowerCase().includes(needle) ||
    (p.reason ?? '').toLowerCase().includes(needle) ||
    titleFor(entry).toLowerCase().includes(needle)
  );
}

const filtered = computed(() =>
  (entries.value ?? []).filter((e) => matchesKind(e, kindFilter.value) && matchesSearch(e)),
);
const filtersActive = computed(() => search.value.trim() !== '' || kindFilter.value.length > 0);

function clearFilters() {
  search.value = '';
  kindFilter.value = [];
}

function toggleExpanded(eventId: string) {
  const next = new Set(expanded.value);
  if (next.has(eventId)) next.delete(eventId);
  else next.add(eventId);
  expanded.value = next;
}

function goToTask(taskId: string) {
  router.push(`/tasks/${encodeURIComponent(taskId)}`);
}
</script>

<template>
  <div class="app-page">
    <PageHeader title="Timeline" />

    <Toolbar :count="`${filtered.length} events`">
      <label style="display: flex; align-items: center; gap: var(--ds-space-1-5)">
        <Icon name="search" :size="14" />
        <input
          v-model="search"
          type="search"
          placeholder="Search prompts/reasons"
          aria-label="Search prompts and dispatch reasons"
          class="raw-input"
          style="width: 256px; border: 1px solid var(--ds-border); border-radius: var(--ds-radius-control); height: var(--ds-control-height); padding: 0 var(--ds-space-2); background: var(--ds-surface); color: var(--ds-text)"
        />
      </label>
      <template #end>
        <Button
          :variant="decisionsOnly ? 'secondary' : 'outline'"
          size="sm"
          icon="scale"
          :aria-pressed="decisionsOnly"
          @click="decisionsOnly = !decisionsOnly"
        >
          Decisions
        </Button>
        <Button variant="ghost" size="sm" icon="refresh-cw" @click="refresh">Refresh</Button>
      </template>
    </Toolbar>
    <FilterChips :options="KIND_OPTIONS" v-model="kindFilter" @clear="clearFilters" />

    <Banner v-if="error" tone="danger" show-retry @retry="load">{{ error }}</Banner>

    <template v-else-if="loading">
      <!-- ds-allow-hardcode:start — 28px matches .timeline-row__icon's own
           fixed icon-circle diameter (ds-components.css); no token models
           a specific icon-circle size. -->
      <div v-for="i in 6" :key="i" style="display: flex; gap: var(--ds-space-2); padding: var(--ds-space-2) 0">
        <Skeleton width="28px" height="28px" radius="var(--ds-radius-pill)" /><!-- ds-allow-hardcode:end -->
        <div style="flex: 1; display: flex; flex-direction: column; gap: var(--ds-space-1)">
          <Skeleton height="14" />
          <Skeleton width="40%" height="12" />
        </div>
      </div>
    </template>

    <EmptyState v-else-if="canClaimEmpty(entries !== null, filtered.length)" icon="history">
      No events match these filters.
      <template v-if="filtersActive" #action>
        <Button variant="ghost" size="sm" @click="clearFilters">Clear filters</Button>
      </template>
    </EmptyState>

    <CausalTimelineList v-else-if="entries !== null" :entries="filtered" :expanded="expanded" @toggle="toggleExpanded" @select="goToTask" />
  </div>
</template>
