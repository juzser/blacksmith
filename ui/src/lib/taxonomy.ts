// Taxonomy → Lozenge tone/variant mapping, copied verbatim from
// ui/docs/design-spec.md §3 (the "governing rule, stated once, applied
// everywhere"). Evaluative dimensions get a colour-coded status tone;
// descriptive dimensions render as plain outline pills — never a status
// colour. This module is the single place that mapping lives; pages must
// call it rather than re-deriving tones ad hoc.
export type Tone = 'info' | 'success' | 'warning' | 'danger' | 'discovery' | 'neutral';
// Only variants Lozenge.vue can actually render belong here: `subtle` and
// `bold` are the two the component's `style` computed handles (and the only
// two that apply `tone` at all), `outline` is served by a .hds-loz--outline
// rule. A fourth member, `solid`, was declared here and rendered by neither
// channel — see D-217. hdsVariants.test.ts holds the union to that rule.
export type LozengeVariant = 'subtle' | 'bold' | 'outline';

export interface ToneMapping {
  tone: Tone;
  variant: 'subtle' | 'bold';
}

const TASK_STATUS_TONE: Record<string, Tone> = {
  todo: 'neutral',
  ready: 'neutral',
  'in-progress': 'info',
  grading: 'info',
  reviewing: 'info',
  merging: 'info',
  blocked: 'warning',
  escalated: 'warning',
  completed: 'success',
  waived: 'success',
  failed: 'danger',
  superseded: 'neutral',
};

const PLAN_STATUS_TONE: Record<string, Tone> = {
  draft: 'neutral',
  'in-review': 'info',
  active: 'success',
  superseded: 'neutral',
};

const RUN_STATUS_TONE: Record<string, Tone> = {
  queued: 'neutral',
  running: 'info',
  done: 'success',
  dead: 'danger',
};

const FINDING_STATUS_TONE: Record<string, Tone> = {
  raised: 'info',
  'fix-pending': 'info',
  'fix-landed': 'info',
  confirmed: 'warning',
  // D-127. `amend-pending` is open and blocking — the plan amendment is cut but
  // the tasks it obligates have not landed — so it reads like `confirmed`, not
  // like a close. `amended` is the one terminal exit an S1/S2 spec finding has.
  'amend-pending': 'warning',
  amended: 'success',
  'fix-verified': 'success',
  waived: 'success',
  refuted: 'neutral',
  expired: 'neutral',
};

const LESSON_STATUS_TONE: Record<string, Tone> = {
  candidate: 'neutral',
  'novelty-rejected': 'neutral',
  superseded: 'neutral',
  'pending-approval': 'warning',
  approved: 'success',
  invalidated: 'danger',
};

/**
 * Fix-round (uiux S2 #3): roadmap.md milestones carry `MilestoneStatus`
 * (`planned` | `in-progress` | `completed` — factory/orchestrator/src/
 * roadmap.ts's own, SEPARATE closed set, not taxonomy.yml's `plan_status`
 * — a roadmap phase isn't a plan or a task, per roadmap.ts's own header
 * comment). RoadmapPage.vue was calling `planStatusTone()` against this
 * different vocabulary — none of its 3 values match `plan_status`'s
 * (`draft`/`in-review`/`active`/`superseded`), so every milestone rendered
 * the `?? 'neutral'` fallback regardless of actual status. This map (and
 * `milestoneStatusTone()`) is the correct one; taxonomy.test.ts asserts it
 * covers roadmap.ts's `MILESTONE_STATUSES` exactly, so a future value added
 * to one and not the other fails a test instead of silently graying out.
 */
// Exported (not just the function) so taxonomy.test.ts can assert its key
// set against roadmap.ts's MILESTONE_STATUSES without duplicating the list.
export const MILESTONE_STATUS_TONE: Record<string, Tone> = {
  planned: 'neutral',
  'in-progress': 'info',
  completed: 'success',
};

/**
 * Fix-round (uiux S2 #5, caught while building the Task detail rail):
 * agents-registry.ts's `AgentStatus` (`live`/`done`/`error`/`superseded`/
 * `abandoned`) is ALSO not `run_status` (`queued`/`running`/`done`/`dead`) — same
 * "different vocabulary, same-looking name" trap as #3 above. Exported +
 * drift-tested against `agents-registry.ts`'s `AGENT_STATUSES`.
 */
export const AGENT_STATUS_TONE: Record<string, Tone> = {
  live: 'info',
  done: 'success',
  error: 'danger',
  superseded: 'neutral',
  // Open when its epic closed (D-187): bookkeeping the run outran, not a
  // failure of the agent — same neutral reading as a supersede.
  abandoned: 'neutral',
};

export function taskStatusTone(status: string): Tone {
  return TASK_STATUS_TONE[status] ?? 'neutral';
}

/**
 * What a task_status says about the task's *outcome*, as opposed to its
 * colour. Only `passed` and `failed` are a verdict: a rate computed over
 * task_status has to know which statuses are an answer, which are still
 * running, and which will never answer at all.
 *
 * `passed` is the {completed, waived} pair that queries.ts's
 * MILESTONE_COMPLETE_TASK_STATUSES and epic.ts's TERMINAL_OK_TASK_STATUSES
 * each already declare — a waived task landed on the team's own decision, so
 * counting only `completed` reports a pass as a non-event. `superseded` is
 * `void` rather than `failed`: a task replaced by a newer plan version never
 * got a verdict, and charging it as a failure invents one.
 *
 * taxonomy.test.ts holds these keys to taxonomy.yml's task_status list, so a
 * thirteenth status cannot land without a decision about what it means here.
 */
export type TaskOutcome = 'passed' | 'failed' | 'open' | 'void';

export const TASK_STATUS_OUTCOME: Record<string, TaskOutcome> = {
  todo: 'open',
  ready: 'open',
  'in-progress': 'open',
  grading: 'open',
  reviewing: 'open',
  merging: 'open',
  blocked: 'open',
  escalated: 'open',
  completed: 'passed',
  waived: 'passed',
  failed: 'failed',
  superseded: 'void',
};

/** Unknown statuses read as `open`: an unrecognised status is not a verdict. */
export function taskOutcome(status: string): TaskOutcome {
  return TASK_STATUS_OUTCOME[status] ?? 'open';
}
export function planStatusTone(status: string): Tone {
  return PLAN_STATUS_TONE[status] ?? 'neutral';
}
/** roadmap.md milestone status -> tone (NOT plan_status — see MILESTONE_STATUS_TONE's comment). */
export function milestoneStatusTone(status: string): Tone {
  return MILESTONE_STATUS_TONE[status] ?? 'neutral';
}
/** agents.status (see `AGENT_STATUSES`) -> tone — NOT run_status. */
export function agentStatusTone(status: string): Tone {
  return AGENT_STATUS_TONE[status] ?? 'neutral';
}
export function runStatusTone(status: string): Tone {
  return RUN_STATUS_TONE[status] ?? 'neutral';
}
export function findingStatusTone(status: string): Tone {
  return FINDING_STATUS_TONE[status] ?? 'neutral';
}
export function lessonStatusTone(status: string): Tone {
  return LESSON_STATUS_TONE[status] ?? 'neutral';
}

/** §3.4 severity → tone + variant (S1 is the one "bold" — a danger wall). */
export function severityTone(severity: string): ToneMapping {
  switch (severity) {
    case 'S1-stop-the-line':
      return { tone: 'danger', variant: 'bold' };
    case 'S2-major':
      return { tone: 'danger', variant: 'subtle' };
    case 'S3-minor':
      return { tone: 'warning', variant: 'subtle' };
    case 'S4-nit':
      return { tone: 'neutral', variant: 'subtle' };
    default:
      return { tone: 'neutral', variant: 'subtle' };
  }
}

/** §3.7 error group.class → icon name (never a colour Lozenge). */
const ERROR_GROUP_ICON: Record<string, string> = {
  spec: 'file-text',
  contract: 'file-check',
  execution: 'play',
  integration: 'git-merge',
  economy: 'coins',
  judgment: 'scale',
  coordination: 'users',
  memory: 'database',
};

export function errorGroupIcon(group: string): string {
  return ERROR_GROUP_ICON[group] ?? 'file-text';
}
