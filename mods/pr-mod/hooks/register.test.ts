import { test, expect, mock, describe } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'
import type { On, RenderElement, UiPane } from 'claude-code'

// A fake gh: `gh repo view` and `gh pr list` answer canned JSON for the
// session's cwd, `gh pr merge` and `gh pr update-branch` answer what the test
// set, and every call is recorded with its cwd and timeout.
const SID = 'sid-1'
const CWD = '/w/repo'
const T0 = Date.parse('2026-10-07T03:00:00.000Z')
const SEC = 1_000
const MIN = 60_000
const FIX_HOLD_MS = 15 * MIN
const REPO = { nameWithOwner: 'acme/widgets', squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true }
const NOT_A_REPO = 'failed to run git: fatal: not a git repository (or any of the parent directories): .git'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 115,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}
const PANE = {
  title: 'PRs',
  isFocused: false,
  bodyColumns: 100,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}
const PRESENTATION = { isFullscreen: false, columns: 120 }
/** What core answers `next(e)` with for AbovePrompt: the component it draws itself (a survey, else nothing). */
const ENGINE: RenderElement = { type: 'engine', ref: 0 }

/** One CheckRun as `gh pr list --json statusCheckRollup` answers it (measured on acme/widgets). */
function cr(name: string, conclusion = 'SUCCESS', status = 'COMPLETED', id = 100): Record<string, unknown> {
  return {
    __typename: 'CheckRun',
    name,
    status,
    conclusion,
    workflowName: 'CI',
    startedAt: new Date(T0 - 10 * MIN).toISOString(),
    completedAt: status === 'COMPLETED' ? new Date(T0 - 5 * MIN).toISOString() : '0001-01-01T00:00:00Z',
    detailsUrl: `https://github.com/acme/widgets/actions/runs/${id}/job/${id + 1}`,
  }
}

/** One open PR as `gh pr list --json ...` answers it: green, CLEAN, newer as n grows. */
function raw(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: n,
    title: `title ${n}`,
    headRefName: `feat/b${n}`,
    baseRefName: 'main',
    isDraft: false,
    author: { login: 'ada', is_bot: false },
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    statusCheckRollup: [cr('gate')],
    url: `https://github.com/acme/widgets/pull/${n}`,
    updatedAt: new Date(T0 - (100 - n) * MIN).toISOString(),
    headRefOid: `oid${n}`,
    ...over,
  }
}

const RED = { mergeStateStatus: 'UNSTABLE', statusCheckRollup: [cr('gate', 'FAILURE')] }
const DIRTY = { mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }

type Outcome = { code: number; stdout?: string; stderr?: string } | 'deny'
type Call = { argv: string[]; cwd: string | undefined; timeoutMs: number | undefined }

type World = {
  cwd: string
  /** what `gh repo view` answers; null: the cwd is not a git repo */
  repo: Record<string, unknown> | null
  /** the open PRs `gh pr list` answers */
  list: Record<string, unknown>[]
  /** set: `gh pr list` fails this way instead */
  listOutcome?: Outcome
  merge: Outcome
  update: Outcome
  calls: Call[]
  toasts: string[]
  prompts: { text: string; origin: unknown }[]
  panes: UiPane[]
  opened: string[]
  commands: string[]
  /** what lies beneath pr-mod in AbovePrompt: core's own drawing, another plugin's one-line band, or an empty Box */
  below: 'engine' | 'line' | 'empty'
  /** what a Bash tool call prints */
  toolOut: string
}

function world(on: On): World {
  const w: World = {
    cwd: CWD,
    repo: REPO,
    list: [],
    merge: { code: 0, stdout: '' },
    update: { code: 0, stdout: '' },
    calls: [],
    toasts: [],
    prompts: [],
    panes: [],
    opened: [],
    commands: [],
    below: 'engine',
    toolOut: '',
  }
  const answer = (o: Outcome) =>
    o === 'deny'
      ? { deny: 'gh is not allowed here' }
      : { value: { exitCode: o.code, stdout: o.stdout ?? '', stderr: o.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }

  on('session.id', () => ({ value: SID }))
  on('session.cwd', () => ({ value: w.cwd }))
  on('process.run', ($, e) => {
    w.calls.push({ argv: [...e.argv], cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
    const head = e.argv.slice(0, 3).join(' ')
    if (head === 'gh repo view') return answer(w.repo ? { code: 0, stdout: JSON.stringify(w.repo) } : { code: 1, stderr: `${NOT_A_REPO}\n` })
    if (head === 'gh pr list') return answer(w.listOutcome ?? { code: 0, stdout: JSON.stringify(w.list) })
    if (head === 'gh pr merge') return answer(w.merge)
    if (head === 'gh pr update-branch') return answer(w.update)
    return { deny: `unexpected process: ${e.argv.join(' ')}` }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    if (!w.panes.some(p => p.id === e.id)) w.panes.push({ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true })
    return { value: { isPlaced: true as const } }
  })
  on('ui.panes', () => ({ value: w.panes }))
  on('command.register', ($, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('prompt.submit', ($, e) => {
    w.prompts.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: { stdout: w.toolOut, stderr: '', interrupted: false }, text: w.toolOut }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if (w.below === 'line') return h(Box, { key: 'other' }, h(Text, null, 'other plugin band')) as RenderElement
    if (w.below === 'empty') return h(Box, null) as RenderElement
    return ENGINE
  })
  return w
}

async function up($: Engine, on: On, w: World): Promise<MockClock> {
  const clock = mock.clock(on, { now: T0 })
  await $.session.start({ cwd: w.cwd, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return clock
}

async function prmod($: Engine): Promise<string> {
  const ran = await $.command.run({ command: 'pr-mod', args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })
  return (ran as { text?: string }).text ?? ''
}

function mountPane($: Engine, props: typeof PANE = PANE) {
  return $.ui.mount({ plugin: 'pr-mod', surface: 'terminal', component: 'Pane', requestId: 'pr-mod', props, viewport: { columns: 120, rows: 40 } })
}

function mountBand($: Engine, props: typeof BAND = BAND) {
  return $.ui.mount({ plugin: 'pr-mod', surface: 'terminal', component: 'AbovePrompt', props })
}

type Found = { type: string; key?: string | null; text: string; props: Record<string, unknown> }
type Finder = {
  find: (q: { key?: string; type?: string; text?: RegExp }) => Promise<Found | undefined>
  findAll: (q: { key?: string; type?: string; text?: RegExp }) => Promise<readonly Found[]>
  drawn: () => Promise<RenderElement>
}

async function rowText(ui: Finder, key: string): Promise<string> {
  return (await ui.find({ key }))?.text ?? ''
}

/** The keys of the drawing's rows: one column Box, each row a keyed child. */
async function rowKeys(ui: Finder): Promise<string[]> {
  const root = await ui.drawn()
  const kids = 'children' in root ? (root.children ?? []) : []
  return kids.map(k => (typeof k === 'object' && k && 'props' in k ? String((k.props as { key?: unknown } | undefined)?.key ?? '') : ''))
}

async function shown(ui: Finder): Promise<string> {
  return (await ui.find({}))?.text ?? ''
}

/** The actions on PR n's row, as their key prefixes (`merge`, `fixci`, `open`, ...). */
async function buttonsOf(ui: Finder, n: number): Promise<string[]> {
  const all = await ui.findAll({ type: 'Button' })
  return all.map(b => String(b.key ?? '')).filter(k => k.endsWith(`:${n}`)).map(k => k.slice(0, k.lastIndexOf(':')))
}

async function label(ui: Finder, key: string): Promise<string> {
  return String((await ui.find({ key }))?.props.label ?? '')
}

const merges = (w: World) => w.calls.filter(c => c.argv[2] === 'merge')
const updates = (w: World) => w.calls.filter(c => c.argv[2] === 'update-branch')
const lists = (w: World) => w.calls.filter(c => c.argv[1] === 'pr' && c.argv[2] === 'list')
const repoViews = (w: World) => w.calls.filter(c => c.argv[1] === 'repo')

describe('pane', () => {
  test('/pr-mod opens the pane: a header with the repo, the count and the fetch age, then mine first and the newest', async ($, on) => {
    const w = world(on)
    w.list = [raw(1), raw(2), raw(3)]
    const clock = await up($, on, w)
    expect(w.commands).toEqual(['pr-mod'])
    expect(await prmod($)).toBe('Opened the PR pane: acme/widgets, 3 open')
    expect(w.opened).toEqual(['pr-mod'])
    await clock.advance(12 * SEC)
    const ui = await mountPane($)
    expect(await rowText(ui, 'header')).toMatch(/^acme\/widgets · 3 open · fetched 12s ago/)
    expect(await label(ui, 'refresh')).toBe('Refresh')
    expect(await rowKeys(ui)).toEqual(['header', 'pr:3', 'pr:2', 'pr:1'])
    expect(await rowText(ui, 'pr:3')).toMatch(/^#3\s+title 3/)
    expect((await ui.find({ type: 'Text', text: /^#3$/ }))?.props.bold).toBe(true)
    expect(lists(w)[0]).toEqual({
      argv: ['gh', 'pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,baseRefName,isDraft,author,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,url,updatedAt,headRefOid', '--limit', '50'],
      cwd: CWD,
      timeoutMs: 30_000,
    })
  })

  const GATES: { name: string; over: Record<string, unknown>; buttons: string[]; shows: string[] }[] = [
    { name: 'green, CLEAN, not a draft: Merge', over: {}, buttons: ['merge', 'open'], shows: ['✔ green', '⚑ CLEAN'] },
    { name: 'a draft: no Merge', over: { isDraft: true, mergeStateStatus: 'DRAFT' }, buttons: ['open'], shows: ['✔ green', 'draft'] },
    { name: 'CI red: Fix CI, no Merge', over: RED, buttons: ['fixci', 'open'], shows: ['✖ CI red (1)'] },
    { name: 'a conflict: Fix conflict, no Merge', over: DIRTY, buttons: ['fixc', 'open'], shows: ['⚠ conflict'] },
    { name: 'behind its base: Update branch, no Merge', over: { mergeStateStatus: 'BEHIND' }, buttons: ['update', 'open'], shows: ['↓ behind main'] },
    { name: 'blocked on a review: no Merge, the blocker named', over: { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }, buttons: ['open'], shows: ['⊘ blocked: review required'] },
    { name: 'checks still running: no Merge', over: { mergeStateStatus: 'BLOCKED', statusCheckRollup: [cr('gate', '', 'IN_PROGRESS')] }, buttons: ['open'], shows: ['◌ pending'] },
    { name: 'no checks at all: no Merge', over: { statusCheckRollup: [] }, buttons: ['open'], shows: ['no checks'] },
  ]
  for (const g of GATES) {
    test(`row actions: ${g.name}`, async ($, on) => {
      const w = world(on)
      w.list = [raw(1, g.over)]
      await up($, on, w)
      await prmod($)
      const ui = await mountPane($)
      expect(await buttonsOf(ui, 1)).toEqual(g.buttons)
      const row = await rowText(ui, 'pr:1')
      for (const s of g.shows) expect(row).toContain(s)
    })
  }

  test('40 PRs in 10 rows: the header, 8 PRs and +32 more', async ($, on) => {
    const w = world(on)
    w.list = Array.from({ length: 40 }, (_, i) => raw(i + 1))
    await up($, on, w)
    await prmod($)
    const ui = await mountPane($, { ...PANE, scroll: { offset: 0, bodyRows: 10 } })
    const keys = await rowKeys(ui)
    expect(keys).toHaveLength(10)
    expect(keys.slice(0, 2)).toEqual(['header', 'pr:40'])
    expect(keys.at(-1)).toBe('more')
    expect(await rowText(ui, 'more')).toBe('+32 more')
  })
})

describe('merge', () => {
  test('the first press arms Confirm merge, the second runs gh pr merge --squash, toasts and refreshes', async ($, on) => {
    const w = world(on)
    w.list = [raw(1), raw(2)]
    const clock = await up($, on, w)
    w.toolOut = 'https://github.com/acme/widgets/pull/1\n'
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    await clock.settle()
    await prmod($)
    const ui = await mountPane($)
    await ui.press({ key: 'merge:1' })
    expect(await label(ui, 'merge:1')).toBe('Confirm merge #1 (squash)')
    expect(merges(w)).toEqual([])
    w.list = [raw(2)]
    await ui.press({ key: 'merge:1' })
    await clock.settle()
    expect(merges(w)).toEqual([{ argv: ['gh', 'pr', 'merge', '1', '--squash'], cwd: CWD, timeoutMs: 120_000 }])
    // mine left the list, but because this mod merged it: no second toast
    expect(w.toasts).toEqual(['Merged #1 (squash)'])
    expect(await rowKeys(ui)).toEqual(['header', 'pr:2'])
  })

  test('an armed Merge disarms after 8 s without merging', async ($, on) => {
    const w = world(on)
    w.list = [raw(1)]
    const clock = await up($, on, w)
    await prmod($)
    const ui = await mountPane($)
    await ui.press({ key: 'merge:1' })
    await clock.advance(7_999)
    expect(await label(ui, 'merge:1')).toBe('Confirm merge #1 (squash)')
    await clock.advance(1)
    expect(await label(ui, 'merge:1')).toBe('Merge')
    expect(merges(w)).toEqual([])
    // a press after the disarm arms again rather than merging
    await ui.press({ key: 'merge:1' })
    expect(merges(w)).toEqual([])
    expect(await label(ui, 'merge:1')).toBe('Confirm merge #1 (squash)')
  })

  test('squash not allowed: the merge commit method, read once per session', async ($, on) => {
    const w = world(on)
    w.repo = { ...REPO, squashMergeAllowed: false }
    w.list = [raw(1)]
    const clock = await up($, on, w)
    await clock.advance(2 * MIN)
    expect(repoViews(w)).toHaveLength(1)
    expect(repoViews(w)[0]?.argv).toEqual(['gh', 'repo', 'view', '--json', 'nameWithOwner,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed'])
    await prmod($)
    const ui = await mountPane($)
    await ui.press({ key: 'merge:1' })
    expect(await label(ui, 'merge:1')).toBe('Confirm merge #1 (merge)')
    await ui.press({ key: 'merge:1' })
    await clock.settle()
    expect(merges(w)[0]?.argv).toEqual(['gh', 'pr', 'merge', '1', '--merge'])
    expect(w.toasts).toEqual(['Merged #1 (merge)'])
  })

  test('only rebase allowed: --rebase', async ($, on) => {
    const w = world(on)
    w.repo = { ...REPO, squashMergeAllowed: false, mergeCommitAllowed: false }
    w.list = [raw(1)]
    const clock = await up($, on, w)
    await prmod($)
    const ui = await mountPane($)
    await ui.press({ key: 'merge:1' })
    await ui.press({ key: 'merge:1' })
    await clock.settle()
    expect(merges(w)[0]?.argv).toEqual(['gh', 'pr', 'merge', '1', '--rebase'])
  })

  test('no method allowed: no Merge button, and the row says why', async ($, on) => {
    const w = world(on)
    w.repo = { ...REPO, squashMergeAllowed: false, mergeCommitAllowed: false, rebaseMergeAllowed: false }
    w.list = [raw(1)]
    await up($, on, w)
    await prmod($)
    const ui = await mountPane($)
    expect(await buttonsOf(ui, 1)).toEqual(['open'])
    expect(await rowText(ui, 'pr:1')).toContain('no merge method allowed')
  })

  test('a failed merge toasts gh\'s stderr on one line and the button returns to Merge', async ($, on) => {
    const w = world(on)
    w.list = [raw(1)]
    w.merge = { code: 1, stderr: 'X Pull request acme/widgets#1 is not mergeable: the base branch policy prohibits the merge.\nTo have the pull request merged after all the requirements have been met, add the `--auto` flag.\n' }
    const clock = await up($, on, w)
    await prmod($)
    const ui = await mountPane($)
    await ui.press({ key: 'merge:1' })
    await ui.press({ key: 'merge:1' })
    await clock.settle()
    expect(w.toasts).toEqual(['Merge #1 failed: X Pull request acme/widgets#1 is not mergeable: the base branch policy prohibits the merge.'])
    expect(await label(ui, 'merge:1')).toBe('Merge')
  })
})

describe('update branch', () => {
  test('Update branch runs gh pr update-branch with no confirm, toasts and refreshes', async ($, on) => {
    const w = world(on)
    w.list = [raw(2, { mergeStateStatus: 'BEHIND' })]
    const clock = await up($, on, w)
    await prmod($)
    const ui = await mountPane($)
    w.list = [raw(2)]
    await ui.press({ key: 'update:2' })
    await clock.settle()
    expect(updates(w)).toEqual([{ argv: ['gh', 'pr', 'update-branch', '2'], cwd: CWD, timeoutMs: 120_000 }])
    expect(w.toasts).toEqual(['Updated #2 from main'])
    expect(await buttonsOf(ui, 2)).toEqual(['merge', 'open'])
  })

  test('a failed update toasts gh\'s stderr on one line', async ($, on) => {
    const w = world(on)
    w.list = [raw(2, { mergeStateStatus: 'BEHIND' })]
    w.update = { code: 1, stderr: 'GraphQL: merge conflict between base and head (updatePullRequestBranch)\n' }
    const clock = await up($, on, w)
    await prmod($)
    const ui = await mountPane($)
    await ui.press({ key: 'update:2' })
    await clock.settle()
    expect(w.toasts).toEqual(['Update #2 failed: GraphQL: merge conflict between base and head (updatePullRequestBranch)'])
  })
})

describe('fix prompts', () => {
  test('Fix conflict submits one prompt naming the PR, head and base; a second press while fix sent holds does nothing', async ($, on) => {
    const w = world(on)
    w.list = [raw(4, DIRTY)]
    const clock = await up($, on, w)
    await prmod($)
    const ui = await mountPane($)
    await ui.press({ key: 'fixc:4' })
    await clock.settle()
    expect(w.prompts).toHaveLength(1)
    const sent = w.prompts[0]
    expect(sent?.origin).toMatchObject({ kind: 'plugin', name: 'pr-mod' })
    expect((sent?.origin as { asUser?: unknown } | undefined)?.asUser).toBeUndefined()
    expect(sent?.text).toContain('#4')
    expect(sent?.text).toContain('Head branch: feat/b4')
    expect(sent?.text).toContain('Base branch: main')
    expect(sent?.text.trimEnd().endsWith('Do not merge the PR.')).toBe(true)
    expect(w.toasts).toEqual(['Queued: fix conflict for #4'])
    expect(await label(ui, 'fixc:4')).toBe('fix sent')
    await ui.press({ key: 'fixc:4' })
    await clock.settle()
    expect(w.prompts).toHaveLength(1)
    expect(w.toasts).toEqual(['Queued: fix conflict for #4'])
    await clock.advance(FIX_HOLD_MS)
    expect(await label(ui, 'fixc:4')).toBe('Fix conflict')
  })

  test('fix sent clears when the head moves', async ($, on) => {
    const w = world(on)
    w.list = [raw(4, DIRTY)]
    const clock = await up($, on, w)
    await prmod($)
    const ui = await mountPane($)
    await ui.press({ key: 'fixc:4' })
    expect(await label(ui, 'fixc:4')).toBe('fix sent')
    w.list = [raw(4, { ...DIRTY, headRefOid: 'oid4b' })]
    await ui.press({ key: 'refresh' })
    await clock.settle()
    expect(await label(ui, 'fixc:4')).toBe('Fix conflict')
    await ui.press({ key: 'fixc:4' })
    await clock.settle()
    expect(w.prompts).toHaveLength(2)
  })

  test('Fix CI submits a prompt naming the failing checks and their runs', async ($, on) => {
    const w = world(on)
    w.list = [raw(5, { mergeStateStatus: 'UNSTABLE', statusCheckRollup: [cr('gate', 'FAILURE', 'COMPLETED', 555), cr('e2e')] })]
    const clock = await up($, on, w)
    await prmod($)
    const ui = await mountPane($)
    await ui.press({ key: 'fixci:5' })
    await clock.settle()
    const text = w.prompts[0]?.text ?? ''
    expect(text).toContain('- "gate" (run 555): https://github.com/acme/widgets/actions/runs/555/job/556')
    expect(text).not.toContain('"e2e"')
    expect(text).toContain('gh pr checks 5')
    expect(text.trimEnd().endsWith('Do not merge the PR.')).toBe(true)
    expect(w.toasts).toEqual(['Queued: fix CI for #5'])
    expect(await label(ui, 'fixci:5')).toBe('fix sent')
  })
})

describe('stale', () => {
  test('a gh failure keeps the cached rows and shows stale with the reason, dim; a later success clears it', async ($, on) => {
    const w = world(on)
    w.list = [raw(1), raw(2)]
    const clock = await up($, on, w)
    await prmod($)
    const ui = await mountPane($)
    w.listOutcome = { code: 1, stderr: 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n' }
    await ui.press({ key: 'refresh' })
    await clock.settle()
    expect(await rowKeys(ui)).toEqual(['header', 'stale', 'pr:2', 'pr:1'])
    expect(await rowText(ui, 'stale')).toBe('stale: error connecting to api.github.com')
    expect((await ui.find({ type: 'Text', text: /^stale: / }))?.props.dimColor).toBe(true)
    const band = await mountBand($)
    expect(await rowText(band, 'pr-mod')).toContain('· stale')
    w.listOutcome = undefined
    await ui.press({ key: 'refresh' })
    await clock.settle()
    expect(await rowKeys(ui)).toEqual(['header', 'pr:2', 'pr:1'])
  })

  test('a denied gh reads as stale with the denial', async ($, on) => {
    const w = world(on)
    w.list = [raw(1)]
    const clock = await up($, on, w)
    await prmod($)
    const ui = await mountPane($)
    w.listOutcome = 'deny'
    await ui.press({ key: 'refresh' })
    await clock.settle()
    expect(await rowText(ui, 'stale')).toContain('gh is not allowed here')
    expect(await rowKeys(ui)).toEqual(['header', 'stale', 'pr:1'])
  })
})

describe('band', () => {
  test('one line of counts, zero counts dropped, each in its colour', async ($, on) => {
    const w = world(on)
    w.list = [raw(1), raw(2), raw(3, RED), raw(4, { ...DIRTY, statusCheckRollup: [cr('gate', '', 'IN_PROGRESS')] })]
    await up($, on, w)
    const ui = await mountBand($)
    expect(await rowKeys(ui)).toEqual(['pr-mod'])
    expect(await rowText(ui, 'pr-mod')).toBe('PR 4 open · ✔ 2 green · ✖ 1 CI red · ⚠ 1 conflict · ◌ 1 pending')
    expect((await ui.find({ type: 'Text', text: /^4$/ }))?.props.bold).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^✔ 2 green$/ }))?.props.color).toBe('success')
    expect((await ui.find({ type: 'Text', text: /^✖ 1 CI red$/ }))?.props.color).toBe('error')
    expect((await ui.find({ type: 'Text', text: /^⚠ 1 conflict$/ }))?.props.color).toBe('warning')
    expect((await ui.find({ type: 'Text', text: /^◌ 1 pending$/ }))?.props.color).toBe('warning')
  })

  test('one green PR reads PR 1 open · ✔ 1 green', async ($, on) => {
    const w = world(on)
    w.list = [raw(1)]
    await up($, on, w)
    expect(await rowText(await mountBand($), 'pr-mod')).toBe('PR 1 open · ✔ 1 green')
  })

  test('nothing open: no line, what is beneath draws', async ($, on) => {
    const w = world(on)
    await up($, on, w)
    expect(await (await mountBand($)).drawn()).toEqual(ENGINE)
  })

  test('stacks over another plugin\'s band beneath, its line first', async ($, on) => {
    const w = world(on)
    w.list = [raw(1)]
    w.below = 'line'
    await up($, on, w)
    const ui = await mountBand($)
    expect(await rowKeys(ui)).toEqual(['pr-mod', 'below'])
    expect(await shown(ui)).toContain('other plugin band')
  })

  for (const below of ['empty', 'engine'] as const) {
    test(`draws its line alone over nothing drawable beneath (${below})`, async ($, on) => {
      const w = world(on)
      w.list = [raw(1)]
      w.below = below
      await up($, on, w)
      expect(await rowKeys(await mountBand($))).toEqual(['pr-mod'])
    })
  }

  test('yields to a survey', async ($, on) => {
    const w = world(on)
    w.list = [raw(1)]
    await up($, on, w)
    expect(await (await mountBand($, { ...BAND, hasSurvey: true })).drawn()).toEqual(ENGINE)
  })

  // Two more plugins, one above pr-mod that wraps next and one beneath that draws without it: all three bands show.
  const ABOVE: Plugin = {
    name: 'band-above',
    tier: 'prepend',
    register: on => {
      on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const below = await next(e)
        const { Box, Text } = $.ui.resolve(e)
        return h(Box, { flexDirection: 'column' }, h(Box, { key: 'above' }, h(Text, null, 'band above')), h(Box, { key: 'rest' }, below)) as RenderElement
      })
    },
  }
  const BENEATH: Plugin = {
    name: 'band-beneath',
    tier: 'append',
    register: on => {
      on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
        const { Box, Text } = $.ui.resolve(e)
        return h(Box, { key: 'beneath' }, h(Text, null, 'band beneath')) as RenderElement
      })
    },
  }
  test('between a plugin above and one beneath, all three bands show', { plugins: [ABOVE, BENEATH] }, async ($, on) => {
    const w = world(on)
    w.list = [raw(1)]
    await up($, on, w)
    const text = await shown(await mountBand($))
    expect(text).toContain('band above')
    expect(text).toContain('band beneath')
    expect(text.split('PR 1 open')).toHaveLength(2)
    expect(text.indexOf('band above')).toBeLessThan(text.indexOf('PR 1 open'))
    expect(text.indexOf('PR 1 open')).toBeLessThan(text.indexOf('band beneath'))
  })
})

describe('toasts', () => {
  test('none on the first fetch, then one when a PR\'s CI goes red', async ($, on) => {
    const w = world(on)
    w.list = [raw(1, RED), raw(2)]
    const clock = await up($, on, w)
    expect(w.toasts).toEqual([])
    w.list = [raw(1, RED), raw(2, RED)]
    await clock.advance(MIN)
    expect(w.toasts).toEqual(['#2 CI went red: title 2'])
  })

  test('CI going green toasts only for mine', async ($, on) => {
    const w = world(on)
    w.list = [raw(1, RED), raw(2, RED)]
    const clock = await up($, on, w)
    w.toolOut = 'Creating pull request for feat/b1 into main in acme/widgets\n\nhttps://github.com/acme/widgets/pull/1\n'
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --title "title 1" --body x' })
    await clock.settle()
    w.list = [raw(1), raw(2)]
    await clock.advance(MIN)
    expect(w.toasts).toEqual(['#1 CI is green: title 1'])
  })

  test('turning conflicting toasts; mine leaving the list toasts', async ($, on) => {
    const w = world(on)
    w.list = [raw(1), raw(2)]
    const clock = await up($, on, w)
    w.toolOut = 'https://github.com/acme/widgets/pull/1\n'
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    await clock.settle()
    w.list = [raw(1), raw(2, DIRTY)]
    await clock.advance(MIN)
    expect(w.toasts).toEqual(['#2 has a conflict with main: title 2'])
    w.list = [raw(2, DIRTY)]
    await clock.advance(MIN)
    expect(w.toasts).toEqual(['#2 has a conflict with main: title 2', '#1 left the open list (merged or closed): title 1'])
  })
})

describe('refresh triggers and mine', () => {
  test('gh pr create makes a PR mine and puts it first; git push and gh pr refresh, other commands do not', async ($, on) => {
    const w = world(on)
    w.list = [raw(1), raw(2), raw(3)]
    const clock = await up($, on, w)
    expect(lists(w)).toHaveLength(1)
    w.toolOut = 'https://github.com/acme/widgets/pull/1\n'
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    await clock.settle()
    expect(lists(w)).toHaveLength(2)
    w.toolOut = ''
    await $.tool.call({ tool: 'Bash', command: 'git push -u origin feat/b4' })
    await clock.settle()
    expect(lists(w)).toHaveLength(3)
    await $.tool.call({ tool: 'Bash', command: 'gh pr view 12' })
    await clock.settle()
    expect(lists(w)).toHaveLength(4)
    await $.tool.call({ tool: 'Bash', command: 'ls -la' })
    await clock.settle()
    expect(lists(w)).toHaveLength(4)
    await prmod($)
    expect(await rowKeys(await mountPane($))).toEqual(['header', 'pr:1', 'pr:3', 'pr:2'])
  })
})

describe('outside a GitHub repo', () => {
  test('one dim pane line, no band, no toasts, no list call', async ($, on) => {
    const w = world(on)
    w.repo = null
    const clock = await up($, on, w)
    expect(await prmod($)).toContain('no GitHub repo here')
    const ui = await mountPane($)
    expect(await rowKeys(ui)).toEqual(['none'])
    expect(await rowText(ui, 'none')).toBe(`pr-mod: no GitHub repo here (${NOT_A_REPO})`)
    expect((await ui.find({ type: 'Text', text: /^pr-mod: / }))?.props.dimColor).toBe(true)
    expect(await (await mountBand($)).drawn()).toEqual(ENGINE)
    await clock.advance(2 * MIN)
    expect(w.toasts).toEqual([])
    expect(lists(w)).toEqual([])
  })
})

describe('polling', () => {
  test('polls every 60 s while PRs are open', async ($, on) => {
    const w = world(on)
    w.list = [raw(1)]
    const clock = await up($, on, w)
    expect(lists(w)).toHaveLength(1)
    await clock.advance(MIN)
    expect(lists(w)).toHaveLength(2)
  })

  test('nothing open and no pane: no poll; once the pane opens, polls resume', async ($, on) => {
    const w = world(on)
    const clock = await up($, on, w)
    await clock.advance(MIN)
    expect(lists(w)).toHaveLength(1)
    await prmod($)
    expect(lists(w)).toHaveLength(2)
    await clock.advance(MIN)
    expect(lists(w)).toHaveLength(3)
  })

  test('UNKNOWN merge state re-polls every 5 s, three times, and reads computing', async ($, on) => {
    const w = world(on)
    w.list = [raw(1, { mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' })]
    const clock = await up($, on, w)
    const seen = [lists(w).length]
    for (let i = 0; i < 4; i++) {
      await clock.advance(5 * SEC)
      seen.push(lists(w).length)
    }
    expect(seen).toEqual([1, 2, 3, 4, 4])
    await prmod($)
    expect(await rowText(await mountPane($), 'pr:1')).toContain('… computing')
  })
})

// ---------------------------------------------------------------- palette

/** The `/config` theme row, as `$.config.list()` answers it; the same shape bs-mod reads. */
function themed(on: On, theme: string): void {
  on('config.list', () => ({
    value: [{ key: 'theme', label: 'Theme', kind: 'choice' as const, value: theme, provider: { plugin: 'engine', tier: 'core' as const }, isLocked: false }],
  }))
  on('config.set', ($, e) => ({ value: e.value }))
}

const PENDING_PR = { mergeStateStatus: 'UNSTABLE', statusCheckRollup: [cr('gate', '', 'IN_PROGRESS')] }

// the same hex values as bs-mod's palette: green success, red failure, yellow pending, pastel accent
const LOOKS = [
  ['dark', { green: '#a6e3a1', red: '#f38ba8', pending: '#f9e2af', accent: '#fab387' }],
  ['dark-ansi', { green: '#a6e3a1', red: '#f38ba8', pending: '#f9e2af', accent: '#fab387' }],
  ['light', { green: '#40a02b', red: '#d20f39', pending: '#df8e1d', accent: '#fe640b' }],
  ['dark-daltonized', { green: 'success', red: 'error', pending: 'warning', accent: 'claude' }],
  ['auto', { green: 'success', red: 'error', pending: 'warning', accent: 'claude' }],
] as const

describe('palette', () => {
  for (const [theme, want] of LOOKS) {
    test(`under ${theme} the band draws green, red and pending in the palette`, async ($, on) => {
      const w = world(on)
      themed(on, theme)
      w.list = [raw(1), raw(2, RED), raw(3, PENDING_PR)]
      await up($, on, w)
      const ui = await mountBand($)
      expect((await ui.find({ type: 'Text', text: /^✔ 1 green$/ }))?.props.color).toBe(want.green)
      expect((await ui.find({ type: 'Text', text: /^✖ 1 CI red$/ }))?.props.color).toBe(want.red)
      expect((await ui.find({ type: 'Text', text: /^◌ 1 pending$/ }))?.props.color).toBe(want.pending)
      expect((await ui.find({ type: 'Text', text: /^PR$/ }))?.props.color).toBe(want.accent)
    })

    test(`under ${theme} a pane row draws green, red and pending in the palette`, async ($, on) => {
      const w = world(on)
      themed(on, theme)
      w.list = [raw(1), raw(2, RED), raw(3, PENDING_PR)]
      await up($, on, w)
      await prmod($)
      const ui = await mountPane($)
      expect((await ui.find({ type: 'Text', text: /^✔ green$/ }))?.props.color).toBe(want.green)
      expect((await ui.find({ type: 'Text', text: /^✖ CI red/ }))?.props.color).toBe(want.red)
      expect((await ui.find({ type: 'Text', text: /^◌ pending$/ }))?.props.color).toBe(want.pending)
    })
  }

  test('no theme read: the theme keys draw', async ($, on) => {
    const w = world(on)
    on('config.list', () => {
      throw new Error('config unavailable')
    })
    w.list = [raw(1)]
    await up($, on, w)
    expect((await (await mountBand($)).find({ type: 'Text', text: /^✔ 1 green$/ }))?.props.color).toBe('success')
  })

  test('a theme set from dark to light turns the Mocha colors Latte on the next draw', async ($, on) => {
    const w = world(on)
    themed(on, 'dark')
    w.list = [raw(1)]
    await up($, on, w)
    const ui = await mountBand($)
    expect((await ui.find({ type: 'Text', text: /^✔ 1 green$/ }))?.props.color).toBe('#a6e3a1')
    await $.config.set({ key: 'theme', value: 'light', previous: 'dark', provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })
    expect((await ui.find({ type: 'Text', text: /^✔ 1 green$/ }))?.props.color).toBe('#40a02b')
  })

  test('labels and secondary text are dim, marks and numbers are not', async ($, on) => {
    const w = world(on)
    themed(on, 'dark')
    w.list = [raw(1)]
    await up($, on, w)
    await prmod($)
    const band = await mountBand($)
    expect((await band.find({ type: 'Text', text: /^ open$/ }))?.props.dimColor).toBe(true)
    expect((await band.find({ type: 'Text', text: /^✔ 1 green$/ }))?.props.dimColor).toBeUndefined()
    const pane = await mountPane($)
    expect((await pane.find({ type: 'Text', text: /^acme\/widgets$/ }))?.props.dimColor).toBe(true)
    expect((await pane.find({ type: 'Text', text: /^ open$/ }))?.props.dimColor).toBe(true)
    expect((await pane.find({ type: 'Text', text: /^fetched / }))?.props.dimColor).toBe(true)
    expect((await pane.find({ type: 'Text', text: /^✔ green$/ }))?.props.dimColor).toBeUndefined()
  })
})
