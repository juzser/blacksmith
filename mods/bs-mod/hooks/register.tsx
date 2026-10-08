// bs-mod: a band above the prompt, a pane and toasts for the Blacksmith epic
// this CLI session drives. It reads the event logs itself, a few lines at a
// time: the files of every epic one of whose events names this session, and,
// with nothing pinned and none of those to show, of the newest running epic
// under the session's own roots, watched without toasts.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderNode, TextProps } from 'claude-code'

import type { BandTab, EpicView, Hud, PlanTier } from '../types'
import {
  activeSessionAgents,
  bar,
  capped,
  currentModel,
  emptyHud,
  EPIC_ERE,
  epicOfFile,
  epicIdOf,
  epicsFromGrep,
  fmtElapsed,
  fmtTok,
  foldEvent,
  latestPlanName,
  newestRunning,
  nextModel,
  overviewModel,
  parseBsRoots,
  pastModel,
  pickEpic,
  pickView,
  planDirOf,
  planEffort,
  planVersionOf,
  segments,
  shortTask,
  splitLines,
  STATUS_RANK,
  summarize,
} from './fold'
import type { BsEvent, Cells, Phase, PromptRow, Spend, Summary, TaskRow, Tier } from './fold'

const PANE = 'bs-mod'
const TICK_MS = 4000
const TOAST_MS = 6000
/** an event older than this is history, never a toast */
const FRESH_MS = 120_000
const GREP_CHUNK = 200
/** the line that closes an epic, as Blacksmith writes it */
const CLOSED_NEEDLE = '"event_type":"epic-closed"'
/**
 * The lines that give an epic something pickView draws: fold.ts mints a task row only on these, and a
 * `wave-admitted` counts in `admitted`. An epic whose logs hold none (a pre-plan epic: research and
 * prompts under `<epic>/integration`) has nothing to draw.
 */
const DRAWN_ERE = '"event_type":"(task-added|wave-admitted|gate-outcome|wave-merged|task-superseded)"'
const ROOTS_CAP = 20
const SEP = ' · '
/** band bar cells: progress, budget */
const BAND_BAR = 10
const BAND_GAUGE = 8
const PANE_BAR = 24
const MAX_DOTS = 8
/** the active / in-progress status color: no theme key is teal */
const ACTIVE_COLOR = '#14b8a6'
/** the prompts Current and Next show, newest first; no `+N more` row for the rest */
const BAND_PROMPTS = 2
const BS_COMMAND = /\bbs\b|smith|cli\.js|BS_HOME|SMITH_HOME/
const EPIC_ID = /^[A-Za-z0-9][\w.-]*$/

const hudAtom = atom({ plugin: 'bs-mod', key: 'hud' } as const, emptyHud())
const pinnedAtom = atom({ plugin: 'bs-mod', key: 'pinned' } as const, null)
const hiddenAtom = atom({ plugin: 'bs-mod', key: 'isHidden' } as const, false)
const minuteAtom = atom({ plugin: 'bs-mod', key: 'minute' } as const, 0)
const watchedAtom = atom({ plugin: 'bs-mod', key: 'watched' } as const, null)
const planTiersAtom = atom({ plugin: 'bs-mod', key: 'planTiers' } as const, {} as Record<string, PlanTier>)
/** the band's active tab, in `$.state` so a reload of the band keeps it; Overview until a tab is picked */
const tabAtom = atom({ plugin: 'bs-mod', key: 'tab' } as const, 'overview' as BandTab)

type Entry = { path: string; name: string; size: number; mtimeMs: number }
/** a folded line, with the epic of the file it came from */
type Line = { ev: BsEvent; ref: string; ts: number; isNewFile: boolean; fileEpic: string }
type Look = { color?: string; bg?: string; bold?: boolean; dim?: boolean }
/** a stretch of text drawn in one style; `shrink`: the run a band row cuts first when it is too wide */
type Run = Look & { text: string; shrink?: boolean }
/** a piece of a band line; rank 0 always stays, the highest rank goes first */
type Part = { runs: Run[]; rank: number }

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** The event dirs a Bash command taught the mod, as kept in `$.store`. */
function learned(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((x): x is string => typeof x === 'string' && x.startsWith('/')).slice(0, ROOTS_CAP)
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function style(p: Look): TextProps {
  const out: TextProps = {}
  if (p.color) out.color = p.color
  if (p.bg) out.backgroundColor = p.bg
  if (p.bold) out.bold = true
  if (p.dim) out.dimColor = true
  return out
}

function run(text: string, look: Look = {}): Run {
  return { text, ...look }
}

function part(rank: number, ...runs: Run[]): Part {
  return { runs: runs.filter(r => r.text), rank }
}

function partWidth(p: Part): number {
  return p.runs.reduce((n, r) => n + r.text.length, 0)
}

/** Each role keeps one theme color, wherever it is drawn. */
const ROLE_COLOR: Record<string, string> = {
  coder: 'claude',
  tester: 'planMode',
  reviewer: 'ide',
  'spec-reviewer': 'ide',
  verifier: 'bashBorder',
  grader: 'autoAccept',
  'security-reviewer': 'error',
  uiux: 'merged',
  researcher: 'permission',
  planner: 'permission',
  merger: 'success',
  'wave-runner': 'suggestion',
  scribe: 'subtle',
}

function roleColor(role: string): string {
  return ROLE_COLOR[role] ?? 'suggestion'
}

function budgetColor(pct: number): string {
  if (pct >= 90) return 'error'
  if (pct >= 70) return 'warning'
  return 'success'
}

const FINDING_COLOR: Record<string, string> = {
  raised: 'error',
  confirmed: 'error',
  'amend-pending': 'warning',
  'fix-pending': 'claude',
  'fix-landed': 'ide',
}

function chip(epicId: string): Run {
  return run(` ${epicId} `, { bg: 'claude', color: 'inverseText', bold: true })
}

/** The progress bar, one color per status: done, review, active, todo. */
function barRuns(c: Cells): Run[] {
  return [
    run('█'.repeat(c.done), { color: 'success' }),
    run('█'.repeat(c.review), { color: 'ide' }),
    run('█'.repeat(c.active), { color: ACTIVE_COLOR }),
    run('░'.repeat(c.todo), { color: 'inactive' }),
  ].filter(r => r.text)
}

/** The budget gauge, `width` cells filled to `pct` in the budget tone. */
function gaugeRuns(pct: number, width: number): Run[] {
  const full = Math.min(width, Math.max(0, Math.round((pct / 100) * width)))
  return [run('▰'.repeat(full), { color: budgetColor(pct) }), run('▱'.repeat(width - full), { color: 'inactive' })].filter(r => r.text)
}

/** The budget gauge and its numbers, green, then warning at 70%, error at 90%. */
function budgetRuns(b: NonNullable<Summary['budget']>, width: number): Run[] {
  const tone = budgetColor(b.pct)
  return [
    ...gaugeRuns(b.pct, width),
    run(` ${fmtTok(b.projected)}/${fmtTok(b.cap)}`),
    run(' tok ', { dim: true }),
    run(`${b.pct}%`, { color: tone, bold: true }),
  ].filter(r => r.text)
}

/** Status counts after the bar: review, active, todo, each in its bar color. */
function tallyParts(c: Summary['counts']): Part[] {
  const out: Part[] = []
  if (c.review) out.push(part(3, run(`◐ ${c.review} review`, { color: 'ide' })))
  if (c.active) out.push(part(3, run(`● ${c.active} active`, { color: ACTIVE_COLOR })))
  if (c.todo) out.push(part(4, run(`○ ${c.todo} todo`, { dim: true })))
  return out
}

/** Drops the highest-ranked parts, the last of a rank first, until the rest fit. */
function fit(parts: Part[], width: number): Part[] {
  const kept = [...parts]
  const len = () => kept.reduce((n, p, i) => n + partWidth(p) + (i ? SEP.length : 0), 0)
  while (len() > width) {
    let drop = -1
    let dropRank = 0
    kept.forEach((p, i) => {
      if (p.rank > 0 && p.rank >= dropRank) {
        drop = i
        dropRank = p.rank
      }
    })
    if (drop < 0) break
    kept.splice(drop, 1)
  }
  return kept
}

function stateRun(s: Summary): Run {
  if (s.isClosed) return run('✔ closed', { color: 'success', bold: true })
  if (s.now) return run('● running', { color: 'claude', bold: true })
  if (s.isWaitingOnYou) return run('⚑ waiting on you', { color: 'warning', bold: true })
  return run('idle', { dim: true })
}

function statusOf(s: Summary): string {
  return `${s.epicId}${SEP}w${s.wave}${SEP}${s.counts.done}/${s.counts.total}`
}

function glyph(status: string): Look & { mark: string } {
  switch (status) {
    case 'blocked':
    case 'failed':
      return { mark: '✖', color: 'error' }
    case 'escalated':
      return { mark: '⚑', color: 'warning' }
    case 'in-progress':
      return { mark: '●', color: ACTIVE_COLOR }
    case 'reviewing':
    case 'merging':
      return { mark: '◐', color: 'ide' }
    case 'completed':
      return { mark: '✔', color: 'success' }
    // landed without a merge: done, like Blacksmith queries.ts statusBucketForTaskStatus counts it, drawn a step quieter
    case 'waived':
      return { mark: '✔', color: 'success', dim: true }
    case 'superseded':
      return { mark: '–', dim: true }
    default:
      return { mark: '○', dim: true }
  }
}

function taskNumber(id: string): number {
  const m = /task-(\d+)/.exec(id)
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}

// The fold titles a row no task-added named with its own id, so a title that
// is the id (full or short) is no title: the row already draws the id.
function titleText(id: string, title: string): string {
  return title === id || title === shortTask(id) ? '' : title
}

function toneColor(tone: string): string | undefined {
  if (tone === 'bad') return 'error'
  if (tone === 'warn') return 'warning'
  if (tone === 'ok') return 'success'
  return undefined
}

// ── The band: a rule, a tab row and the active tab's rows, each row cut to bodyColumns ─────────

/**
 * The band's tabs in the tab row's order: label, hotkey and accent (the chip, the rule and the header). The
 * hotkeys are letters: a bare digit typed into an empty composer presses a band Button (ButtonProps.hotkey), so a
 * digit would switch tabs from the prompt; a letter fires only while the band holds the focus.
 */
type TabSpec = { id: BandTab; label: string; hotkey: string; accent: string }
const OVERVIEW_TAB: TabSpec = { id: 'overview', label: 'Overview', hotkey: 'o', accent: 'text' }
const TABS: readonly TabSpec[] = [
  OVERVIEW_TAB,
  { id: 'current', label: 'Current', hotkey: 'c', accent: 'permission' },
  { id: 'next', label: 'Next', hotkey: 'n', accent: 'planMode' },
  { id: 'past', label: 'Past', hotkey: 'p', accent: 'success' },
]
const TAB_GAP = 2
/** the columns a plain Button adds to its label: the hotkey, a colon and a space (`c: Current`) */
const PLAIN_HOTKEY_W = 3
/** the columns a Button with chrome adds to its label: `[ Details ]` */
const BUTTON_CHROME_W = 4
/** the band's row labels pad to this, so the bars line up */
const LABEL_W = 8
const TIER_COLOR: Record<Tier, string> = { small: 'success', medium: 'ide', huge: 'autoAccept' }
const PHASE_COLOR: Record<Phase['kind'], string> = {
  planning: 'planMode',
  wave: 'permission',
  after: 'permission',
  closing: 'merged',
  closed: 'success',
}

/** One band row: its key (the test kit and the bodyColumns check find it by it) and its runs, cut to fit when drawn. */
type BandRow = { key: string; runs: Run[] }

/** Columns, counted per code point so a cut never splits a surrogate pair; a wide glyph still counts one. */
function cols(text: string): number {
  return [...text].length
}

function cut(text: string, n: number): string {
  return [...text].slice(0, Math.max(0, n)).join('')
}

function runsWidth(runs: readonly Run[]): number {
  return runs.reduce((n, r) => n + cols(r.text), 0)
}

/** The run a row cuts first when it is too wide: a title, a prompt. */
function shrink(r: Run): Run {
  return { ...r, shrink: true }
}

/** Cuts a row to `width` columns, ending it in `…`: the shrink run gives way first, then the tail. */
function clip(runs: readonly Run[], width: number): Run[] {
  if (width < 1) return []
  const out = runs.filter(r => r.text)
  const over = runsWidth(out) - width
  if (over <= 0) return out
  const i = out.findIndex(r => r.shrink)
  const give = out[i]
  const keep = give ? cols(give.text) - over - 1 : 0
  if (give && keep > 0) {
    out[i] = { ...give, text: `${cut(give.text, keep).trimEnd()}…` }
    return out
  }
  const kept: Run[] = []
  let room = width - 1
  for (const r of out) {
    if (cols(r.text) <= room) {
      kept.push(r)
      room -= cols(r.text)
      continue
    }
    kept.push({ ...r, text: `${cut(r.text, room).trimEnd()}…` })
    break
  }
  return kept
}

/** Parts joined by a separator, after `fit` dropped what the width cannot hold. */
function joinParts(parts: Part[], width: number): Run[] {
  return fit(parts, width).flatMap((p, i) => (i > 0 ? [run(SEP, { color: 'subtle' }), ...p.runs] : p.runs))
}

/** A row label in the tab's accent, padded so the bars line up. */
function label(text: string, accent: string): Run[] {
  return [run(text, { color: accent, bold: true }), run(' '.repeat(Math.max(1, LABEL_W - text.length)))]
}

function num(n: number, look: Look = {}): Run {
  return run(String(n), { ...look, bold: true })
}

function dots(roles: readonly string[]): Run[] {
  return roles.slice(0, MAX_DOTS).map(r => run('●', { color: roleColor(r) }))
}

/** The band's status tallies after the bar, each number bold in its bar color. */
function bandTallies(c: Cells): Part[] {
  const out: Part[] = []
  if (c.review) out.push(part(3, run('◐ ', { color: 'ide' }), num(c.review, { color: 'ide' }), run(' review', { color: 'ide' })))
  if (c.active) out.push(part(3, run('● ', { color: ACTIVE_COLOR }), num(c.active, { color: ACTIVE_COLOR }), run(' active', { color: ACTIVE_COLOR })))
  if (c.todo) out.push(part(4, run('○ ', { color: 'inactive' }), num(c.todo, { color: 'inactive' }), run(' todo', { color: 'inactive' })))
  return out
}

/**
 * A spend row: the label, the gauge in the budget tone, `projected / cap` and the percent; `projected` left out
 * when the row is too narrow for it.
 */
function spendRow(key: string, name: string, accent: string, b: Spend, width: number): BandRow {
  const tone = budgetColor(b.pct)
  const runs = (basis: string) => [
    ...label(name, accent),
    ...gaugeRuns(b.pct, BAND_GAUGE),
    run(' '),
    run(`${fmtTok(b.projected)} / ${fmtTok(b.cap)}`, { color: tone, bold: true }),
    run(basis, { color: 'subtle' }),
    run(' '),
    run(`${b.pct}%`, { color: tone, bold: true }),
  ]
  const full = runs(' projected')
  return { key, runs: runsWidth(full) <= width ? full : runs('') }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** A task row: the status mark, the short id, the title (none when it would repeat the id), the role working it and since when. */
function taskRuns(t: TaskRow): Run[] {
  const g = glyph(t.status)
  const runs = [run(g.mark, { color: g.color ?? 'inactive' }), run(' '), run(t.short, { bold: true })]
  if (t.title) runs.push(run(' '), shrink(run(oneLine(t.title))))
  if (t.role) runs.push(run(' '), run(t.role, { color: roleColor(t.role), bold: true }))
  if (t.elapsed) runs.push(run(' '), run(t.elapsed, { dim: true }))
  return runs
}

/**
 * An operator prompt, apart from the task rows: `❝`, how long ago, the text on one line. `ago`: Past's `5m ago `;
 * Current's and Next's Prompts sections draw the bare age and two spaces.
 */
function promptRuns(p: PromptRow, now: number, ago = true): Run[] {
  const age = fmtElapsed(Math.max(0, now - p.ts))
  return [
    run('❝ ', { color: 'remember' }),
    run(ago ? `${age} ago` : age, { dim: true }),
    run(ago ? ' ' : '  '),
    shrink(run(oneLine(p.text), { color: 'remember' })),
  ]
}

function moreRow(key: string, n: number, what = 'more'): BandRow {
  return { key, runs: [run(`+${n} ${what}`, { dim: true })] }
}

/**
 * How many task rows and prompts fit `budget` rows, each list followed by a `+N more` row when it is cut: a task,
 * a second task, a prompt, then the rest of the tasks, then the rest of the prompts.
 */
function allot(budget: number, tasks: number, prompts: number): [number, number] {
  const total: [number, number] = [tasks, prompts]
  const n: [number, number] = [0, 0]
  const cost = () => n[0] + (n[0] < tasks ? 1 : 0) + n[1] + (n[1] < prompts ? 1 : 0)
  const wants: [0 | 1, number][] = [[0, 1], [0, 2], [1, 1], [0, tasks], [1, prompts]]
  for (const [i, target] of wants) {
    while (n[i] < Math.min(target, total[i])) {
      n[i] += 1
      if (cost() > budget) {
        n[i] -= 1
        break
      }
    }
  }
  return n
}

/** A task list and its prompts in `budget` rows, each cut list ending in a dim `+N more`. */
function listRows(tasks: readonly TaskRow[], prompts: readonly PromptRow[], budget: number, now: number, tag = ''): BandRow[] {
  const [t, p] = allot(budget, tasks.length, prompts.length)
  // not even one row and its `+N more`: one count for both lists
  if (t === 0 && p === 0) return budget >= 1 && tasks.length + prompts.length > 0 ? [moreRow(`more${tag}`, tasks.length + prompts.length)] : []
  const shown = capped(tasks, t)
  const asked = capped(prompts, p)
  const rows: BandRow[] = shown.rows.map(r => ({ key: `task:${r.id}`, runs: taskRuns(r) }))
  if (shown.more) rows.push(moreRow(`more:tasks${tag}`, shown.more))
  rows.push(...asked.rows.map(r => ({ key: `prompt:${r.ref}`, runs: promptRuns(r, now) })))
  if (asked.more) rows.push(moreRow(`more:prompts${tag}`, asked.more))
  return rows.slice(0, Math.max(0, budget))
}

/** The head row of Next and Past: the header in the tab's accent, a watched epic marked dim. */
function headRow(key: string, header: string, accent: string, watched: string | null): BandRow {
  const mark = watched ? [run(SEP, { color: 'subtle' }), run(`watching ${watched}`, { dim: true })] : []
  return { key, runs: [run(header, { color: accent, bold: true }), ...mark] }
}

/** A section divider of Current and Next, `── Tasks ───…`, as wide as the band like the rule. */
function sectionRow(key: string, name: string, width: number): BandRow {
  return {
    key,
    runs: [
      run('── ', { color: 'subtle' }),
      run(name, { color: 'text', bold: true }),
      run(` ${'─'.repeat(Math.max(0, width - 3 - cols(name) - 1))}`, { color: 'subtle' }),
    ],
  }
}

/** `text` in at most `n` columns, ending in `…` when it was cut. */
function ellipsize(text: string, n: number): string {
  if (cols(text) <= n) return text
  return n < 1 ? '' : `${cut(text, n - 1).trimEnd()}…`
}

function spaces(n: number): Run {
  return run(' '.repeat(Math.max(0, n)))
}

/**
 * A task list in columns: the mark, the short id padded to the widest, the title cut with `…` to the room left and
 * padded, then, when a row has them, the role padded to the widest and the elapsed time. With no role or time in the
 * list the title runs to the edge; no row is wider than `width`.
 */
function columnRows(tasks: readonly TaskRow[], width: number): BandRow[] {
  const widest = (f: (t: TaskRow) => string) => Math.max(0, ...tasks.map(t => cols(f(t))))
  const idW = widest(t => t.short)
  const roleW = widest(t => t.role ?? '')
  const timeW = widest(t => t.elapsed ?? '')
  const right = (roleW ? 2 + roleW : 0) + (timeW ? 2 + timeW : 0)
  const titleW = Math.min(widest(t => oneLine(t.title)), Math.max(0, width - 2 - idW - 2 - right))
  return tasks.map(t => {
    const g = glyph(t.status)
    const runs: Run[] = [run(g.mark, { color: g.color ?? 'inactive' }), run(' '), run(t.short, { bold: true }), spaces(idW - cols(t.short))]
    if (titleW > 0) {
      const title = ellipsize(oneLine(t.title), titleW)
      runs.push(run('  '), shrink(run(title)), spaces(titleW - cols(title)))
    }
    if (roleW) runs.push(run('  '), run(t.role ?? '', { color: roleColor(t.role ?? ''), bold: true }), spaces(roleW - cols(t.role ?? '')))
    if (timeW) runs.push(run('  '), run(t.elapsed ?? '', { dim: true }))
    // a row with no role or time ends at its title
    while (runs.at(-1)?.text.trim() === '') runs.pop()
    return { key: `task:${t.id}`, runs }
  })
}

/**
 * How many tasks and prompts Current's and Next's sections show in `budget` rows: a task, a second task, a prompt, a
 * second prompt, then the rest of the tasks. A section costs its divider, a cut task list its `+N more`. With tasks
 * to show and not one that fits, no section shows: the prompts never stand in for the tasks.
 */
function allotSections(budget: number, tasks: number, prompts: number): [number, number] {
  const total: [number, number] = [tasks, prompts]
  const n: [number, number] = [0, 0]
  const cost = () => (n[0] ? 1 + n[0] + (n[0] < tasks ? 1 : 0) : 0) + (n[1] ? 1 + n[1] : 0)
  const wants: [0 | 1, number][] = [[0, 1], [0, 2], [1, 1], [1, 2], [0, tasks]]
  for (const [i, target] of wants) {
    while (n[i] < Math.min(target, total[i])) {
      n[i] += 1
      if (cost() > budget) {
        n[i] -= 1
        break
      }
    }
  }
  return tasks > 0 && n[0] === 0 ? [0, 0] : n
}

/** Current's and Next's lists in `budget` rows: a Tasks section and its `+N more` when cut, then a Prompts section. */
function sectionRows(tasks: readonly TaskRow[], prompts: readonly PromptRow[], budget: number, width: number, now: number): BandRow[] {
  const [t, p] = allotSections(budget, tasks.length, prompts.length)
  // not even one section: one count for both lists
  if (t === 0 && p === 0) return budget >= 1 && tasks.length + prompts.length > 0 ? [moreRow('more', tasks.length + prompts.length)] : []
  const rows: BandRow[] = []
  if (t > 0) {
    const shown = capped(tasks, t)
    rows.push(sectionRow('section:tasks', 'Tasks', width), ...columnRows(shown.rows, width))
    if (shown.more) rows.push(moreRow('more:tasks', shown.more))
  }
  if (p > 0) {
    rows.push(sectionRow('section:prompts', 'Prompts', width))
    rows.push(...prompts.slice(0, p).map(r => ({ key: `prompt:${r.ref}`, runs: promptRuns(r, now, false) })))
  }
  return rows.slice(0, Math.max(0, budget))
}

type BandInput = { epic: EpicView; now: number; rows: number; width: number; watched: boolean; effort: Tier | null; sessionAgents: number }

/** The Overview's `Agents N in this session`: the idle band draws the same part. */
function sessionAgentsPart(n: number, accent: string): Part {
  return part(0, ...label('Agents', accent), num(n), run(' in this session'))
}

/** The active tab: an inverse badge in its accent. */
function badge(t: TabSpec): Run {
  return run(` ${t.label} `, { bg: t.accent, color: 'inverseText', bold: true })
}

/** The band's rule, in the active tab's accent. */
function rule(width: number, accent: string): Run {
  return run('─'.repeat(width), { color: accent })
}

/** What the band holds in `rows`: a blank row, then the rule, from three rows; the rule from two; the tab row
 * always; the body what is left. Short rows clip the body first, then the blank row; the rule and the tab row go
 * last, the rule first. */
function bandFit(rows: number): { blank: boolean; rule: boolean; body: number } {
  if (rows >= 3) return { blank: true, rule: true, body: rows - 3 }
  return { blank: false, rule: rows === 2, body: 0 }
}

const IDLE_LINE = `no running epic${SEP}/bs-mod <epic-id> pins one`

/** The idle band's body, with no epic in view: the session's live agents, styled as the Overview's, then a dim line. */
function idleRows(sessionAgents: number, width: number): BandRow[] {
  return [
    { key: 'agents', runs: joinParts([sessionAgentsPart(sessionAgents, OVERVIEW_TAB.accent)], width) },
    { key: 'idle', runs: [run(IDLE_LINE, { dim: true })] },
  ]
}

/**
 * Whether a tree from beneath draws anything. `next(e)` always answers an element: with no plugin beneath
 * bs-mod, core's `{ type: 'engine' }`, its own AbovePrompt, which draws a survey (passed through before the band
 * draws) and else nothing. An empty Box or Text draws nothing either.
 */
function drawable(node: RenderNode | null | undefined): boolean {
  if (node === null || node === undefined) return false
  if (typeof node === 'string') return node.length > 0
  if (node.type === 'engine') return false
  if (node.type === 'Box' || node.type === 'Text') return (node.children ?? []).some(drawable)
  return true
}

function overviewRows(b: BandInput): BandRow[] {
  const m = overviewModel(b.epic, b.now, b.effort)
  const accent = OVERVIEW_TAB.accent
  const name = b.watched ? [run('watching', { dim: true }), run(' '), run(m.epicId, { dim: true })] : [chip(m.epicId)]
  const head = [part(0, ...name), part(0, run(m.phase.label, { color: PHASE_COLOR[m.phase.kind], bold: true }))]
  if (m.tier.tier) head.push(part(1, run(`tier ${m.tier.tier}`, { color: TIER_COLOR[m.tier.tier], bold: true })))
  const agents = [
    sessionAgentsPart(b.sessionAgents, accent),
    part(1, ...dots(m.agents.roles), run(m.agents.roles.length ? ' ' : ''), num(m.agents.count), run(' in the epic')),
  ]
  const c = m.tasks
  const tasks = [
    part(0, ...label('Tasks', accent), ...barRuns(segments(c, BAND_BAR)), run(' '), run(`${c.done}/${c.total} done`, { color: 'success', bold: true })),
    ...bandTallies(c),
  ]
  const rows: BandRow[] = [
    { key: 'head', runs: joinParts(head, b.width) },
    { key: 'agents', runs: joinParts(agents, b.width) },
    { key: 'tasks', runs: joinParts(tasks, b.width) },
  ]
  if (m.budget) rows.push(spendRow('budget', 'Budget', accent, m.budget, b.width))
  return rows
}

/**
 * Current: one head row (the phase, the wave bar and done/total, the live agents on the wave, the spend, a watched
 * epic), then a Tasks and a Prompts section. A narrow band drops the spend first, then the agents, then the watch.
 */
function currentRows(b: BandInput): BandRow[] {
  const m = currentModel(b.epic, b.now, { prompts: BAND_PROMPTS })
  const accent = 'permission'
  const w = m.wave
  const progress = w ? [run('  '), ...barRuns(segments(w, BAND_BAR)), run(' '), run(`${w.done}/${w.total}`, { color: 'success', bold: true })] : []
  const head = [part(0, run(m.header, { color: accent, bold: true }), ...progress)]
  if (m.agents.count > 0) head.push(part(2, ...dots(m.agents.roles), run(' '), num(m.agents.count)))
  if (m.tokens) {
    const tone = budgetColor(m.tokens.pct)
    head.push(part(3, run(`${fmtTok(m.tokens.projected)}/${fmtTok(m.tokens.cap)}`, { color: tone }), run(' '), run(`${m.tokens.pct}%`, { color: tone, bold: true })))
  }
  if (b.watched) head.push(part(1, run(`watching ${b.epic.epicId}`, { dim: true })))
  const empty = m.tasks.rows.length === 0 && m.prompts.rows.length === 0
  const lists = empty
    ? [{ key: 'empty', runs: [run('nothing running', { color: 'inactive' })] }]
    : sectionRows(m.tasks.rows, m.prompts.rows, b.rows - 1, b.width, b.now)
  return [{ key: 'head', runs: joinParts(head, b.width) }, ...lists]
}

function nextRows(b: BandInput): BandRow[] {
  const m = nextModel(b.epic, b.now, { prompts: BAND_PROMPTS })
  const head = headRow('head', m.header, 'planMode', b.watched ? b.epic.epicId : null)
  if (m.tasks.rows.length === 0) return [head, { key: 'empty', runs: [run('nothing planned', { color: 'inactive' })] }]
  return [head, ...sectionRows(m.tasks.rows, m.prompts.rows, b.rows - 1, b.width, b.now)]
}

function pastRows(b: BandInput): BandRow[] {
  const groups = pastModel(b.epic, b.now).rows
  if (groups.length === 0) return [{ key: 'empty', runs: [run('nothing done yet', { color: 'inactive' })] }]
  const rows: BandRow[] = []
  for (const [i, g] of groups.entries()) {
    const later = groups.length - i - 1
    // a row for `+N more waves` while a later wave waits; a head and one row at least for this one
    const room = b.rows - rows.length - (later > 0 ? 1 : 0)
    if (room < 2 && i > 0) {
      const left = groups.length - i
      rows.push(moreRow('more:groups', left, left === 1 ? 'more wave' : 'more waves'))
      break
    }
    rows.push(i === 0 ? headRow('head', g.label, 'success', b.watched ? b.epic.epicId : null) : { key: `group:${g.label}`, runs: [run(g.label, { color: 'success', bold: true })] })
    rows.push(...listRows(g.tasks.rows, g.prompts.rows, room - 1, b.now, `:${g.label}`))
  }
  return rows
}

/** A key once per drawing: a prompt that asked for work of two waves shows under each. */
function uniqueKeys(rows: BandRow[]): BandRow[] {
  const seen = new Map<string, number>()
  return rows.map(r => {
    const n = (seen.get(r.key) ?? 0) + 1
    seen.set(r.key, n)
    return n === 1 ? r : { ...r, key: `${r.key}#${n}` }
  })
}

/** The active tab's rows, at most `rows` of them. */
function tabRows(tab: BandTab, b: BandInput): BandRow[] {
  const rows = tab === 'current' ? currentRows(b) : tab === 'next' ? nextRows(b) : tab === 'past' ? pastRows(b) : overviewRows(b)
  return uniqueKeys(rows.slice(0, Math.max(0, b.rows)))
}

/** What one load of the module knows; `register` makes it, each hook passes it on. */
type State = {
  hud: Hud
  /** per log file: complete lines folded, and the size they were read at (-1: read again) */
  cursors: Map<string, { lines: number; size: number }>
  /** per log file not yet known to be ours: the size grep last searched */
  scanned: Map<string, number>
  /** per log file: the epic its content names, kept for good (a file's epic never changes) */
  fileEpic: Map<string, string>
  /** per log file whose content names no epic: the size grep last searched */
  probed: Map<string, number>
  /** epics one of whose events names this CLI session */
  mine: Set<string>
  /** the newest running epic of the session's own roots, followed while nothing is pinned and no epic of its own can be shown */
  watched: string | null
  /** per log file of an epic the watch picked: the size grep last searched for `epic-closed` */
  closedScan: Map<string, number>
  /** log files holding an `epic-closed` line */
  closedFiles: Set<string>
  /** per log file of an epic the watch picked: the size grep last searched for a DRAWN_ERE line */
  drawnScan: Map<string, number>
  /** log files holding a DRAWN_ERE line */
  drawnFiles: Set<string>
  maxTs: number
  isBooted: boolean
  running: Promise<void> | null
  lastStatus: string | undefined
  lastMinute: number
  /** the epic of each log file the last tick listed */
  lastEpics: string[]
  lastRoots: string[]
  lastError: string
  timer: { cancel(): void } | null
}

function newState(): State {
  return {
    hud: emptyHud(),
    cursors: new Map(),
    scanned: new Map(),
    fileEpic: new Map(),
    probed: new Map(),
    mine: new Set(),
    watched: null,
    closedScan: new Map(),
    closedFiles: new Set(),
    drawnScan: new Map(),
    drawnFiles: new Set(),
    maxTs: 0,
    isBooted: false,
    running: null,
    lastStatus: undefined,
    lastMinute: -1,
    lastEpics: [],
    lastRoots: [],
    lastError: '',
    timer: null,
  }
}

function resetFold(st: State): void {
  st.hud = emptyHud()
  st.cursors.clear()
  st.maxTs = 0
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The event dirs of this session itself: its BS_HOME / SMITH_HOME and its cwd. */
async function ownRoots($: EngineInterface): Promise<string[]> {
  const cwd = (await $.session.cwd()).replace(/\/$/, '')
  const out = new Set<string>()
  for (const home of [await $.env.get('BS_HOME'), await $.env.get('SMITH_HOME')]) {
    if (home && home.startsWith('/')) out.add(`${home.replace(/\/$/, '')}/state/events`)
  }
  out.add(`${cwd}/state/events`)
  out.add(`${cwd}/.blacksmith/state/events`)
  return [...out]
}

/** The session's own event dirs, then the ones Bash commands taught the mod (shared by every session). */
async function rootsOf($: EngineInterface, own: string[]): Promise<string[]> {
  const out = new Set(own)
  for (const root of learned(await $.store.get('roots'))) out.add(root)
  return [...out]
}

async function listLogs($: EngineInterface, roots: string[]): Promise<Entry[]> {
  const out: Entry[] = []
  for (const dir of roots) {
    let entries
    try {
      entries = await $.fs.list(dir)
    } catch {
      continue
    }
    for (const en of entries) {
      if (en.kind === 'file' && en.name.endsWith('.jsonl')) out.push({ path: `${dir}/${en.name}`, name: en.name, size: en.size, mtimeMs: en.mtimeMs })
    }
  }
  return out
}

/** A log file's epic: the one its content names, else the one its name gives. */
function epicOf(st: State, en: { path: string; name: string }): string {
  return st.fileEpic.get(en.path) ?? epicOfFile(en.name)
}

/**
 * Greps the logs whose epic is unknown for the first one their content names:
 * a name alone cannot tell `web-audit-1-close-<date>` from an epic of its own.
 */
async function resolveEpics($: EngineInterface, st: State, entries: Entry[]): Promise<void> {
  const fresh = entries.filter(en => !st.fileEpic.has(en.path) && st.probed.get(en.path) !== en.size)
  for (let i = 0; i < fresh.length; i += GREP_CHUNK) {
    const chunk = fresh.slice(i, i + GREP_CHUNK)
    const res = await $.process.run(['grep', '-m1', '-oE', '-H', '--', EPIC_ERE, ...chunk.map(c => c.path)])
    // a hit is a fact even when another file of the chunk failed (exit 2)
    for (const [path, epic] of epicsFromGrep(res.stdout)) st.fileEpic.set(path, epic)
    if (res.exitCode === 0 || res.exitCode === 1) for (const c of chunk) if (!st.fileEpic.has(c.path)) st.probed.set(c.path, c.size)
  }
}

/** Greps the logs not yet ours for this session's id; a hit makes its epic ours. */
async function discover($: EngineInterface, st: State, sid: string, entries: Entry[]): Promise<void> {
  const fresh = entries.filter(en => !st.mine.has(epicOf(st, en)) && st.scanned.get(en.path) !== en.size)
  for (let i = 0; i < fresh.length; i += GREP_CHUNK) {
    const chunk = fresh.slice(i, i + GREP_CHUNK)
    const res = await $.process.run(['grep', '-l', '-F', '--', sid, ...chunk.map(c => c.path)])
    if (res.exitCode === 0) for (const path of res.stdout.split('\n')) if (path) st.mine.add(epicOf(st, { path, name: basename(path) }))
    if (res.exitCode === 0 || res.exitCode === 1) for (const c of chunk) st.scanned.set(c.path, c.size)
  }
}

/**
 * The epic to watch among the logs of the session's own roots: newestRunning's pick,
 * once grep found no `epic-closed` line in that epic's logs and found a DRAWN_ERE line
 * there. Only the pick's logs are grepped, each once per size, so a tick re-reads no
 * whole log: a closed pick is remembered, a pick with nothing to draw yet (a pre-plan
 * epic) is set aside for this tick, and the next newest is tried. When grep fails on a
 * pick's logs and found no such line, the pick stands: an unread epic is not an empty one.
 */
async function pickWatched($: EngineInterface, st: State, own: Entry[], now: number): Promise<string | null> {
  const stamps = own.map(en => ({ epic: epicOf(st, en), mtimeMs: en.mtimeMs, isNamed: st.fileEpic.has(en.path) }))
  const seen = new Set<string>()
  const looked = new Set<string>()
  const empty = new Set<string>()
  for (;;) {
    const closed = new Set([...st.closedFiles].map(path => epicOf(st, { path, name: basename(path) })))
    const pick = newestRunning(stamps, new Set([...closed, ...empty]), now)
    if (!pick) return null
    const logs = own.filter(en => epicOf(st, en) === pick)
    const fresh = logs.filter(en => !seen.has(en.path) && st.closedScan.get(en.path) !== en.size)
    if (fresh.length > 0) {
      for (let i = 0; i < fresh.length; i += GREP_CHUNK) {
        const chunk = fresh.slice(i, i + GREP_CHUNK)
        const res = await $.process.run(['grep', '-l', '-F', '--', CLOSED_NEEDLE, ...chunk.map(c => c.path)])
        for (const c of chunk) seen.add(c.path)
        // a hit is a fact even when another file of the chunk failed (exit 2)
        if (res.exitCode === 0) for (const path of res.stdout.split('\n')) if (path) st.closedFiles.add(path)
        if (res.exitCode === 0 || res.exitCode === 1) for (const c of chunk) st.closedScan.set(c.path, c.size)
      }
      continue
    }
    if (logs.some(en => st.drawnFiles.has(en.path))) return pick
    const unread = logs.filter(en => !looked.has(en.path) && st.drawnScan.get(en.path) !== en.size)
    if (unread.length === 0) {
      empty.add(pick)
      continue
    }
    let failed = false
    for (let i = 0; i < unread.length; i += GREP_CHUNK) {
      const chunk = unread.slice(i, i + GREP_CHUNK)
      const res = await $.process.run(['grep', '-l', '-E', '--', DRAWN_ERE, ...chunk.map(c => c.path)])
      for (const c of chunk) looked.add(c.path)
      if (res.exitCode === 0) for (const path of res.stdout.split('\n')) if (path) st.drawnFiles.add(path)
      if (res.exitCode === 0 || res.exitCode === 1) for (const c of chunk) st.drawnScan.set(c.path, c.size)
      else failed = true
    }
    if (failed && !logs.some(en => st.drawnFiles.has(en.path))) return pick
  }
}

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}

/**
 * Glue for fold.ts tierOf's plan fallback, kept minimal: the shown epic's latest
 * plan `effort`, from where Blacksmith latestPlan lists by default (planDirOf of
 * each dir holding the epic's logs), through `$.fs` only. Read once per plan
 * version the fold saw and kept in `planTiers`; skipped once an admission names a
 * tier. A plan written with `--specs-dir` sits elsewhere and is not found.
 */
async function readPlanTier($: EngineInterface, st: State, epic: EpicView, entries: Entry[]): Promise<void> {
  if (epic.admittedTier) return
  const version = planVersionOf(epic)
  if ((await read($, planTiersAtom))?.[epic.epicId]?.version === version) return
  let tier: PlanTier['tier'] = null
  for (const dir of new Set(entries.filter(en => epicOf(st, en) === epic.epicId).map(en => dirOf(en.path)))) {
    const plans = planDirOf(dir, epic.epicId)
    if (!plans) continue
    try {
      const name = latestPlanName((await $.fs.list(plans)).filter(f => f.kind === 'file').map(f => f.name))
      if (name) tier = planEffort(await $.fs.read(`${plans}/${name}`))
    } catch {
      // no plan dir there, or an unreadable plan: no tier from it
    }
    if (tier) break
  }
  await update($, planTiersAtom, held => ({ ...held, [epic.epicId]: { version, tier } }))
}

/** The complete lines each tracked file gained since its cursor. */
async function readChanged($: EngineInterface, st: State, tracked: Entry[]): Promise<Line[]> {
  const out: Line[] = []
  for (const en of tracked) {
    const cur = st.cursors.get(en.path)
    if (cur && cur.size === en.size) continue
    const from = cur?.lines ?? 0
    const res = await $.process.run(['tail', '-n', `+${from + 1}`, en.path])
    if (res.exitCode !== 0) continue
    const { lines, count } = splitLines(res.stdout)
    const base = en.name.replace(/\.jsonl$/, '')
    lines.forEach((text, i) => {
      let ev: BsEvent
      try {
        ev = JSON.parse(text) as BsEvent
      } catch {
        return
      }
      if (!ev || typeof ev.event_type !== 'string') return
      out.push({ ev, ref: `${base}#${from + i}`, ts: (ev.ts && Date.parse(ev.ts)) || 0, isNewFile: from === 0, fileEpic: epicOf(st, en) })
    })
    // A partial last line or a capped read means the file holds more than was folded.
    const isWhole = !res.isStdoutTruncated && (res.stdout === '' || res.stdout.endsWith('\n'))
    st.cursors.set(en.path, { lines: from + count, size: isWhole ? en.size : -1 })
  }
  return out
}

async function tick($: EngineInterface, st: State): Promise<void> {
  const sid = await $.session.id()
  const now = await $.clock.now()
  const pinned = await read($, pinnedAtom)
  const own = await ownRoots($)
  const roots = await rootsOf($, own)
  const entries = await listLogs($, roots)
  st.lastRoots = roots
  await resolveEpics($, st, entries)
  st.lastEpics = entries.map(en => epicOf(st, en))
  if (sid) await discover($, st, sid, entries)

  // Nothing pinned and no epic of its own to show: watch the newest running epic,
  // from the session's own roots only (a learned root is every session's). A session
  // with epics of its own lets the first fold tell whether one of them can be shown.
  const isWatching = !pinned && (st.isBooted || st.mine.size === 0) && !pickEpic(st.hud, null)
  const ownDirs = new Set(own)
  let watched = isWatching ? await pickWatched($, st, entries.filter(en => ownDirs.has(dirOf(en.path))), now) : null
  // the watched epic's events fold like any other, but toasts are for this session's work
  const quiet = watched && !st.mine.has(watched) ? watched : null

  const followed = new Set([...st.mine, ...(pinned ? [pinned] : []), ...(watched ? [watched] : [])])
  const tracked = entries.filter(en => followed.has(epicOf(st, en)))
  // The first read is the history the session booted on: fold it, toast none of it.
  let isQuiet = !st.isBooted
  if (tracked.some(en => (st.cursors.get(en.path)?.size ?? -1) > en.size)) {
    resetFold(st)
    isQuiet = true
  }
  let batch = await readChanged($, st, tracked)
  // A file newly followed may hold events older than what is folded, and the
  // fold is order-sensitive: fold everything again, in time order.
  if (st.maxTs > 0 && batch.some(r => r.isNewFile && r.ts < st.maxTs)) {
    resetFold(st)
    isQuiet = true
    batch = await readChanged($, st, tracked)
  }
  batch.sort((a, b) => a.ts - b.ts)

  for (const r of batch) {
    const notices = foldEvent(st.hud, r.ev, r.ref, sid, r.fileEpic)
    if (r.ts > st.maxTs) st.maxTs = r.ts
    if (isQuiet || now - r.ts > FRESH_MS) continue
    if (quiet && (r.fileEpic === quiet || epicIdOf(r.ev, r.fileEpic) === quiet)) continue
    for (const n of notices) $.ui.toast(n.text, { timeoutMs: TOAST_MS })
  }
  if (batch.length > 0 || isQuiet) {
    const copy = JSON.parse(JSON.stringify(st.hud)) as Hud
    await update($, hudAtom, () => copy)
  }
  // an epic of its own this fold made showable replaces the watched one
  if (watched && pickEpic(st.hud, null)) watched = null
  if (watched !== st.watched) {
    st.watched = watched
    await update($, watchedAtom, () => watched)
  }

  const minute = Math.floor(now / 60_000)
  if (minute !== st.lastMinute) {
    st.lastMinute = minute
    await update($, minuteAtom, () => minute)
  }

  const view = pickView(st.hud, pinned, st.watched)
  if (view) await readPlanTier($, st, view.epic, entries)
  const status = view ? statusOf(summarize(view.epic, now)) : undefined
  if (status !== st.lastStatus) {
    st.lastStatus = status
    $.ui.status(status)
  }
  st.isBooted = true
}

/** Starts a tick unless one runs; resolves when the running one ends. */
function kick($: EngineInterface, st: State): Promise<void> {
  if (!st.running) {
    st.running = tick($, st)
      .then(() => {
        st.lastError = ''
      })
      .catch((err: unknown) => {
        st.lastError = messageOf(err)
      })
      .finally(() => {
        st.running = null
      })
  }
  return st.running
}

/** A tick that starts after the call: one already running may predate a pin. */
async function refresh($: EngineInterface, st: State): Promise<void> {
  if (st.running) await st.running
  await kick($, st)
}

/** What the band, pane and command draw, as pickView decides it from `$.state`. */
async function viewOf($: EngineInterface): Promise<ReturnType<typeof pickView>> {
  return pickView(await read($, hudAtom), await read($, pinnedAtom), await read($, watchedAtom))
}

async function openPane($: EngineInterface, epicId: string): Promise<void> {
  await $.ui.open({ id: PANE, title: `bs · ${epicId}` })
}

export const register: Register = on => {
  const st = newState()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bs-mod',
      description: 'Blacksmith HUD: open the pane; <epic-id> pins an epic, auto follows this session, off/on hides the band',
      argumentHint: '[epic-id|auto|off|on]',
    })
    st.timer?.cancel()
    st.timer = $.clock.every(TICK_MS, () => void kick($, st))
    void kick($, st)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (!BS_COMMAND.test(e.command)) return ran
    try {
      const found = parseBsRoots(e.command, await $.session.cwd(), (await $.env.get('HOME')) ?? '')
      if (found.length > 0) {
        const known = learned(await $.store.get('roots'))
        const merged = [...new Set([...found, ...known])].slice(0, ROOTS_CAP)
        if (merged.join('\n') !== known.join('\n')) await $.store.set('roots', merged)
      }
    } catch (err) {
      st.lastError = messageOf(err)
    }
    void kick($, st)
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'bs-mod' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off' || arg === 'on') {
      await update($, hiddenAtom, () => arg === 'off')
      return { text: arg === 'off' ? 'bs-mod band hidden; /bs-mod on brings it back.' : 'bs-mod band shown.' }
    }
    if (arg === 'auto') {
      await update($, pinnedAtom, () => null)
      await refresh($, st)
      return { text: 'bs-mod follows the epic this session drives.' }
    }
    if (arg) {
      if (!EPIC_ID.test(arg)) return { text: `bs-mod: not an epic id: ${arg}` }
      const before = await read($, pinnedAtom)
      await update($, pinnedAtom, () => arg)
      await refresh($, st)
      if (!st.lastEpics.includes(arg)) {
        await update($, pinnedAtom, () => before)
        await refresh($, st)
        return { text: `bs-mod: no event log found for ${arg} under ${st.lastRoots.join(', ')}` }
      }
      await update($, hiddenAtom, () => false)
      await openPane($, arg)
      return { text: `Pinned ${arg}; /bs-mod auto follows this session again.` }
    }
    // a tick that starts now: the boot tick does not watch yet, so awaiting it alone left the
    // session of an epic with nothing to draw answering "No bs epic" for a TICK_MS
    await refresh($, st)
    const view = await viewOf($)
    if (!view) return { text: 'No bs epic in this session yet; /bs-mod <epic-id> pins one.' }
    await openPane($, view.epic.epicId)
    const how = view.kind === 'watched' ? ' (watching the newest running epic)' : ''
    return { text: `bs-mod pane opened on ${view.epic.epicId}${how}.` }
  })

  // The band always draws, the idle band with no epic in view; it passes only to a survey and when hidden.
  // AbovePrompt is one instance, so the band stacks over what the plugins beneath draw through next.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hiddenAtom))) return next(e)
    const view = await viewOf($)
    await read($, minuteAtom)
    const below = await next(e)
    const stacked = drawable(below)
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    const texts = (runs: Run[]) => runs.map(r => <Text {...style(r)}>{r.text}</Text>)
    const liveAgents = async () => {
      try {
        return activeSessionAgents(await $.agent.list()).length
      } catch {
        // no agent list: the session's count reads 0 until it answers
        return 0
      }
    }
    // maxRows is read-only: a hook cannot hand the plugins beneath fewer rows, and a column taller than maxRows
    // scrolls with the band at its top. So the band takes its rows first, one less when stacked: a one-row tree
    // beneath fits, a taller one scrolls under the band, which stays whole.
    const fit = bandFit(Math.max(1, e.props.maxRows - (stacked ? 1 : 0)))
    const band = (accent: string, tabRow: RenderElement, body: BandRow[]) => {
      const rows: RenderElement[] = []
      // an empty Text, not marginTop: a row the harness finds and counts, the same row in Ink
      if (fit.blank) rows.push(<Box key="blank"><Text>{' '}</Text></Box>)
      if (fit.rule) rows.push(<Box key="rule">{texts([rule(width, accent)])}</Box>)
      rows.push(tabRow)
      for (const r of body.slice(0, fit.body)) rows.push(<Box key={r.key} flexDirection="row">{texts(clip(r.runs, width))}</Box>)
      if (stacked) rows.push(<Box key="below" flexDirection="column">{below}</Box>)
      return <Box flexDirection="column">{rows}</Box>
    }

    if (!view) {
      const tabRow = <Box key="tabs" flexDirection="row">{texts([badge(OVERVIEW_TAB)])}</Box>
      return band(OVERVIEW_TAB.accent, tabRow, fit.body > 0 ? idleRows(await liveAgents(), width) : [])
    }
    const epic = view.epic
    const now = await $.clock.now()
    const s = summarize(epic, now)
    const picked = await read($, tabAtom)
    const active = TABS.find(t => t.id === picked) ?? OVERVIEW_TAB

    // the tab row: the tabs on the left; the waits, the S1/S2 count and Details on the right, dropped in reverse
    // order when the row is narrow, before the tabs give anything up
    const waiting = s.waits.waivers + s.waits.escalations + s.waits.specs
    const side: { w: number; el: RenderElement }[] = []
    for (const r of [
      waiting ? run(`⚑ ${waiting} waiting on you`, { color: 'warning', bold: true }) : null,
      s.blockers.total ? run(`✖ ${s.blockers.total} S1/S2 open`, { color: 'error', bold: true }) : null,
    ]) {
      if (r) side.push({ w: cols(r.text), el: <Text {...style(r)}>{r.text}</Text> })
    }
    side.push({ w: cols('Details') + BUTTON_CHROME_W, el: <Button key="details" label="Details" dimColor onPress={() => openPane($, epic.epicId)} /> })
    const tabsW = (gap: number) =>
      TABS.reduce((n, t) => n + cols(t.label) + (t.id === active.id ? 2 : PLAIN_HOTKEY_W), 0) + gap * (TABS.length - 1)
    const sideW = () => side.reduce((n, x) => n + x.w, 0) + TAB_GAP * Math.max(0, side.length - 1)
    while (side.length && tabsW(TAB_GAP) + TAB_GAP + sideW() > width) side.pop()
    const gap = tabsW(TAB_GAP) <= width ? TAB_GAP : 1
    const tabs = TABS.map(t => {
      if (t.id === active.id) return texts([badge(t)])[0]
      return (
        <Box key={`tabbox:${t.id}`}>
          <Button key={`tab:${t.id}`} label={t.label} hotkey={t.hotkey} plain hover={{ color: t.accent, bold: true }} onPress={() => update($, tabAtom, () => t.id)} />
        </Box>
      )
    })
    const tabRow = (
      <Box key="tabs" flexDirection="row" justifyContent="space-between">
        {[
          <Box flexDirection="row" columnGap={gap}>{tabs}</Box>,
          ...(side.length ? [<Box flexDirection="row" columnGap={TAB_GAP}>{side.map(x => x.el)}</Box>] : []),
        ]}
      </Box>
    )

    // the tab's own rows, given what the fit leaves them
    let body: BandRow[] = []
    if (fit.body > 0) {
      const sessionAgents = active.id === 'overview' ? await liveAgents() : 0
      const effort = (await read($, planTiersAtom))?.[epic.epicId]?.tier ?? null
      const watched = view.kind === 'watched'
      body = tabRows(active.id, { epic, now, rows: fit.body, width, watched, effort, sessionAgents })
    }
    return band(active.accent, tabRow, body)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const view = await viewOf($)
    await read($, minuteAtom)
    if (!view) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No bs epic in this session yet; /bs-mod {'<epic-id>'} pins one.</Text>
        </Box>
      )
    }
    const epic = view.epic
    const now = await $.clock.now()
    const s = summarize(epic, now)
    const rows: RenderElement[] = []
    const gap = () => rows.push(<Text> </Text>)
    const row = (...runs: Run[]) =>
      rows.push(<Box flexDirection="row">{runs.filter(r => r.text).map(r => <Text {...style(r)}>{r.text}</Text>)}</Box>)
    const heading = (title: string, color: string, extra = '') => {
      gap()
      row(run('▍', { color }), run(title, { color, bold: true }), run(extra, { dim: true }))
    }
    const joined = (parts: Part[]) => parts.flatMap((p, i) => (i > 0 ? [run(SEP, { dim: true }), ...p.runs] : p.runs))

    const watching = view.kind === 'watched' ? [run(SEP, { dim: true }), run('watching · newest running epic', { dim: true })] : []
    row(chip(s.epicId), run(' '), run(`wave ${s.wave}`, { color: 'permission', bold: true }), run(SEP, { dim: true }), stateRun(s), ...watching)
    const c = s.counts
    row(...barRuns(segments(c, PANE_BAR)), run(' '), run(`${c.done}/${c.total} done`, { color: 'success', bold: true }), ...tallyParts(c).flatMap(t => [run(SEP, { dim: true }), ...t.runs]))
    if (s.budget) {
      const status = epic.budget?.status ? `${SEP}${epic.budget.status}` : ''
      row(...budgetRuns(s.budget, PANE_BAR), run(status, { dim: true }))
    }

    // the fold's live list: open dispatches plus one wave-runner per live wave session
    const live = s.agents
    heading('Agents', 'claude', `${SEP}${live.length} live`)
    if (live.length === 0) row(run(`  none${s.next ? `${SEP}next ${s.next}` : ''}`, { dim: true }))
    const pad = live.reduce((n, a) => Math.max(n, a.role.length), 0)
    for (const a of live) {
      const color = roleColor(a.role)
      row(
        run('  ● ', { color }),
        run(a.role, { color, bold: true }),
        run(' '.repeat(pad - a.role.length + 1)),
        run(shortTask(a.taskId), { bold: true }),
        run(`${SEP}${fmtElapsed(now - a.since)}`, { dim: true }),
        run(a.model ? `${SEP}${a.model}` : '', { color: 'subtle' }),
      )
    }
    if (s.staleCount) row(run(`  ${plural(s.staleCount, 'dispatch')} with no result for over 3h`, { dim: true }))

    // a closed epic waits on nothing (summarize zeroes s.waits); the maps keep the history
    const waits = s.isClosed ? [] : [
      ...epic.pendingWaivers.map(t => `waiver pending ${shortTask(t)}`),
      ...Object.entries(epic.escalations).map(([k, t]) => `escalation ${t ? shortTask(t) : k.split(':')[0]}`),
      ...epic.pendingSpecChanges.map(r => `spec change ${r}`),
    ]
    if (waits.length > 0) {
      heading('Waiting on you', 'warning', `${SEP}${waits.length}`)
      for (const w of waits) row(run('  ⚑ ', { color: 'warning', bold: true }), run(w, { color: 'warning' }))
    }
    if (s.blockers.total > 0) {
      heading('Blocks close', 'error', `${SEP}${s.blockers.total} S1/S2 open`)
      row(
        run('  ✖ ', { color: 'error', bold: true }),
        run(`S1 ${s.findings.S1}`, { color: 'error', bold: true }),
        run(SEP, { dim: true }),
        run(`S2 ${s.findings.S2}`, { color: 'warning', bold: true }),
      )
      const byStatus = Object.entries(s.blockers.byStatus).map(([k, n]) => part(0, run(`${n} ${k}`, { color: FINDING_COLOR[k] ?? 'subtle' })))
      row(run('  '), ...joined(byStatus))
    }

    const tasks = Object.entries(epic.tasks)
      .filter(([, t]) => t.origin !== 'escalation')
      .sort(([a, x], [b, y]) => (STATUS_RANK[x.status] ?? 1) - (STATUS_RANK[y.status] ?? 1) || taskNumber(a) - taskNumber(b))
    heading('Tasks', 'permission', `${SEP}${tasks.length}`)
    for (const [id, t] of tasks) {
      const g = glyph(t.status)
      const isDone = t.status === 'completed' || t.status === 'waived' || t.status === 'superseded'
      const title = titleText(id, t.title)
      rows.push(
        <Box flexDirection="row" columnGap={1}>
          <Text>{' '}</Text>
          <Text {...style(g)}>{g.mark}</Text>
          <Text bold={!isDone} dimColor={isDone}>{shortTask(id)}</Text>
          {title ? <Text wrap="truncate-end" dimColor={isDone}>{title}</Text> : null}
          <Text {...style(isDone ? { dim: true } : g)}>{t.status}</Text>
        </Box>,
      )
    }

    const recent = [...epic.activity].reverse().slice(0, Math.max(5, (e.viewport?.rows ?? 24) - rows.length - 4))
    if (recent.length > 0) {
      heading('Recent', 'suggestion')
      for (const a of recent) {
        rows.push(
          <Box flexDirection="row" columnGap={1}>
            <Text dimColor>{`${fmtElapsed(now - a.ts)} ago`.padStart(10)}</Text>
            <Text {...style({ color: toneColor(a.tone) })}>{a.text}</Text>
          </Box>,
        )
      }
    }

    gap()
    rows.push(<Text dimColor>/bs-mod {'<epic-id>'} pins · auto follows this session · off hides the band</Text>)
    if (st.lastError) rows.push(<Text color="error">{`last read failed: ${st.lastError}`}</Text>)
    return <Box flexDirection="column">{rows}</Box>
  })
}
