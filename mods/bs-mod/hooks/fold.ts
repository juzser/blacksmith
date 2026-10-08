// The pure half of bs-mod: folds Blacksmith event-log lines into the views the
// band and pane draw. Task status mirrors factory/orchestrator/src/db/projector.ts
// (`foldTasks`); agents, waits and activity are the HUD's own reading.
import type { AdmissionView, AgentView, BgState, EpicView, FindingView, Hud, PromptView, TaskItem, TaskView, Tone, WaveView } from '../types'
import type { AgentInfo, AgentStatus } from 'claude-code'

export type { BgState, TaskItem }

export type BsEvent = {
  session_id?: string
  actor?: string
  event_type: string
  task_id?: string | null
  payload?: Record<string, unknown>
  cli_session_id?: string | null
  ts?: string
  /** `"<session_id>#<line index>"` of the event that caused this one; see walkToPrompt */
  causal_parent?: string | null
}

export type Notice = { text: string; tone: Tone }

export type Summary = {
  epicId: string
  wave: number
  now: { role: string; task: string; elapsed: string } | null
  agentCount: number
  /** the live agents' roles, newest first */
  roles: string[]
  staleCount: number
  /** the live agents, newest first: open dispatches and one wave-runner per live wave session */
  agents: AgentView[]
  next: string | null
  isWaitingOnYou: boolean
  counts: { done: number; review: number; active: number; todo: number; superseded: number; total: number }
  progress: number
  budget: { cap: number; projected: number; pct: number } | null
  /** decisions only the operator can take */
  waits: { waivers: number; escalations: number; specs: number }
  /** open S1/S2 findings: they block the epic's close, but the factory works them */
  blockers: { total: number; byStatus: Record<string, number> }
  /** amend-pending findings whose amended tasks all landed (Blacksmith D-127 Part B): neither open nor blocking */
  amendsLanded: number
  findings: Record<'S1' | 'S2' | 'S3' | 'S4', number>
  isClosed: boolean
}

// mirror Blacksmith taskStatus.ts TERMINAL_TASK_STATUSES and TERMINAL_OK_TASK_STATUSES
const TERMINAL = new Set(['completed', 'superseded', 'failed', 'escalated', 'waived'])
const LANDED = new Set(['completed', 'waived'])
const CLOSED_FINDING = new Set(['fix-verified', 'waived', 'refuted', 'expired', 'amended'])
// mirrors Blacksmith projector.ts NOTE_ONLY_SEVERITIES: an error at these leaves its task where it is
const NOTE_ONLY = new Set(['S3-minor', 'S4-nit'])
const ACTIVITY_CAP = 30
const STALE_MS = 3 * 3600_000
// a working wave session is rarely silent over an hour; a longer silence is a pause, a takeover or an abandoned wave
export const WAVE_IDLE_MS = 60 * 60_000
const WAVE_RUNNER = 'wave-runner'

export function emptyHud(): Hud {
  return { epics: {} }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

// a wave part is `w4`, `w1r` or `wave-3`, maybe with a word before the date (`w2-takeover-<date>`)
function stripSession(sid: string): string {
  return sid.replace(/-(?:w|wave-)\d+[a-z]?(?:-[a-z]+)?-\d{4}-\d{2}-\d{2}.*$/, '').replace(/-\d{4}-\d{2}-\d{2}.*$/, '')
}

/** A home log's session id prefix (`prompts-<cli id>`): it holds one CLI session's prompts, never an epic's events. */
const HOME_LOG = 'prompts-'

/** An event's epic: its payload `epic_id`, its task id's `<epic>/` prefix, the epic its log file names, then its session id; a home log has none. */
export function epicIdOf(ev: BsEvent, fileEpic?: string | null): string | null {
  const fromPayload = str(ev.payload?.epic_id)
  if (fromPayload) return fromPayload
  const task = str(ev.task_id)
  if (task && task.includes('/')) return task.slice(0, task.indexOf('/'))
  // a session-start names no epic, and a session id may end in a word (`-close-<date>`) no name rule can strip
  if (fileEpic) return fileEpic
  const sid = str(ev.session_id)
  if (sid?.startsWith(HOME_LOG)) return null
  return sid ? stripSession(sid) : null
}

/** A wave session's label: `w4`, `w1r`, `w3` for `wave-3`, `w6` for `-w6-<date>-takeover`; null for the epic's own session. */
export function waveLabel(sessionId: string, epicId = stripSession(sessionId)): string | null {
  const prefix = `${epicId}-`
  if (!sessionId.startsWith(prefix)) return null
  const m = /^(?:w|wave-)(\d+[a-z]?)(?=-|$)/.exec(sessionId.slice(prefix.length))
  return m ? `w${m[1]}` : null
}

export function waveOf(sessionId: string, epicId?: string): number {
  const label = waveLabel(sessionId, epicId)
  return label ? parseInt(label.slice(1), 10) : 0
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function parseBsHome(command: string, cwd: string, home: string): string | null {
  const re = /(?:^|[\s;&|(])(?:export\s+)?(?:BS_HOME|SMITH_HOME)=("[^"]*"|'[^']*'|[^\s;&|)]+)/g
  let last: string | null = null
  for (const m of command.matchAll(re)) last = m[1] ?? null
  if (last === null) return null
  let value = last
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
  if (!value || value.includes('$') || value.includes('`')) return null
  if (value === '~' || value.startsWith('~/')) value = home + value.slice(1)
  if (!value.startsWith('/')) value = `${cwd.replace(/\/$/, '')}/${value.replace(/^\.\//, '')}`
  return value.replace(/\/$/, '')
}

/**
 * `grep -E` for a log's epic: a payload `epic_id`, or a task id with an `<epic>/`
 * prefix. A bare task id or an audit run id has no slash and never matches.
 */
export const EPIC_ERE = '"epic_id":"[^"/]+"|"task_id":"[^"/]+/'

/** Reads `grep -m1 -oE -H -- EPIC_ERE <paths>`: each path's epic, its first hit winning. */
export function epicsFromGrep(stdout: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const ln of stdout.split('\n')) {
    // anchored at the end, so a colon inside the path stays in the path
    const m = /^(.+):"(?:epic_id":"([^"/]+)"|task_id":"([^"/]+)\/)$/.exec(ln)
    const path = m?.[1]
    const epic = m?.[2] ?? m?.[3]
    if (path && epic && !out.has(path)) out.set(path, epic)
  }
  return out
}

/** The epic a log file is named for: its session id less the wave and date; null for a home log. */
export function epicOfFile(name: string): string | null {
  return name.startsWith(HOME_LOG) ? null : stripSession(name.replace(/\.jsonl$/, ''))
}

const CLONE_CLI = /(?:^|[\s;&|(=])([^\s;&|()'"`]*)\/factory\/orchestrator\/dist\/cli\.js\b/g

/**
 * The event directories a Bash command writes to: its declared home's, else
 * each Blacksmith clone whose CLI it runs (a clone writes into itself).
 */
export function parseBsRoots(command: string, cwd: string, home: string): string[] {
  const declared = parseBsHome(command, cwd, home)
  if (declared) return [`${declared}/state/events`]
  const roots = new Set<string>()
  for (const m of command.matchAll(CLONE_CLI)) {
    let root = m[1]
    if (!root || root.includes('$')) continue
    if (root === '~' || root.startsWith('~/')) root = home + root.slice(1)
    if (!root.startsWith('/')) root = `${cwd.replace(/\/$/, '')}/${root.replace(/^\.\//, '')}`
    roots.add(`${root.replace(/\/$/, '')}/state/events`)
  }
  return [...roots]
}

export function splitLines(text: string): { lines: string[]; count: number } {
  const end = text.lastIndexOf('\n')
  if (end < 0) return { lines: [], count: 0 }
  const lines = text.slice(0, end).split('\n')
  return { lines, count: lines.length }
}

export function shortTask(id: string): string {
  const m = /(task-\d+[a-z]?)(?:-|$)/.exec(id)
  if (m?.[1]) return m[1]
  return id.slice(id.lastIndexOf('/') + 1)
}

export function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`
  if (n >= 1_000) return `${trim(n / 1_000)}k`
  return String(Math.round(n))
}

function trim(x: number): string {
  return x >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10)
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/**
 * The colors the band and the pane draw by meaning, each role named by the theme key it stood for; `active` was a
 * teal constant, no theme key being teal; `label` is the soft white of the labels and the Overview (subtext0). The neutrals (text, inverseText, inactive, subtle, dim) stay theme keys.
 */
export type PaletteRole = 'active' | 'success' | 'error' | 'warning' | 'permission' | 'planMode' | 'remember' | 'claude' | 'ide' | 'merged' | 'autoAccept' | 'suggestion' | 'label'
export type Palette = Readonly<Record<PaletteRole, string>>

/** Catppuccin Mocha, for a dark theme. */
export const MOCHA: Palette = {
  active: '#94e2d5', success: '#a6e3a1', error: '#f38ba8', warning: '#f9e2af', permission: '#89b4fa', planMode: '#cba6f7',
  remember: '#b4befe', claude: '#fab387', ide: '#89dceb', merged: '#f5c2e7', autoAccept: '#f2cdcd', suggestion: '#74c7ec', label: '#a6adc8',
}

/** Catppuccin Latte, for a light theme. */
export const LATTE: Palette = {
  active: '#179299', success: '#40a02b', error: '#d20f39', warning: '#df8e1d', permission: '#1e66f5', planMode: '#8839ef',
  remember: '#7287fd', claude: '#fe640b', ide: '#04a5e5', merged: '#ea76cb', autoAccept: '#dd7878', suggestion: '#209fb5', label: '#6c6f85',
}

/** The engine's own theme keys, and the teal: what a daltonized, `auto` or unknown theme keeps. */
export const THEME_KEYS: Palette = {
  active: '#14b8a6', success: 'success', error: 'error', warning: 'warning', permission: 'permission', planMode: 'planMode',
  remember: 'remember', claude: 'claude', ide: 'ide', merged: 'merged', autoAccept: 'autoAccept', suggestion: 'suggestion', label: 'inactive',
}

/**
 * The palette for a `/config` theme name: Latte for `light*`, Mocha for `dark*` (the `-ansi` themes included), the
 * theme keys for anything else. A daltonized theme is colour-blind safe, so it keeps the engine's own colors.
 */
export function paletteOf(theme: string | null | undefined): Palette {
  if (typeof theme !== 'string' || theme.includes('daltonized')) return THEME_KEYS
  if (theme.startsWith('light')) return LATTE
  if (theme.startsWith('dark')) return MOCHA
  return THEME_KEYS
}

export function bar(frac: number, width: number): string {
  const f = Math.min(1, Math.max(0, frac))
  const full = Math.round(f * width)
  return '█'.repeat(full) + '░'.repeat(width - full)
}

export type Cells = { done: number; review: number; active: number; todo: number }

/** The cells of a `width`-cell bar each status takes, in bar order; they sum to `width`. */
export function segments(c: Cells, width: number): Cells {
  const order = [c.done, c.review, c.active, c.todo]
  const total = order.reduce((n, x) => n + x, 0)
  if (total === 0) return { done: 0, review: 0, active: 0, todo: width }
  let cum = 0
  let edge = 0
  const [done = 0, review = 0, active = 0, todo = 0] = order.map(n => {
    cum += n
    const next = Math.round((cum * width) / total)
    const cells = next - edge
    edge = next
    return cells
  })
  return { done, review, active, todo }
}

function newEpic(epicId: string): EpicView {
  return {
    epicId,
    admitted: 0,
    waveMax: 0,
    waveTaskIds: [],
    tasks: {},
    agents: {},
    waves: {},
    taskWave: {},
    budget: null,
    pendingWaivers: [],
    escalations: {},
    openFindings: {},
    successors: {},
    pendingSpecChanges: [],
    activity: [],
    lastTs: 0,
    isClosed: false,
    isMine: false,
  }
}

/** The epic's own id, its integration branch or a plan ref: mirrors Blacksmith projector.ts touch()'s reserved refs. */
function isReserved(epicId: string, id: string): boolean {
  // `norm` prefixes a bare epic id, so the epic's own id arrives as `<epic>/<epic>`
  return id === epicId || id === `${epicId}/${epicId}` || id === `${epicId}/integration` || new RegExp(`^${escapeRe(epicId)}/plan-v\\d+$`).test(id)
}

function norm(epicId: string, id: string): string {
  return id.includes('/') ? id : `${epicId}/${id}`
}

/**
 * Mints the row of a task an admission, gate, merge or supersede names before any `task-added` did:
 * mirrors Blacksmith projector.ts touch(), never for a reserved ref. Origin and plan version stay null
 * until a `task-added` fills them in; the title falls back to the id, as task-added's does.
 */
function ensureRow(epic: EpicView, epicId: string, id: string): void {
  if (!epic.tasks[id] && !isReserved(epicId, id)) epic.tasks[id] = { status: 'todo', title: id, origin: null, planVersion: null }
}

/** Moves a task unless it is terminal; `force` overwrites a terminal status too. */
function setStatus(epic: EpicView, id: string, status: string, force = false): void {
  const t = epic.tasks[id]
  if (t && (force || !TERMINAL.has(t.status))) t.status = status
}

/** Times the task's newest merge or supersede; `??=`: a hud persisted before these were timed has no map. */
function doneAt(epic: EpicView, id: string, ts: number): void {
  const at = (epic.doneAt ??= {})
  if (ts > (at[id] ?? 0)) at[id] = ts
}

function closeAgents(epic: EpicView, task: string, keep?: (a: AgentView) => boolean): void {
  for (const [k, a] of Object.entries(epic.agents)) if (a.taskId === task && !(keep && keep(a))) delete epic.agents[k]
}

function dropWaits(epic: EpicView, task: string): void {
  epic.pendingWaivers = epic.pendingWaivers.filter(t => t !== task)
  for (const [k, t] of Object.entries(epic.escalations)) if (t === task) delete epic.escalations[k]
}

/** What a quorum case is about; mirrors Blacksmith quorumEscalations.ts `subjectOf`. */
function subjectOf(p: Record<string, unknown>): 'finding' | 'plan' | 'epic' {
  if ('blocks' in p) return 'finding'
  if ('sound' in p) return 'plan'
  if ('ready' in p) return 'epic'
  if (str(p.fingerprint)) return 'finding'
  if (typeof p.plan_version === 'number') return 'plan'
  return 'epic'
}

function sevCode(sev: unknown): string {
  return typeof sev === 'string' ? sev.slice(0, 2) : ''
}

function taskRefs(epic: EpicView, ev: BsEvent): string[] {
  const own = str(ev.task_id)
  const raw = own ? [own] : (str(ev.payload?.task_ref) ?? '').split(',')
  return raw.map(s => s.trim()).filter(Boolean).map(s => norm(epic.epicId, s))
}

// ── Prompts: which of the operator's prompts asked for which work ──────────────────────────────
//
// Every event's envelope carries `causal_parent`, `"<session_id>#<n>"`: n is the parent's 0-based line
// index in `<session_id>.jsonl` (log line number − 1), the very ref the fold is handed for each line
// (register.tsx `${base}#${from + i}`, base = the file name less `.jsonl`). Checked on all 11,505 real
// events (k-work/parents.ts): no ref past its file's end, none pointing forward or later in ts, 19 with no
// parent; 100 sit in another session's file, 13 of those in another epic's.

/** The most parent edges a walk follows before it gives up. */
export const PROMPT_HOPS = 50

/** What the walk needs of one event: its type and its `causal_parent` (null when it has none). */
export type Link = { type: string; parent: string | null }

/**
 * A walk's result: the nearest `user_prompt` ancestor's ref, or null; `hops` = parent edges followed to a known
 * event (1 when the start cites the prompt itself); `end` says why it stopped.
 */
export type Walk = { prompt: string | null; hops: number; end: 'prompt' | 'missing' | 'root' | 'cycle' | 'cap' }

/** Walks `causal_parent` up from the event `start` to its nearest `user_prompt` ancestor: at most `cap` hops, stopping on a cycle or a parent `linkOf` does not know. */
export function walkToPrompt(start: string, linkOf: (ref: string) => Link | undefined, cap = PROMPT_HOPS): Walk {
  let cur = linkOf(start)
  if (!cur) return { prompt: null, hops: 0, end: 'missing' }
  const seen = new Set([start])
  for (let hops = 0; ; ) {
    const parent = cur.parent
    if (!parent) return { prompt: null, hops, end: 'root' }
    if (seen.has(parent)) return { prompt: null, hops, end: 'cycle' }
    if (hops >= cap) return { prompt: null, hops, end: 'cap' }
    const next = linkOf(parent)
    if (!next) return { prompt: null, hops, end: 'missing' }
    hops += 1
    if (next.type === 'user_prompt') return { prompt: parent, hops, end: 'prompt' }
    seen.add(parent)
    cur = next
  }
}

/** Each prompt ref once, in first-seen order; the nulls of walks that found none dropped. */
export function distinctPrompts(refs: Iterable<string | null | undefined>): string[] {
  const out: string[] = []
  for (const r of refs) if (r && !out.includes(r)) out.push(r)
  return out
}

/** A stored prompt's longest text, an ellipsis past it: one huge prompt reaches tens of KB and the band shows one line. */
export const PROMPT_CHARS = 240

/** A prompt's text as the epic keeps it: whitespace runs (newlines too) folded to one space, trimmed, cut to PROMPT_CHARS plus `…`. */
function promptLine(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > PROMPT_CHARS ? `${one.slice(0, PROMPT_CHARS)}…` : one
}

/**
 * What the walk reads, per hud, in memory only: every folded event's link, and each `user_prompt`'s time and cut text.
 * A WeakMap keeps it out of the hud register persists (the biggest epic's links alone run ~190 KB) and drops it with
 * the hud on a reset; register rebuilds the hud from the logs at load, so nothing is lost across a reload.
 */
const indexes = new WeakMap<Hud, { links: Map<string, Link>; prompts: Map<string, PromptView> }>()

function indexOf(hud: Hud) {
  let ix = indexes.get(hud)
  if (!ix) indexes.set(hud, (ix = { links: new Map(), prompts: new Map() }))
  return ix
}

/**
 * The nearest prompt `ref`'s causal chain reaches, copied into the epic's kept prompts; null when none.
 * A parent folded later than its child is missed: register sorts each batch by ts and re-folds from the start
 * when it follows a file with older events, and a parent is never later in ts than its child.
 */
function reachPrompt(hud: Hud, epic: EpicView, ref: string): string | null {
  const ix = indexOf(hud)
  const { prompt } = walkToPrompt(ref, r => ix.links.get(r))
  const view = prompt ? ix.prompts.get(prompt) : undefined
  if (!prompt || !view) return null
  ;(epic.prompts ??= {})[prompt] ??= view
  return prompt
}

/** The newest prompts an epic keeps whether or not any work descends from them. */
export const EPIC_PROMPTS = 20
/** The newest prompts of the own home log the idle band keeps. */
const HOME_PROMPTS = 2

/** A `parent_prompt_id` that names a home-log prompt (`prompts-<id>#<n>`), or null. */
function homeRef(v: unknown): string | null {
  return typeof v === 'string' && v.startsWith(HOME_LOG) && /#\d+$/.test(v) ? v : null
}

/** The home logs some epic named through `parent_prompt_id`: register reads each into the fold. */
export function promptHomes(hud: Hud): string[] {
  return hud.homes ?? []
}

/**
 * Keeps an epic-log prompt on the epic and drops the oldest past EPIC_PROMPTS. A prompt some admission, task or kept
 * wave points at stays: Past and Next read it by ref.
 */
function keepPrompt(epic: EpicView, ref: string, view: PromptView | undefined): void {
  if (!view) return
  const kept = (epic.prompts ??= {})
  kept[ref] ??= view
  const refs = Object.keys(kept)
  if (refs.length <= EPIC_PROMPTS) return
  const pinned = new Set([...Object.values(epic.taskPrompts ?? {}).flat(), ...(epic.admissions ?? []).map(a => a.prompt)])
  const oldest = refs.filter(r => !pinned.has(r)).sort((a, b) => kept[a]!.ts - kept[b]!.ts)
  for (const r of oldest.slice(0, refs.length - EPIC_PROMPTS)) delete kept[r]
}

/** Folds one event into `hud` in place; returns what is worth a toast. */
export function foldEvent(hud: Hud, ev: BsEvent, ref: string, sid: string, fileEpic?: string | null): Notice[] {
  const p = ev.payload ?? {}
  const ts = ev.ts ? Date.parse(ev.ts) || 0 : 0
  // every event's link, an epic's or not: a work event's chain can cross into another session's or epic's log
  const ix = indexOf(hud)
  ix.links.set(ref, { type: ev.event_type, parent: str(ev.causal_parent) })
  if (ev.event_type === 'user_prompt') ix.prompts.set(ref, { ts, text: promptLine(typeof p.prompt === 'string' ? p.prompt : '') })
  const epicId = epicIdOf(ev, fileEpic)
  if (!epicId) {
    // the own home log's newest prompts are the idle band's; no other home log is kept whole
    if (ev.event_type === 'user_prompt' && sid && ev.session_id === `${HOME_LOG}${sid}`) {
      const view = ix.prompts.get(ref)
      if (view) hud.homePrompts = [{ ref, ...view }, ...(hud.homePrompts ?? [])].sort((a, b) => b.ts - a.ts).slice(0, HOME_PROMPTS)
    }
    return []
  }
  const epic = (hud.epics[epicId] ??= newEpic(epicId))
  const notices: Notice[] = []
  const task = str(ev.task_id) ? norm(epicId, ev.task_id as string) : null
  const short = task ? shortTask(task) : ''
  const note = (text: string, tone: Tone, toast = false) => {
    epic.activity.push({ ts, text, tone })
    if (epic.activity.length > ACTIVITY_CAP) epic.activity.splice(0, epic.activity.length - ACTIVITY_CAP)
    if (toast) notices.push({ text, tone })
  }

  if (ev.event_type === 'user_prompt') keepPrompt(epic, ref, ix.prompts.get(ref))
  // a prompt typed in another session's home log can open an epic's session or dispatch its work
  const home = ev.event_type === 'session-start' || ev.event_type === 'dispatch_decision' ? homeRef(p.parent_prompt_id) : null
  if (home) {
    const homeSession = home.slice(0, home.lastIndexOf('#'))
    if (!(hud.homes ??= []).includes(homeSession)) hud.homes.push(homeSession)
    const view = ix.prompts.get(home)
    if (view) {
      ;(epic.prompts ??= {})[home] ??= view
      if (task && ev.event_type === 'dispatch_decision') {
        const mine = ((epic.taskPrompts ??= {})[task] ??= [])
        if (!mine.includes(home)) mine.push(home)
      }
    }
  }

  if (sid && ev.cli_session_id === sid) epic.isMine = true
  if (ts > epic.lastTs) epic.lastTs = ts
  const wave = ev.session_id ? waveLabel(ev.session_id, epicId) : null
  if (wave) {
    epic.waveMax = Math.max(epic.waveMax, parseInt(wave.slice(1), 10))
    // `??=`: a hud persisted before waves were kept has none
    const w = ((epic.waves ??= {})[wave] ??= { since: ts, seen: ts, tasks: [] })
    // after a pause the wave resumed: the band times this run, not the session
    if (ts && w.seen && ts - w.seen > WAVE_IDLE_MS) w.since = ts
    // an earlier event folded late moves the run's start back, never into a run before a pause
    else if (ts && (!w.since || (ts < w.since && w.since - ts <= WAVE_IDLE_MS))) w.since = ts
    if (ts > w.seen) w.seen = ts
    // a finding names the task it is filed or deferred against, often one another wave works
    const works = task && !isReserved(epicId, task) && !ev.event_type.startsWith('finding-')
    if (works && !w.tasks.includes(task)) w.tasks.push(task)
    // the last wave to touch a task owns it: a takeover hands it on
    if (works) (epic.taskWave ??= {})[task] = wave
  }

  switch (ev.event_type) {
    case 'task-added': {
      if (!task || isReserved(epicId, task)) break
      const prev = epic.tasks[task]
      const title = str(p.title) ?? str(p.objective) ?? task
      const origin = str(p.origin) ?? 'user'
      // an amendment re-emits the task with its new version; a terminal status still stands (D-18b)
      const planVersion = typeof p.plan_version === 'number' ? p.plan_version : (prev?.planVersion ?? null)
      if (!prev) epic.tasks[task] = { status: str(p.task_status) ?? 'todo', title, origin, planVersion }
      else {
        prev.title = title
        prev.origin = origin
        prev.planVersion = planVersion
        if (!TERMINAL.has(prev.status)) prev.status = str(p.task_status) ?? 'todo'
      }
      const asked = reachPrompt(hud, epic, ref)
      if (asked) {
        const mine = ((epic.taskPrompts ??= {})[task] ??= [])
        if (!mine.includes(asked)) mine.push(asked)
      }
      break
    }
    case 'wave-admitted': {
      const ids = Array.isArray(p.task_ids) ? p.task_ids.filter((x): x is string => typeof x === 'string').map(x => norm(epicId, x)) : []
      epic.admitted += 1
      epic.waveTaskIds = ids
      const admission: AdmissionView = { ts, taskIds: ids, prompt: reachPrompt(hud, epic, ref), waveMaxAt: epic.waveMax }
      ;(epic.admissions ??= []).push(admission)
      // a wave admitted after a goal check: the close turned back into work
      delete epic.isClosing
      for (const id of ids) {
        ensureRow(epic, epicId, id)
        setStatus(epic, id, 'ready')
      }
      const b = p.budget as Record<string, unknown> | undefined
      if (b && typeof b.cap_tokens === 'number') {
        epic.budget = { cap: b.cap_tokens, projected: typeof b.projected_tokens === 'number' ? b.projected_tokens : 0, status: str(b.status) ?? '' }
      }
      // since Blacksmith sizes admissions per tier; an admission naming none (every log before 2026-10-08) keeps it
      if (b && isTier(b.tier)) epic.admittedTier = b.tier
      note(`▶ wave admitted · ${ids.length} task${ids.length === 1 ? '' : 's'}`, 'info', true)
      break
    }
    case 'dispatch_decision': {
      if (!task) break
      const role = str(p.agent_role) ?? str(p.agent) ?? 'agent'
      // every wave-runner is dispatched on `integration` from the epic session: its wave shows in `epic.waves`
      if (role === WAVE_RUNNER) {
        note(`${role} → ${short}`, 'info')
        break
      }
      if (role !== 'coder') closeAgents(epic, task, a => a.role !== 'coder')
      epic.agents[`${task}|${role}`] = { taskId: task, role, since: ts, model: str(p.model) ?? str(p.model_tier) ?? '' }
      if (!isReserved(epicId, task)) setStatus(epic, task, 'in-progress')
      note(`${role} → ${short}`, 'info')
      break
    }
    case 'task-result-recorded': {
      if (!task) break
      const role = str(p.agent_role) ?? str(p.agent)
      if (role && epic.agents[`${task}|${role}`]) delete epic.agents[`${task}|${role}`]
      else {
        const newest = Object.entries(epic.agents).filter(([, a]) => a.taskId === task).sort((x, y) => y[1].since - x[1].since)[0]
        if (newest) delete epic.agents[newest[0]]
      }
      note(`${role ?? 'agent'} ${str(p.run_status) ?? 'done'} ${short}`, p.run_status === 'dead' ? 'bad' : 'ok')
      break
    }
    case 'judge-reported': {
      if (!task) break
      const role = str(p.agent_role) ?? 'judge'
      delete epic.agents[`${task}|${role}`]
      const n = typeof p.finding_count === 'number' ? p.finding_count : 0
      note(`${role} reported ${short} · ${n} finding${n === 1 ? '' : 's'}`, n > 0 ? 'warn' : 'ok')
      break
    }
    case 'grader-verdict': {
      if (!task) break
      delete epic.agents[`${task}|grader`]
      note(`grader ${str(p.overall) ?? str(p.verdict) ?? 'verdict'} ${short}`, p.overall === 'pass' || p.verdict === 'met' ? 'ok' : 'warn')
      break
    }
    case 'judge-verdict': {
      if (!task) break
      const role = str(p.agent) ?? str(p.agent_role) ?? 'verifier'
      delete epic.agents[`${task}|${role}`]
      // a verdict informs; it is neither a pass nor a failure
      note([role, str(p.verdict), short].filter(Boolean).join(' '), 'info')
      break
    }
    case 'gate-outcome': {
      if (!task) break
      ensureRow(epic, epicId, task)
      closeAgents(epic, task, a => a.role !== 'coder' && a.role !== 'tester')
      const outcome = str(p.outcome) ?? ''
      if (outcome === 'blocked') {
        setStatus(epic, task, 'blocked')
        note(`✖ gate fail ${short} (${str(p.reason) ?? 'blocked'})`, 'bad', true)
      } else if (outcome === 'pass-with-waivers-pending') {
        setStatus(epic, task, 'reviewing')
        if (!epic.pendingWaivers.includes(task)) epic.pendingWaivers.push(task)
        note(`⚑ waiver pending ${short}`, 'warn', true)
      } else if (outcome === 'pass') {
        setStatus(epic, task, 'merging')
        epic.pendingWaivers = epic.pendingWaivers.filter(t => t !== task)
        note(`gate pass ${short}`, 'ok')
      }
      break
    }
    case 'task-waiver-approved': {
      if (task) epic.pendingWaivers = epic.pendingWaivers.filter(t => t !== task)
      break
    }
    case 'wave-merged': {
      const listed = Array.isArray(p.task_ids) ? p.task_ids.filter((x): x is string => typeof x === 'string') : []
      const ids = (listed.length ? listed : task ? [task] : []).map(x => norm(epicId, x))
      for (const id of ids) {
        ensureRow(epic, epicId, id)
        // mirrors Blacksmith projector.ts wave-merged: the merge completes the task over any status, escalated included
        setStatus(epic, id, 'completed', true)
        closeAgents(epic, id)
        dropWaits(epic, id)
        doneAt(epic, id, ts)
      }
      // the wave merged by then: Past keeps the prompts up to it (pastModel)
      const w = wave ? epic.waves?.[wave] : undefined
      if (w && ids.length && ts > (w.merged ?? 0)) w.merged = ts
      if (ids.length) note(`✔ merged ${ids.map(shortTask).join(', ')}`, 'ok', true)
      break
    }
    case 'task-superseded': {
      if (!task) break
      // mirrors Blacksmith projector.ts task-superseded: a completed task superseded later is superseded,
      // so an amendment naming it waits on its successor
      ensureRow(epic, epicId, task)
      setStatus(epic, task, 'superseded', true)
      closeAgents(epic, task)
      dropWaits(epic, task)
      doneAt(epic, task, ts)
      note(`superseded ${short}`, 'info')
      break
    }
    case 'error-logged': {
      const sev = sevCode(p.severity)
      const error = str(p.error) ?? 'error'
      // a deliberate divergence: Blacksmith projector.ts touch() mints from error refs, the mod moves existing rows only.
      // The refs that would mint are audit run ids (`20260914-5fe9088c.code-quality`), `lab-audit-1-planner` and a bare
      // epic id; as rows they would inflate the counts and keep a wave live. Every real error naming a real task comes after
      // its wave-admitted but one: web-audit-2's budget-exceeded on task-8, 24 min before it (Blacksmith showed it blocked).
      const refs = taskRefs(epic, ev).filter(id => !isReserved(epicId, id))
      const role = str(p.agent_role)
      if (task && role) delete epic.agents[`${task}|${role}`]
      // only an exact S3-minor or S4-nit leaves the task; a missing severity moves it like a major one
      if (!NOTE_ONLY.has(str(p.severity) ?? '')) {
        for (const id of refs) setStatus(epic, id, error.startsWith('coordination.') ? 'escalated' : 'blocked')
        note(`✖ ${sev || 'S?'} ${error} ${refs.map(shortTask).join(', ')}`.trim(), 'bad', true)
      } else note(`${sev || 'S?'} ${error} ${refs.map(shortTask).join(', ')}`.trim(), 'warn')
      break
    }
    case 'quorum-decision': {
      // one case per subject + identity, latest outcome wins: mirrors Blacksmith quorumEscalations.ts
      const subject = subjectOf(p)
      const taskId = str(p.task_id) ?? str(ev.task_id) ?? '(no task)'
      const key = `${subject}:${subject === 'finding' ? (str(p.fingerprint) ?? taskId) : taskId}`
      if (p.outcome === 'escalate') {
        const of = taskId === '(no task)' ? '' : norm(epicId, taskId)
        epic.escalations[key] = of
        note(`⚑ escalation ${of ? shortTask(of) : subject} (${str(p.escalation_reason) ?? 'escalate'})`, 'warn', true)
      } else delete epic.escalations[key]
      break
    }
    case 'finding-raised': {
      const id = str(p.finding_id)
      if (!id) break
      const sev = str(p.severity) ?? ''
      epic.openFindings[id] = { severity: sev, status: str(p.finding_status) ?? 'raised' }
      const code = sevCode(sev)
      if (code === 'S1' || code === 'S2') note(`✖ ${code} finding ${short}`, 'bad', code === 'S1')
      break
    }
    case 'finding-transitioned': {
      const id = str(p.finding_id)
      const to = str(p.to_status) ?? ''
      if (!CLOSED_FINDING.has(to)) {
        const open = id ? epic.openFindings[id] : undefined
        if (open && to) open.status = to
        // the amendment's obligation, last one carried wins: mirrors Blacksmith findings.ts (a 0 version is dropped there too)
        if (open && Array.isArray(p.amends_task_ids)) open.amendsTaskIds = p.amends_task_ids.map(x => (typeof x === 'string' ? x : ''))
        if (open && typeof p.amends_plan_version === 'number' && p.amends_plan_version) open.amendsPlanVersion = p.amends_plan_version
        break
      }
      const fp = str(p.fingerprint)
      for (const k of [id, fp]) if (k) delete epic.openFindings[k]
      // a mod-side courtesy, not Blacksmith behaviour: a closed finding's case stops waiting on you
      if (fp) delete epic.escalations[`finding:${fp}`]
      break
    }
    case 'plan-version-created': {
      if (p.epic_id !== epicId) break
      // a plan amended after a goal check (web-ux-1 v12): the close turned back into planning work
      delete epic.isClosing
      const succ = (epic.successors ??= {})
      const pair = (from: unknown, to: unknown) => {
        if (typeof from === 'string' && typeof to === 'string') succ[norm(epicId, from)] = norm(epicId, to)
      }
      // mirrors Blacksmith spec.ts taskSuccessors: a present `successors` key wins, even empty or null
      if (p.successors !== undefined) {
        if (p.successors && typeof p.successors === 'object') for (const [from, to] of Object.entries(p.successors)) pair(from, to)
        break
      }
      const diff = p.diff as Record<string, unknown> | null | undefined
      const gone = diff && typeof diff === 'object' ? diff.superseded : null
      const added = diff && typeof diff === 'object' ? diff.added : null
      if (Array.isArray(gone) && Array.isArray(added) && gone.length === 1 && added.length === 1 && gone[0] !== added[0]) pair(gone[0], added[0])
      break
    }
    case 'spec-change-proposed': {
      if (!epic.pendingSpecChanges.includes(ref)) epic.pendingSpecChanges.push(ref)
      note('⚑ spec change proposed', 'warn', true)
      break
    }
    case 'spec-change-decided': {
      const id = str(p.proposal_id)
      if (id) epic.pendingSpecChanges = epic.pendingSpecChanges.filter(r => r !== id)
      note(`spec change ${str(p.decision) ?? 'decided'}`, 'info')
      break
    }
    case 'goal-check-recorded': {
      // Blacksmith runs the goal check only on the close path (11 of 11 closed epics, none elsewhere)
      if (p.epic_id === epicId) epic.isClosing = true
      break
    }
    case 'epic-closed': {
      epic.isClosed = true
      epic.agents = {}
      note(`✔ epic ${epicId} closed`, 'ok', true)
      break
    }
  }
  return notices
}

/** The first non-superseded row a superseded task's successors lead to; undefined when a hop is missing or the chain cycles. Mirrors Blacksmith epic.ts resolveSupersededRow. */
function successorRow(epic: EpicView, id: string): TaskView | undefined {
  const seen = new Set([id])
  for (let at = id; ;) {
    const next = epic.successors?.[at]
    if (next === undefined || seen.has(next)) return undefined
    seen.add(next)
    const row = epic.tasks[next]
    if (!row || row.status !== 'superseded') return row
    at = next
  }
}

/**
 * An amend-pending finding Blacksmith counts discharged (D-127 Part B): it names
 * tasks and a version, and every task (or the successor of a superseded one)
 * landed completed or waived at or past that version. Ids compare bare, which
 * `norm` gives, since the plan side and the event side spell them either way.
 */
export function isAmendLanded(epic: EpicView, f: FindingView): boolean {
  const ids = f.amendsTaskIds
  const version = f.amendsPlanVersion
  if (f.status !== 'amend-pending' || !ids?.length || typeof version !== 'number') return false
  return ids.every(raw => {
    if (!str(raw)) return false
    const id = norm(epic.epicId, raw)
    const row = epic.tasks[id]
    const evidence = row?.status === 'superseded' ? (successorRow(epic, id) ?? row) : row
    return !!evidence && LANDED.has(evidence.status) && evidence.planVersion != null && evidence.planVersion >= version
  })
}

/**
 * A wave is done once it touched a plan task and every plan task it still owns is terminal:
 * a wave whose open tasks a later wave took over has nothing left to land.
 */
function isWaveDone(epic: EpicView, label: string, w: WaveView): boolean {
  // an escalation followup, or an id no event minted a row for (only a dispatch or a result named it), is no work the wave lands;
  // a minted row with no origin yet is a plan task
  const plan = w.tasks.filter(id => {
    const t = epic.tasks[id]
    return !!t && t.origin !== 'escalation'
  })
  // `??`: a hud persisted before owners were kept has none, so the toucher owns its task
  const open = plan.filter(id => (epic.taskWave?.[id] ?? label) === label && !TERMINAL.has(epic.tasks[id]?.status ?? ''))
  return plan.length > 0 && open.length === 0
}

/** One wave-runner per wave session silent no longer than WAVE_IDLE_MS and not done, timed from its current run; none once the epic closed. */
function waveRunners(epic: EpicView, now: number): AgentView[] {
  if (epic.isClosed) return []
  return Object.entries(epic.waves ?? {})
    .filter(([label, w]) => now - w.seen <= WAVE_IDLE_MS && !isWaveDone(epic, label, w))
    .map(([label, w]) => ({ taskId: label, role: WAVE_RUNNER, since: w.since, model: '' }))
}

export function summarize(epic: EpicView, now: number): Summary {
  // a hud folded before waves were kept may hold a dispatch-keyed `integration|wave-runner`
  const agents = Object.values(epic.agents).filter(a => a.role !== WAVE_RUNNER)
  const dispatched = agents.filter(a => now - a.since <= STALE_MS)
  const live = [...dispatched, ...waveRunners(epic, now)].sort((a, b) => b.since - a.since)
  // Now prefers a worker: a wave-runner only coordinates
  const head = live.find(a => a.role !== WAVE_RUNNER) ?? live[0]

  const counts = { done: 0, review: 0, active: 0, todo: 0, superseded: 0, total: 0 }
  for (const t of Object.values(epic.tasks)) {
    if (t.origin === 'escalation') continue
    if (t.status === 'superseded') counts.superseded += 1
    // waived is done: mirrors Blacksmith queries.ts statusBucketForTaskStatus
    else if (LANDED.has(t.status)) counts.done += 1
    else if (t.status === 'reviewing' || t.status === 'merging') counts.review += 1
    else if (t.status === 'todo' || t.status === 'ready') counts.todo += 1
    else counts.active += 1
  }
  counts.total = counts.done + counts.review + counts.active + counts.todo

  const findings = { S1: 0, S2: 0, S3: 0, S4: 0 }
  const blockers = { total: 0, byStatus: {} as Record<string, number> }
  let amendsLanded = 0
  for (const f of Object.values(epic.openFindings)) {
    // discharged, so neither open nor blocking; the fold keeps it until the close moves it to `amended`
    if (isAmendLanded(epic, f)) {
      amendsLanded += 1
      continue
    }
    const code = sevCode(f.severity) as keyof typeof findings
    if (!(code in findings)) continue
    findings[code] += 1
    if ((code === 'S1' || code === 'S2') && !epic.isClosed) {
      blockers.total += 1
      blockers.byStatus[f.status] = (blockers.byStatus[f.status] ?? 0) + 1
    }
  }
  // a closed epic waits on nothing: Blacksmith leaves its cases open, the summary hides them
  const waits = epic.isClosed
    ? { waivers: 0, escalations: 0, specs: 0 }
    : { waivers: epic.pendingWaivers.length, escalations: Object.keys(epic.escalations).length, specs: epic.pendingSpecChanges.length }

  const busy = new Set(live.map(a => a.taskId))
  const idle = (id: string) => {
    const s = epic.tasks[id]?.status
    return (s === 'todo' || s === 'ready') && !busy.has(id)
  }
  const nextId = epic.waveTaskIds.find(idle) ?? Object.keys(epic.tasks).find(id => epic.tasks[id]?.origin !== 'escalation' && idle(id))

  return {
    epicId: epic.epicId,
    // the band's phase reads the same helper (phaseOf), so the status line and the band name one wave
    wave: waveNumber(epic),
    now: head ? { role: head.role, task: shortTask(head.taskId), elapsed: fmtElapsed(now - head.since) } : null,
    agentCount: live.length,
    roles: live.map(a => a.role),
    staleCount: agents.length - dispatched.length,
    agents: live,
    next: nextId ? shortTask(nextId) : null,
    isWaitingOnYou: live.length === 0 && waits.waivers + waits.escalations + waits.specs > 0,
    counts,
    progress: counts.total ? counts.done / counts.total : 0,
    budget: epic.budget && epic.budget.cap > 0
      ? { cap: epic.budget.cap, projected: epic.budget.projected, pct: Math.round((epic.budget.projected / epic.budget.cap) * 100) }
      : null,
    waits,
    blockers,
    amendsLanded,
    findings,
    isClosed: epic.isClosed,
  }
}

/** Where an epic stands, read from its log: `label` is what the band prints. */
export type Phase = {
  kind: 'planning' | 'wave' | 'after' | 'closing' | 'closed'
  /** waveNumber's answer, the number the status line prints too; null with neither an admission nor a wave session */
  wave: number | null
  /** `planning`, `wave 7`, `after wave 7`, `closing` or `closed` */
  label: string
}

/** A plan task the fold still holds open: neither terminal nor an escalation follow-up. */
function isOpenPlanTask(t: TaskView): boolean {
  return t.origin !== 'escalation' && !TERMINAL.has(t.status)
}

/**
 * The latest admission's wave number. A `wave-admitted` names no wave, so the highest-numbered wave session that runs
 * it: one that worked one of its tasks at or after it, or one that started after it numbered at least the waveMax it
 * landed on (`w1r` is 1, an older wave's `-land` session is not; two sessions on one admission, web-ux-3 w18 + w19,
 * give 19). Before its session starts, the wave after the highest seen then; with no wave session at all (waves run
 * inline in the epic session), the admission count. With no admission kept (a wave session file with no
 * `wave-admitted`, or a hud persisted before admissions were kept): the highest wave session's number, else the
 * admission count; 0 with neither. One source for the status line (summarize's `wave`) and the band (phaseOf).
 */
export function waveNumber(epic: EpicView): number {
  const adm = epic.admissions?.at(-1)
  if (!adm) return epic.waveMax > 0 ? epic.waveMax : epic.admitted
  let best = 0
  for (const [label, w] of Object.entries(epic.waves ?? {})) {
    const n = parseInt(label.slice(1), 10)
    const works = w.seen >= adm.ts && w.tasks.some(id => epic.waveTaskIds.includes(id))
    // `since` restarts after an hour's pause, so an older wave resuming is told apart by its number
    const opened = adm.waveMaxAt !== undefined && w.since >= adm.ts && n >= adm.waveMaxAt
    if (works || opened) best = Math.max(best, n)
  }
  if (best > 0) return best
  const before = adm.waveMaxAt ?? epic.waveMax
  return before > 0 ? before + 1 : epic.admitted
}

/**
 * The tasks of wave `n`: the latest admission's; with no `wave-admitted` folded (a wave session file read without its
 * epic session's), the tasks the sessions numbered `n` worked.
 */
function waveIds(epic: EpicView, n: number | null): string[] {
  if (epic.admitted > 0 || n === null) return epic.waveTaskIds
  const ids = Object.entries(epic.waves ?? {}).filter(([label]) => parseInt(label.slice(1), 10) === n).flatMap(([, w]) => w.tasks)
  return [...new Set(ids)]
}

/**
 * The epic's phase, first match wins:
 * - `closed`: an `epic-closed`;
 * - `planning`: neither a `wave-admitted` nor a wave session yet;
 * - `closing`: a `goal-check-recorded` with no `wave-admitted` or `plan-version-created` after it, open work or not
 *   (lab-audit-1 and web-audit-7 checked their goal with a task still open);
 * - `wave N`: a task of wave N is still open: the latest admission's tasks, or with no admission (a wave session file
 *   with no `wave-admitted`, web-audit-5's) the tasks wave N's sessions worked;
 * - `after wave N`: that wave's tasks are all terminal, other plan work is open;
 * - `closing`: every plan task is terminal (the close path's reviews run next).
 * Task status comes from the fold (`task-added`, `dispatch_decision`, `gate-outcome`, `error-logged`, `wave-merged`,
 * `task-superseded`); N from waveNumber, the helper the status line's `wN` reads (summarize), so the two never differ.
 */
export function phaseOf(epic: EpicView): Phase {
  const n = waveNumber(epic)
  const wave = n > 0 ? n : null
  if (epic.isClosed) return { kind: 'closed', wave, label: 'closed' }
  if (wave === null) return { kind: 'planning', wave, label: 'planning' }
  if (epic.isClosing) return { kind: 'closing', wave, label: 'closing' }
  const open = (id: string) => {
    const t = epic.tasks[id]
    return !!t && !TERMINAL.has(t.status)
  }
  if (waveIds(epic, wave).some(open)) return { kind: 'wave', wave, label: `wave ${wave}` }
  if (Object.values(epic.tasks).some(isOpenPlanTask)) return { kind: 'after', wave, label: `after wave ${wave}` }
  return { kind: 'closing', wave, label: 'closing' }
}

// ── Tier: the effort tier the epic runs at ─────────────────────────────────────────────────────

/** Blacksmith's effort tiers (effortTiers.ts EFFORT_TIERS). */
export type Tier = 'small' | 'medium' | 'huge'

/** tierOf's answer: the tier and where it came from, both null when nothing names one. */
export type TierPick = { tier: Tier | null; source: 'admission' | 'plan' | null }

const TIERS: readonly string[] = ['small', 'medium', 'huge']

function isTier(v: unknown): v is Tier {
  return typeof v === 'string' && TIERS.includes(v)
}

/**
 * The epic's tier: the newest `wave-admitted` whose `payload.budget.tier` names one, which is the tier Blacksmith
 * sized the budget for; else `planEffort`, the latest plan's raw `effort` (register reads it once per plan
 * version: planDirOf, latestPlanName, planEffort); else none. The plan's effort can sit below the effective
 * tier: epicBudget.ts budgetTierForPlan raises it to effort.yml's `security_floor` when the plan touches a
 * security trigger ("a plan's raw `effort` is not its tier", budgets.ts), so only the admission's tier is exact.
 */
export function tierOf(epic: EpicView, planEffort: Tier | null = null): TierPick {
  if (epic.admittedTier) return { tier: epic.admittedTier, source: 'admission' }
  if (planEffort) return { tier: planEffort, source: 'plan' }
  return { tier: null, source: null }
}

/**
 * Where Blacksmith's plan.ts `latestPlan` looks for `epicId`'s plans: `<work root>/factory/specs/active/<epic>`
 * (SPECS_ACTIVE_DIR), the work root being the one whose `state/events` holds the logs (STATE_EVENTS_DIR); null
 * for a dir not named `state/events`, or an epic id that would leave the dir. A plan written with `--specs-dir`
 * (a project whose plans sit under its own .blacksmith while its logs sit in the clone) is not there: the tier
 * falls through to none.
 */
export function planDirOf(eventsDir: string, epicId: string): string | null {
  const dir = eventsDir.replace(/\/+$/, '')
  if (!dir.endsWith('/state/events') || !epicId || epicId.includes('/') || epicId === '.' || epicId === '..') return null
  return `${dir.slice(0, -'/state/events'.length)}/factory/specs/active/${epicId}`
}

/** The latest plan file among a plan dir's names: the highest `plan-vN.json`, as plan.ts latestPlanVersion picks it; null when none. */
export function latestPlanName(names: Iterable<string>): string | null {
  let best: string | null = null
  let max = -1
  for (const name of names) {
    const m = /^plan-v(\d+)\.json$/.exec(name)
    if (m && Number(m[1]) > max) {
      max = Number(m[1])
      best = name
    }
  }
  return best
}

/** A plan file's `effort` when it names a tier; null for no effort, an unknown one, or text that is no JSON object. */
export function planEffort(text: string): Tier | null {
  try {
    const plan = JSON.parse(text) as unknown
    return plan && typeof plan === 'object' && isTier((plan as Record<string, unknown>).effort) ? ((plan as Record<string, unknown>).effort as Tier) : null
  } catch {
    return null
  }
}

/** The highest plan version a `task-added` carried, 0 when none did: register re-reads the plan when it moves. */
export function planVersionOf(epic: EpicView): number {
  let max = 0
  for (const t of Object.values(epic.tasks)) if (t.planVersion !== null && t.planVersion > max) max = t.planVersion
  return max
}

/** The pinned epic (closed or not), else the most recently active open epic this CLI session wrote to. */
export function pickEpic(hud: Hud, pinned: string | null): EpicView | null {
  if (pinned) return hud.epics[pinned] ?? null
  const mine = Object.values(hud.epics).filter(e => e.isMine && !e.isClosed && (Object.keys(e.tasks).length > 0 || e.admitted > 0))
  mine.sort((a, b) => b.lastTs - a.lastTs)
  return mine[0] ?? null
}

/** Which of the two an epic on screen is: pinned, or this session's own. */
export type ViewKind = 'pinned' | 'own'

/** The one place the drawing asks what to show: the pin, else this session's own open epic. */
export function pickView(hud: Hud, pinned: string | null): { epic: EpicView; kind: ViewKind } | null {
  if (pinned) {
    const epic = hud.epics[pinned]
    return epic ? { epic, kind: 'pinned' } : null
  }
  const own = pickEpic(hud, null)
  return own ? { epic: own, kind: 'own' } : null
}

// ── Tab models: what each tab of the band lists, as plain data the drawing cuts to fit ─────────

/** A list cut to a cap: the rows to draw and how many it left out, so the drawing can print `+N more`. */
export type Capped<T> = { rows: T[]; more: number }

/** The first `cap` items (every one with Infinity, the default; none with 0 or less) and how many were left out. */
export function capped<T>(items: readonly T[], cap = Infinity): Capped<T> {
  const rows = items.slice(0, Number.isNaN(cap) ? items.length : Math.max(0, cap))
  return { rows, more: items.length - rows.length }
}

/** Per-list caps a tab model takes; a cap left out lists everything. */
export type TabCaps = {
  /** task rows per list (Current, Next, each Past group) */
  rows?: number
  /** prompts per list (Current, Next, each Past group) */
  prompts?: number
  /** Past's wave groups */
  groups?: number
}

/** One task as a tab lists it. */
export type TaskRow = {
  /** the epic-prefixed id */
  id: string
  /** shortTask(id), `task-17`: what the row draws for the id */
  short: string
  /** '' when the title is the id or the short id (the task-H rule: the row never draws the id twice) */
  title: string
  status: string
  /** the role of the newest live dispatch on it (no older than STALE_MS, never a wave-runner); null when none */
  role: string | null
  /** fmtElapsed since that dispatch; null when none */
  elapsed: string | null
}

/** An operator prompt as a tab lists it, newest first: `ref` is its `<session id>#<line index>`. */
export type PromptRow = {
  ref: string
  ts: number
  text: string
  /** the first task (lowest number) the prompt led to, `task-16`; absent when no work descends from it */
  task?: string
  /** how many more tasks it led to; absent when it led to one or none */
  more?: number
}

/**
 * Tokens spent against the cap. The log names one spend, the epic's: the newest `wave-admitted`'s `projected_tokens`,
 * which is measured tokens plus the declared cap of every dispatch nothing measured (Blacksmith waveBudget.ts,
 * budgetAlarm.ts's projection), so `basis: 'projected'`. No wave's own spend can be computed honestly: `wave_tokens`
 * is the admitted tasks' declared budgets, not a spend, and judges are never measured, so `scope` is always `'epic'`.
 */
export type Spend = { cap: number; projected: number; pct: number; scope: 'epic'; basis: 'projected' }

/** The pane's and the band's row order: failing first, then in progress, review, ready, landed, superseded; an unknown status sorts as in progress. */
export const STATUS_RANK: Readonly<Record<string, number>> = {
  blocked: 0,
  escalated: 0,
  failed: 0,
  'in-progress': 1,
  reviewing: 2,
  merging: 2,
  ready: 3,
  todo: 3,
  completed: 4,
  waived: 4,
  superseded: 5,
}

/** register.tsx taskNumber: the number after `task-`, an id with none last. */
function taskNo(id: string): number {
  const m = /task-(\d+)/.exec(id)
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}

/** Sorts task ids as the pane sorts its rows: STATUS_RANK, then task number; a tie keeps the given order. */
function inPaneOrder(epic: EpicView, ids: readonly string[]): string[] {
  const rank = (id: string) => STATUS_RANK[epic.tasks[id]?.status ?? ''] ?? 1
  return [...ids].sort((a, b) => rank(a) - rank(b) || taskNo(a) - taskNo(b))
}

/** summarize's live agents, newest first: open dispatches no older than STALE_MS, then one wave-runner per live wave. */
function liveAgents(epic: EpicView, now: number): AgentView[] {
  const dispatched = Object.values(epic.agents).filter(a => a.role !== WAVE_RUNNER && now - a.since <= STALE_MS)
  return [...dispatched, ...waveRunners(epic, now)].sort((a, b) => b.since - a.since)
}

function taskRow(epic: EpicView, id: string, live: readonly AgentView[], now: number): TaskRow {
  const t = epic.tasks[id]
  const short = shortTask(id)
  const title = t?.title ?? id
  // `live` is newest first
  const agent = live.find(a => a.taskId === id && a.role !== WAVE_RUNNER)
  return {
    id,
    short,
    title: title === id || title === short ? '' : title,
    status: t?.status ?? 'todo',
    role: agent?.role ?? null,
    elapsed: agent ? fmtElapsed(now - agent.since) : null,
  }
}

/**
 * The kept prompts `refs` name, each once, newest first; a ref with no kept prompt (a hud persisted before prompts were
 * kept) is left out, and so is one dated after `until` when it is given.
 */
function promptRows(epic: EpicView, refs: Iterable<string | null | undefined>, cap?: number, until?: number): Capped<PromptRow> {
  const kept = epic.prompts ?? {}
  const rows = distinctPrompts(refs).flatMap(ref => {
    const p = kept[ref]
    return p && (until === undefined || p.ts <= until) ? [promptRow(epic, ref, p)] : []
  })
  return capped(rows.sort((a, b) => b.ts - a.ts), cap)
}

/** A kept prompt as a row, with the first task it led to and how many more. */
function promptRow(epic: EpicView, ref: string, p: PromptView): PromptRow {
  const ids = Object.entries(epic.taskPrompts ?? {}).filter(([, refs]) => refs.includes(ref)).map(([id]) => id).sort((a, b) => taskNo(a) - taskNo(b))
  const row: PromptRow = { ref, ts: p.ts, text: p.text }
  if (ids[0]) row.task = shortTask(ids[0])
  if (ids.length > 1) row.more = ids.length - 1
  return row
}

function spendOf(epic: EpicView): Spend | null {
  const b = epic.budget
  if (!b || !(b.cap > 0)) return null
  return { cap: b.cap, projected: b.projected, pct: Math.round((b.projected / b.cap) * 100), scope: 'epic', basis: 'projected' }
}

/** Status cells over `ids` as summarize counts them: escalation follow-ups and rows never minted left out, superseded out of the total. */
function cellsOf(epic: EpicView, ids: readonly string[]): Cells & { total: number } {
  const c = { done: 0, review: 0, active: 0, todo: 0, total: 0 }
  for (const id of new Set(ids)) {
    const t = epic.tasks[id]
    if (!t || t.origin === 'escalation' || t.status === 'superseded') continue
    if (LANDED.has(t.status)) c.done += 1
    else if (t.status === 'reviewing' || t.status === 'merging') c.review += 1
    else if (t.status === 'todo' || t.status === 'ready') c.todo += 1
    else c.active += 1
  }
  c.total = c.done + c.review + c.active + c.todo
  return c
}

/** Every task any wave admitted: each admission's tasks, plus the latest wave's (all a hud persisted before admissions were kept has). */
function admittedIds(epic: EpicView): string[] {
  return [...epic.waveTaskIds, ...(epic.admissions ?? []).flatMap(a => a.taskIds)]
}

/** Current's task ids: every task any wave admitted and every task a live dispatch works, minus landed and superseded ones, in pane order (failing first). */
function currentIds(epic: EpicView, live: readonly AgentView[]): string[] {
  const ids = new Set([...admittedIds(epic), ...live.filter(a => a.role !== WAVE_RUNNER).map(a => a.taskId)])
  return inPaneOrder(epic, [...ids].filter(id => {
    const t = epic.tasks[id]
    return !!t && !LANDED.has(t.status) && t.status !== 'superseded'
  }))
}

/** The Overview tab. */
export type OverviewModel = {
  epicId: string
  phase: Phase
  tier: TierPick
  /** summarize's agentCount and roles (newest first): live dispatches plus one wave-runner per live wave session */
  agents: { count: number; roles: string[] }
  /** summarize's counts in bar order, for `segments` (today's bar runs): escalation follow-ups and superseded tasks left out */
  tasks: Cells & { total: number }
  budget: Spend | null
}

/** The Overview tab: epic, phase, tier (`effort`: the plan's, register's cached planTiers), the epic's agents, its task cells and its spend. */
export function overviewModel(epic: EpicView, now: number, effort: Tier | null = null): OverviewModel {
  const s = summarize(epic, now)
  const { done, review, active, todo, total } = s.counts
  return {
    epicId: epic.epicId,
    phase: phaseOf(epic),
    tier: tierOf(epic, effort),
    agents: { count: s.agentCount, roles: s.roles },
    tasks: { done, review, active, todo, total },
    budget: spendOf(epic),
  }
}

/** The Current tab. */
export type CurrentModel = {
  /** phaseOf's label: `wave 7`, `after wave 7`, `planning`, `closing`, `closed` */
  header: string
  phase: Phase
  /** every admitted task still open plus any task a live dispatch works (an escalation follow-up included), in pane order: blocked, escalated and failed first */
  tasks: Capped<TaskRow>
  /** the latest admission's prompt, the prompts of the admissions that admitted those tasks, and the tasks' own prompts, newest first */
  prompts: Capped<PromptRow>
  /** wave N's cells (phaseOf's wave, waveIds' tasks): escalation follow-ups left out, superseded out of the total; null while planning */
  wave: (Cells & { number: number; total: number }) | null
  /** the live agents on the wave, newest first: dispatches on its tasks, and the wave-runner of its session (numbered as the wave, or working one of its tasks) */
  agents: { count: number; roles: string[] }
  /** the epic's spend: see Spend */
  tokens: Spend | null
}

export function currentModel(epic: EpicView, now: number, caps: TabCaps = {}): CurrentModel {
  const phase = phaseOf(epic)
  const live = liveAgents(epic, now)
  const ids = currentIds(epic, live)
  // every prompt the epic kept, linked to work or not: Current answers what the operator asked
  const prompts = promptRows(epic, Object.keys(epic.prompts ?? {}), caps.prompts)
  const waveTasks = waveIds(epic, phase.wave)
  const inWave = new Set(waveTasks)
  const runs = (label: string) =>
    parseInt(label.slice(1), 10) === phase.wave || (epic.waves?.[label]?.tasks ?? []).some(id => inWave.has(id))
  const onWave = phase.wave === null ? [] : live.filter(a => (a.role === WAVE_RUNNER ? runs(a.taskId) : inWave.has(a.taskId)))
  return {
    header: phase.label,
    phase,
    tasks: capped(ids.map(id => taskRow(epic, id, live, now)), caps.rows),
    prompts,
    wave: phase.wave === null ? null : { number: phase.wave, ...cellsOf(epic, waveTasks) },
    agents: { count: onWave.length, roles: onWave.map(a => a.role) },
    tokens: spendOf(epic),
  }
}

/** The Next tab. */
export type NextModel = {
  /** `after wave N` while wave N runs, `next wave` between waves, `planned` before any admission and once the epic closes */
  header: string
  /** open plan tasks (not landed or superseded, any other status) no wave admitted and no live agent works, in the fold's order */
  tasks: Capped<TaskRow>
  /** those tasks' prompts, newest first */
  prompts: Capped<PromptRow>
}

export function nextModel(epic: EpicView, now: number, caps: TabCaps = {}): NextModel {
  const phase = phaseOf(epic)
  const live = liveAgents(epic, now)
  const current = new Set(currentIds(epic, live))
  const busy = new Set(live.map(a => a.taskId))
  // with Current, every open plan task in exactly one list: a stale or blocked task no wave took is still to come
  const ids = [...new Set([...epic.waveTaskIds, ...Object.keys(epic.tasks)])].filter(id => {
    const t = epic.tasks[id]
    return !!t && t.origin !== 'escalation' && !LANDED.has(t.status) && t.status !== 'superseded' && !busy.has(id) && !current.has(id)
  })
  const header = phase.kind === 'wave' ? `after wave ${phase.wave}` : phase.kind === 'after' ? 'next wave' : 'planned'
  return {
    header,
    tasks: capped(ids.map(id => taskRow(epic, id, live, now)), caps.rows),
    prompts: promptRows(epic, ids.flatMap(id => epic.taskPrompts?.[id] ?? []), caps.prompts),
  }
}

/** One wave's landed work in the Past tab. */
export type PastGroup = {
  /** the wave number; null for work no wave took (superseded before an admission, or merged outside any wave) */
  wave: number | null
  /** `wave 6`, or `no wave` */
  label: string
  /** its completed, waived and superseded plan tasks, in pane order */
  tasks: Capped<TaskRow>
  /** the prompts of the admissions that admitted them and their own prompts, newest first, up to the group's mergedAt */
  prompts: Capped<PromptRow>
}

/**
 * When a Past group's wave merged: the newest `wave-merged` its wave sessions wrote (a re-run `w1r` is wave 1's). A group
 * none wrote (waves run inline, its tasks merged outside their wave's session, or `no wave`) ends when its last task
 * landed or was superseded. Undefined in a hud persisted before merges were timed: the group keeps every prompt.
 */
function mergedAt(epic: EpicView, wave: number | null, ids: readonly string[]): number | undefined {
  const times = (xs: (number | undefined)[]) => {
    const kept = xs.filter((x): x is number => typeof x === 'number' && x > 0)
    return kept.length ? Math.max(...kept) : undefined
  }
  const merged = wave === null ? undefined
    : times(Object.entries(epic.waves ?? {}).filter(([label]) => parseInt(label.slice(1), 10) === wave).map(([, w]) => w.merged))
  return merged ?? times(ids.map(id => epic.doneAt?.[id]))
}

/**
 * The Past tab: done work (completed, waived, superseded; escalation follow-ups left out) grouped by wave, newest first,
 * `no wave` last. A task's wave is the wave session that touched it last (taskWave: a takeover hands a task on, and a
 * merge lands in the owner's session); with no wave session in the epic at all (waves run inline in the epic session),
 * the last admission naming it, numbered by admission order as waveNumber numbers inline waves. A group keeps the
 * prompts, admission or task-added, dated at or before its wave merged (mergedAt): a re-plan after the merge re-adds
 * its tasks, and its approval belongs to later work.
 */
export function pastModel(epic: EpicView, now: number, caps: TabCaps = {}): Capped<PastGroup> {
  const inline = Object.keys(epic.waves ?? {}).length === 0
  const admissions = epic.admissions ?? []
  const byWave = new Map<number | null, string[]>()
  for (const [id, t] of Object.entries(epic.tasks)) {
    if (t.origin === 'escalation' || !(LANDED.has(t.status) || t.status === 'superseded')) continue
    const label = epic.taskWave?.[id]
    let n: number | null = label ? parseInt(label.slice(1), 10) : null
    if (n !== null && !Number.isFinite(n)) n = null
    if (n === null && inline) {
      const i = admissions.findLastIndex(a => a.taskIds.includes(id))
      if (i >= 0) n = i + 1
    }
    byWave.set(n, [...(byWave.get(n) ?? []), id])
  }
  const live = liveAgents(epic, now)
  const groups = [...byWave]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : b - a))
    .map(([wave, ids]): PastGroup => {
      const mine = new Set(ids)
      const asked = admissions.filter(a => a.taskIds.some(id => mine.has(id))).map(a => a.prompt)
      const until = mergedAt(epic, wave, ids)
      return {
        wave,
        label: wave === null ? 'no wave' : `wave ${wave}`,
        tasks: capped(inPaneOrder(epic, ids).map(id => taskRow(epic, id, live, now)), caps.rows),
        prompts: promptRows(epic, [...asked, ...ids.flatMap(id => epic.taskPrompts?.[id] ?? [])], caps.prompts, until),
      }
    })
  return capped(groups, caps.groups)
}

/**
 * The `$.agent.list()` statuses that count as active: work the session started and has not finished. `running` is
 * mid-turn; `waiting` is mid-task, held on background work it owns, a plan's approval or an Agent call; `pending` is
 * spawned and about to start. `idle` is out: between turns until a message wakes it, which is how a teammate with no
 * work waits. `completed`, `failed` and `killed` have ended.
 */
export const ACTIVE_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['pending', 'running', 'waiting'])

/** The agents of a `$.agent.list()` result whose status is in ACTIVE_AGENT_STATUSES, in list order. */
export function activeSessionAgents(list: readonly AgentInfo[]): AgentInfo[] {
  return list.filter(a => ACTIVE_AGENT_STATUSES.has(a.status))
}

// ---------------------------------------------------------------------------
// The session's own task list and background work (§2.9): what the idle band shows outside an epic.

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function idOf(v: unknown): string | null {
  return typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null
}

/**
 * The task list after one main-loop task tool call: TaskCreate adds, TaskUpdate edits or (status `deleted`) removes,
 * TaskList and TodoWrite replace the list. `input` and `result` are the call's raw values; a result of another shape,
 * a failed update or a tool of no interest returns the list as it was.
 */
export function foldTaskTool(list: readonly TaskItem[], tool: string, input: unknown, result: unknown): TaskItem[] {
  const inp = rec(input) ?? {}
  const out = rec(result)
  if (!out) return list as TaskItem[]
  switch (tool) {
    case 'TaskCreate': {
      const t = rec(out.task)
      const id = idOf(t?.id)
      if (!t || !id) return list as TaskItem[]
      const subject = str(t.subject) ?? str(inp.subject) ?? id
      return [...list.filter(x => x.id !== id), { id, subject, activeForm: str(inp.activeForm), status: 'pending' }]
    }
    case 'TaskUpdate': {
      const id = idOf(inp.taskId)
      if (out.success !== true || !id || !list.some(x => x.id === id)) return list as TaskItem[]
      if (inp.status === 'deleted') return list.filter(x => x.id !== id)
      return list.map(x =>
        x.id !== id ? x : { ...x, status: str(inp.status) ?? x.status, subject: str(inp.subject) ?? x.subject, activeForm: str(inp.activeForm) ?? x.activeForm },
      )
    }
    case 'TaskList': {
      if (!Array.isArray(out.tasks)) return list as TaskItem[]
      return out.tasks.flatMap((raw): TaskItem[] => {
        const t = rec(raw)
        const id = idOf(t?.id)
        if (!t || !id) return []
        return [{ id, subject: str(t.subject) ?? id, activeForm: list.find(x => x.id === id)?.activeForm ?? null, status: str(t.status) ?? 'pending' }]
      })
    }
    case 'TodoWrite': {
      if (!Array.isArray(out.newTodos)) return list as TaskItem[]
      return out.newTodos.flatMap((raw, i): TaskItem[] => {
        const t = rec(raw)
        const subject = str(t?.content)
        return t && subject ? [{ id: String(i + 1), subject, activeForm: str(t.activeForm), status: str(t.status) ?? 'pending' }] : []
      })
    }
    default:
      return list as TaskItem[]
  }
}

/** Marks background work `id` (a shell or a monitor the main loop started) as started. */
export function bgStart(bg: BgState, id: string, kind: 'shell' | 'monitor'): BgState {
  return { ...bg, started: { ...bg.started, [id]: kind } }
}

/** Marks background work `id` as ended, once however many times it is told. */
export function bgEnd(bg: BgState, id: string): BgState {
  return bg.ended.includes(id) ? bg : { ...bg, ended: [...bg.ended, id] }
}

/** The task id a `task-notification` prompt reports ended: any status but `running` ends it; null when it names no id. */
export function notificationEnd(text: string): string | null {
  const id = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1]?.trim()
  const status = /<status>([^<]+)<\/status>/.exec(text)?.[1]?.trim()
  return id && status !== 'running' ? id : null
}

/** What the idle band's progress row draws: the task list's counts, or the background work's. */
export type Progress =
  | { kind: 'list'; done: number; total: number; doing: string | null }
  | { kind: 'bg'; running: number; done: number; agents: number; shells: number; monitors: number }

/**
 * The progress of a session with no epic: its task list when it has one, else its background work (running agents from
 * `agents`, running shells and monitors from `bg`, done = ended ids); null when it has neither.
 */
export function progressOf(list: readonly TaskItem[], bg: BgState, agents: readonly AgentInfo[]): Progress | null {
  if (list.length) {
    const doing = list.find(t => t.status === 'in_progress')
    return { kind: 'list', done: list.filter(t => t.status === 'completed').length, total: list.length, doing: doing ? (doing.activeForm ?? doing.subject) : null }
  }
  const ended = new Set(bg.ended)
  const live = activeSessionAgents(agents).filter(a => !ended.has(a.id)).length
  const running = Object.entries(bg.started).filter(([id]) => !ended.has(id))
  const shells = running.filter(([, k]) => k === 'shell').length
  const monitors = running.length - shells
  const total = live + shells + monitors
  return total + ended.size === 0 ? null : { kind: 'bg', running: total, done: ended.size, agents: live, shells, monitors }
}
