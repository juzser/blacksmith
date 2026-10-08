// The bs-mod contract: what the mod keeps in `$.state`, and the shapes its
// pure fold (hooks/fold.ts) hands the drawing.

export type Tone = 'ok' | 'bad' | 'warn' | 'info'

export type TaskView = {
  status: string
  title: string
  /** null until a `task-added` names the task: a row minted by an admission, gate, merge or supersede, as Blacksmith projector.ts touch() mints it */
  origin: string | null
  /** the plan version its last `task-added` carried, kept across a re-emit that omits it; null when none did */
  planVersion: number | null
}

/** An open finding, plus the obligation an amend-pending move names (Blacksmith D-127). */
export type FindingView = {
  severity: string
  status: string
  /** the task ids the amendment must land, as the transition spelled them; a non-string entry is kept as '' */
  amendsTaskIds?: string[]
  /** the plan version every amended task must land at or past */
  amendsPlanVersion?: number
}

export type AgentView = { taskId: string; role: string; since: number; model: string }

/** One wave session (`<epic>-w4-<date>`): its wave-runner is live while the session writes (silent ≤ WAVE_IDLE_MS) and a task it owns is open. */
export type WaveView = {
  /** first event ts of the current run: the event that broke a silence over WAVE_IDLE_MS, else the session's first */
  since: number
  /** latest event ts seen in the session */
  seen: number
  /** epic-prefixed task ids its events carried, reserved refs (`integration`, `plan-vN`) left out */
  tasks: string[]
  /** ts of the newest `wave-merged` in the session; absent before it merged, and in a hud persisted before merges were timed */
  merged?: number
}

export type Activity = { ts: number; text: string; tone: Tone }

export type Budget = { cap: number; projected: number; status: string }

/** An operator prompt some work descends from: its `user_prompt` ts and its text on one line, cut to PROMPT_CHARS plus `…`. */
export type PromptView = { ts: number; text: string }

/** One `wave-admitted`: when, the epic-prefixed task ids it admitted, and the ref of the prompt its causal chain reaches (null when none). */
export type AdmissionView = {
  ts: number
  taskIds: string[]
  prompt: string | null
  /** the epic's waveMax when the admission landed: a wave session numbered at least this, started after it, runs it; absent in admissions kept before */
  waveMaxAt?: number
}

export type EpicView = {
  epicId: string
  /** wave-admitted events seen for the epic */
  admitted: number
  /** highest wave number in a wave session id (`<epic>-w7-<date>`, `-wave-3-`, `-w2-takeover-`), 0 when none */
  waveMax: number
  waveTaskIds: string[]
  tasks: Record<string, TaskView>
  /** open dispatches, keyed `<task id>|<role>`; wave-runners live in `waves`, not here */
  agents: Record<string, AgentView>
  /** one per wave session, keyed by wave label: `w4`, `w1r`, `w3` for `wave-3`; a takeover or land session of wave 6 is `w6` */
  waves: Record<string, WaveView>
  /** task id → label of the wave that touched it last, its owner: a takeover moves a task to the later wave */
  taskWave: Record<string, string>
  budget: Budget | null
  /** the tier (`small` / `medium` / `huge`) of the newest `wave-admitted` whose `budget.tier` names one; absent before one did */
  admittedTier?: 'small' | 'medium' | 'huge'
  /** task ids whose gate passed with waivers pending */
  pendingWaivers: string[]
  /** open quorum escalations, keyed `<finding|plan|epic>:<fingerprint or task id>` like Blacksmith quorumEscalations.ts, valued by task id ('' when none) */
  escalations: Record<string, string>
  /** open findings: severity (`S2-major`), the status it last moved to (`amend-pending`) and any amendment obligation */
  openFindings: Record<string, FindingView>
  /** superseded task id → the id that replaced it, both epic-prefixed, from `plan-version-created` */
  successors: Record<string, string>
  /** spec-change proposals with no decision, as `<session id>#<line index>` */
  pendingSpecChanges: string[]
  activity: Activity[]
  /** the prompts some admission or task-added reached, keyed by `<session id>#<line index>`; absent in a hud persisted before prompts were kept */
  prompts?: Record<string, PromptView>
  /** every `wave-admitted` in log order; absent in a hud persisted before prompts were kept */
  admissions?: AdmissionView[]
  /** task id → the distinct prompt refs its `task-added` events reached, first seen first; a task none reached has no entry */
  taskPrompts?: Record<string, string[]>
  /** task id → ts of the newest `wave-merged` or `task-superseded` naming it; absent in a hud persisted before these were timed */
  doneAt?: Record<string, number>
  lastTs: number
  isClosed: boolean
  /** a `goal-check-recorded` came and no `wave-admitted` or `plan-version-created` since: the close is under way; absent otherwise */
  isClosing?: boolean
  /** an event of this CLI session belongs to the epic */
  isMine: boolean
}

export type Hud = { epics: Record<string, EpicView> }

/** An epic's latest plan `effort` where Blacksmith latestPlan looks by default, read once at `version` (fold.ts planVersionOf); `tier` null when no plan there names one. */
export type PlanTier = { version: number; tier: 'small' | 'medium' | 'huge' | null }

/** The band's four tabs, in the order the tab row draws them. */
export type BandTab = 'overview' | 'current' | 'next' | 'past'

declare module 'claude-code' {
  interface PluginState {
    'bs-mod': {
      hud: Hud
      pinned: string | null
      isHidden: boolean
      /** the clock's minute, written each tick it changes, so elapsed times redraw */
      minute: number
      /** per shown epic with no admission tier: its plan's effort (fold.ts tierOf's fallback), cached so the plan file is read once per plan version */
      planTiers: Record<string, PlanTier>
      /** the band's active tab; survives a reload, Overview by default */
      tab: BandTab
      /** the `/config` theme, read at session start and on each theme write; null when unread, so the theme keys draw (fold.ts paletteOf) */
      theme: string | null
    }
  }
}
