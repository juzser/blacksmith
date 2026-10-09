import { test, expect, mock, describe } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { AgentInfo, On, RenderElement } from 'claude-code'

// A fake Blacksmith clone: one events directory, read the way the mod reads
// it (fs.list, grep -l, grep -m1 -oE, tail -n +K), its files growing as the
// test appends.
const SID = 'sid-1'
const CWD = '/w/proj'
const ROOT = '/w/proj/state/events'
const T0 = Date.parse('2026-10-07T03:00:00.000Z')
const MIN = 60_000
const T15 = 'web-ux-4/task-15-settings-panels'
const T16 = 'web-ux-4/task-16-phone-toolbar-hits'
const T17 = 'web-ux-4/task-17-remote-error-and-phone-header'
const EPIC_S = 'web-ux-4-2026-10-04'
const WAVE_S = 'web-ux-4-w4-2026-10-07'
const OTHER_S = 'other-1-2026-10-01'
const EPIC_F = `${ROOT}/${EPIC_S}.jsonl`
const WAVE_F = `${ROOT}/${WAVE_S}.jsonl`
const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 115,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}
/** What core answers `next(e)` with for AbovePrompt: the component it draws itself (a survey, else nothing). */
const ENGINE: RenderElement = { type: 'engine', ref: 0 }
/** The idle band's rows: no epic in view. */
const IDLE_KEYS = ['blank', 'rule', 'tabs', 'agents', 'idle']
const IDLE_LINE = 'no running epic · /bs-mod <epic-id> pins one'
const PANE = {
  title: 'bs · web-ux-4',
  isFocused: false,
  bodyColumns: 80,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}
const PRESENTATION = { isFullscreen: false, columns: 120 }

function line(session_id: string, cli: string, event_type: string, task_id: string | null, at: number, payload: Record<string, unknown> = {}, causal_parent?: string): string {
  const parent = causal_parent === undefined ? {} : { causal_parent }
  return `${JSON.stringify({ session_id, actor: 'orchestrator', event_type, task_id, payload, cli_session_id: cli, ts: new Date(at).toISOString(), ...parent })}\n`
}

function seed(): Map<string, string> {
  const files = new Map<string, string>()
  files.set(EPIC_F, [
    line(EPIC_S, SID, 'task-added', T15, T0 - 60 * MIN, { title: 'Settings panels' }),
    line(EPIC_S, SID, 'task-added', T16, T0 - 60 * MIN, { title: 'Phone toolbar hits' }),
    line(EPIC_S, SID, 'task-added', T17, T0 - 60 * MIN, { title: 'Remote error and phone header' }),
    line(EPIC_S, SID, 'wave-admitted', null, T0 - 50 * MIN, {
      epic_id: 'web-ux-4',
      task_ids: [T15, T16, T17],
      budget: { cap_tokens: 16_000_000, projected_tokens: 9_100_000, status: 'ok' },
    }),
  ].join(''))
  // The wave session writes under another CLI session: tracked because its
  // epic is this session's, not because it names this session.
  files.set(WAVE_F, [
    line(WAVE_S, 'sid-w', 'dispatch_decision', T15, T0 - 40 * MIN, { agent_role: 'coder', model: 'opus' }),
    line(WAVE_S, 'sid-w', 'task-result-recorded', T15, T0 - 30 * MIN, { agent_role: 'coder', run_status: 'done' }),
    line(WAVE_S, 'sid-w', 'gate-outcome', T15, T0 - 25 * MIN, { outcome: 'pass' }),
    line(WAVE_S, 'sid-w', 'wave-merged', null, T0 - 20 * MIN, { epic_id: 'web-ux-4', task_ids: [T15] }),
    line(WAVE_S, 'sid-w', 'dispatch_decision', T16, T0 - 12 * MIN, { agent_role: 'coder', model: 'sonnet' }),
  ].join(''))
  files.set(`${ROOT}/${OTHER_S}.jsonl`, [
    line(OTHER_S, 'sid-other', 'task-added', 'other-1/task-1-x', T0 - 3 * 1440 * MIN, { title: 'X' }),
    line(OTHER_S, 'sid-other', 'wave-admitted', null, T0 - 3 * 1440 * MIN, { epic_id: 'other-1', task_ids: ['other-1/task-1-x'] }),
  ].join(''))
  return files
}

const ASK_1 = 'Group by tag (Recommended · 80%)'
const ASK_2 = 'Add task 18: phone tab bar.'
const T18 = 'web-ux-4/task-18-phone-tab-bar'
const promptRef = (i: number) => `${EPIC_S}#${i}`

/**
 * seed() with the operator's prompts, as Blacksmith links them: ASK_1 (line 0) reaches the three tasks and the
 * admission through causal_parent, ASK_2 (line 5) a task no wave took. The admission names its tier.
 */
function prompted(): Map<string, string> {
  const files = seed()
  files.set(EPIC_F, [
    line(EPIC_S, SID, 'user_prompt', null, T0 - 70 * MIN, { prompt: ASK_1 }),
    line(EPIC_S, SID, 'task-added', T15, T0 - 60 * MIN, { title: 'Settings panels' }, promptRef(0)),
    line(EPIC_S, SID, 'task-added', T16, T0 - 60 * MIN, { title: 'Phone toolbar hits' }, promptRef(0)),
    line(EPIC_S, SID, 'task-added', T17, T0 - 60 * MIN, { title: 'Remote error and phone header' }, promptRef(0)),
    line(EPIC_S, SID, 'wave-admitted', null, T0 - 50 * MIN, {
      epic_id: 'web-ux-4',
      task_ids: [T15, T16, T17],
      budget: { cap_tokens: 16_000_000, projected_tokens: 9_100_000, status: 'ok', tier: 'medium' },
    }, promptRef(0)),
    line(EPIC_S, SID, 'user_prompt', null, T0 - 8 * MIN, { prompt: ASK_2 }),
    line(EPIC_S, SID, 'task-added', T18, T0 - 7 * MIN, { title: 'Phone tab bar' }, promptRef(5)),
  ].join(''))
  return files
}

/** The eight extra tasks wave5() adds. */
const EXTRA = Array.from({ length: 8 }, (_, i) => `web-ux-4/task-${30 + i}-extra-${i}`)

/**
 * prompted() and then a wave 5 of task-18 and eight more, admitted from a third prompt (line 15): eleven open tasks
 * (task-16 and task-17 still open from wave 4) and three prompts, more than a band body holds.
 */
function wave5(): Map<string, string> {
  const files = prompted()
  files.set(EPIC_F, (files.get(EPIC_F) ?? '') + [
    ...EXTRA.map(id => line(EPIC_S, SID, 'task-added', id, T0 - 6 * MIN, { title: `Extra work ${id.slice(-1)}` }, promptRef(5))),
    line(EPIC_S, SID, 'user_prompt', null, T0 - 4 * MIN, { prompt: 'Run wave 5 now' }),
    line(EPIC_S, SID, 'wave-admitted', null, T0 - 3 * MIN, {
      epic_id: 'web-ux-4',
      task_ids: [T18, ...EXTRA],
      budget: { cap_tokens: 16_000_000, projected_tokens: 9_100_000, status: 'ok', tier: 'medium' },
    }, promptRef(15)),
  ].join(''))
  return files
}

/** The session's own subagents, as `$.agent.list()` answers them. */
function agent(id: string, status: AgentInfo['status']): AgentInfo {
  return { id, description: id, type: 'general-purpose', status }
}

type Finder = { find: (q: { key?: string; type?: string; text?: RegExp }) => Promise<{ text: string; props: Record<string, unknown> } | undefined> }

/** The text of the row keyed `key`: `head` is the active tab's first body row. */
async function rowText(ui: Finder, key: string): Promise<string> {
  return (await ui.find({ key }))?.text ?? ''
}

/** The keys of the band's rows as drawn: the band is one column Box, each row a keyed child. */
async function rowKeys(ui: { drawn: () => Promise<RenderElement> }): Promise<string[]> {
  const root = await ui.drawn()
  const kids = 'children' in root ? (root.children ?? []) : []
  return kids.map(k => (typeof k === 'object' && k && 'props' in k ? String((k.props as { key?: unknown } | undefined)?.key ?? '') : ''))
}

function mountBand($: Engine, surface: (typeof SURFACES)[number] = 'terminal', props: typeof BAND = BAND) {
  return $.ui.mount({ plugin: 'bs-mod', surface, component: 'AbovePrompt', props })
}

type World = {
  files: Map<string, string>
  toasts: string[]
  statuses: (string | undefined)[]
  opened: string[]
  commands: string[]
  /** called when a session.start reaches the engine, beneath every plugin */
  onStart?: () => void
  /** the paths of each `grep -m1 -oE` call, in call order */
  resolves: string[][]
  /** a file's mtime when not T0 */
  mtimes: Map<string, number>
  /** the path of each `tail` call, in call order */
  tails: string[]
  /** paths whose `tail` exits non-zero though the file is listed */
  unreadable: Set<string>
  /** what `$.agent.list()` answers: the session's subagents */
  agents: AgentInfo[]
  /** what lies beneath bs-mod in AbovePrompt: core's own drawing, another plugin's one-line band, or an empty Box */
  below: 'engine' | 'line' | 'empty'
  /** each `bs-prompt-hook` call's argv, in call order */
  hookCalls: string[][]
  /** each `node <entry> --resolve` call's argv, in call order */
  nodeCalls: string[][]
  /** the files `$.fs.exists` answers true for, besides every seeded one */
  present: Set<string>
  /** what `bs-prompt-hook --resolve` answers: a stdout and exit code, or null for no such bin (the call is denied) */
  hook: { stdout: string; exitCode: number } | null
  /** a tool's result, as the engine answers `$.tool.call`; the default is an empty Bash result */
  tools: Record<string, unknown>
}

function world(on: On, files: Map<string, string>, sid = SID, cwd = CWD): World {
  const w: World = { files, toasts: [], statuses: [], opened: [], commands: [], resolves: [], mtimes: new Map(), tails: [], unreadable: new Set(), agents: [], below: 'engine', hookCalls: [], nodeCalls: [], present: new Set(), hook: null, tools: {} }
  const ran = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

  on('session.id', () => ({ value: sid }))
  on('session.cwd', () => ({ value: cwd }))
  on('agent.list', () => ({ value: w.agents }))
  on('fs.list', ($, e) => {
    const prefix = `${e.path.replace(/\/$/, '')}/`
    const paths = [...files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
    if (paths.length === 0) return { deny: `no such directory: ${e.path}` }
    return {
      value: paths.map(p => ({ name: p.slice(prefix.length), kind: 'file' as const, size: (files.get(p) ?? '').length, mtimeMs: w.mtimes.get(p) ?? T0, isLink: false })),
    }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || w.present.has(e.path) }))
  on('process.run', ($, e) => {
    const [cmd, ...rest] = e.argv
    if (cmd === 'node') {
      w.nodeCalls.push(e.argv.slice(1))
      return w.hook ? ran(w.hook.exitCode, w.hook.stdout) : { deny: 'no such command: node' }
    }
    // grep -m1 -oE -H -- <ERE> <paths>: per file, every match on its first matching line, as `path:match`
    if (cmd === 'grep' && rest.includes('-oE')) {
      const at = rest.indexOf('--')
      if (!rest.includes('-m1') || !rest.includes('-H')) return { deny: `unexpected grep: ${e.argv.join(' ')}` }
      const ere = rest[at + 1] ?? ''
      const paths = rest.slice(at + 2)
      w.resolves.push(paths)
      let out = ''
      for (const p of paths) {
        const first = (files.get(p) ?? '').split('\n').find(l => new RegExp(ere).test(l))
        for (const m of first?.match(new RegExp(ere, 'g')) ?? []) out += `${p}:${m}\n`
      }
      return ran(out ? 0 : 1, out)
    }
    // grep -l [-F|-E] -- <needle> <paths>: the files holding the needle (a fixed string, or with -E an ERE)
    if (cmd === 'grep') {
      const at = rest.indexOf('--')
      const needle = rest[at + 1] ?? '\0'
      const holds = rest.includes('-E') ? (text: string) => new RegExp(needle).test(text) : (text: string) => text.includes(needle)
      const hits = rest.slice(at + 2).filter(p => holds(files.get(p) ?? ''))
      return ran(hits.length ? 0 : 1, hits.map(p => `${p}\n`).join(''))
    }
    if (cmd === 'tail' && rest[0] === '-n') {
      w.tails.push(rest[2] ?? '')
      const text = files.get(rest[2] ?? '')
      if (text === undefined || w.unreadable.has(rest[2] ?? '')) return ran(1, '')
      return ran(0, text.split('\n').slice(Number((rest[1] ?? '+1').replace('+', '')) - 1).join('\n'))
    }
    if (cmd === 'bs-prompt-hook') {
      w.hookCalls.push(e.argv.slice(1))
      return w.hook ? ran(w.hook.exitCode, w.hook.stdout) : { deny: 'no such command: bs-prompt-hook' }
    }
    return { deny: `unexpected process: ${e.argv.join(' ')}` }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('command.register', ($, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', ($, e) => {
    w.onStart?.()
    return { cwd: e.cwd }
  })
  on('tool.call', ($, e) => ({ result: (w.tools[e.tool] ?? { stdout: '', stderr: '', interrupted: false }) as never, text: '' }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if (w.below === 'line') return h(Box, { key: 'other' }, h(Text, null, 'other plugin band')) as RenderElement
    if (w.below === 'empty') return h(Box, null) as RenderElement
    return ENGINE
  })
  return w
}

async function boot($: Engine, clock: MockClock, cwd = CWD): Promise<void> {
  await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
  await clock.settle()
}

function bs($: Engine, args: string) {
  return $.command.run({ command: 'bs-mod', args, origin: { kind: 'composer' }, presentation: PRESENTATION })
}

/** Everything the drawing shows, its outermost element's text. */
async function shown(ui: { find: (q: { type?: string }) => Promise<{ text: string } | undefined> }): Promise<string> {
  return (await ui.find({}))?.text ?? ''
}

function append(w: World, path: string, text: string): void {
  w.files.set(path, (w.files.get(path) ?? '') + text)
}

describe('band', () => {
  for (const surface of SURFACES) {
    test(`draws a rule, four tabs and Overview by default: epic, phase, tier, agents, tasks and budget (${surface})`, async ($, on) => {
      const w = world(on, prompted())
      w.agents = [agent('a1', 'running'), agent('a2', 'waiting'), agent('a3', 'pending'), agent('a4', 'completed'), agent('a5', 'idle')]
      const clock = mock.clock(on, { now: T0 })
      mock.store(on)
      mock.env(on, { HOME: '/home/u' })
      await boot($, clock)

      const ui = await mountBand($, surface)
      const text = await shown(ui)
      expect((await rowKeys(ui)).slice(0, 3)).toEqual(['blank', 'rule', 'tabs'])
      expect(await rowText(ui, 'rule')).toBe('─'.repeat(115))
      const tabs = await rowText(ui, 'tabs')
      expect(tabs).toMatch(/^ Overview .*Current.*Next.*Past/)
      expect(await rowText(ui, 'head')).toMatch(/web-ux-4\s+· wave 4 · tier medium/)
      // running, waiting and pending are active; completed and idle are not
      expect(await rowText(ui, 'agents')).toMatch(/^Agents.*3 in this session · .*2 in the epic$/)
      // T15 done, T16 active, T17 and T18 todo
      expect(await rowText(ui, 'tasks')).toMatch(/^Tasks.*1\/4 done/)
      expect(await rowText(ui, 'budget')).toMatch(/^Budget.*9\.1M \/ 16M projected.*57%/)
      expect(text).not.toContain('other-1')
    })
  }

  test('Current draws one head row (phase, wave bar, agents, spend), then a Tasks and a Prompts section', async ($, on) => {
    world(on, prompted())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await mountBand($)
    await ui.press({ key: 'tab:current' })
    expect(await rowKeys(ui)).toEqual(['blank', 'rule', 'tabs', 'head', 'section:tasks', `task:${T16}`, `task:${T17}`, 'section:prompts', `prompt:${promptRef(5)}`, `prompt:${promptRef(0)}`])
    // the wave's 1/3 done, its coder and wave-runner, the epic's projected spend: no Wave or Tokens row below
    expect(await rowText(ui, 'head')).toMatch(/^wave 4  [█░]{10} 1\/3 · ●● 2 · 9\.1M\/16M 57%$/)
    expect(await rowText(ui, 'section:tasks')).toBe(`── Tasks ${'─'.repeat(115 - 9)}`)
    // the title column is as wide as the widest title, so the role and the time line up after it
    expect(await rowText(ui, `task:${T16}`)).toBe(`● task-16  Phone toolbar hits${' '.repeat(11)}  coder  12m`)
    expect(await rowText(ui, `task:${T17}`)).toBe('○ task-17  Remote error and phone header')
    expect(await rowText(ui, 'section:prompts')).toBe(`── Prompts ${'─'.repeat(115 - 11)}`)
    // ASK_1, reached through the admission's and the tasks' causal_parent, names the first task it led to and the two more
    expect(await rowText(ui, `prompt:${promptRef(0)}`)).toBe(`❝ 1h10m  ${ASK_1} → task-15 +2`)
    // ASK_2 asked for task-18 only: Current shows every prompt of the epic, linked to the wave or not
    expect(await rowText(ui, `prompt:${promptRef(5)}`)).toBe(`❝ 8m  ${ASK_2} → task-18`)
    expect(await shown(ui)).not.toContain('Task 18 row')
  })

  test('Next draws its head, then a Tasks and a Prompts section of the open tasks no wave took', async ($, on) => {
    world(on, prompted())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await mountBand($)
    await ui.press({ key: 'tab:next' })
    expect(await rowKeys(ui)).toEqual(['blank', 'rule', 'tabs', 'head', 'section:tasks', `task:${T18}`, 'section:prompts', `prompt:${promptRef(5)}`])
    expect(await rowText(ui, 'head')).toBe('after wave 4')
    expect(await rowText(ui, 'section:tasks')).toBe(`── Tasks ${'─'.repeat(115 - 9)}`)
    expect(await rowText(ui, `task:${T18}`)).toBe('○ task-18  Phone tab bar')
    expect(await rowText(ui, 'section:prompts')).toBe(`── Prompts ${'─'.repeat(115 - 11)}`)
    expect(await rowText(ui, `prompt:${promptRef(5)}`)).toBe(`❝ 8m  ${ASK_2} → task-18`)
    const text = await shown(ui)
    expect(text).not.toContain('task-16')
    expect(text).not.toContain('task-17')
  })

  test('Current\'s task rows line up their role and time columns', async ($, on) => {
    const files = prompted()
    files.set(WAVE_F, (files.get(WAVE_F) ?? '') + line(WAVE_S, 'sid-w', 'dispatch_decision', T17, T0 - 3 * MIN, { agent_role: 'reviewer', model: 'opus' }))
    world(on, files)
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await mountBand($)
    await ui.press({ key: 'tab:current' })
    const t16 = await rowText(ui, `task:${T16}`)
    const t17 = await rowText(ui, `task:${T17}`)
    expect(t16).toBe(`● task-16  Phone toolbar hits${' '.repeat(11)}  coder     12m`)
    expect(t17).toBe('● task-17  Remote error and phone header  reviewer  3m')
    expect(t16.indexOf('coder')).toBe(t17.indexOf('reviewer'))
    expect(t16.indexOf('12m')).toBe(t17.indexOf('3m'))
    // the padding is a run of its own, so the role keeps its color and nothing else
    expect((await ui.find({ type: 'Text', text: /^reviewer$/ }))?.props).toEqual({ color: 'ide', bold: true })
    expect((await ui.find({ type: 'Text', text: /^coder$/ }))?.props).toEqual({ color: 'claude', bold: true })
  })

  test('at a narrow width no Current or Next row runs past it, and the dividers fill it', async ($, on) => {
    world(on, prompted())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const width = 24
    const ui = await mountBand($, 'terminal', { ...BAND, bodyColumns: width })
    for (const tab of ['current', 'next']) {
      await ui.press({ key: `tab:${tab}` })
      const keys = await rowKeys(ui)
      expect(keys).toContain('section:tasks')
      // the tab's own rows, after the tab row (its Buttons are the band's, not this tab's)
      for (const key of keys.slice(keys.indexOf('tabs') + 1)) expect([...(await rowText(ui, key))].length).toBeLessThanOrEqual(width)
      expect(await rowText(ui, 'section:tasks')).toBe(`── Tasks ${'─'.repeat(width - 9)}`)
      expect(await rowText(ui, 'section:prompts')).toBe(`── Prompts ${'─'.repeat(width - 11)}`)
    }
    await ui.press({ key: 'tab:current' })
    // the head keeps the phase and the wave, the spend and then the agents dropped
    expect(await rowText(ui, 'head')).toMatch(/^wave 4  [█░]{10} 1\/3$/)
    // the role and the time keep their columns; the title gives way
    expect(await rowText(ui, `task:${T16}`)).toBe('● task-16  …  coder  12m')
    expect(await rowText(ui, `task:${T17}`)).toBe('○ task-17  …')
    expect(await rowText(ui, `prompt:${promptRef(0)}`)).toBe('❝ 1h10m  G… → task-15 +2')
    // with no role column the title runs to the edge
    await ui.press({ key: 'tab:next' })
    expect(await rowText(ui, `task:${T18}`)).toBe('○ task-18  Phone tab bar')
  })

  test('Past groups the done work by wave, newest first, with each wave\'s prompts', async ($, on) => {
    world(on, prompted())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await mountBand($)
    await ui.press({ key: 'tab:past' })
    expect(await rowText(ui, 'head')).toBe('wave 4')
    expect(await rowText(ui, `task:${T15}`)).toMatch(/task-15.*Settings panels/)
    expect(await shown(ui)).toContain(ASK_1)
    expect(await shown(ui)).not.toContain('task-16')
  })

  test('an open task admitted to an earlier wave shows in Current', async ($, on) => {
    const files = prompted()
    // wave 5 takes task-18; task-17 of wave 4 is still open
    files.set(EPIC_F, (files.get(EPIC_F) ?? '') + line(EPIC_S, SID, 'wave-admitted', null, T0 - 5 * MIN, {
      epic_id: 'web-ux-4',
      task_ids: [T18],
      budget: { cap_tokens: 16_000_000, projected_tokens: 9_100_000, status: 'ok', tier: 'medium' },
    }, promptRef(5)))
    world(on, files)
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await mountBand($)
    await ui.press({ key: 'tab:current' })
    expect(await rowText(ui, 'head')).toMatch(/^wave 5  /)
    expect(await rowText(ui, `task:${T17}`)).toContain('task-17')
    expect(await rowText(ui, `task:${T18}`)).toContain('task-18')
    await ui.press({ key: 'tab:next' })
    expect(await shown(ui)).not.toContain('task-17')
    expect(await rowText(ui, 'empty')).toBe('nothing planned')
  })

  test('the waiting badge and the S1/S2 count show on every tab', async ($, on) => {
    const files = prompted()
    files.set(WAVE_F, (files.get(WAVE_F) ?? '') + [
      line(WAVE_S, 'sid-w', 'gate-outcome', T16, T0 - 9 * MIN, { outcome: 'pass-with-waivers-pending' }),
      line(WAVE_S, 'sid-w', 'quorum-decision', T17, T0 - 8 * MIN, {
        task_id: T17, epic_id: 'web-ux-4', finding_id: 'f-q', blocks: true, fingerprint: 'fq', outcome: 'escalate', escalation_reason: 'disagreement',
      }),
      line(WAVE_S, 'sid-w', 'finding-raised', T17, T0 - 7 * MIN, { finding_id: 'f1', severity: 'S1-stop-the-line', finding_status: 'raised' }),
    ].join(''))
    world(on, files)
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await mountBand($)
    for (const tab of ['overview', 'current', 'next', 'past']) {
      if (tab !== 'overview') await ui.press({ key: `tab:${tab}` })
      const tabs = await rowText(ui, 'tabs')
      expect(tabs).toContain('⚑ 2 waiting on you')
      expect(tabs).toContain('✖ 1 S1/S2 open')
    }
    expect((await ui.find({ type: 'Text', text: /^⚑ 2 waiting on you$/ }))?.props).toEqual({ color: 'warning', bold: true })
    expect((await ui.find({ type: 'Text', text: /^✖ 1 S1\/S2 open$/ }))?.props).toEqual({ color: 'error', bold: true })
  })

  test('the hotkey switches tabs only while the band has focus', async ($, on) => {
    world(on, prompted())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await mountBand($)
    // A bare digit typed into an empty composer presses a band Button (ButtonProps.hotkey), so digits would switch
    // tabs from the prompt; a letter hotkey fires only while the band (or its pane) holds the focus.
    const buttons = await ui.findAll({ type: 'Button' })
    const hotkeys = Object.fromEntries(buttons.map(b => [b.key, b.props.hotkey]))
    expect(hotkeys).toMatchObject({ 'tab:current': 'c', 'tab:next': 'n', 'tab:past': 'p' })
    for (const b of buttons) expect(String(b.props.hotkey ?? '')).not.toMatch(/\d/)
    expect(hotkeys['tab:overview']).toBeUndefined()
    await ui.press({ key: 'tab:next' })
    expect(await rowText(ui, 'head')).toBe('after wave 4')
    expect((await ui.findAll({ type: 'Button' })).find(b => b.key === 'tab:overview')?.props.hotkey).toBe('o')
    await ui.press({ key: 'tab:overview' })
    expect(await rowText(ui, 'head')).toMatch(/web-ux-4/)
  })

  test('the active tab survives a reload of the band', async ($, on) => {
    world(on, prompted())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const first = await mountBand($)
    await first.press({ key: 'tab:past' })
    await first.unmount()
    const ui = await mountBand($)
    expect((await ui.find({ type: 'Text', text: /^ Past $/ }))?.props).toEqual({ backgroundColor: 'success', color: 'inverseText', bold: true })
    expect(await rowText(ui, `task:${T15}`)).toContain('Settings panels')
  })

  test('colors the rule, the tab chip, the epic chip, the phase, the labels and the bar', async ($, on) => {
    world(on, prompted())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await mountBand($)
    const props = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.props
    // the Overview is the soft label color; only the epic chip keeps the claude color
    expect((await props(/^─+$/))?.color).toBe('inactive')
    expect(await props(/^ Overview $/)).toEqual({ backgroundColor: 'inactive', color: 'inverseText', bold: true })
    expect(await props(/^ web-ux-4 $/)).toEqual({ backgroundColor: 'claude', color: 'inverseText', bold: true })
    expect(await props(/^wave 4$/)).toEqual({ color: 'permission', bold: true })
    expect(await props(/^tier medium$/)).toEqual({ color: 'ide', bold: true })
    for (const label of ['Agents', 'Tasks', 'Budget']) expect(await props(new RegExp(`^${label}$`))).toEqual({ color: 'inactive', bold: true })
    // 1 done, 1 active, 2 todo across ten cells; active is teal, in the bar and in its tally
    const cells = await ui.findAll({ type: 'Text', text: /^[█░]+$/ })
    expect(cells.map(c => c.props.color)).toEqual(['success', '#14b8a6', 'inactive'])
    expect((await props(/^● $/))?.color).toBe('#14b8a6')
    expect((await props(/^ active$/))?.color).toBe('#14b8a6')
    expect((await props(/^57%$/))?.color).toBe('success')
    expect((await props(/^1\/4 done$/))).toEqual({ color: 'success', bold: true })

    await ui.press({ key: 'tab:current' })
    expect((await props(/^─+$/))?.color).toBe('permission')
    expect(await props(/^ Current $/)).toEqual({ backgroundColor: 'permission', color: 'inverseText', bold: true })
    // the head row: done/total in success, the spend in its budget tone, the percent bold
    expect(await props(/^1\/3$/)).toEqual({ color: 'success', bold: true })
    expect((await props(/^9\.1M\/16M$/))?.color).toBe('success')
    expect(await props(/^57%$/)).toEqual({ color: 'success', bold: true })
    // a section divider: the rule subtle, the name in the soft label color, bold
    expect(await props(/^── $/)).toEqual({ color: 'subtle' })
    expect(await props(/^Tasks$/)).toEqual({ color: 'inactive', bold: true })
    expect(await props(/^Prompts$/)).toEqual({ color: 'inactive', bold: true })
    // the role keeps its own color; the in-progress mark is teal, after the head's role dots
    expect((await props(/^coder$/))?.color).toBe('claude')
    expect((await props(/^12m$/))?.dimColor).toBe(true)
    const marks = await ui.findAll({ type: 'Text', text: /^●$/ })
    expect(marks[marks.length - 1]?.props.color).toBe('#14b8a6')
    // a prompt is drawn apart from the task rows, its age dim
    expect((await props(new RegExp(`^${ASK_1.replace(/[()]/g, '\\$&')}$`)))?.color).toBe('remember')
    expect(await props(/^1h10m$/)).toEqual({ dimColor: true })
  })

  for (const [projected, tone] of [[11_200_000, 'warning'], [14_400_000, 'error']] as const) {
    const pct = `${Math.round((projected / 16_000_000) * 100)}%`
    test(`the budget turns ${tone} at ${pct}`, async ($, on) => {
      const files = seed()
      files.set(EPIC_F, (files.get(EPIC_F) ?? '').replace('9100000', String(projected)))
      world(on, files)
      const clock = mock.clock(on, { now: T0 })
      mock.store(on)
      mock.env(on, { HOME: '/home/u' })
      await boot($, clock)
      const ui = await mountBand($)
      expect((await ui.find({ type: 'Text', text: new RegExp(`^${pct}$`) }))?.props.color).toBe(tone)
    })
  }

  test('the Current tab at maxRows 12 keeps its head, three tasks and their cut, and the two newest prompts', async ($, on) => {
    world(on, wave5())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await mountBand($, 'terminal', { ...BAND, maxRows: 12, scroll: { offset: 0, bodyRows: 12 } })
    await ui.press({ key: 'tab:current' })
    const keys = await rowKeys(ui)
    expect(keys.length).toBe(12)
    const tasks = keys.filter(k => k.startsWith('task:'))
    expect(tasks.length).toBe(3)
    // 11 open tasks cannot all fit: the cut says how many it left out; the prompts get no such row
    expect(keys).toEqual(['blank', 'rule', 'tabs', 'head', 'section:tasks', ...tasks, 'more:tasks', 'section:prompts', `prompt:${promptRef(15)}`, `prompt:${promptRef(5)}`])
    expect(await rowText(ui, 'more:tasks')).toBe('+8 more')
    expect(await rowText(ui, 'head')).toMatch(/^wave 5/)
    expect(await shown(ui)).not.toContain(ASK_1)
  })

  test('Current shows only the two newest prompts, with no more row for the rest', async ($, on) => {
    world(on, wave5())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await mountBand($, 'terminal', { ...BAND, maxRows: 20, scroll: { offset: 0, bodyRows: 20 } })
    await ui.press({ key: 'tab:current' })
    const keys = await rowKeys(ui)
    expect(keys.filter(k => k.startsWith('prompt:'))).toEqual([`prompt:${promptRef(15)}`, `prompt:${promptRef(5)}`])
    expect(keys.filter(k => k.startsWith('task:')).length).toBe(11)
    expect(keys).not.toContain('more:prompts')
    expect(keys).not.toContain('more:tasks')
    expect(await shown(ui)).not.toContain(ASK_1)
  })

  // the body rows after the head row, at each small height: task 1, task 2, prompt 1, prompt 2, then the rest of the tasks
  const SMALL: readonly (readonly [number, readonly string[]])[] = [
    [4, []],
    [5, ['more']],
    [6, ['more']],
    [7, ['section:tasks', 'task', 'more:tasks']],
    [8, ['section:tasks', 'task', 'task', 'more:tasks']],
    [9, ['section:tasks', 'task', 'task', 'task', 'more:tasks']],
    [10, ['section:tasks', 'task', 'task', 'more:tasks', 'section:prompts', 'prompt']],
    [11, ['section:tasks', 'task', 'task', 'more:tasks', 'section:prompts', 'prompt', 'prompt']],
  ]
  for (const [maxRows, body] of SMALL) {
    test(`at maxRows ${maxRows} Current's sections take ${body.length} rows after its head and never more than the band holds`, async ($, on) => {
      world(on, wave5())
      const clock = mock.clock(on, { now: T0 })
      mock.store(on)
      mock.env(on, { HOME: '/home/u' })
      await boot($, clock)

      const ui = await mountBand($, 'terminal', { ...BAND, maxRows, scroll: { offset: 0, bodyRows: maxRows } })
      await ui.press({ key: 'tab:current' })
      const keys = await rowKeys(ui)
      expect(keys.length).toBeLessThanOrEqual(maxRows)
      expect(keys.slice(0, 4)).toEqual(['blank', 'rule', 'tabs', 'head'])
      expect(keys.slice(4).map(k => k.replace(/:web-ux-4\/.*$|:web-ux-4-.*$/, ''))).toEqual(body)
      const tasks = keys.filter(k => k.startsWith('task:')).length
      // nothing fits but a single cut: it counts every task and both prompts
      if (body[0] === 'more') expect(await rowText(ui, 'more')).toBe('+13 more')
      if (body.includes('more:tasks')) expect(await rowText(ui, 'more:tasks')).toBe(`+${11 - tasks} more`)
    })
  }

  test('every row fits bodyColumns, a long one cut with …', async ($, on) => {
    world(on, prompted())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await mountBand($, 'terminal', { ...BAND, bodyColumns: 40 })
    for (const tab of ['overview', 'current', 'next', 'past']) {
      if (tab !== 'overview') await ui.press({ key: `tab:${tab}` })
      const keys = await rowKeys(ui)
      expect(keys.length).toBeGreaterThan(2)
      for (const key of keys) {
        expect(key).not.toBe('')
        expect((await rowText(ui, key)).length).toBeLessThanOrEqual(40)
      }
    }
    await ui.press({ key: 'tab:current' })
    expect(await rowText(ui, `prompt:${promptRef(0)}`)).toMatch(/… → task-15 \+2$/)
  })

  test('draws the idle band when this session wrote no bs event and no epic ran in the last seven days', async ($, on) => {
    const files = seed()
    const w = world(on, files, 'sid-none')
    for (const p of files.keys()) w.mtimes.set(p, T0 - 7 * 1440 * MIN - 1)
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await $.ui.mount({ plugin: 'bs-mod', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await rowKeys(ui)).toEqual(IDLE_KEYS)
    expect(await rowText(ui, 'idle')).toBe(IDLE_LINE)
    expect((await bs($, '')).text).toContain('No bs epic in this session yet; /bs-mod <epic-id> pins one.')
    expect(w.opened).toEqual([])
  })

  test('/bs-mod off hides it, /bs-mod on brings it back', async ($, on) => {
    world(on, seed())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await mountBand($)
    expect((await bs($, 'off')).text).toBe('bs-mod band hidden; /bs-mod on brings it back.')
    expect(await ui.drawn()).toEqual(ENGINE)
    await bs($, 'on')
    expect(await rowText(ui, 'head')).toMatch(/web-ux-4\s+· wave 4/)
  })

  test('keeps to the tab row when the band has one row', async ($, on) => {
    world(on, seed())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await mountBand($, 'terminal', { ...BAND, maxRows: 1 })
    expect((await rowKeys(ui)).length).toBe(1)
    const text = await shown(ui)
    expect(text).toMatch(/^ Overview .*Current/)
    expect(text).not.toContain('─')
    expect(text).not.toContain('Budget')
  })
})

describe('band always', () => {
  /** A session outside any clone (no log at all), and the session of a clone whose epics all went idle past the cutoff. */
  const IDLE_WORLDS = {
    'outside any clone': (on: On) => world(on, new Map(), 'sid-none', '/w/elsewhere'),
    'in a clone with no running epic': (on: On) => {
      const files = seed()
      const w = world(on, files, 'sid-none')
      for (const p of files.keys()) w.mtimes.set(p, T0 - 7 * 1440 * MIN - 1)
      return w
    },
  } as const

  async function up($: Engine, on: On, cwd = CWD): Promise<void> {
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock, cwd)
  }

  /** The band's own rows: every key but the tree from beneath. */
  const own = (keys: string[]) => keys.filter(k => k !== 'below')

  for (const [name, make] of Object.entries(IDLE_WORLDS)) {
    test(`a session ${name} draws the idle band: a blank row, the rule, the Overview badge alone, its agents and the dim line`, async ($, on) => {
      make(on)
      await up($, on, name === 'outside any clone' ? '/w/elsewhere' : CWD)

      const ui = await mountBand($)
      expect(await rowKeys(ui)).toEqual(IDLE_KEYS)
      expect(await rowText(ui, 'blank')).toBe(' ')
      expect(await rowText(ui, 'rule')).toBe('─'.repeat(115))
      expect((await ui.find({ type: 'Text', text: /^─+$/ }))?.props).toEqual({ color: 'inactive' })
      expect(await rowText(ui, 'tabs')).toBe(' Overview ')
      expect((await ui.find({ type: 'Text', text: /^ Overview $/ }))?.props).toEqual({ backgroundColor: 'inactive', color: 'inverseText', bold: true })
      expect(await ui.findAll({ type: 'Button' })).toEqual([])
      expect(await rowText(ui, 'agents')).toBe('Agents  0 in this session')
      expect((await ui.find({ type: 'Text', text: /^Agents$/ }))?.props).toEqual({ color: 'inactive', bold: true })
      expect((await ui.find({ type: 'Text', text: /^0$/ }))?.props).toEqual({ bold: true })
      expect(await rowText(ui, 'idle')).toBe(IDLE_LINE)
      expect((await ui.find({ type: 'Text', text: /^no running epic/ }))?.props).toEqual({ dimColor: true })
      expect(await shown(ui)).toBe(` ${'─'.repeat(115)} Overview Agents  0 in this session${IDLE_LINE}`)
    })
  }

  test('the idle band counts this session\'s live agents', async ($, on) => {
    const w = world(on, new Map(), 'sid-none', '/w/elsewhere')
    w.agents = [agent('a1', 'running'), agent('a2', 'waiting'), agent('a3', 'pending'), agent('a4', 'completed'), agent('a5', 'idle')]
    await up($, on, '/w/elsewhere')

    const ui = await mountBand($)
    expect(await rowText(ui, 'agents')).toBe('Agents  3 in this session')
  })

  for (const epic of [true, false]) {
    test(`hasSurvey passes to the engine ${epic ? 'with' : 'without'} an epic`, async ($, on) => {
      if (epic) world(on, seed())
      else world(on, new Map(), 'sid-none', '/w/elsewhere')
      await up($, on, epic ? CWD : '/w/elsewhere')

      const ui = await mountBand($, 'terminal', { ...BAND, hasSurvey: true })
      expect(await ui.drawn()).toEqual(ENGINE)
    })
  }

  for (const epic of [true, false]) {
    test(`a tree from beneath stacks under the ${epic ? 'tabbed' : 'idle'} band, one blank row at the top`, async ($, on) => {
      const w = epic ? world(on, seed()) : world(on, new Map(), 'sid-none', '/w/elsewhere')
      w.below = 'line'
      await up($, on, epic ? CWD : '/w/elsewhere')

      const ui = await mountBand($)
      const keys = await rowKeys(ui)
      expect(keys.slice(0, 3)).toEqual(['blank', 'rule', 'tabs'])
      expect(keys[keys.length - 1]).toBe('below')
      expect(keys.filter(k => k === 'blank')).toEqual(['blank'])
      expect(await rowText(ui, 'other')).toBe('other plugin band')
      expect(await rowText(ui, 'below')).toBe('other plugin band')
      if (epic) expect(await rowText(ui, 'head')).toMatch(/web-ux-4\s+· wave 4/)
      else expect(await rowText(ui, 'idle')).toBe(IDLE_LINE)
      // the band keeps its rows whole: the tree from beneath fills the row it leaves
      expect(own(keys).length).toBeLessThanOrEqual(BAND.maxRows - 1)
    })
  }

  for (const below of ['engine', 'empty'] as const) {
    test(`an empty tree from beneath (${below}) leaves the band alone`, async ($, on) => {
      const w = world(on, seed())
      w.below = below
      await up($, on)

      const ui = await mountBand($)
      const keys = await rowKeys(ui)
      expect(keys.slice(0, 2)).toEqual(['blank', 'rule'])
      expect(keys).not.toContain('below')
      expect(JSON.stringify(await ui.drawn())).not.toContain('"engine"')
    })
  }

  test('a tall tree from beneath leaves the band its rows: the band fits the window less one, the rest scrolls', async ($, on) => {
    const w = world(on, seed())
    w.below = 'line'
    await up($, on)

    const ui = await mountBand($, 'terminal', { ...BAND, maxRows: 4, scroll: { offset: 0, bodyRows: 4 } })
    expect(await rowKeys(ui)).toEqual(['blank', 'rule', 'tabs', 'below'])
  })

  for (const epic of [true, false]) {
    const kind = epic ? 'tabbed' : 'idle'
    test(`a small maxRows keeps the rule and the tab row of the ${kind} band and clips the body first`, async ($, on) => {
      if (epic) world(on, seed())
      else world(on, new Map(), 'sid-none', '/w/elsewhere')
      await up($, on, epic ? CWD : '/w/elsewhere')

      const three = await mountBand($, 'terminal', { ...BAND, maxRows: 3, scroll: { offset: 0, bodyRows: 3 } })
      expect(await rowKeys(three)).toEqual(['blank', 'rule', 'tabs'])
      const four = await mountBand($, 'terminal', { ...BAND, maxRows: 4, scroll: { offset: 0, bodyRows: 4 } })
      expect(await rowKeys(four)).toEqual(['blank', 'rule', 'tabs', epic ? 'head' : 'agents'])
    })

    test(`maxRows 2 gives the ${kind} band its rule and tab row, no blank row`, async ($, on) => {
      if (epic) world(on, seed())
      else world(on, new Map(), 'sid-none', '/w/elsewhere')
      await up($, on, epic ? CWD : '/w/elsewhere')

      const ui = await mountBand($, 'terminal', { ...BAND, maxRows: 2, scroll: { offset: 0, bodyRows: 2 } })
      expect(await rowKeys(ui)).toEqual(['rule', 'tabs'])
      expect(await rowText(ui, 'rule')).toBe('─'.repeat(115))
    })
  }

  for (const kind of ['tabbed', 'idle', 'stacked'] as const) {
    test(`the first row of the ${kind} band is blank and the rule comes right after it`, async ($, on) => {
      const w = kind === 'idle' ? world(on, new Map(), 'sid-none', '/w/elsewhere') : world(on, seed())
      if (kind === 'stacked') w.below = 'line'
      await up($, on, kind === 'idle' ? '/w/elsewhere' : CWD)

      const ui = await mountBand($)
      const keys = await rowKeys(ui)
      expect(keys.slice(0, 2)).toEqual(['blank', 'rule'])
      expect(await rowText(ui, 'blank')).toBe(' ')
      expect((await rowText(ui, 'rule')).startsWith('─')).toBe(true)
    })
  }

  for (const how of ['its own', 'pinned'] as const) {
    test(`the dim line never says no running epic while an epic is in view (${how})`, async ($, on) => {
      const w = how === 'its own' ? world(on, seed()) : world(on, seed(), 'sid-none')
      w.mtimes.set(`${ROOT}/${OTHER_S}.jsonl`, T0 - 3 * 1440 * MIN)
      await up($, on)
      if (how === 'pinned') await bs($, 'web-ux-4')

      const ui = await mountBand($)
      expect(await rowText(ui, 'head')).toMatch(/web-ux-4/)
      expect(await rowKeys(ui)).not.toContain('idle')
      expect(await shown(ui)).not.toContain('no running epic')
    })
  }
})

describe('status line', () => {
  test('names the epic, wave and done count', async ($, on) => {
    const w = world(on, seed())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    expect(w.commands).toContain('bs-mod')
    expect(w.statuses[w.statuses.length - 1]).toBe('web-ux-4 · w4 · 1/3')
  })
})

describe('pane', () => {
  test('/bs-mod opens it on the agents, tasks and activity', async ($, on) => {
    const w = world(on, seed())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    await bs($, '')
    expect(w.opened).toEqual(['bs-mod'])
    const pane = await $.ui.mount({
      plugin: 'bs-mod',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'bs-mod',
      props: PANE,
      viewport: { columns: 120, rows: 40 },
    })
    const text = await shown(pane)
    expect(text).toMatch(/coder\s+task-16/)
    expect(text).toMatch(/wave-runner\s+w4/)
    expect(text).toMatch(/\/bs-mod <epic-id> pins/)
    expect(text).not.toContain('/bs-hud')
    expect(text).toContain('Remote error and phone header')
    expect(text).toContain('✔ merged task-15')
    expect((await pane.find({ type: 'Text', text: /^coder$/ }))?.props.color).toBe('claude')
    expect((await pane.find({ type: 'Text', text: /^in-progress$/ }))?.props.color).toBe('#14b8a6')
    expect((await pane.find({ type: 'Text', text: /Agents/ }))?.props.color).toBe('claude')
    expect((await pane.find({ type: 'Text', text: /^ web-ux-4 $/ }))?.props.backgroundColor).toBe('claude')
  })

  test('open S1/S2 findings show as blocking the close, each status counted', async ($, on) => {
    const files = seed()
    files.set(WAVE_F, (files.get(WAVE_F) ?? '') + [
      line(WAVE_S, 'sid-w', 'finding-raised', T16, T0 - 5 * MIN, { finding_id: 'f1', severity: 'S2-major', finding_status: 'raised' }),
      line(WAVE_S, 'sid-w', 'finding-raised', null, T0 - 4 * MIN, { finding_id: 'f2', epic_id: 'web-ux-4', severity: 'S2-major', finding_status: 'raised' }),
      line(WAVE_S, 'sid-w', 'finding-transitioned', null, T0 - 3 * MIN, { finding_id: 'f2', from_status: 'raised', to_status: 'amend-pending' }),
    ].join(''))
    const w = world(on, files)
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const band = await $.ui.mount({ plugin: 'bs-mod', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await shown(band)).toContain('✖ 2 S1/S2 open')
    await bs($, '')
    expect(w.opened).toEqual(['bs-mod'])
    const pane = await $.ui.mount({
      plugin: 'bs-mod',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'bs-mod',
      props: PANE,
      viewport: { columns: 120, rows: 40 },
    })
    const text = await shown(pane)
    expect(text).toContain('Blocks close')
    expect(text).toContain('✖ S1 0 · S2 2')
    expect(text).toContain('1 raised · 1 amend-pending')
    expect((await pane.find({ type: 'Text', text: /^1 raised$/ }))?.props.color).toBe('error')
    expect((await pane.find({ type: 'Text', text: /^1 amend-pending$/ }))?.props.color).toBe('warning')
    expect(text).not.toContain('Waiting on you')
  })

  test('a closed epic shows nothing waiting on you and nothing blocking its close', async ($, on) => {
    const files = seed()
    files.set(WAVE_F, (files.get(WAVE_F) ?? '') + [
      line(WAVE_S, 'sid-w', 'gate-outcome', T16, T0 - 9 * MIN, { outcome: 'pass-with-waivers-pending' }),
      line(WAVE_S, 'sid-w', 'quorum-decision', T17, T0 - 8 * MIN, {
        task_id: T17, epic_id: 'web-ux-4', finding_id: 'f-q', blocks: true, fingerprint: 'fq', outcome: 'escalate', escalation_reason: 'disagreement',
      }),
      line(WAVE_S, 'sid-w', 'finding-raised', T17, T0 - 7 * MIN, { finding_id: 'f1', severity: 'S1-stop-the-line', finding_status: 'raised' }),
    ].join(''))
    files.set(EPIC_F, (files.get(EPIC_F) ?? '') +
      line(EPIC_S, SID, 'epic-closed', 'web-ux-4/integration', T0 - 2 * MIN, { epic_id: 'web-ux-4', closed_by: 'operator', machine_verdict: 'met', summary: 's' }))
    world(on, files)
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    // a closed epic is not the session's own any more, so it is pinned to be drawn
    await bs($, 'web-ux-4')
    const pane = await $.ui.mount({
      plugin: 'bs-mod',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'bs-mod',
      props: PANE,
      viewport: { columns: 120, rows: 40 },
    })
    const text = await shown(pane)
    expect(text).toContain('✔ epic web-ux-4 closed')
    expect(text).not.toContain('Waiting on you')
    expect(text).not.toContain('Blocks close')
  })

  test('a waived task row is drawn done: a dim check, dimmed, sorted with the landed rows', async ($, on) => {
    const files = seed()
    files.set(EPIC_F, (files.get(EPIC_F) ?? '') + line(EPIC_S, SID, 'task-added', 'web-ux-4/task-18-paired-device-details-hit', T0 - 6 * MIN, { title: 'Paired device details hit', task_status: 'waived' }))
    world(on, files)
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    await bs($, '')
    const pane = await $.ui.mount({
      plugin: 'bs-mod',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'bs-mod',
      props: PANE,
      viewport: { columns: 120, rows: 40 },
    })
    // the agents list draws task-16 first; the last four are the task rows
    const ids = (await pane.findAll({ type: 'Text', text: /^task-\d+$/ })).map(t => t.text)
    expect(ids.slice(-4)).toEqual(['task-16', 'task-17', 'task-15', 'task-18'])
    expect((await pane.findAll({ type: 'Text', text: /^✔$/ })).map(t => t.props)).toEqual([{ color: 'success' }, { color: 'success', dimColor: true }])
    expect((await pane.find({ type: 'Text', text: /^task-18$/ }))?.props).toMatchObject({ bold: false, dimColor: true })
    expect((await pane.find({ type: 'Text', text: /^Paired device details hit$/ }))?.props.dimColor).toBe(true)
    expect((await pane.find({ type: 'Text', text: /^waived$/ }))?.props).toEqual({ dimColor: true })
  })

  test('a task only its wave-admitted named shows its id once', async ($, on) => {
    const files = seed()
    // no task-added for task-17: the fold titles its row with the full id
    files.set(EPIC_F, (files.get(EPIC_F) ?? '').split('\n').filter(l => !(l.includes('"task-added"') && l.includes(T17))).join('\n'))
    world(on, files)
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    await bs($, '')
    const pane = await $.ui.mount({
      plugin: 'bs-mod',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'bs-mod',
      props: PANE,
      viewport: { columns: 120, rows: 40 },
    })
    // a row's texts join with no separator: the mark, the id, no title, the status
    expect((await pane.find({ type: 'Box', text: /^ ○task-17/ }))?.text).toBe(' ○task-17ready')
    expect(await shown(pane)).not.toContain(T17)
    expect(await pane.findAll({ type: 'Text', text: /^task-17$/ })).toHaveLength(1)
  })

  test('a task titled with its short id shows the id once', async ($, on) => {
    const files = seed()
    files.set(EPIC_F, (files.get(EPIC_F) ?? '').replace('Remote error and phone header', 'task-17'))
    world(on, files)
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    await bs($, '')
    const pane = await $.ui.mount({
      plugin: 'bs-mod',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'bs-mod',
      props: PANE,
      viewport: { columns: 120, rows: 40 },
    })
    expect((await pane.find({ type: 'Box', text: /^ ○task-17/ }))?.text).toBe(' ○task-17ready')
    expect(await pane.findAll({ type: 'Text', text: /^task-17$/ })).toHaveLength(1)
  })

  test('a task its task-added titled still shows the title', async ($, on) => {
    world(on, seed())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    await bs($, '')
    const pane = await $.ui.mount({
      plugin: 'bs-mod',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'bs-mod',
      props: PANE,
      viewport: { columns: 120, rows: 40 },
    })
    expect((await pane.find({ type: 'Box', text: /^ ○task-17/ }))?.text).toBe(' ○task-17Remote error and phone headerready')
    expect((await pane.find({ type: 'Text', text: /^Remote error and phone header$/ }))?.props).toEqual({ wrap: 'truncate-end', dimColor: false })
  })

  test('the band Details button opens it', async ($, on) => {
    const w = world(on, seed())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await $.ui.mount({ plugin: 'bs-mod', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    await ui.press({ key: 'details' })
    expect(w.opened).toEqual(['bs-mod'])
  })
})

describe('live log', () => {
  test('toasts a fresh gate failure, never the history it booted on', async ($, on) => {
    const w = world(on, seed())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)
    expect(w.toasts).toEqual([])

    append(w, WAVE_F, line(WAVE_S, 'sid-w', 'gate-outcome', T17, T0 + 1000, { outcome: 'blocked', reason: 'unit' }))
    append(w, WAVE_F, line(WAVE_S, 'sid-w', 'gate-outcome', T16, T0 - 10 * MIN, { outcome: 'blocked', reason: 'late' }))
    await clock.advance(4000)
    expect(w.toasts).toEqual(['✖ gate fail task-17 (unit)'])
  })

  test('follows a new wave file of the epic', async ($, on) => {
    const w = world(on, seed())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await $.ui.mount({ plugin: 'bs-mod', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const w5 = 'web-ux-4-w5-2026-10-07'
    append(w, `${ROOT}/${w5}.jsonl`, line(w5, 'sid-w5', 'dispatch_decision', T17, T0 + 1000, { agent_role: 'tester' }))
    await clock.advance(4000)
    expect(await rowText(ui, 'head')).toMatch(/web-ux-4\s+· wave 5/)
    // the old band's `Now tester task-17` is a Current row
    await ui.press({ key: 'tab:current' })
    expect(await rowText(ui, 'head')).toMatch(/^wave 5/)
    expect(await rowText(ui, `task:${T17}`)).toMatch(/task-17.*tester/)
  })

  test('refolds quietly when a log file shrinks', async ($, on) => {
    const w = world(on, seed())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await $.ui.mount({ plugin: 'bs-mod', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    w.files.set(WAVE_F, (w.files.get(WAVE_F) ?? '').split('\n').slice(0, 2).join('\n') + '\n')
    await clock.advance(4000)
    expect(await shown(ui)).toContain('0/3 done')
    expect(w.toasts).toEqual([])
  })

  test('learns a clone from a Bash command that runs its CLI', async ($, on) => {
    world(on, seed(), SID, '/w/elsewhere')
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock, '/w/elsewhere')

    const ui = await $.ui.mount({ plugin: 'bs-mod', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await rowKeys(ui)).toEqual(IDLE_KEYS)
    await $.tool.call({ tool: 'Bash', command: 'node /w/proj/factory/orchestrator/dist/cli.js event append --session web-ux-4-2026-10-04' })
    await clock.advance(4000)
    expect(await rowText(ui, 'head')).toMatch(/web-ux-4\s+· wave 4/)
  })
})

describe('file epics', () => {
  const A5 = 'web-audit-5'
  const A5_W3 = 'web-audit-5-wave-3-2026-09-23'
  const A1 = 'web-audit-1'
  const A1_S = 'web-audit-1-2026-10-01'
  const A1_CLOSE = 'web-audit-1-close-2026-10-07'
  const a1Task = (n: number) => `${A1}/task-${n}-x`
  /** web-audit-1's own session, written by another CLI session */
  const a1Files = (): Map<string, string> => new Map([[`${ROOT}/${A1_S}.jsonl`, [
    line(A1_S, 'sid-o', 'session-start', null, T0 - 90 * MIN),
    line(A1_S, 'sid-o', 'task-added', a1Task(1), T0 - 80 * MIN, { title: 'One' }),
    line(A1_S, 'sid-o', 'task-added', a1Task(2), T0 - 80 * MIN, { title: 'Two' }),
    line(A1_S, 'sid-o', 'wave-admitted', null, T0 - 70 * MIN, { epic_id: A1, task_ids: [a1Task(1), a1Task(2)] }),
  ].join('')]])

  test('a wave-3 file is its epic\'s wave, never an epic of its own', async ($, on) => {
    const files = new Map([[`${ROOT}/${A5_W3}.jsonl`, [
      line(A5_W3, SID, 'session-start', null, T0 - 30 * MIN),
      line(A5_W3, SID, 'task-added', `${A5}/task-1-x`, T0 - 29 * MIN, { title: 'X' }),
      line(A5_W3, SID, 'dispatch_decision', `${A5}/task-1-x`, T0 - 10 * MIN, { agent_role: 'coder', model: 'opus' }),
    ].join('')]])
    const w = world(on, files)
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await $.ui.mount({ plugin: 'bs-mod', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    // no wave-admitted: the band's phase (fold.ts phaseOf) and the status line both name the file's wave
    expect(await rowText(ui, 'head')).toMatch(/web-audit-5\s+· wave 3/)
    expect(await shown(ui)).not.toContain('web-audit-5-wave-3')
    expect(w.statuses[w.statuses.length - 1]).toBe('web-audit-5 · w3 · 0/1')
    // the old band's `Now coder task-1 (10m)` is a Current row
    await ui.press({ key: 'tab:current' })
    expect(await rowText(ui, `task:${A5}/task-1-x`)).toMatch(/task-1.*coder.*10m/)
    expect(await shown(ui)).not.toContain('web-audit-5-wave-3')
  })

  test('wave files with no wave-admitted: the band and the status line name the same wave, the highest file\'s', async ($, on) => {
    const W2 = 'web-audit-5-wave-2-2026-09-23'
    const W4 = 'web-audit-5-wave-4-2026-09-23'
    const one = `${A5}/task-1-x`
    const two = `${A5}/task-2-y`
    const files = new Map([
      [`${ROOT}/${W2}.jsonl`, [
        line(W2, 'sid-2', 'task-added', one, T0 - 90 * MIN, { title: 'X' }),
        line(W2, 'sid-2', 'wave-merged', one, T0 - 60 * MIN, { epic_id: A5, task_ids: [one] }),
      ].join('')],
      [`${ROOT}/${W4}.jsonl`, [
        line(W4, SID, 'session-start', null, T0 - 30 * MIN),
        line(W4, SID, 'task-added', two, T0 - 29 * MIN, { title: 'Y' }),
        line(W4, SID, 'dispatch_decision', two, T0 - 10 * MIN, { agent_role: 'coder', model: 'opus' }),
      ].join('')],
    ])
    const w = world(on, files)
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await $.ui.mount({ plugin: 'bs-mod', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await rowText(ui, 'head')).toMatch(/web-audit-5\s+· wave 4/)
    expect(w.statuses[w.statuses.length - 1]).toBe('web-audit-5 · w4 · 1/2')
    // Current's head row carries the wave bar, which counts the tasks wave 4's session worked
    await ui.press({ key: 'tab:current' })
    expect(await rowText(ui, 'head')).toMatch(/^wave 4  [█░]+ 0\/1/)
  })

  test('a close session the content names for its epic brings in the epic\'s other files', async ($, on) => {
    const files = a1Files()
    files.set(`${ROOT}/${A1_CLOSE}.jsonl`, [
      line(A1_CLOSE, SID, 'session-start', null, T0 - 5 * MIN),
      line(A1_CLOSE, SID, 'dispatch_decision', a1Task(2), T0 - 3 * MIN, { agent_role: 'reviewer', model: 'opus' }),
    ].join(''))
    const w = world(on, files)
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await $.ui.mount({ plugin: 'bs-mod', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const text = await shown(ui)
    expect(await rowText(ui, 'head')).toMatch(/web-audit-1\s+· wave 1/)
    expect(text).toContain('0/2 done')
    expect(text).not.toContain('web-audit-1-close')
    expect(w.statuses[w.statuses.length - 1]).toBe('web-audit-1 · w1 · 0/2')
    // the old band's `Now reviewer task-2 (3m)` is a Current row
    await ui.press({ key: 'tab:current' })
    expect(await rowText(ui, `task:${a1Task(2)}`)).toMatch(/task-2.*reviewer.*3m/)
    expect(await shown(ui)).not.toContain('web-audit-1-close')
  })

  test('the second tick greps no file whose epic is known, and a file naming none only once it grows', async ($, on) => {
    const files = seed()
    const MAINT = `${ROOT}/maint-2026-09-20.jsonl`
    files.set(MAINT, line('maint-2026-09-20', 'sid-m', 'session-start', null, T0 - 1440 * MIN))
    const w = world(on, files)
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    expect(w.resolves.flat().sort()).toEqual([EPIC_F, MAINT, `${ROOT}/${OTHER_S}.jsonl`, WAVE_F].sort())
    const booted = w.resolves.length
    append(w, WAVE_F, line(WAVE_S, 'sid-w', 'gate-outcome', T16, T0 + 1000, { outcome: 'pass' }))
    await clock.advance(4000)
    expect(w.resolves.length).toBe(booted)

    append(w, MAINT, line('maint-2026-09-20', 'sid-m', 'note', 'task-1-bare', T0 + 2000))
    await clock.advance(4000)
    expect(w.resolves.slice(booted)).toEqual([[MAINT]])
  })
})

describe('pinning', () => {
  test('/bs-mod <epic> pins another epic, /bs-mod auto lets go', async ($, on) => {
    const w = world(on, seed())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await $.ui.mount({ plugin: 'bs-mod', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect((await bs($, 'other-1')).text).toBe('Pinned other-1; /bs-mod auto follows this session again.')
    expect(await rowText(ui, 'head')).toMatch(/other-1\s+· wave 1/)
    expect(w.opened).toEqual(['bs-mod'])

    await bs($, 'auto')
    expect(await rowText(ui, 'head')).toMatch(/web-ux-4\s+· wave 4/)
  })

  test('says so when the pinned epic has no log', async ($, on) => {
    world(on, seed())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    expect((await bs($, 'nope-9')).text).toContain('no event log found for nope-9')
  })

  test('/bs-mod <epic> takes an epic whose only log is named for a word after it', async ($, on) => {
    const CLOSE = 'web-audit-1-close-2026-10-07'
    const files = new Map([[`${ROOT}/${CLOSE}.jsonl`, [
      line(CLOSE, 'sid-o', 'session-start', null, T0 - 9 * MIN),
      line(CLOSE, 'sid-o', 'task-added', 'web-audit-1/task-1-x', T0 - 8 * MIN, { title: 'X' }),
      line(CLOSE, 'sid-o', 'wave-admitted', null, T0 - 7 * MIN, { epic_id: 'web-audit-1', task_ids: ['web-audit-1/task-1-x'] }),
    ].join('')]])
    world(on, files)
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    const ui = await $.ui.mount({ plugin: 'bs-mod', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect((await bs($, 'web-audit-1')).text).toContain('Pinned web-audit-1')
    expect(await rowText(ui, 'head')).toMatch(/web-audit-1\s+· wave 1/)
    expect(await shown(ui)).not.toContain('web-audit-1-close')
  })
})

describe('own epics only', () => {
  const OTHER_F = `${ROOT}/${OTHER_S}.jsonl`
  const NO_EPIC = 'No bs epic in this session yet; /bs-mod <epic-id> pins one.'
  const CLOSE = line(EPIC_S, SID, 'epic-closed', 'web-ux-4/integration', T0 - 2 * MIN, { epic_id: 'web-ux-4', closed_by: 'operator', machine_verdict: 'met', summary: 's' })

  function band($: Engine) {
    return $.ui.mount({ plugin: 'bs-mod', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  }

  async function up($: Engine, on: On, cwd = CWD): Promise<void> {
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock, cwd)
  }

  /** seed() with the session's epic closed */
  function closedSeed(): Map<string, string> {
    const files = seed()
    files.set(EPIC_F, (files.get(EPIC_F) ?? '') + CLOSE)
    return files
  }

  test('a session with no epic of its own shows the idle band, though another session runs an epic in its cwd', async ($, on) => {
    const w = world(on, seed(), 'sid-none')
    await up($, on)

    const ui = await band($)
    expect(await rowKeys(ui)).toEqual(IDLE_KEYS)
    expect(await rowText(ui, 'idle')).toBe(IDLE_LINE)
    expect(await shown(ui)).not.toContain('web-ux-4')
    expect(await shown(ui)).not.toContain('watching')
    expect((await bs($, '')).text).toBe(NO_EPIC)
    expect(w.opened).toEqual([])
    expect(w.statuses[w.statuses.length - 1]).toBeUndefined()
  })

  test('a log only under a learned root is never shown, though a pin still finds it', async ($, on) => {
    world(on, seed(), 'sid-none', '/w/elsewhere')
    const clock = mock.clock(on, { now: T0 })
    mock.store(on, { roots: [ROOT] })
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock, '/w/elsewhere')

    const ui = await band($)
    expect(await rowKeys(ui)).toEqual(IDLE_KEYS)
    expect(await rowText(ui, 'idle')).toBe(IDLE_LINE)
    expect((await bs($, '')).text).toBe(NO_EPIC)
    expect((await bs($, 'web-ux-4')).text).toBe('Pinned web-ux-4; /bs-mod auto follows this session again.')
  })

  test('a session whose only epic is closed shows the idle band', async ($, on) => {
    const w = world(on, closedSeed())
    await up($, on)

    const ui = await band($)
    expect(await rowKeys(ui)).toEqual(IDLE_KEYS)
    expect(await shown(ui)).not.toContain('web-ux-4')
    expect((await bs($, '')).text).toBe(NO_EPIC)
    expect(w.opened).toEqual([])
  })

  test('a closed epic still shows while it is pinned; /bs-mod auto lets it go', async ($, on) => {
    world(on, closedSeed())
    await up($, on)

    const ui = await band($)
    expect((await bs($, 'web-ux-4')).text).toBe('Pinned web-ux-4; /bs-mod auto follows this session again.')
    expect(await rowText(ui, 'head')).toMatch(/web-ux-4/)
    expect(await rowKeys(ui)).not.toContain('idle')
    expect((await bs($, '')).text).toBe('bs-mod pane opened on web-ux-4.')
    await bs($, 'auto')
    expect(await rowKeys(ui)).toEqual(IDLE_KEYS)
  })

  test('a closed epic gives way to an older open epic of the same session', async ($, on) => {
    const files = closedSeed()
    files.set(OTHER_F, (files.get(OTHER_F) ?? '').replace(/sid-other/g, SID))
    const w = world(on, files)
    w.mtimes.set(OTHER_F, T0 - 3 * 1440 * MIN)
    await up($, on)

    const ui = await band($)
    expect(await rowText(ui, 'head')).toMatch(/other-1\s+· wave 1/)
    expect(await shown(ui)).not.toContain('web-ux-4')
    expect((await bs($, '')).text).toBe('bs-mod pane opened on other-1.')
  })

  test('the epic-closed toast still fires for an own epic', async ($, on) => {
    const w = world(on, seed())
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    append(w, EPIC_F, line(EPIC_S, SID, 'epic-closed', 'web-ux-4/integration', T0 + 1000, { epic_id: 'web-ux-4', closed_by: 'operator', machine_verdict: 'met', summary: 's' }))
    await clock.advance(4000)
    expect(w.toasts.join('\n')).toContain('✔ epic web-ux-4 closed')
    expect(await rowKeys(await band($))).toEqual(IDLE_KEYS)
  })
})

// glue for fold.ts tierOf: the shown epic's latest plan `effort`, read where plan.ts latestPlan looks
describe('plan tier', () => {
  const PLANS = '/w/proj/factory/specs/active/web-ux-4'
  /** the last planTiers value the mod wrote */
  function tiersSet(on: On): { value?: unknown; sets: number } {
    const seen: { value?: unknown; sets: number } = { sets: 0 }
    on('state.set', { plugin: 'bs-mod', key: 'planTiers' }, ($, e, next) => {
      seen.value = e.value
      seen.sets++
      return next(e)
    })
    return seen
  }

  function reader(on: On, files: Map<string, string>): string[] {
    const reads: string[] = []
    on('fs.read', ($, e) => {
      reads.push(e.path)
      const text = files.get(e.path)
      return text === undefined ? { deny: `no such file: ${e.path}` } : { value: text }
    })
    return reads
  }

  test('reads the shown epic\'s latest plan once per plan version, and none once an admission names a tier', async ($, on) => {
    const files = seed()
    files.set(`${PLANS}/plan.json`, JSON.stringify({ effort: 'small' }))
    files.set(`${PLANS}/plan-v3.json`, JSON.stringify({ version: 3, effort: 'small' }))
    files.set(`${PLANS}/plan-v4.json`, JSON.stringify({ version: 4, effort: 'huge' }))
    const w = world(on, files)
    const reads = reader(on, files)
    const tiers = tiersSet(on)
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)

    // seed's task-added carry no plan_version: version 0
    expect(reads).toEqual([`${PLANS}/plan-v4.json`])
    expect(tiers.value).toEqual({ 'web-ux-4': { version: 0, tier: 'huge' } })
    await clock.advance(4000)
    expect(reads).toHaveLength(1)

    files.set(`${PLANS}/plan-v5.json`, JSON.stringify({ version: 5, effort: 'medium' }))
    append(w, EPIC_F, line(EPIC_S, SID, 'task-added', T17, T0 + 1000, { title: 'Remote error and phone header', plan_version: 5 }))
    await clock.advance(4000)
    expect(reads).toEqual([`${PLANS}/plan-v4.json`, `${PLANS}/plan-v5.json`])
    expect(tiers.value).toEqual({ 'web-ux-4': { version: 5, tier: 'medium' } })

    append(w, EPIC_F, [
      line(EPIC_S, SID, 'task-added', T17, T0 + 5000, { title: 'Remote error and phone header', plan_version: 6 }),
      line(EPIC_S, SID, 'wave-admitted', null, T0 + 5000, { epic_id: 'web-ux-4', task_ids: [T17], budget: { cap_tokens: 16_000_000, projected_tokens: 9_100_000, status: 'ok', tier: 'huge' } }),
    ].join(''))
    await clock.advance(4000)
    expect(reads).toHaveLength(2)
  })

  test('no plan where latestPlan looks (a plan written with --specs-dir): nothing read, no tier, asked once', async ($, on) => {
    const files = seed()
    const reads = reader(on, files)
    const tiers = tiersSet(on)
    world(on, files)
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)
    await clock.advance(4000)
    expect(reads).toEqual([])
    expect(tiers.value).toEqual({ 'web-ux-4': { version: 0, tier: null } })
    expect(tiers.sets).toBe(1)
  })
})

/** The `/config` theme row, as `$.config.list()` answers it; and a writer beneath bs-mod, so a `config.set` lands. */
function themed(on: On, theme: string): void {
  on('config.list', () => ({
    value: [{ key: 'theme', label: 'Theme', kind: 'choice' as const, value: theme, provider: { plugin: 'engine', tier: 'core' as const }, isLocked: false }],
  }))
  on('config.set', ($, e) => ({ value: e.value }))
}

describe('palette', () => {
  type Ui = Awaited<ReturnType<typeof mountBand>>
  const prompt = new RegExp(`^${ASK_1.replace(/[()]/g, '\\$&')}$`)

  /** The colors at the spots a theme repaints: a done and an active bar cell, the Current accent, a prompt, a done mark. */
  async function spots(ui: Ui) {
    const color = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.props
    const cells = await ui.findAll({ type: 'Text', text: /^[█░]+$/ })
    const out = { done: cells[0]?.props.color, active: cells[1]?.props.color, current: undefined as unknown, rule: undefined as unknown, prompt: undefined as unknown, mark: undefined as unknown }
    await ui.press({ key: 'tab:current' })
    out.current = (await color(/^ Current $/))?.backgroundColor
    out.rule = (await color(/^─+$/))?.color
    out.prompt = (await color(prompt))?.color
    await ui.press({ key: 'tab:past' })
    out.mark = (await color(/^✔$/))?.color
    await ui.press({ key: 'tab:overview' })
    return out
  }

  async function up($: Engine, on: On, theme: string | null): Promise<Ui> {
    world(on, prompted())
    if (theme !== null) themed(on, theme)
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)
    return mountBand($)
  }

  const CASES = [
    ['dark', { done: '#a6e3a1', active: '#94e2d5', current: '#89b4fa', rule: '#89b4fa', prompt: '#b4befe', mark: '#a6e3a1' }],
    ['dark-ansi', { done: '#a6e3a1', active: '#94e2d5', current: '#89b4fa', rule: '#89b4fa', prompt: '#b4befe', mark: '#a6e3a1' }],
    ['light', { done: '#40a02b', active: '#179299', current: '#1e66f5', rule: '#1e66f5', prompt: '#7287fd', mark: '#40a02b' }],
    ['dark-daltonized', { done: 'success', active: '#14b8a6', current: 'permission', rule: 'permission', prompt: 'remember', mark: 'success' }],
  ] as const

  for (const [theme, want] of CASES) {
    test(`under ${theme} the done, active, Current and prompt spots carry its palette`, async ($, on) => {
      const ui = await up($, on, theme)
      expect(await spots(ui)).toEqual(want)
    })
  }

  test('a theme set from dark to light turns the Mocha colors Latte on the next draw', async ($, on) => {
    const ui = await up($, on, 'dark')
    expect((await spots(ui)).active).toBe('#94e2d5')

    const set = await $.config.set({ key: 'theme', value: 'light', previous: 'dark', provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })
    expect(set).toEqual({ value: 'light' })
    expect(await spots(ui)).toEqual(CASES[2][1])
  })

  test('a denied theme write leaves the palette as it was', async ($, on) => {
    world(on, prompted())
    on('config.list', () => ({
      value: [{ key: 'theme', label: 'Theme', kind: 'choice' as const, value: 'dark', provider: { plugin: 'engine', tier: 'core' as const }, isLocked: false }],
    }))
    on('config.set', () => ({ deny: 'locked by policy' }))
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)
    const ui = await mountBand($)

    expect(await $.config.set({ key: 'theme', value: 'light', previous: 'dark', provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })).toEqual({ deny: 'locked by policy' })
    expect((await spots(ui)).active).toBe('#94e2d5')
  })

  test('a theme that cannot be read leaves the theme keys and the band drawn', async ($, on) => {
    world(on, prompted())
    on('config.list', () => {
      throw new Error('config unavailable')
    })
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)
    const ui = await mountBand($)
    expect(await rowKeys(ui)).toContain('head')
    expect(await spots(ui)).toEqual(CASES[3][1])
  })

  test('a theme write that fails leaves the palette as it was', async ($, on) => {
    on('state.set', { plugin: 'bs-mod', key: 'theme' }, ($, e, next) => {
      return e.value === 'light' ? { deny: 'state unavailable' } : next(e)
    })
    const ui = await up($, on, 'dark')
    const set = await $.config.set({ key: 'theme', value: 'light', previous: 'dark', provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })
    expect(set).toEqual({ value: 'light' })
    expect((await spots(ui)).active).toBe('#94e2d5')
  })

  test('session.start goes down the chain before the theme is read', async ($, on) => {
    const order: string[] = []
    on('state.set', { plugin: 'bs-mod', key: 'theme' }, ($, e, next) => {
      order.push('theme')
      return next(e)
    })
    const w = world(on, prompted())
    w.onStart = () => order.push('engine')
    themed(on, 'dark')
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)
    expect(order).toEqual(['engine', 'theme'])
  })

  // the soft label color per palette: Mocha subtext0, Latte subtext0, the theme key
  for (const [theme, soft] of [['dark', '#a6adc8'], ['light', '#6c6f85'], ['dark-daltonized', 'inactive'], [null, 'inactive']] as const) {
    test(`the Overview accent and labels take the soft label color ${soft} under ${theme ?? 'no theme'}`, async ($, on) => {
      const ui = await up($, on, theme)
      const props = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.props
      expect((await props(/^─+$/))?.color).toBe(soft)
      expect(await props(/^ Overview $/)).toEqual({ backgroundColor: soft, color: 'inverseText', bold: true })
      for (const label of ['Agents', 'Tasks', 'Budget']) expect(await props(new RegExp(`^${label}$`))).toEqual({ color: soft, bold: true })
      await ui.press({ key: 'tab:current' })
      for (const name of ['Tasks', 'Prompts']) expect(await props(new RegExp(`^${name}$`))).toEqual({ color: soft, bold: true })
    })
  }
})

describe('prompts and task progress outside an epic', () => {
  const HOME_ID = `prompts-${SID}`
  const ELSE = '/w/elsewhere'
  const CLONE_EVENTS = '/w/clone/state/events'
  const M4 = JSON.stringify({ events_dir: CLONE_EVENTS, project: 'acme', rule: 'M4' })

  /** The home log of the session, one user_prompt per entry, oldest first, `ago` minutes before T0. */
  function homeLog(prompts: [number, string][], id = HOME_ID): string {
    return prompts.map(([ago, text]) => line(id, SID, 'user_prompt', null, T0 - ago * MIN, { prompt: text })).join('')
  }

  const PROMPTS: [number, string][] = [
    [30, 'Rename the beta-app settings page'],
    [20, 'Why does the acme build warn?'],
    [5, 'Add a dark theme toggle'],
  ]

  async function up($: Engine, on: On, cwd = CWD): Promise<void> {
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock, cwd)
  }

  /** A ToDoWrite answer holding `todos`. */
  const todos = (...rows: [string, string, string][]) => ({
    oldTodos: [],
    newTodos: rows.map(([content, status, activeForm]) => ({ content, status, activeForm })),
  })

  async function write($: Engine, w: World, newTodos: unknown, extra: Record<string, unknown> = {}): Promise<void> {
    w.tools.TodoWrite = newTodos
    await $.tool.call({ tool: 'TodoWrite', todos: [], ...extra } as never)
  }

  test('the idle band shows the 2 newest own prompts from the home log, in the session\'s own events dir', async ($, on) => {
    const files = new Map<string, string>([[`${ELSE}/state/events/${HOME_ID}.jsonl`, homeLog(PROMPTS)]])
    world(on, files, SID, ELSE)
    await up($, on, ELSE)

    const ui = await mountBand($)
    const keys = await rowKeys(ui)
    expect(keys).toEqual(['blank', 'rule', 'tabs', 'agents', `prompt:${HOME_ID}#2`, `prompt:${HOME_ID}#1`, 'idle'])
    expect(await rowText(ui, `prompt:${HOME_ID}#2`)).toBe('❝ 5m ago Add a dark theme toggle')
    expect(await rowText(ui, `prompt:${HOME_ID}#1`)).toBe('❝ 20m ago Why does the acme build warn?')
  })

  test('the tick follows prompts-<sid>.jsonl as it grows', async ($, on) => {
    const path = `${ELSE}/state/events/${HOME_ID}.jsonl`
    const files = new Map<string, string>([[path, homeLog(PROMPTS.slice(0, 1))]])
    world(on, files, SID, ELSE)
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock, ELSE)

    const ui = await mountBand($)
    expect(await rowKeys(ui)).toContain(`prompt:${HOME_ID}#0`)
    files.set(path, homeLog(PROMPTS))
    await clock.advance(4000)
    expect(await rowText(ui, `prompt:${HOME_ID}#2`)).toContain('Add a dark theme toggle')
  })

  test('no prompt row for another session\'s home log', async ($, on) => {
    const other = 'prompts-sid-other'
    world(on, new Map([[`${ELSE}/state/events/${other}.jsonl`, homeLog(PROMPTS, other)]]), SID, ELSE)
    await up($, on, ELSE)

    expect(await rowKeys(await mountBand($))).toEqual(IDLE_KEYS)
  })

  describe('the capture root (M4)', () => {
    const cloneWorld = (on: On) => {
      const w = world(on, new Map([[`${CLONE_EVENTS}/${HOME_ID}.jsonl`, homeLog(PROMPTS)]]), SID, ELSE)
      w.hook = { stdout: `${M4}\n`, exitCode: 0 }
      return w
    }

    test('a root --resolve prints, that no own root names, supplies the idle band\'s prompts', async ($, on) => {
      const w = cloneWorld(on)
      await up($, on, ELSE)

      const ui = await mountBand($)
      expect(w.hookCalls[0]).toEqual(['--resolve', ELSE])
      expect(await rowKeys(ui)).toEqual(['blank', 'rule', 'tabs', 'agents', `prompt:${HOME_ID}#2`, `prompt:${HOME_ID}#1`, 'idle'])
      expect(await rowText(ui, `prompt:${HOME_ID}#2`)).toContain('Add a dark theme toggle')
    })

    test('--resolve runs once per session and cwd, not once per tick', async ($, on) => {
      const w = cloneWorld(on)
      const clock = mock.clock(on, { now: T0 })
      mock.store(on)
      mock.env(on, { HOME: '/home/u' })
      await boot($, clock, ELSE)
      await clock.advance(4000)
      await clock.advance(4000)
      await clock.advance(4000)
      expect(w.hookCalls).toEqual([['--resolve', ELSE]])
    })

    describe('BS_PROMPT_HOOK names the entry first', () => {
      const ENTRY = '/home/u/bs/promptHook.js'
      const upWith = async ($: Engine, on: On, env: Record<string, string>) => {
        const clock = mock.clock(on, { now: T0 })
        mock.store(on)
        mock.env(on, { HOME: '/home/u', ...env })
        await boot($, clock, ELSE)
      }

      test('an absolute existing file runs under node and its store feeds the band', async ($, on) => {
        const w = cloneWorld(on)
        w.present.add(ENTRY)
        await upWith($, on, { BS_PROMPT_HOOK: ENTRY })

        const ui = await mountBand($)
        expect(w.nodeCalls).toEqual([[ENTRY, '--resolve', ELSE]])
        expect(w.hookCalls).toEqual([])
        expect(await rowKeys(ui)).toEqual(['blank', 'rule', 'tabs', 'agents', `prompt:${HOME_ID}#2`, `prompt:${HOME_ID}#1`, 'idle'])
      })

      for (const [name, entry] of [['a relative path', 'bs/promptHook.js'], ['an absolute path with no file', '/home/u/missing.js']] as const) {
        test(`${name} is never run; bs-prompt-hook answers`, async ($, on) => {
          const w = cloneWorld(on)
          w.present.add('bs/promptHook.js')
          await upWith($, on, { BS_PROMPT_HOOK: entry })

          const ui = await mountBand($)
          expect(w.nodeCalls).toEqual([])
          expect(w.hookCalls[0]).toEqual(['--resolve', ELSE])
          expect(await rowKeys(ui)).toContain(`prompt:${HOME_ID}#2`)
        })
      }

      test('unset asks bs-prompt-hook', async ($, on) => {
        const w = cloneWorld(on)
        await upWith($, on, {})
        await mountBand($)
        expect(w.nodeCalls).toEqual([])
        expect(w.hookCalls[0]).toEqual(['--resolve', ELSE])
      })
    })

    const BROKEN = {
      'a missing bin': null,
      'empty output': { stdout: '', exitCode: 0 },
      'a non-zero exit': { stdout: `${M4}\n`, exitCode: 1 },
      'bad JSON': { stdout: 'not json\n', exitCode: 0 },
      'JSON with no events_dir': { stdout: '{"project":"acme"}\n', exitCode: 0 },
    } as const
    for (const [name, hook] of Object.entries(BROKEN)) {
      test(`${name} adds no root and shows no error`, async ($, on) => {
        const w = cloneWorld(on)
        w.hook = hook
        await up($, on, ELSE)

        const ui = await mountBand($)
        expect(await rowKeys(ui)).toEqual(IDLE_KEYS)
        expect(w.toasts).toEqual([])
        const out = (await $.command.run({ command: 'bs-mod', args: '' } as never)) as { text?: string } | undefined
        expect(JSON.stringify(out ?? {})).not.toMatch(/error/i)
      })
    }
  })

  test('homePrompts survives the hud copy: the idle band of a clone whose epics all went idle still shows them', async ($, on) => {
    const files = seed()
    const home = 'prompts-sid-none'
    files.set(`${ROOT}/${home}.jsonl`, homeLog(PROMPTS, home))
    const w = world(on, files, 'sid-none')
    for (const p of files.keys()) if (!p.includes(home)) w.mtimes.set(p, T0 - 7 * 1440 * MIN - 1)
    await up($, on)

    const ui = await mountBand($)
    expect(await rowKeys(ui)).toEqual(['blank', 'rule', 'tabs', 'agents', `prompt:${home}#2`, `prompt:${home}#1`, 'idle'])
  })

  test('a parent_prompt_id on an epic\'s session-start pulls its home log into the fold', async ($, on) => {
    const files = prompted()
    const other = 'prompts-sid-other'
    files.set(`${ROOT}/${other}.jsonl`, homeLog([[3, 'Plan the web-ux-4 epic']], other))
    files.set(WAVE_F, (files.get(WAVE_F) ?? '') + line(WAVE_S, 'sid-w', 'session-start', null, T0 - MIN, { parent_prompt_id: `${other}#0` }))
    world(on, files)
    await up($, on)

    const ui = await mountBand($)
    await ui.press({ key: 'tab:current' })
    const text = JSON.stringify(await ui.drawn())
    expect(text).toContain('Plan the web-ux-4 epic')
  })

  test('a named home log that cannot be read is not retried within every tick', async ($, on) => {
    const files = prompted()
    const other = 'prompts-sid-other'
    const otherF = `${ROOT}/${other}.jsonl`
    files.set(otherF, homeLog([[3, 'Plan the web-ux-4 epic']], other))
    files.set(WAVE_F, (files.get(WAVE_F) ?? '') + line(WAVE_S, 'sid-w', 'session-start', null, T0 - MIN, { parent_prompt_id: `${other}#0` }))
    const w = world(on, files)
    w.unreadable.add(otherF)
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    mock.env(on, { HOME: '/home/u' })
    await boot($, clock)
    // the first tick tracks it only after the fold names it: one read in the retry
    expect(w.tails.filter(p => p === otherF).length).toBe(1)
    await clock.advance(4000)
    // the second tick tracks it from the start and reads it once: no retry for a file that was already tracked
    expect(w.tails.filter(p => p === otherF).length).toBe(2)
  })

  describe('the task list (§2.9)', () => {
    test('shows Tasks 2/5 done with the first in-progress task\'s activeForm', async ($, on) => {
      const w = world(on, new Map(), SID, ELSE)
      await up($, on, ELSE)
      await write($, w, todos(['a', 'completed', 'Doing a'], ['b', 'completed', 'Doing b'], ['c', 'in_progress', 'Running tests'], ['d', 'pending', 'Doing d'], ['e', 'pending', 'Doing e']))

      const ui = await mountBand($)
      expect(await rowKeys(ui)).toEqual(['blank', 'rule', 'tabs', 'agents', 'progress', 'idle'])
      expect(await rowText(ui, 'progress')).toBe('Tasks   2/5 done · ▸ Running tests')
      expect(await rowText(ui, 'agents')).toBe('Agents  0 in this session')
    })

    test('with every task done it shows Tasks 5/5 done and no ▸', async ($, on) => {
      const w = world(on, new Map(), SID, ELSE)
      await up($, on, ELSE)
      await write($, w, todos(...(['a', 'b', 'c', 'd', 'e'].map(c => [c, 'completed', c]) as [string, string, string][])))

      expect(await rowText(await mountBand($), 'progress')).toBe('Tasks   5/5 done')
    })

    test('TaskCreate then TaskUpdate build the list through the tool hooks', async ($, on) => {
      const w = world(on, new Map(), SID, ELSE)
      await up($, on, ELSE)
      for (const [id, subject] of [['1', 'Write tests'], ['2', 'Write code']]) {
        w.tools.TaskCreate = { task: { id, subject } }
        await $.tool.call({ tool: 'TaskCreate', subject, description: subject, activeForm: `Doing ${subject}` } as never)
      }
      w.tools.TaskUpdate = { success: true, taskId: '1', updatedFields: ['status'] }
      await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' } as never)

      expect(await rowText(await mountBand($), 'progress')).toBe('Tasks   0/2 done · ▸ Doing Write tests')
    })

    test('a subagent\'s TaskCreate (agentId set) is ignored', async ($, on) => {
      const w = world(on, new Map(), SID, ELSE)
      await up($, on, ELSE)
      w.tools.TaskCreate = { task: { id: '1', subject: 'Sub work' } }
      await $.tool.call({ tool: 'TaskCreate', subject: 'Sub work', description: 'x', agentId: 'a1' } as never)

      expect(await rowKeys(await mountBand($))).toEqual(IDLE_KEYS)
    })

    test('the list survives a reload of the band', async ($, on) => {
      const w = world(on, new Map(), SID, ELSE)
      await up($, on, ELSE)
      await write($, w, todos(['a', 'completed', 'A'], ['b', 'in_progress', 'Doing b']))

      const first = await mountBand($)
      expect(await rowText(first, 'progress')).toContain('1/2 done')
      await first.unmount()
      expect(await rowText(await mountBand($), 'progress')).toBe('Tasks   1/2 done · ▸ Doing b')
    })
  })

  describe('background work, with no task list', () => {
    const bg = (w: World, id: string) => {
      w.tools.Bash = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id }
    }

    test('a background Bash result and a running agent read Tasks 2 running', async ($, on) => {
      const w = world(on, new Map(), SID, ELSE)
      w.agents = [agent('a1', 'running')]
      await up($, on, ELSE)
      bg(w, 'bsh1')
      await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true } as never)

      expect(await rowText(await mountBand($), 'progress')).toBe('Tasks   2 running · 0 done · 1 agent, 1 shell')
    })

    test('a Monitor call adds a running monitor', async ($, on) => {
      const w = world(on, new Map(), SID, ELSE)
      await up($, on, ELSE)
      w.tools.Monitor = { taskId: 'bmon1', timeoutMs: 1000 }
      await $.tool.call({ tool: 'Monitor', command: 'tail -f x', description: 'x' } as never)

      expect(await rowText(await mountBand($), 'progress')).toBe('Tasks   1 running · 0 done · 1 monitor')
    })

    test('a TaskStop naming a shell ends it, once however often it is told', async ($, on) => {
      const w = world(on, new Map(), SID, ELSE)
      w.agents = [agent('a1', 'running')]
      await up($, on, ELSE)
      bg(w, 'bsh1')
      await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true } as never)
      await $.tool.call({ tool: 'TaskStop', shell_id: 'bsh1' } as never)
      await $.tool.call({ tool: 'TaskStop', task_id: 'bsh1' } as never)

      expect(await rowText(await mountBand($), 'progress')).toBe('Tasks   1 running · 1 done · 1 agent')
    })

    test('a subagent\'s background Bash result is ignored', async ($, on) => {
      const w = world(on, new Map(), SID, ELSE)
      await up($, on, ELSE)
      bg(w, 'bsh9')
      await $.tool.call({ tool: 'Bash', command: 'sleep 9', run_in_background: true, agentId: 'a1' } as never)

      expect(await rowKeys(await mountBand($))).toEqual(IDLE_KEYS)
    })

    test('a plugin-origin prompt carrying notification text changes nothing', async ($, on) => {
      const w = world(on, new Map(), SID, ELSE)
      on('prompt.submit', (_$, e) => ({ text: e.text }))
      await up($, on, ELSE)
      bg(w, 'bsh1')
      await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true } as never)
      await $.prompt.submit({ text: '<task-notification>\n<task-id>bsh1</task-id>\n<status>completed</status>\n</task-notification>' } as never)

      expect(await rowText(await mountBand($), 'progress')).toBe('Tasks   1 running · 0 done · 1 shell')
    })
  })
})
