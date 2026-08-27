<script setup lang="ts">
// Projects hub (Phase 6b, operator requirement) — app default route (`/`
// redirects here). One card per project: live agents, open findings by
// severity, current epic + milestone progress, last activity, budget burn,
// epic identity chips (operator directive 2).
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import CommandHint, { type CommandHintItem } from '../components/CommandHint.vue';
import Banner from '../components/ds/Banner.vue';
import Card from '../components/ds/Card.vue';
import EmptyState from '../components/ds/EmptyState.vue';
import PageHeader from '../components/ds/PageHeader.vue';
import Skeleton from '../components/ds/Skeleton.vue';
import IdentityChip from '../components/IdentityChip.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { fetchOverview, type OverviewResult, type ProjectOverviewSummary } from '../lib/api.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import { pluralize } from '../lib/format.js';

const router = useRouter();
const { setBreadcrumb } = useBreadcrumb();
setBreadcrumb([{ label: 'Projects' }]);

const overview = ref<OverviewResult | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);

async function load() {
  // Cleared on success, not on attempt. `load()` never re-raises `loading`,
  // so clearing it up front meant the operator's own Retry click dropped the
  // banner and left the page on the empty state alone -- the failure erased
  // by the gesture asking to retry it (D-226).
  try {
    overview.value = await fetchOverview();
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const projects = computed<ProjectOverviewSummary[]>(() => overview.value?.projects ?? []);
/** The fetch's own verdict. `!loading` is not it: loading goes false on failure too. */
const loaded = computed(() => overview.value !== null);

function budgetPct(p: ProjectOverviewSummary): number | null {
  if (!p.tokensBudget || p.tokensBudget === 0) return null;
  return Math.round((p.tokensSpent / p.tokensBudget) * 100);
}

function goToProject(project: string) {
  router.push({ name: 'overview-project', params: { project } });
}

// Operator directive (Phase 6b round 10): "hoặc trong Projects với command
// /bs new để tạo project mới". This page is a hub with no "new project"
// affordance, because creating one is not something the dashboard can do —
// `smith new` scaffolds a repo on disk. Naming the command is the honest
// version of that button. Descriptions follow .claude/skills/bs/SKILL.md.
const newProjectCommands: CommandHintItem[] = [
  { cmd: '/bs new <project>', desc: 'Scaffold a new project from the stack answers' },
  { cmd: '/bs new <project> --ui', desc: 'Same, plus the frontend and design system answered for' },
  { cmd: '/bs mcp <project>', desc: 'Layer the MCP surface on at the closing milestone' },
];
</script>

<template>
  <div class="app-page">
    <PageHeader title="Projects" description="One card per project, the factory's multi-project hub." />

    <Banner v-if="error" tone="danger" show-retry @retry="load">{{ error }}</Banner>

    <template v-if="loading">
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: var(--ds-space-4)">
        <Skeleton v-for="i in 3" :key="i" height="180" />
      </div>
    </template>

    <!-- This hub is the app's default route, and the sentence below is a
         claim about the whole event log. It may only be made once the fetch
         behind it has landed (D-226). -->
    <EmptyState v-else-if="canClaimEmpty(loaded, projects.length)" icon="layers">
      No projects yet. Every event ever logged is untagged (defaults to "black-smith").
    </EmptyState>

    <div
      v-else-if="loaded"
      style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: var(--ds-space-4)"
    >
      <Card
        v-for="p in projects"
        :key="p.project"
        role="link"
        tabindex="0"
        :aria-label="`${p.project} project, opens overview`"
        style="cursor: pointer"
        @click="goToProject(p.project)"
        @keydown.enter="goToProject(p.project)"
      >
        <template #action>
          <IdentityChip :id="p.project" />
        </template>
        <!-- Bug fix (Phase 6b round 7, token-existence check): --ds-text-lg
             doesn't exist in ds-tokens.css's scale (xs/sm/base/xl/2xl,
             no "lg" step) — an invalid custom property silently drops to
             the browser's default font-size instead of failing loudly.
             --ds-text-xl is the real next size up from base. -->
        <div style="font-weight: var(--ds-weight-semibold); font-size: var(--ds-text-xl)">{{ p.project }}</div>
        <div class="project-card__stats">
          <div class="project-card__stat">
            <span class="project-card__stat-value">{{ p.liveAgentCount }}</span>
            <span class="project-card__stat-label">{{ pluralize(p.liveAgentCount, 'live agent') }}</span>
          </div>
          <div class="project-card__stat">
            <span class="project-card__stat-value">{{ p.epicsInFlight.length }}</span>
            <span class="project-card__stat-label">{{ pluralize(p.epicsInFlight.length, 'epic in flight', 'epics in flight') }}</span>
          </div>
          <div class="project-card__stat">
            <span class="project-card__stat-value">{{ p.alerts.escalations + p.alerts.pendingWaivers }}</span>
            <span class="project-card__stat-label">pending review</span>
          </div>
          <div class="project-card__stat">
            <span class="project-card__stat-value">{{ budgetPct(p) === null ? '-' : `${budgetPct(p)}%` }}</span>
            <span class="project-card__stat-label">budget used</span>
          </div>
        </div>
        <div v-if="p.epicsInFlight.length > 0" style="display: flex; flex-wrap: wrap; gap: var(--ds-space-1); margin-top: var(--ds-space-3)">
          <IdentityChip v-for="epicId in p.epicsInFlight" :key="epicId" :id="epicId" />
        </div>
      </Card>
    </div>

    <!-- Rendered in both the populated and the empty case: on a fresh install
         this is the first thing there is to do, and it stays useful after. -->
    <Card v-if="!loading" title="Start a new project">
      <CommandHint :items="newProjectCommands" />
    </Card>
  </div>
</template>
