// pr-mod: the open PRs of the repo this session stands in, as a pane (/pr-mod) with merge, update and fix
// actions, and a one-line band of counts above the prompt that stacks over whatever the plugins beneath draw.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderNode, TextProps, Timer, UiPressArgument } from 'claude-code'

import type { FixHold, Pr, PrCache, RepoInfo } from '../types'
import {
  FIX_HOLD_MS,
  PR_LIST_ARGV,
  REPO_VIEW_ARGV,
  ago,
  bandCounts,
  canMerge,
  ciPart,
  firstLine,
  fixCiPrompt,
  fixConflictPrompt,
  isConflict,
  isHeld,
  isMine,
  parsePrs,
  parseRepo,
  prUrlsIn,
  rollup,
  sortPrs,
  statePart,
  toastsBetween,
} from './prs'
import type { Tone } from './prs'
import { paletteOf } from './palette'
import type { Palette, PaletteRole } from './palette'

const PANE = 'pr-mod'
const POLL_MS = 60_000
const RECHECK_MS = 5_000
const RECHECK_MAX = 3
const ARM_MS = 8_000
const LIST_TIMEOUT_MS = 30_000
const ACTION_TIMEOUT_MS = 120_000
/** A Button with chrome draws its label plus two columns each side. */
const BUTTON_CHROME_W = 4
const GAP = 1
const GH_PR_CREATE = /\bgh\s+pr\s+create\b/
const REFRESHES = /\bgit\s+push\b|\bgh\s+pr\s/

const EMPTY_CACHE: PrCache = { cwd: '', prs: [], fetchedAt: null, error: null }
const cacheAtom = atom({ plugin: 'pr-mod', key: 'cache' } as const, EMPTY_CACHE)
const repoAtom = atom({ plugin: 'pr-mod', key: 'repo' } as const, null as RepoInfo | null)
const mineAtom = atom({ plugin: 'pr-mod', key: 'mine' } as const, [] as string[])
const armedAtom = atom({ plugin: 'pr-mod', key: 'armed' } as const, null as { number: number; until: number } | null)
const fixAtom = atom({ plugin: 'pr-mod', key: 'fixSent' } as const, {} as Record<string, FixHold>)
const busyAtom = atom({ plugin: 'pr-mod', key: 'busy' } as const, {} as Record<string, string>)
/** the `/config` theme, which picks the palette (palette.ts paletteOf); null until read, so the theme keys draw */
const themeAtom = atom({ plugin: 'pr-mod', key: 'theme' } as const, null as string | null)

type St = {
  running: Promise<void> | null
  timer: Timer | null
  recheckTimer: Timer | null
  recheck: number
  /** PRs this mod merged: their leaving the list is no news */
  mergedHere: number[]
}

type FixKind = 'conflict' | 'ci'

// ---------------------------------------------------------------- drawing helpers

/** `color`: a palette role (palette.ts PaletteRole) */
type Look = { color?: PaletteRole; bold?: boolean; dim?: boolean }
type Run = Look & { text: string; shrink?: boolean }

function run(text: string, look: Look = {}): Run {
  return { text, ...look }
}

function cols(text: string): number {
  return [...text].length
}

function cut(text: string, n: number): string {
  return [...text].slice(0, Math.max(0, n)).join('')
}

function runsWidth(runs: readonly Run[]): number {
  return runs.reduce((n, r) => n + cols(r.text), 0)
}

/** Fits runs into width: the shrinkable run gives first, else the line is cut with an ellipsis. */
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

/** Whether a tree beneath draws anything: core's own component and empty Boxes do not. */
function drawable(node: RenderNode | null | undefined): boolean {
  if (node === null || node === undefined) return false
  if (typeof node === 'string') return node.length > 0
  if (typeof node !== 'object') return false
  if (node.type === 'engine') return false
  if (node.type === 'Box' || node.type === 'Text') return (node.children ?? []).some(drawable)
  return true
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function style(look: Look, pal: Palette): TextProps {
  const out: TextProps = {}
  if (look.color) out.color = pal[look.color]
  if (look.bold) out.bold = true
  if (look.dim) out.dimColor = true
  return out
}

function toneLook(tone: Tone): Look {
  if (tone === 'success') return { color: 'success' }
  if (tone === 'error') return { color: 'error' }
  if (tone === 'warning') return { color: 'warning' }
  if (tone === 'pending') return { color: 'warning' }
  return { dim: true }
}

// ---------------------------------------------------------------- fetching

function failure(out: { exitCode: number; stderr: string }): string {
  return firstLine(out.stderr) || `exit ${out.exitCode}`
}

async function tick($: EngineInterface, st: St, isRecheck: boolean): Promise<void> {
  const cwd = await $.session.cwd()
  const prev = await read($, cacheAtom)
  let repo = await read($, repoAtom)
  if (!repo || repo.cwd !== cwd) {
    let found: RepoInfo
    try {
      const out = await $.process.run(REPO_VIEW_ARGV, { cwd, timeoutMs: LIST_TIMEOUT_MS })
      if (out.exitCode !== 0) throw new Error(failure(out))
      found = parseRepo(out.stdout, cwd)
    } catch (err) {
      const error = messageOf(err)
      await update($, repoAtom, () => null)
      await update($, cacheAtom, () => ({ cwd, prs: [], fetchedAt: null, error }))
      return
    }
    repo = found
    await update($, repoAtom, () => found)
  }

  const kept = prev.cwd === cwd ? prev.prs : []
  let next: Pr[]
  try {
    const out = await $.process.run(PR_LIST_ARGV, { cwd, timeoutMs: LIST_TIMEOUT_MS })
    if (out.exitCode !== 0) throw new Error(failure(out))
    next = parsePrs(out.stdout, kept)
  } catch (err) {
    const error = firstLine(messageOf(err)) || 'gh pr list failed'
    await update($, cacheAtom, c => (c.cwd === cwd ? { ...c, error } : { cwd, prs: [], fetchedAt: null, error }))
    return
  }

  if (prev.fetchedAt !== null && prev.cwd === cwd) {
    const mine = await read($, mineAtom)
    for (const text of toastsBetween(prev.prs, next, mine, st.mergedHere)) $.ui.toast(text)
  }
  const holds = await read($, fixAtom)
  const stillHeld = Object.entries(holds).filter(([key, hold]) => {
    const pr = next.find(p => p.number === Number(key.slice(key.indexOf(':') + 1)))
    return pr !== undefined && pr.headRefOid === hold.oid
  })
  if (stillHeld.length !== Object.keys(holds).length) await update($, fixAtom, () => Object.fromEntries(stillHeld))
  const now = await $.clock.now()
  await update($, cacheAtom, () => ({ cwd, prs: next, fetchedAt: now, error: null }))

  // GitHub answers UNKNOWN while it computes mergeability: look again soon, a few times
  if (!isRecheck) st.recheck = 0
  st.recheckTimer?.cancel()
  st.recheckTimer = null
  const computing = next.some(p => p.mergeStateStatus === 'UNKNOWN' || p.mergeable === 'UNKNOWN')
  if (computing && st.recheck < RECHECK_MAX) {
    st.recheck += 1
    st.recheckTimer = $.clock.after(RECHECK_MS, () => {
      st.recheckTimer = null
      void kick($, st, true)
    })
  }
}

/** Starts a fetch, or joins the one in flight. */
function kick($: EngineInterface, st: St, isRecheck = false): Promise<void> {
  if (st.running) return st.running
  st.running = tick($, st, isRecheck)
    .catch(() => {
      // a failed read leaves the cache as it was; the next tick tries again
    })
    .finally(() => {
      st.running = null
    })
  return st.running
}

/** A fetch that starts now: one already in flight may predate what changed. */
async function refresh($: EngineInterface, st: St): Promise<void> {
  if (st.running) await st.running
  await kick($, st)
}

async function paneShown($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE && p.isShown)
  } catch {
    return false
  }
}

/** Polls only while something shows the PRs: the band (PRs open) or the pane. */
async function poll($: EngineInterface, st: St): Promise<void> {
  const cache = await read($, cacheAtom)
  if (cache.prs.length === 0 && !(await paneShown($))) return
  await kick($, st)
}

// ---------------------------------------------------------------- actions

async function prOf($: EngineInterface, n: number): Promise<Pr | undefined> {
  return (await read($, cacheAtom)).prs.find(p => p.number === n)
}

async function setBusy($: EngineInterface, n: number, what: string | null): Promise<void> {
  await update($, busyAtom, b => {
    const out = { ...b }
    if (what === null) delete out[String(n)]
    else out[String(n)] = what
    return out
  })
}

async function pressMerge($: EngineInterface, st: St, n: number): Promise<void> {
  if ((await read($, busyAtom))[String(n)]) return
  const repo = await read($, repoAtom)
  const method = repo?.method
  if (!repo || !method) return
  const now = await $.clock.now()
  const armed = await read($, armedAtom)
  if (!armed || armed.number !== n || now >= armed.until) {
    const until = now + ARM_MS
    await update($, armedAtom, () => ({ number: n, until }))
    $.clock.after(ARM_MS, () => {
      void update($, armedAtom, a => (a && a.number === n && a.until === until ? null : a))
    })
    return
  }
  await update($, armedAtom, () => null)
  await setBusy($, n, 'merge')
  try {
    const out = await $.process.run(['gh', 'pr', 'merge', String(n), `--${method}`], { cwd: repo.cwd, timeoutMs: ACTION_TIMEOUT_MS })
    if (out.exitCode === 0) {
      st.mergedHere.push(n)
      $.ui.toast(`Merged #${n} (${method})`)
    } else {
      $.ui.toast(`Merge #${n} failed: ${failure(out)}`)
    }
  } catch (err) {
    $.ui.toast(`Merge #${n} failed: ${firstLine(messageOf(err))}`)
  } finally {
    await setBusy($, n, null)
  }
  await refresh($, st)
}

async function pressUpdate($: EngineInterface, st: St, n: number): Promise<void> {
  if ((await read($, busyAtom))[String(n)]) return
  const repo = await read($, repoAtom)
  const pr = await prOf($, n)
  if (!repo || !pr) return
  await setBusy($, n, 'update')
  try {
    const out = await $.process.run(['gh', 'pr', 'update-branch', String(n)], { cwd: repo.cwd, timeoutMs: ACTION_TIMEOUT_MS })
    if (out.exitCode === 0) $.ui.toast(`Updated #${n} from ${pr.baseRefName}`)
    else $.ui.toast(`Update #${n} failed: ${failure(out)}`)
  } catch (err) {
    $.ui.toast(`Update #${n} failed: ${firstLine(messageOf(err))}`)
  } finally {
    await setBusy($, n, null)
  }
  await refresh($, st)
}

async function dropHold($: EngineInterface, key: string, hold: FixHold): Promise<void> {
  await update($, fixAtom, h => {
    const cur = h[key]
    if (!cur || cur.at !== hold.at || cur.oid !== hold.oid) return h
    const out = { ...h }
    delete out[key]
    return out
  })
}

async function pressFix($: EngineInterface, n: number, kind: FixKind): Promise<void> {
  const pr = await prOf($, n)
  if (!pr) return
  const key = `${kind}:${n}`
  const now = await $.clock.now()
  if (isHeld((await read($, fixAtom))[key], pr, now)) return
  // the hold goes up before the prompt: a second press while it submits does nothing
  const hold: FixHold = { at: now, oid: pr.headRefOid, kind }
  await update($, fixAtom, h => ({ ...h, [key]: hold }))
  $.clock.after(FIX_HOLD_MS, () => void dropHold($, key, hold))
  const what = kind === 'conflict' ? 'conflict' : 'CI'
  try {
    const sent = await $.prompt.submit({ text: kind === 'conflict' ? fixConflictPrompt(pr) : fixCiPrompt(pr) })
    if (sent.drop !== undefined) {
      await dropHold($, key, hold)
      $.ui.toast(`Fix ${what} for #${n} not queued: ${firstLine(sent.drop)}`)
      return
    }
    $.ui.toast(`Queued: fix ${what} for #${n}`)
  } catch (err) {
    await dropHold($, key, hold)
    $.ui.toast(`Fix ${what} for #${n} not queued: ${firstLine(messageOf(err))}`)
  }
}

/** No platform call opens a browser: the URL goes to a toast, and to the clipboard where one is reachable. */
async function pressOpen($: EngineInterface, n: number, press: UiPressArgument): Promise<void> {
  const pr = await prOf($, n)
  if (!pr) return
  let isCopied = false
  try {
    isCopied = (await $.ui.copy({ text: pr.url, surface: press.surface })).isCopied
  } catch {
    // no clipboard on this surface: the toast still carries the URL
  }
  $.ui.toast(`#${n} ${pr.url}${isCopied ? ' (copied)' : ''}`)
}

function textOf(ran: unknown): string {
  if (!ran || typeof ran !== 'object') return ''
  const r = ran as { text?: unknown; result?: unknown }
  const parts: string[] = []
  if (typeof r.text === 'string') parts.push(r.text)
  const res = r.result as { stdout?: unknown } | null | undefined
  if (res && typeof res === 'object' && typeof res.stdout === 'string') parts.push(res.stdout)
  return parts.join('\n')
}

// ---------------------------------------------------------------- register

export const register: Register = on => {
  const st: St = { running: null, timer: null, recheckTimer: null, recheck: 0, mergedHere: [] }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: PANE,
      description: 'Open PRs of this repo: a pane with merge, update and fix actions',
    })
    st.timer?.cancel()
    st.timer = $.clock.every(POLL_MS, () => void poll($, st))
    void kick($, st)
    const started = await next(e)
    try {
      const theme = (await $.config.list()).find(row => row.key === 'theme')?.value
      await update($, themeAtom, () => (typeof theme === 'string' ? theme : null))
    } catch {
      // no theme read: the theme keys draw until a theme is set
    }
    return started
  })

  // A theme written from /config or a plugin repaints the band and the pane; a deny or a failed write keeps the palette.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const set = await next(e)
    if (set.deny === undefined && typeof set.value === 'string') {
      const theme = set.value
      try {
        await update($, themeAtom, () => theme)
      } catch {
        // the palette stays as it was
      }
    }
    return set
  }).catch(($, e, next) => next(e))

  // gh pr create names a PR this session made; a push or any gh pr command may have changed the list
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    if (GH_PR_CREATE.test(e.command)) {
      const urls = prUrlsIn(textOf(ran))
      if (urls.length > 0) await update($, mineAtom, mine => [...new Set([...mine, ...urls])])
    }
    if (REFRESHES.test(e.command)) void refresh($, st)
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: PANE }, async $ => {
    await refresh($, st)
    try {
      await $.ui.open({ id: PANE, title: 'PRs' })
    } catch (err) {
      return { text: `pr-mod: the pane did not open: ${messageOf(err)}` }
    }
    const repo = await read($, repoAtom)
    const cache = await read($, cacheAtom)
    if (!repo) return { text: `pr-mod: no GitHub repo here (${cache.error ?? 'not read yet'})` }
    return { text: `Opened the PR pane: ${repo.nameWithOwner}, ${cache.prs.length} open` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const cache = await read($, cacheAtom)
    const repo = await read($, repoAtom)
    const mine = await read($, mineAtom)
    const armed = await read($, armedAtom)
    const holds = await read($, fixAtom)
    const busy = await read($, busyAtom)
    const now = await $.clock.now()
    const width = e.props.bodyColumns
    const pal = paletteOf(await read($, themeAtom))
    const texts = (runs: Run[]) => runs.map(r => <Text {...style(r, pal)}>{r.text}</Text>)

    if (!repo) {
      const line = cache.error ? `pr-mod: no GitHub repo here (${cache.error})` : 'pr-mod: reading open PRs…'
      // the reason is the point of this line: it wraps rather than losing its end
      return (
        <Box flexDirection="column">
          <Box key="none">
            <Text dimColor wrap="wrap">
              {line}
            </Text>
          </Box>
        </Box>
      )
    }

    const rows: RenderElement[] = []
    const refreshW = cols('Refresh') + BUTTON_CHROME_W
    const head = [
      run(repo.nameWithOwner, { dim: true }),
      run(' · ', { dim: true }),
      run(String(cache.prs.length), { bold: true, color: 'claude' }),
      run(' open', { dim: true }),
      run(' · ', { dim: true }),
      run(cache.fetchedAt === null ? 'not fetched yet' : `fetched ${ago(now - cache.fetchedAt)}`, { dim: true }),
    ]
    rows.push(
      <Box key="header" flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">{texts(clip(head, width - refreshW - GAP))}</Box>
        <Button key="refresh" label="Refresh" onPress={() => refresh($, st)} />
      </Box>,
    )
    if (cache.error) rows.push(<Box key="stale">{texts(clip([run(`stale: ${cache.error}`, { dim: true })], width))}</Box>)

    const sorted = sortPrs(cache.prs, mine)
    const room = Math.max(1, e.props.scroll.bodyRows - rows.length)
    const shown = sorted.length > room ? sorted.slice(0, room - 1) : sorted

    for (const pr of shown) {
      const n = pr.number
      const ci = ciPart(pr)
      const state = statePart(pr)
      const left: Run[] = [run(`#${n}`, { bold: true }), run(' '), { text: pr.title, shrink: true }, run('  '), run(ci.text, toneLook(ci.tone))]
      if (state) left.push(run('  '), run(state.text, toneLook(state.tone)))
      if (canMerge(pr) && !repo.method) left.push(run(' · no merge method allowed', { dim: true }))
      if (isMine(pr, mine)) left.push(run(' · mine', { dim: true }))

      type Act = { key: string; label: string; dim?: boolean; onPress: (press: UiPressArgument) => void }
      const acts: Act[] = []
      const doing = busy[String(n)]
      if (canMerge(pr) && repo.method) {
        const isArmed = armed !== null && armed.number === n && now < armed.until
        const text = doing === 'merge' ? 'Merging…' : isArmed ? `Confirm merge #${n} (${repo.method})` : 'Merge'
        acts.push({ key: `merge:${n}`, label: text, onPress: () => pressMerge($, st, n) })
      }
      if (pr.mergeStateStatus === 'BEHIND') {
        acts.push({ key: `update:${n}`, label: doing === 'update' ? 'Updating…' : 'Update branch', onPress: () => pressUpdate($, st, n) })
      }
      if (isConflict(pr)) {
        const held = isHeld(holds[`conflict:${n}`], pr, now)
        acts.push({ key: `fixc:${n}`, label: held ? 'fix sent' : 'Fix conflict', dim: held, onPress: () => pressFix($, n, 'conflict') })
      }
      if (rollup(pr.checks).kind === 'red') {
        const held = isHeld(holds[`ci:${n}`], pr, now)
        acts.push({ key: `fixci:${n}`, label: held ? 'fix sent' : 'Fix CI', dim: held, onPress: () => pressFix($, n, 'ci') })
      }
      acts.push({ key: `open:${n}`, label: 'Open', dim: true, onPress: press => pressOpen($, n, press) })

      const actsW = acts.reduce((w, a) => w + cols(a.label) + BUTTON_CHROME_W, 0) + GAP * (acts.length - 1)
      rows.push(
        <Box key={`pr:${n}`} flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">{texts(clip(left, width - actsW - GAP))}</Box>
          <Box flexDirection="row" columnGap={GAP}>
            {acts.map(a => (
              <Button key={a.key} label={a.label} dimColor={a.dim === true} onPress={a.onPress} />
            ))}
          </Box>
        </Box>,
      )
    }
    if (shown.length < sorted.length) {
      rows.push(<Box key="more">{texts([run(`+${sorted.length - shown.length} more`, { dim: true })])}</Box>)
    }
    return <Box flexDirection="column">{rows}</Box>
  })

  // One line of counts over what the plugins beneath draw; nothing when no PR is open, and a survey passes through.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const cache = await read($, cacheAtom)
    const repo = await read($, repoAtom)
    if (e.props.hasSurvey || !repo || cache.prs.length === 0) return next(e)
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const pal = paletteOf(await read($, themeAtom))
    const c = bandCounts(cache.prs)
    const runs: Run[] = [run('PR', { bold: true, color: 'claude' }), run(' '), run(String(c.open), { bold: true, color: 'claude' }), run(' open', { dim: true })]
    const add = (count: number, text: string, look: Look) => {
      if (count > 0) runs.push(run(' · ', { dim: true }), run(text, look))
    }
    add(c.green, `✔ ${c.green} green`, { color: 'success' })
    add(c.red, `✖ ${c.red} CI red`, { color: 'error' })
    add(c.conflict, `⚠ ${c.conflict} conflict`, { color: 'warning' })
    add(c.pending, `◌ ${c.pending} pending`, { color: 'warning' })
    if (cache.error) runs.push(run(' · stale', { dim: true }))
    const rows: RenderElement[] = [
      <Box key="pr-mod" flexDirection="row">
        {clip(runs, e.props.bodyColumns).map(r => (
          <Text {...style(r, pal)}>{r.text}</Text>
        ))}
      </Box>,
    ]
    if (drawable(below)) rows.push(<Box key="below" flexDirection="column">{below}</Box>)
    return <Box flexDirection="column">{rows}</Box>
  })
}
