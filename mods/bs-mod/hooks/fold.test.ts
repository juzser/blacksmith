import { test, expect, describe } from 'claude-code/testing'
import type { AgentInfo, AgentStatus } from 'claude-code'
import {
  activeSessionAgents,
  bar,
  capped,
  currentModel,
  distinctPrompts,
  emptyHud,
  EPIC_IDLE_MS,
  epicIdOf,
  epicOfFile,
  epicsFromGrep,
  fmtElapsed,
  fmtTok,
  foldEvent,
  LATTE,
  MOCHA,
  newestRunning,
  nextModel,
  overviewModel,
  paletteOf,
  pastModel,
  parseBsHome,
  parseBsRoots,
  pickEpic,
  pickView,
  phaseOf,
  planDirOf,
  planEffort,
  planVersionOf,
  latestPlanName,
  tierOf,
  segments,
  shortTask,
  splitLines,
  summarize,
  WAVE_IDLE_MS,
  waveLabel,
  waveOf,
  walkToPrompt,
  PROMPT_HOPS,
  PROMPT_CHARS,
  THEME_KEYS,
  type BsEvent,
  type Link,
} from './fold'

// Shapes copied from real event logs, project names changed.
const SID = '04eaaef5-ce61-45c0-a78f-28c43d92b1b2'
const EPIC = 'web-ux-4'
const T16 = 'web-ux-4/task-16-phone-toolbar-hits'
const T17 = 'web-ux-4/task-17-remote-error-and-phone-header'
const T18 = 'web-ux-4/task-18-paired-device-details-hit'
const T17B = 'web-ux-4/task-17b-remote-error-and-phone-header-regate'
const T0 = Date.parse('2026-10-07T03:00:00.000Z')

let seq = 0
function ev(
  event_type: string,
  task_id: string | null,
  payload: Record<string, unknown> = {},
  extra: Partial<BsEvent> = {},
): BsEvent {
  seq += 1
  return {
    session_id: 'web-ux-4-w7-2026-10-07',
    actor: 'wave-runner',
    event_type,
    task_id,
    payload,
    cli_session_id: null,
    ts: new Date(T0 + seq * 1000).toISOString(),
    ...extra,
  }
}

function added(id: string, extra: Record<string, unknown> = {}) {
  return ev('task-added', id, { epic_id: EPIC, origin: 'user', task_status: 'todo', plan_version: 4, objective: `do ${id}`, ...extra }, { session_id: 'web-ux-4-2026-10-04', actor: 'orchestrator' })
}

function admitted(ids: string[], projected = 9_100_000) {
  return ev('wave-admitted', null, {
    epic_id: EPIC,
    task_ids: ids,
    budget: { status: 'ok', cap_tokens: 16_000_000, projected_tokens: projected, wave_tokens: 300_000, headroom_tokens: 16_000_000 - projected },
  }, { session_id: 'web-ux-4-2026-10-04', actor: 'system' })
}

function dispatch(task: string, role: string) {
  return ev('dispatch_decision', task, { agent_role: role, provider: 'claude', model_tier: 'mid', model: 'claude-sonnet-5-5', round: 1, reason: 'r' })
}

/** A quorum-decision; `subject` is the field its emitter alone writes: `blocks` (+ fingerprint), `sound` (+ plan_version) or `ready`. */
function quorum(task: string, outcome: string, subject: Record<string, unknown>, finding_id: string | null = null) {
  return ev('quorum-decision', task, {
    task_id: task, epic_id: EPIC, finding_id, ...subject, trigger_reason: 't', finder_provider: 'claude', outcome,
    decision: outcome === 'decided' ? 'refute' : null, escalation_reason: outcome === 'escalate' ? 'disagreement' : null,
  })
}

function fold(events: BsEvent[], sid = SID) {
  const hud = emptyHud()
  const notices: string[] = []
  events.forEach((e, i) => {
    for (const n of foldEvent(hud, e, `f#${i}`, sid)) notices.push(n.text)
  })
  return { hud, notices, epic: epicIn(hud) }
}

function epicIn(hud: ReturnType<typeof emptyHud>) {
  const epic = hud.epics[EPIC]
  if (!epic) throw new Error(`no ${EPIC} in the fold`)
  return epic
}

describe('naming', () => {
  test('epicIdOf reads payload, task prefix, then the session id', async () => {
    expect(epicIdOf(ev('x', null, { epic_id: 'web-ux-3' }))).toBe('web-ux-3')
    expect(epicIdOf(ev('x', T16))).toBe(EPIC)
    expect(epicIdOf(ev('x', 'task-1-app-load-states', {}, { session_id: 'web-ux-4-w2-2026-10-05' }))).toBe(EPIC)
    expect(epicIdOf(ev('x', null, {}, { session_id: 'web-ux-4-2026-10-04-land' }))).toBe(EPIC)
    expect(epicIdOf(ev('x', null, {}, { session_id: 'web-ux-3-w8b-2026-10-01' }))).toBe('web-ux-3')
    expect(epicIdOf(ev('x', null, {}, { session_id: 'web-audit-5-wave-3-2026-09-23' }))).toBe('web-audit-5')
    expect(epicIdOf(ev('x', null, {}, { session_id: 'web-audit-4-w2-takeover-2026-09-25' }))).toBe('web-audit-4')
    expect(epicIdOf(ev('x', null, {}, { session_id: 'web-ux-1-w6-2026-09-29-takeover' }))).toBe('web-ux-1')
    expect(epicIdOf(ev('x', null, {}, { session_id: 'kiosk-lifecycle-1' }))).toBe('kiosk-lifecycle-1')
    expect(epicIdOf(ev('x', null, {}, { session_id: undefined }))).toBeNull()
  })

  test('waveOf reads the wave number from a wave session id', async () => {
    expect(waveOf('web-ux-4-w7-2026-10-07')).toBe(7)
    expect(waveOf('web-ux-4-w1r-2026-10-05')).toBe(1)
    expect(waveOf('web-ux-3-w8b-2026-10-01-takeover')).toBe(8)
    expect(waveOf('web-ux-4-2026-10-04')).toBe(0)
    expect(waveOf('kiosk-lifecycle-1')).toBe(0)
    expect(waveOf('web-audit-5-wave-3-2026-09-23')).toBe(3)
    expect(waveOf('web-audit-4-w2-takeover-2026-09-25')).toBe(2)
    expect(waveOf('web-ux-1-w6-2026-09-29-land', 'web-ux-1')).toBe(6)
    // the epic named, a session of another epic is no wave of it
    expect(waveOf('web-ux-40-w3-2026-10-04', EPIC)).toBe(0)
  })

  test('a file\'s epic comes after the event\'s own, before the session id', async () => {
    const close = { session_id: 'web-audit-1-close-2026-10-07' }
    expect(epicIdOf(ev('x', null, {}, close), 'web-audit-1')).toBe('web-audit-1')
    expect(epicIdOf(ev('x', 'task-1-bare', {}, close), 'web-audit-1')).toBe('web-audit-1')
    expect(epicIdOf(ev('x', null, {}, { session_id: undefined }), 'web-audit-1')).toBe('web-audit-1')
    expect(epicIdOf(ev('x', null, { epic_id: 'web-ux-3' }, close), 'web-audit-1')).toBe('web-ux-3')
    expect(epicIdOf(ev('x', T16, {}, close), 'web-audit-1')).toBe(EPIC)
    // no file epic: the name-only answer
    expect(epicIdOf(ev('x', null, {}, close), null)).toBe('web-audit-1-close')
    expect(epicIdOf(ev('x', null, {}, close))).toBe('web-audit-1-close')
  })

  // the name alone: a wave spelling strips, a word suffix (`-close`, `-epic`, `-plan`) stays — the content lookup fixes those
  const FILE_EPICS: [string, string][] = [
    ['web-ux-4-2026-10-04', EPIC],
    ['web-ux-4-w1r-2026-10-05', EPIC],
    ['web-ux-4-w4-2026-10-06-land', EPIC],
    ['web-ux-1-w6-2026-09-29-takeover', 'web-ux-1'],
    ['web-ux-40-w2-2026-10-04', 'web-ux-40'],
    ['web-audit-5-wave-1-2026-09-22', 'web-audit-5'],
    ['web-audit-4-w2-takeover-2026-09-25', 'web-audit-4'],
    ['web-audit-4-epic-2026-09-25', 'web-audit-4-epic'],
    ['web-audit-1-close-2026-10-07', 'web-audit-1-close'],
    ['coverage-excluded-status-plan-2026-09-18', 'coverage-excluded-status-plan'],
    ['kiosk-lifecycle-1', 'kiosk-lifecycle-1'],
  ]
  for (const [name, epic] of FILE_EPICS) {
    test(`epicOfFile names ${name}.jsonl for ${epic}`, async () => {
      expect(epicOfFile(`${name}.jsonl`)).toBe(epic)
    })
  }

  test('a session-start naming no epic folds into its file\'s epic, as no wave', async () => {
    const CLOSE = 'web-audit-1-close-2026-10-07'
    const start = ev('session-start', null, {}, { session_id: CLOSE, actor: 'orchestrator' })
    const hud = emptyHud()
    foldEvent(hud, start, 'c#0', SID, 'web-audit-1')
    expect(Object.keys(hud.epics)).toEqual(['web-audit-1'])
    expect(hud.epics['web-audit-1']?.waveMax).toBe(0)
    expect(Object.keys(hud.epics['web-audit-1']?.waves ?? {})).toEqual([])
    expect(waveLabel(CLOSE, 'web-audit-1')).toBeNull()
    // without the file's epic it lands on the name-only answer
    const bare = emptyHud()
    foldEvent(bare, start, 'c#0', SID)
    expect(Object.keys(bare.epics)).toEqual(['web-audit-1-close'])
  })

  test('shortTask keeps the task number', async () => {
    expect(shortTask(T16)).toBe('task-16')
    expect(shortTask('web-ux-4/task-17b-remote-error-and-phone-header-regate')).toBe('task-17b')
    expect(shortTask('web-ux-4/followup-1f11677a')).toBe('followup-1f11677a')
    expect(shortTask('web-ux-4/integration')).toBe('integration')
  })
})

describe('epicsFromGrep', () => {
  test('each path takes its first hit; later hits and blank lines are skipped', async () => {
    const out = [
      '/e/web-audit-1-close-2026-10-07.jsonl:"task_id":"web-audit-1/',
      '/e/web-audit-1-close-2026-10-07.jsonl:"epic_id":"other-9"',
      '',
      '/e/web-audit-4-epic-2026-09-25.jsonl:"epic_id":"web-audit-4"',
      '/e/coverage-excluded-status-plan-2026-09-18.jsonl:"task_id":"coverage-excluded-status/',
      '',
    ].join('\n')
    expect([...epicsFromGrep(out)]).toEqual([
      ['/e/web-audit-1-close-2026-10-07.jsonl', 'web-audit-1'],
      ['/e/web-audit-4-epic-2026-09-25.jsonl', 'web-audit-4'],
      ['/e/coverage-excluded-status-plan-2026-09-18.jsonl', 'coverage-excluded-status'],
    ])
  })
  test('a colon in the path stays in the path', async () => {
    expect([...epicsFromGrep('/w/a:b/x-2026-10-01.jsonl:"epic_id":"x-1"\n')]).toEqual([['/w/a:b/x-2026-10-01.jsonl', 'x-1']])
  })
  test('no hit at all is an empty map', async () => {
    expect(epicsFromGrep('').size).toBe(0)
    expect(epicsFromGrep('\n\n').size).toBe(0)
  })
})

describe('parseBsHome', () => {
  const cwd = '/w/proj'
  const home = '/home/me'
  test('reads a prefix assignment and an export', async () => {
    expect(parseBsHome('BS_HOME=/a/b node cli.js status', cwd, home)).toBe('/a/b')
    expect(parseBsHome('export BS_HOME="~/x/.blacksmith"; bs status', cwd, home)).toBe('/home/me/x/.blacksmith')
    expect(parseBsHome("cd y && SMITH_HOME='rel/dir' bs run", cwd, home)).toBe('/w/proj/rel/dir')
  })
  test('the last assignment wins', async () => {
    expect(parseBsHome('BS_HOME=/one true; BS_HOME=/two bs status', cwd, home)).toBe('/two')
  })
  test('skips values it cannot resolve and commands without one', async () => {
    expect(parseBsHome('BS_HOME=$HOME/x bs status', cwd, home)).toBeNull()
    expect(parseBsHome('echo hello', cwd, home)).toBeNull()
    expect(parseBsHome('MY_BS_HOME=/a bs', cwd, home)).toBeNull()
  })
})

describe('parseBsRoots', () => {
  const cwd = '/w/proj'
  const home = '/home/me'
  const CLI = 'factory/orchestrator/dist/cli.js'
  test('a declared home wins over the CLI path', async () => {
    expect(parseBsRoots(`BS_HOME=/a/b node /c/blacksmith/${CLI} status`, cwd, home)).toEqual(['/a/b/state/events'])
  })
  test('a clone CLI writes into its own root', async () => {
    expect(parseBsRoots(`node /c/blacksmith/${CLI} event append x`, cwd, home)).toEqual(['/c/blacksmith/state/events'])
    expect(parseBsRoots(`node ~/bs/${CLI} a && node ~/bs/${CLI} b`, cwd, home)).toEqual(['/home/me/bs/state/events'])
  })
  test('commands that name neither find nothing', async () => {
    expect(parseBsRoots('ls -la', cwd, home)).toEqual([])
    expect(parseBsRoots(`cat $X/${CLI}`, cwd, home)).toEqual([])
  })
})

test('splitLines keeps whole lines and counts the newlines it consumed', async () => {
  expect(splitLines('a\nb\nc')).toEqual({ lines: ['a', 'b'], count: 2 })
  expect(splitLines('')).toEqual({ lines: [], count: 0 })
  expect(splitLines('a\n\nb\n')).toEqual({ lines: ['a', '', 'b'], count: 3 })
})

describe('task fold', () => {
  test('a task moves todo → ready → in-progress → merging → completed', async () => {
    const { epic, notices } = fold([
      added(T16), added(T17),
      admitted([T16]),
      dispatch(T16, 'coder'),
      ev('gate-outcome', T16, { outcome: 'pass' }),
    ])
    expect(epic.tasks[T16]?.status).toBe('merging')
    expect(epic.tasks[T17]?.status).toBe('todo')
    expect(epic.waveTaskIds).toEqual([T16])
    expect(epic.budget).toEqual({ cap: 16_000_000, projected: 9_100_000, status: 'ok' })
    expect(notices).toContain('▶ wave admitted · 1 task')

    const after = fold([added(T16), admitted([T16]), dispatch(T16, 'coder'),
      ev('wave-merged', T16, { task_ids: [T16], files_changed: ['a.ts'] }),
      added(T16)])
    expect(after.epic.tasks[T16]?.status).toBe('completed')
    expect(after.notices).toContain('✔ merged task-16')
  })

  test('a bare task id in a wave session belongs to the epic', async () => {
    const { epic } = fold([
      added('web-ux-4/task-1-app-load-states'),
      ev('wave-merged', 'task-1-app-load-states', { task_ids: ['task-1-app-load-states'] }, { session_id: 'web-ux-4-w2-2026-10-05' }),
    ])
    expect(epic.tasks['web-ux-4/task-1-app-load-states']?.status).toBe('completed')
  })

  test('a blocked gate blocks the task and toasts the reason', async () => {
    const { epic, notices } = fold([added(T17), dispatch(T17, 'coder'), ev('gate-outcome', T17, { outcome: 'blocked', reason: 'tests-failed' })])
    expect(epic.tasks[T17]?.status).toBe('blocked')
    expect(notices).toContain('✖ gate fail task-17 (tests-failed)')
  })

  test('errors block or escalate, skipping S3/S4 and terminal tasks', async () => {
    const { epic, notices } = fold([
      added(T16), added(T17), added(T18),
      ev('error-logged', null, { agent: 'wave-runner', agent_role: 'wave-runner', error: 'execution.flaky-test', task_ref: T16, severity: 'S4-nit', message: 'm' }),
      ev('error-logged', null, { agent: 'coder', agent_role: 'coder', error: 'execution.tool-failed', task_ref: `${T16}, ${T17}`, severity: 'S2-major', message: 'm' }),
      ev('error-logged', T18, { agent: 'coder', agent_role: 'coder', error: 'coordination.conflict', severity: 'S1-stop-the-line', message: 'm' }),
    ])
    expect(epic.tasks[T16]?.status).toBe('blocked')
    expect(epic.tasks[T17]?.status).toBe('blocked')
    expect(epic.tasks[T18]?.status).toBe('escalated')
    expect(notices).toContain('✖ S2 execution.tool-failed task-16, task-17')
    expect(notices.filter(n => n.includes('flaky'))).toHaveLength(0)
  })

  test('an error with no severity moves the task as a major one; S3-minor leaves it', async () => {
    const { epic, notices } = fold([
      added(T16), added(T17), dispatch(T16, 'coder'), dispatch(T17, 'coder'),
      ev('error-logged', T16, { agent: 'coder', agent_role: 'coder', error: 'execution.tool-failed', message: 'm' }),
      ev('error-logged', T17, { agent: 'wave-runner', agent_role: 'wave-runner', error: 'coordination.starvation', severity: 'S3-minor', message: 'm' }),
    ])
    expect(epic.tasks[T16]?.status).toBe('blocked')
    expect(epic.tasks[T17]?.status).toBe('in-progress')
    expect(notices).toContain('✖ S? execution.tool-failed task-16')
    expect(notices.filter(n => n.includes('starvation'))).toHaveLength(0)
  })

  test('a gate, an admission, a dispatch or an error after the merge never reopens the task', async () => {
    const { epic } = fold([
      added(T16), admitted([T16]), dispatch(T16, 'coder'),
      ev('wave-merged', T16, { task_ids: [T16], files_changed: ['a.ts'] }),
      ev('gate-outcome', T16, { outcome: 'blocked', reason: 'tests-failed' }),
      admitted([T16]),
      dispatch(T16, 'tester'),
      ev('error-logged', T16, { agent: 'coder', agent_role: 'coder', error: 'execution.tool-failed', severity: 'S2-major', message: 'm' }),
    ])
    expect(epic.tasks[T16]?.status).toBe('completed')
  })

  test('superseded and reserved refs never count as tasks', async () => {
    const { epic } = fold([
      added(T16), added(T17),
      ev('task-superseded', T17, { epic_id: EPIC }, { actor: 'operator' }),
      dispatch(`${EPIC}/integration`, 'wave-runner'),
      ev('quorum-decision', `${EPIC}/plan-v1`, { outcome: 'pass' }),
    ])
    expect(Object.keys(epic.tasks).sort()).toEqual([T16, T17])
    expect(epic.tasks[T17]?.status).toBe('superseded')
  })

  // web-audit-7 admitted task-14/15 hours before their task-added; web-audit-1/2 never task-added theirs
  test('an admission mints a row no task-added named, as Blacksmith projector.ts touch() does', async () => {
    const events = [added(T16), ev('wave-merged', T16, { task_ids: [T16] }), admitted([T17])]
    const { epic } = fold(events)
    expect(epic.tasks[T17]).toEqual({ status: 'ready', title: T17, origin: null, planVersion: null })
    const s = summarize(epic, Date.parse(events.at(-1)?.ts as string) + 60_000)
    expect(s.counts).toEqual({ done: 1, review: 0, active: 0, todo: 1, superseded: 0, total: 2 })
    expect(s.next).toBe('task-17')
  })

  test('a later task-added fills a minted row in and never reopens a merged one', async () => {
    const { epic } = fold([admitted([T16, T17]), ev('wave-merged', T17, { task_ids: [T17] }), added(T16), added(T17)])
    expect(epic.tasks[T17]).toEqual({ status: 'completed', title: `do ${T17}`, origin: 'user', planVersion: 4 })
    expect(epic.tasks[T16]).toEqual({ status: 'todo', title: `do ${T16}`, origin: 'user', planVersion: 4 })
  })

  test('a gate, a merge or a supersede on an unknown id mints its row', async () => {
    const { epic } = fold([
      ev('gate-outcome', T16, { outcome: 'blocked', reason: 'tests-failed' }),
      ev('wave-merged', null, { epic_id: EPIC, task_ids: [T17] }),
      ev('task-superseded', T18, { epic_id: EPIC }, { actor: 'operator' }),
    ])
    expect(epic.tasks).toEqual({
      [T16]: { status: 'blocked', title: T16, origin: null, planVersion: null },
      [T17]: { status: 'completed', title: T17, origin: null, planVersion: null },
      [T18]: { status: 'superseded', title: T18, origin: null, planVersion: null },
    })
  })

  test('a reserved ref is minted by no admission, gate, merge or supersede', async () => {
    const refs = [`${EPIC}/integration`, `${EPIC}/plan-v3`, EPIC]
    const { epic } = fold([
      admitted(refs),
      ...refs.map(r => ev('gate-outcome', r, { epic_id: EPIC, outcome: 'blocked', reason: 'tests-failed' })),
      ev('wave-merged', null, { epic_id: EPIC, task_ids: refs }),
      ...refs.map(r => ev('task-superseded', r, { epic_id: EPIC }, { actor: 'operator' })),
    ])
    expect(epic.tasks).toEqual({})
  })

  // a deliberate divergence from Blacksmith, which mints from error refs: the real ones are audit run ids
  test('an error naming an unknown ref mints nothing', async () => {
    const { epic } = fold([
      added(T16),
      ev('error-logged', null, { epic_id: EPIC, agent: 'auditor', agent_role: 'auditor', error: 'execution.tool-failed', task_ref: '20260914-5fe9088c.code-quality', severity: 'S2-major', message: 'm' }),
    ])
    expect(Object.keys(epic.tasks)).toEqual([T16])
  })
})

describe('agents', () => {
  test('a dispatch opens an agent; a result or report closes it', async () => {
    const { epic } = fold([
      added(T16), added(T17),
      dispatch(T16, 'tester'),
      dispatch(T17, 'grader'),
      dispatch(T17, 'reviewer'),
      ev('task-result-recorded', T16, { agent: 'tester', run_status: 'done' }),
      ev('judge-reported', T17, { agent_role: 'grader', round: 1, artifact_path: 'x', finding_count: 0 }),
    ])
    expect(Object.keys(epic.agents)).toEqual([`${T17}|reviewer`])
  })

  test('a result with no role closes the newest agent on the task', async () => {
    const { epic } = fold([added(T16), dispatch(T16, 'uiux'), dispatch(T16, 'tester'), ev('task-result-recorded', T16, { run_status: 'done', structured_output: {} })])
    expect(Object.keys(epic.agents)).toEqual([`${T16}|uiux`])
  })

  test('the coder is done once another role or the gate takes the task', async () => {
    const a = fold([added(T16), dispatch(T16, 'coder'), dispatch(T16, 'tester')])
    expect(Object.keys(a.epic.agents)).toEqual([`${T16}|tester`])
    const b = fold([added(T16), dispatch(T16, 'coder'), ev('gate-outcome', T16, { outcome: 'blocked', reason: 'findings' })])
    expect(Object.keys(b.epic.agents)).toEqual([])
  })

  test('grader-verdict closes the grader; merge closes every agent on the task', async () => {
    const { epic } = fold([
      added(T16), added(T17),
      dispatch(T16, 'grader'), ev('grader-verdict', T16, { run_status: 'done', round: 1, overall: 'pass', verdict: 'met' }),
      dispatch(T17, 'reviewer'), dispatch(T17, 'uiux'),
      ev('wave-merged', T17, { task_ids: [T17] }),
    ])
    expect(Object.keys(epic.agents)).toEqual([])
  })

  test('a judge-verdict closes the verifier or spec-reviewer that rendered it', async () => {
    const PLAN = `${EPIC}/plan-v2`
    const judge = (task: string, agent: string, verdict: string | null) => ev('judge-verdict', task, {
      task_id: task, finding_id: 'f-web-ux-4/task-16-x-48374cb0', agent, provider: 'codex', model_tier: 'mid',
      model: 'codex:default', kind: agent === 'verifier' ? 'verify' : 'plan-critique', mode: 'active', ok: true, verdict, rationale: 'r',
    })
    const { epic } = fold([
      added(T16),
      ev('dispatch_decision', T16, { agent_role: 'verifier', provider: 'codex', model_tier: 'mid', model: 'codex:default', round: 1, reason: 'r' }),
      judge(T16, 'verifier', 'refute'),
      ev('dispatch_decision', PLAN, { agent_role: 'spec-reviewer', provider: 'codex', model_tier: 'mid', model: 'codex:default', round: 1, reason: 'r' }),
      judge(PLAN, 'spec-reviewer', null),
    ])
    expect(epic.agents).toEqual({})
    const texts = epic.activity.map(a => a.text)
    expect(texts).toContain('verifier refute task-16')
    expect(texts).toContain('spec-reviewer plan-v2')
    expect(epic.activity.filter(a => a.text.startsWith('verifier refute') || a.text === 'spec-reviewer plan-v2').map(a => a.tone)).toEqual(['info', 'info'])
  })

  test('a judge-verdict carrying agent_role closes that role', async () => {
    const { epic } = fold([
      added(T16),
      ev('dispatch_decision', T16, { agent_role: 'verifier', provider: 'codex', model_tier: 'mid', model: 'codex:default', round: 1, reason: 'r' }),
      ev('judge-verdict', T16, { task_id: T16, agent_role: 'verifier', kind: 'verify', ok: true, verdict: 'confirm' }),
    ])
    expect(epic.agents).toEqual({})
    expect(epic.activity.map(a => a.text)).toContain('verifier confirm task-16')
  })

})

// Every wave-runner is dispatched from the epic session on `integration`; the
// wave it runs only shows in the session it writes, `<epic>-w4-<date>`.
describe('wave-runners', () => {
  const EPIC_S = 'web-ux-4-2026-10-04'
  const W4 = 'web-ux-4-w4-2026-10-06'
  const W5 = 'web-ux-4-w5-2026-10-06'
  const inWave = (session_id: string, e: BsEvent): BsEvent => ({ ...e, session_id })
  const start = (session_id: string) => ev('session-start', null, {}, { session_id })
  const runner = (reason: string) => ev('dispatch_decision', `${EPIC}/integration`, {
    agent_role: 'wave-runner', provider: 'claude', model_tier: 'mid', model: 'claude-sonnet-5-5', round: 1, reason,
  }, { session_id: EPIC_S, actor: 'orchestrator' })
  const lastTs = (events: BsEvent[]) => Date.parse(events.at(-1)?.ts as string)
  const at = (ms: number) => new Date(ms).toISOString()
  const runners = (s: ReturnType<typeof summarize>) => (s.agents ?? []).filter(a => a.role === 'wave-runner').map(a => a.taskId)
  // w5 is admitted and dispatched while w4 still runs
  const two = () => [
    added(T16), added(T17), added(T18),
    admitted([T16]), runner('Run wave 4'), start(W4), inWave(W4, dispatch(T16, 'coder')),
    admitted([T17]), runner('Run wave 5 in parallel with wave 4'), start(W5), inWave(W5, dispatch(T17, 'coder')),
  ]

  test('each wave session is one live wave-runner, named by its wave', async () => {
    const events = two()
    const { epic } = fold(events)
    const s = summarize(epic, lastTs(events) + 60_000)
    expect(runners(s)).toEqual(['w5', 'w4'])
    expect(s.agentCount).toBe(4)
    expect(s.now?.role).toBe('coder')
    expect(s.now?.task).toBe('task-17')
    expect(epic.waves?.w4?.tasks).toEqual([T16])
    expect(epic.waves?.w5?.tasks).toEqual([T17])
    // concurrent waves work disjoint tasks: each owns its own
    expect(epic.taskWave).toEqual({ [T16]: 'w4', [T17]: 'w5' })
    expect(Object.keys(epic.agents).filter(k => k.endsWith('|wave-runner'))).toEqual([])
  })

  // web-ux-4 w1r re-ran w1's open task-2 on 2026-10-05 after w1 stopped
  test('a wave whose open tasks a later wave took over is done; the later wave is live', async () => {
    const W1 = 'web-ux-4-w1-2026-10-05'
    const W1R = 'web-ux-4-w1r-2026-10-05'
    const before = [
      added(T16), added(T17),
      start(W1), inWave(W1, dispatch(T16, 'coder')), inWave(W1, dispatch(T17, 'coder')),
      inWave(W1, ev('wave-merged', T17, { task_ids: [T17] })),
      start(W1R),
    ]
    expect(runners(summarize(fold(before).epic, lastTs(before) + 60_000))).toEqual(['w1r', 'w1'])
    const events = [...before, inWave(W1R, dispatch(T16, 'coder'))]
    expect(runners(summarize(fold(events).epic, lastTs(events) + 60_000))).toEqual(['w1r'])
  })

  test('a spec-reviewer on integration and a new wave admission leave them running', async () => {
    const events = [
      ...two(),
      ev('dispatch_decision', `${EPIC}/integration`, { agent_role: 'spec-reviewer', model: 'codex:default' }, { session_id: EPIC_S, actor: 'orchestrator' }),
      admitted([T18]),
    ]
    const s = summarize(fold(events).epic, lastTs(events) + 60_000)
    expect(runners(s)).toEqual(['w5', 'w4'])
    expect(s.roles).toContain('spec-reviewer')
    expect(s.agentCount).toBe(5)
  })

  test('a wave whose touched tasks all landed drops out; the other stays', async () => {
    const events = [...two(), inWave(W4, ev('wave-merged', null, { epic_id: EPIC, task_ids: [T16] }))]
    const s = summarize(fold(events).epic, lastTs(events) + 60_000)
    expect(runners(s)).toEqual(['w5'])
  })

  // web-ux-4 w4 and w6 filed findings against task-5, which w7 works: they stayed live after their last merge
  test('a finding filed against another wave\'s task does not keep the wave live', async () => {
    const fid = `f-${T17}-4147a195`
    const events = [
      ...two(),
      inWave(W4, ev('finding-raised', T17, { finding_id: fid, task_id: T17, severity: 'S2-major', finding_status: 'raised', summary: 's' })),
      inWave(W4, ev('finding-reattributed', T17, { from_task_id: EPIC, to_task_id: T17, attribution: 'reassigned', finding_id: fid })),
      inWave(W4, ev('wave-merged', null, { epic_id: EPIC, task_ids: [T16] })),
    ]
    const { epic } = fold(events)
    expect(epic.waves?.w4?.tasks).toEqual([T16])
    expect(runners(summarize(epic, lastTs(events) + 60_000))).toEqual(['w5'])
  })

  // web-ux-4 w4/w5 added escalation followups, w4 ran a quorum on one, w6 wrote a doubly-prefixed task-7 id
  test('an escalation followup or an id no task-added named does not keep the wave live', async () => {
    const F = `${EPIC}/followup-dd001c60`
    const events = [
      ...two(),
      inWave(W4, added(F, { origin: 'escalation', case: 'bugfix' })),
      inWave(W4, dispatch(`${EPIC}/followup-1f11677a`, 'verifier')),
      inWave(W4, ev('task-result-recorded', 'web-ux-4-task-16-phone-toolbar-hits', { agent_role: 'coder', run_status: 'done' })),
      inWave(W4, ev('wave-merged', null, { epic_id: EPIC, task_ids: [T16] })),
    ]
    const s = summarize(fold(events).epic, lastTs(events) + 60_000)
    expect(runners(s)).toEqual(['w5'])
  })

  // web-audit-7 w2 merged task-9/14 and kept working task-15, admitted with no task-added: the band hid
  // the wave-runner and read "Waiting on you" on another wave's waiver for ~56 min
  test('a wave working an admitted task no task-added named stays live', async () => {
    const W2 = 'web-ux-4-w2-2026-10-06'
    const events = [
      added(T16), added(T18),
      admitted([T16]),
      ev('gate-outcome', T16, { outcome: 'pass-with-waivers-pending' }, { session_id: EPIC_S }),
      admitted([T17, T18]), start(W2),
      inWave(W2, dispatch(T18, 'coder')),
      inWave(W2, ev('wave-merged', T18, { task_ids: [T18] })),
      inWave(W2, dispatch(T17, 'coder')),
      inWave(W2, ev('task-result-recorded', T17, { agent_role: 'coder', run_status: 'done' })),
      inWave(W2, ev('gate-outcome', T17, { outcome: 'blocked', reason: 'tests-failed' })),
    ]
    const s = summarize(fold(events).epic, lastTs(events) + 60_000)
    expect(runners(s)).toEqual(['w2'])
    expect(s.waits.waivers).toBe(1)
    expect(s.isWaitingOnYou).toBe(false)
  })

  test('a wave session silent for over WAVE_IDLE_MS drops out', async () => {
    const base = two()
    const later = lastTs(base) + WAVE_IDLE_MS
    const events = [...base, inWave(W5, ev('task-result-recorded', T17, { agent_role: 'coder', run_status: 'done' }, { ts: at(later) }))]
    const s = summarize(fold(events).epic, later + 60_000)
    expect(runners(s)).toEqual(['w5'])
  })

  // web-ux-4 w5 paused 311 min and came back: the band read `wave-runner w5 (22h)`
  test('a wave is live up to WAVE_IDLE_MS of silence; its next event starts a new run', async () => {
    const events = [added(T16), admitted([T16]), runner('Run wave 4'), start(W4), inWave(W4, dispatch(T16, 'coder'))]
    const seen = lastTs(events)
    const { hud, epic } = fold(events)
    expect(runners(summarize(epic, seen + WAVE_IDLE_MS))).toEqual(['w4'])
    expect(runners(summarize(epic, seen + WAVE_IDLE_MS + 1))).toEqual([])
    const back = seen + 3 * 3600_000
    foldEvent(hud, inWave(W4, ev('task-result-recorded', T16, { agent_role: 'coder', run_status: 'done' }, { ts: at(back) })), 'f#back', SID)
    const s = summarize(epic, back + 60_000)
    expect(runners(s)).toEqual(['w4'])
    expect(s.agents.find(a => a.role === 'wave-runner')?.since).toBe(back)
  })

  // a wave session's events come in order from its own file; one folded late moves `since` back only within the run
  test('an earlier event inside the current run moves since back; one from before a pause does not', async () => {
    const events = [added(T16), start(W4), inWave(W4, dispatch(T16, 'coder'))]
    const { hud, epic } = fold(events)
    const late = (ms: number) => foldEvent(hud, ev('session-start', null, {}, { session_id: W4, ts: at(ms) }), 'f#late', SID)
    const early = lastTs(events) - 30 * 60_000
    late(early)
    expect(epic.waves?.w4?.since).toBe(early)
    late(early - WAVE_IDLE_MS - 1)
    expect(epic.waves?.w4?.since).toBe(early)
  })

  test('a wave that has only started is live, and is Now while no worker runs', async () => {
    const events = [added(T16), admitted([T16]), runner('Run wave 4'), start(W4)]
    const { epic } = fold(events)
    const s = summarize(epic, lastTs(events) + 60_000)
    expect(runners(s)).toEqual(['w4'])
    expect(s.now).toEqual({ role: 'wave-runner', task: 'w4', elapsed: '1m' })
    expect(epic.waves?.w4?.tasks).toEqual([])
  })

  test('wave-3 and takeover spellings are waves of the epic, and waveMax follows', async () => {
    const W3 = 'web-ux-4-wave-3-2026-10-05'
    const W2T = 'web-ux-4-w2-takeover-2026-10-05'
    const W6T = 'web-ux-4-w6-2026-10-06-takeover'
    const a = fold([added(T16), start(W3), inWave(W3, dispatch(T16, 'coder'))])
    expect(a.epic.waveMax).toBe(3)
    const events = [
      added(T16), added(T17), added(T18),
      start(W3), inWave(W3, dispatch(T16, 'coder')),
      start(W2T), inWave(W2T, dispatch(T17, 'coder')),
      start(W6T), inWave(W6T, dispatch(T18, 'tester')),
    ]
    const { hud, epic } = fold(events)
    expect(Object.keys(hud.epics)).toEqual([EPIC])
    expect(Object.keys(epic.waves ?? {}).sort()).toEqual(['w2', 'w3', 'w6'])
    const s = summarize(epic, lastTs(events) + 60_000)
    expect(s.wave).toBe(6)
    expect(runners(s)).toEqual(['w6', 'w2', 'w3'])
  })

  test('a wave-runner dispatch in the epic session opens no agent', async () => {
    const events = [added(T16), admitted([T16]), runner('Run wave 4')]
    const { epic } = fold(events)
    expect(epic.agents).toEqual({})
    expect(epic.activity.map(a => a.text)).toContain('wave-runner → integration')
    expect(summarize(epic, lastTs(events) + 60_000).agentCount).toBe(0)
  })

  test('a closed epic has no live wave-runner', async () => {
    const events = [...two(), ev('epic-closed', `${EPIC}/integration`, { epic_id: EPIC, closed_by: 'operator', machine_verdict: 'met', summary: 's' }, { session_id: EPIC_S })]
    const s = summarize(fold(events).epic, lastTs(events) + 60_000)
    expect(runners(s)).toEqual([])
    expect(s.agentCount).toBe(0)
  })

  test('an epic folded before waves were kept still folds and summarizes', async () => {
    const { hud, epic } = fold([added(T16), admitted([T16])])
    delete (epic as Partial<typeof epic>).waves
    foldEvent(hud, start(W4), 'f#late', SID)
    expect(epic.waves?.w4?.tasks).toEqual([])
    delete (epic as Partial<typeof epic>).waves
    expect(summarize(epic, T0).agentCount).toBe(0)
  })

  test('an epic folded before task owners were kept still folds and summarizes', async () => {
    const { hud, epic } = fold([added(T16), admitted([T16])])
    delete (epic as Partial<typeof epic>).taskWave
    const late = inWave(W4, dispatch(T16, 'coder'))
    foldEvent(hud, late, 'f#late', SID)
    expect(epic.taskWave).toEqual({ [T16]: 'w4' })
    // no owner on record: the wave that touched a task owns it
    delete (epic as Partial<typeof epic>).taskWave
    expect(runners(summarize(epic, Date.parse(late.ts as string) + 60_000))).toEqual(['w4'])
  })

  test('a dispatch-keyed wave-runner left by an older fold is neither live nor stale', async () => {
    const { epic } = fold([added(T16), admitted([T16])])
    epic.agents[`${EPIC}/integration|wave-runner`] = { taskId: `${EPIC}/integration`, role: 'wave-runner', since: T0, model: 'opus' }
    const s = summarize(epic, T0 + 60_000)
    expect(runners(s)).toEqual([])
    expect(s.agentCount).toBe(0)
    expect(summarize(epic, T0 + 4 * 3600_000).staleCount).toBe(0)
  })
})

describe('waits', () => {
  test('a waiver gate waits until the task passes or merges', async () => {
    const a = fold([added(T16), ev('gate-outcome', T16, { outcome: 'pass-with-waivers-pending' })])
    expect(a.epic.pendingWaivers).toEqual([T16])
    expect(a.epic.tasks[T16]?.status).toBe('reviewing')
    expect(a.notices).toContain('⚑ waiver pending task-16')
    const b = fold([added(T16), ev('gate-outcome', T16, { outcome: 'pass-with-waivers-pending' }), ev('gate-outcome', T16, { outcome: 'pass' })])
    expect(b.epic.pendingWaivers).toEqual([])
  })

  test('an escalation waits until its finding closes', async () => {
    const f = 'f-web-ux-4/task-16-x-48374cb0'
    const a = fold([added(T16), quorum(T16, 'escalate', { blocks: true, fingerprint: 'fp' }, f)])
    expect(a.epic.escalations).toEqual({ 'finding:fp': T16 })
    expect(a.notices).toContain('⚑ escalation task-16 (disagreement)')
    const b = fold([
      added(T16),
      quorum(T16, 'escalate', { blocks: true, fingerprint: 'fp' }, f),
      ev('finding-transitioned', T16, { finding_id: f, fingerprint: 'fp', from_status: 'confirmed', to_status: 'fix-verified' }),
    ])
    expect(b.epic.escalations).toEqual({})
  })

  test('a plan quorum case escalates once, and any later outcome on the plan closes it', async () => {
    const PLAN = `${EPIC}/plan-v1`
    const a = fold([
      added(T16),
      quorum(PLAN, 'escalate', { plan_version: 1, sound: false }, 'f-a'),
      quorum(PLAN, 'escalate', { plan_version: 1, sound: false }, 'f-b'),
    ])
    expect(a.epic.escalations).toEqual({ [`plan:${PLAN}`]: PLAN })
    const b = fold([
      added(T16),
      quorum(PLAN, 'escalate', { plan_version: 1, sound: false }, 'f-a'),
      quorum(PLAN, 'escalate', { plan_version: 1, sound: false }, 'f-b'),
      quorum(PLAN, 'decided', { plan_version: 1, sound: true }, 'f-c'),
    ])
    expect(b.epic.escalations).toEqual({})
  })

  test('a finding quorum case is its fingerprint: a re-run decided under a new finding id closes it', async () => {
    const { epic } = fold([
      added(T16),
      quorum(T16, 'escalate', { blocks: true, fingerprint: 'F' }, 'f-web-ux-4/task-16-x-1'),
      quorum(T16, 'decided', { blocks: false, fingerprint: 'F' }, 'f-web-ux-4/task-16-x-2'),
    ])
    expect(epic.escalations).toEqual({})
  })

  test('an epic verdict escalation is not closed by a plan decision on the same ref', async () => {
    const INT = `${EPIC}/integration`
    const { epic } = fold([
      added(T16),
      quorum(INT, 'escalate', { ready: false }),
      quorum(INT, 'decided', { plan_version: 4, sound: true }),
    ])
    expect(epic.escalations).toEqual({ [`epic:${INT}`]: INT })
  })

  test('an escalation naming no task is keyed (no task) and named by its subject', async () => {
    const { epic, notices } = fold([
      added(T16),
      ev('quorum-decision', null, { epic_id: EPIC, ready: false, outcome: 'escalate', escalation_reason: 'disagreement' }),
    ])
    expect(epic.escalations).toEqual({ 'epic:(no task)': '' })
    expect(notices).toContain('⚑ escalation epic (disagreement)')
  })

  test('findings stay open until a closing transition', async () => {
    const f1 = 'f-web-ux-4/task-16-a'
    const f2 = 'f-web-ux-4/task-17-b'
    const f3 = 'f-web-ux-4/integration-c'
    const { epic, notices } = fold([
      added(T16), added(T17),
      ev('finding-raised', T16, { finding_id: f1, task_id: T16, epic_id: EPIC, severity: 'S1-stop-the-line', finding_status: 'raised', summary: 's' }),
      ev('finding-raised', T17, { finding_id: f2, task_id: T17, epic_id: EPIC, severity: 'S3-minor', finding_status: 'raised', summary: 's' }),
      ev('finding-transitioned', T17, { finding_id: f2, fingerprint: 'fp', from_status: 'raised', to_status: 'waived' }),
      ev('finding-raised', null, { finding_id: f3, epic_id: EPIC, severity: 'S2-major', finding_status: 'raised', summary: 's' }),
      ev('finding-transitioned', null, { finding_id: f3, fingerprint: 'fp3', from_status: 'raised', to_status: 'amend-pending', amends_task_ids: [T17] }),
    ])
    expect(epic.openFindings).toEqual({
      [f1]: { severity: 'S1-stop-the-line', status: 'raised' },
      [f3]: { severity: 'S2-major', status: 'amend-pending', amendsTaskIds: [T17] },
    })
    expect(notices).toContain('✖ S1 finding task-16')
  })

  test('a spec-change proposal waits until a decision names it', async () => {
    const hud = emptyHud()
    foldEvent(hud, ev('spec-change-proposed', null, { epic_id: EPIC, base_version: 4, proposed_by: 'planner', finding_id: 'f', criterion_ref: 'AC1' }), 'web-ux-4-2026-10-04#368', SID)
    expect(hud.epics[EPIC]?.pendingSpecChanges).toEqual(['web-ux-4-2026-10-04#368'])
    foldEvent(hud, ev('spec-change-decided', null, { proposal_id: 'web-ux-4-2026-10-04#368', epic_id: EPIC, decision: 'approved', decided_by: 'operator', plan_version: 5 }), 'web-ux-4-2026-10-04#369', SID)
    expect(hud.epics[EPIC]?.pendingSpecChanges).toEqual([])
  })
})

describe('epic bookkeeping', () => {
  test('marks the epic mine, tracks waves, closes and caps activity', async () => {
    const events = [added(T16, {})]
    events.push(ev('user_prompt', null, { prompt: 'x' }, { session_id: 'web-ux-4-2026-10-04', cli_session_id: SID }))
    for (let i = 0; i < 40; i += 1) events.push(dispatch(T16, i % 2 ? 'tester' : 'grader'))
    events.push(ev('epic-closed', `${EPIC}/integration`, { epic_id: EPIC, closed_by: 'operator', machine_verdict: 'met', summary: 's' }, { session_id: 'web-ux-4-2026-10-04' }))
    const { epic, notices } = fold(events)
    expect(epic.isMine).toBe(true)
    expect(epic.waveMax).toBe(7)
    expect(epic.isClosed).toBe(true)
    expect(epic.activity).toHaveLength(30)
    expect(epic.lastTs).toBe(Date.parse(events.at(-1)?.ts as string))
    expect(notices).toContain('✔ epic web-ux-4 closed')
    expect(fold(events, 'other-session').epic.isMine).toBe(false)
  })
})

describe('summarize', () => {
  test('Now is the newest live worker; stale agents and escalation follow-ups drop out', async () => {
    const hud = emptyHud()
    const events: BsEvent[] = [
      added(T16), added(T17), added(T18),
      added('web-ux-4/followup-35bd1034', { origin: 'escalation' }),
      admitted([T16, T17]),
      ev('dispatch_decision', T18, { agent_role: 'coder', model: 'm' }, { ts: new Date(T0 - 4 * 3600_000).toISOString() }),
      ev('wave-merged', T17, { task_ids: [T17] }),
      ev('dispatch_decision', `${EPIC}/integration`, { agent_role: 'wave-runner' }, { ts: new Date(T0 + 60_000).toISOString() }),
      ev('dispatch_decision', T16, { agent_role: 'coder' }, { ts: new Date(T0 + 120_000).toISOString() }),
    ]
    events.forEach((e, i) => foldEvent(hud, e, `f#${i}`, SID))
    const s = summarize(epicIn(hud), T0 + 120_000 + 12 * 60_000)
    expect(s.wave).toBe(7)
    expect(s.now).toEqual({ role: 'coder', task: 'task-16', elapsed: '12m' })
    expect(s.agentCount).toBe(2)
    expect(s.roles).toEqual(['coder', 'wave-runner'])
    expect(s.staleCount).toBe(1)
    expect(s.counts).toEqual({ done: 1, review: 0, active: 2, todo: 0, superseded: 0, total: 3 })
    expect(s.progress).toBeGreaterThan(0.33)
    expect(s.budget).toEqual({ cap: 16_000_000, projected: 9_100_000, pct: 57 })
  })

  test('with no live agent and something waiting, Next is you', async () => {
    const hud = emptyHud()
    // in the epic session: an event of a wave session is a live wave-runner
    ;[added(T16), added(T17), admitted([T16, T17]), ev('gate-outcome', T16, { outcome: 'pass-with-waivers-pending' }, { session_id: 'web-ux-4-2026-10-04' })]
      .forEach((e, i) => foldEvent(hud, e, `f#${i}`, SID))
    const s = summarize(epicIn(hud), T0 + 3600_000)
    expect(s.now).toBeNull()
    expect(s.isWaitingOnYou).toBe(true)
    expect(s.waits).toEqual({ waivers: 1, escalations: 0, specs: 0 })
    expect(s.next).toBe('task-17')
  })

  test('open S1/S2 findings block the close but wait on the factory, not on you', async () => {
    const hud = emptyHud()
    ;[
      added(T16), admitted([T16]),
      ev('finding-raised', T16, { finding_id: 'f1', task_id: T16, epic_id: EPIC, severity: 'S2-major', finding_status: 'raised', summary: 's' }),
      ev('finding-raised', null, { finding_id: 'f2', epic_id: EPIC, severity: 'S2-major', finding_status: 'raised', summary: 's' }),
      ev('finding-transitioned', null, { finding_id: 'f2', from_status: 'raised', to_status: 'amend-pending' }),
      ev('finding-raised', null, { finding_id: 'f3', epic_id: EPIC, severity: 'S4-nit', finding_status: 'raised', summary: 's' }),
    ].forEach((e, i) => foldEvent(hud, e, `f#${i}`, SID))
    const s = summarize(epicIn(hud), T0 + 3600_000)
    expect(s.isWaitingOnYou).toBe(false)
    expect(s.blockers).toEqual({ total: 2, byStatus: { raised: 1, 'amend-pending': 1 } })
    expect(s.findings).toEqual({ S1: 0, S2: 2, S3: 0, S4: 1 })
  })

  test('a closed epic waits on nothing and blocks nothing, its maps kept', async () => {
    const hud = emptyHud()
    // in the epic session, so `before` has no live wave-runner and waits on you
    const inEpic = (e: BsEvent): BsEvent => ({ ...e, session_id: 'web-ux-4-2026-10-04' })
    const open: BsEvent[] = [
      added(T16), added(T17), admitted([T16, T17]),
      ev('gate-outcome', T16, { outcome: 'pass-with-waivers-pending' }),
      quorum(T17, 'escalate', { blocks: true, fingerprint: 'fq' }, 'f-q'),
      ev('spec-change-proposed', null, { epic_id: EPIC, base_version: 4, proposed_by: 'planner', finding_id: 'f', criterion_ref: 'AC1' }),
      ev('finding-raised', T17, { finding_id: 'f1', task_id: T17, epic_id: EPIC, severity: 'S1-stop-the-line', finding_status: 'raised', summary: 's' }),
    ].map(inEpic)
    open.forEach((e, i) => foldEvent(hud, e, `f#${i}`, SID))
    const before = summarize(epicIn(hud), T0 + 3600_000)
    expect(before.waits).toEqual({ waivers: 1, escalations: 1, specs: 1 })
    expect(before.blockers.total).toBe(1)
    expect(before.isWaitingOnYou).toBe(true)

    foldEvent(hud, ev('epic-closed', `${EPIC}/integration`, { epic_id: EPIC, closed_by: 'operator', machine_verdict: 'met', summary: 's' }), 'f#close', SID)
    const s = summarize(epicIn(hud), T0 + 3600_000)
    expect(s.isClosed).toBe(true)
    expect(s.waits).toEqual({ waivers: 0, escalations: 0, specs: 0 })
    expect(s.blockers).toEqual({ total: 0, byStatus: {} })
    expect(s.isWaitingOnYou).toBe(false)
    expect(epicIn(hud).pendingWaivers).toEqual([T16])
    expect(Object.keys(epicIn(hud).escalations)).toHaveLength(1)
    expect(epicIn(hud).pendingSpecChanges).toHaveLength(1)
    expect(Object.keys(epicIn(hud).openFindings)).toEqual(['f1'])
  })

  test('Next prefers an idle task of the admitted wave', async () => {
    const hud = emptyHud()
    ;[added(T16), added(T17), added(T18), admitted([T17, T18]), dispatch(T17, 'coder')]
      .forEach((e, i) => foldEvent(hud, e, `f#${i}`, SID))
    expect(summarize(epicIn(hud), T0 + 60_000).next).toBe('task-18')
  })
})

describe('amend-pending discharge', () => {
  const F = 'f-web-ux-4/integration-eb27c1c1'
  const merged = (id: string) => ev('wave-merged', id, { task_ids: [id], files_changed: ['src/x.ts'] })
  const amend = (ids: unknown, version?: number) => [
    ev('finding-raised', null, { finding_id: F, epic_id: EPIC, severity: 'S2-major', finding_status: 'raised', summary: 's' }),
    ev('finding-transitioned', null, {
      finding_id: F, fingerprint: 'eb27c1c1', from_status: 'raised', to_status: 'amend-pending', amends_task_ids: ids,
      ...(version === undefined ? {} : { amends_plan_version: version }),
    }),
  ]
  const plan = (version: number, extra: Record<string, unknown>) =>
    ev('plan-version-created', `${EPIC}/plan-v${version}`, { epic_id: EPIC, version, ...extra }, { session_id: 'web-ux-4-2026-10-04', actor: 'system' })
  // T16 landed at v2; `t17` is what became of T17
  const summary = (t17: BsEvent[], obligation = amend([T16, T17], 2)) => {
    const { epic } = fold([added(T16, { plan_version: 2 }), added(T17, { plan_version: 2 }), admitted([T16, T17]), merged(T16), ...t17, ...obligation])
    return { epic, s: summarize(epic, T0 + 3600_000) }
  }
  const BLOCKED = { total: 1, byStatus: { 'amend-pending': 1 } }
  const CLEAR = { total: 0, byStatus: {} }

  test('every amended task landed at or past the version: not a blocker, the finding kept', async () => {
    const { epic, s } = summary([added(T17, { plan_version: 3 }), merged(T17)])
    expect(s.blockers).toEqual(CLEAR)
    expect(s.amendsLanded).toBe(1)
    expect(s.findings.S2).toBe(0)
    expect(epic.openFindings[F]?.status).toBe('amend-pending')
  })

  test('a task landed below the version keeps it a blocker', async () => {
    const { s } = summary([added(T17, { plan_version: 1 }), merged(T17)])
    expect(s.blockers).toEqual(BLOCKED)
    expect(s.amendsLanded).toBe(0)
    expect(s.findings.S2).toBe(1)
  })

  test('a task still in progress keeps it a blocker', async () => {
    const { s } = summary([added(T17, { plan_version: 3 }), dispatch(T17, 'coder')])
    expect(s.blockers).toEqual(BLOCKED)
    expect(s.amendsLanded).toBe(0)
  })

  const superseded = [added(T17, { plan_version: 8, task_status: 'superseded' }), added(T17B, { plan_version: 8 }), merged(T17B)]
  const chains: [string, BsEvent[], typeof CLEAR | typeof BLOCKED][] = [
    ['the successors map', [plan(8, { successors: { [T17]: T17B }, diff: { superseded: [T17, T18], added: [T17B] } })], CLEAR],
    ['the legacy single-pair diff', [plan(8, { diff: { superseded: [T17], added: [T17B] } })], CLEAR],
    ['an empty successors map beats the diff', [plan(8, { successors: {}, diff: { superseded: [T17], added: [T17B] } })], BLOCKED],
    ['a null successors map beats the diff', [plan(8, { successors: null, diff: { superseded: [T17], added: [T17B] } })], BLOCKED],
    ['a multi-pair legacy diff', [plan(8, { diff: { superseded: [T17, T18], added: [T17B] } })], BLOCKED],
  ]
  for (const [name, plans, want] of chains) {
    test(`a superseded task resolves to its landed successor: ${name}`, async () => {
      expect(summary([...superseded, ...plans]).s.blockers).toEqual(want)
    })
  }

  test('a successor chain that cycles keeps the superseded row, a blocker', async () => {
    const cycle = [
      added(T17, { plan_version: 8, task_status: 'superseded' }), added(T17B, { plan_version: 8, task_status: 'superseded' }),
      plan(8, { successors: { [T17]: T17B, [T17B]: T17 } }),
    ]
    expect(summary(cycle).s.blockers).toEqual(BLOCKED)
  })

  test('a bare amended id matches the event-side id', async () => {
    const { s } = summary([added(T17, { plan_version: 2 }), merged(T17)], amend(['task-16-phone-toolbar-hits', 'task-17-remote-error-and-phone-header'], 2))
    expect(s.blockers).toEqual(CLEAR)
    expect(s.amendsLanded).toBe(1)
  })

  const malformed: [string, BsEvent[]][] = [
    ['no ids', amend([], 2)],
    ['an empty id', amend([T16, ''], 2)],
    ['a non-string id', amend([T16, null], 2)],
    ['no plan version', amend([T16, T17])],
  ]
  for (const [name, obligation] of malformed) {
    test(`an obligation with ${name} is never discharged`, async () => {
      const { s } = summary([added(T17, { plan_version: 3 }), merged(T17)], obligation)
      expect(s.blockers).toEqual(BLOCKED)
      expect(s.amendsLanded).toBe(0)
    })
  }

  test('a later transition without the obligation keeps it', async () => {
    const again = ev('finding-transitioned', null, { finding_id: F, from_status: 'amend-pending', to_status: 'amend-pending' })
    const { epic, s } = summary([added(T17, { plan_version: 3 }), merged(T17)], [...amend([T16, T17], 2), again])
    expect(epic.openFindings[F]).toEqual({ severity: 'S2-major', status: 'amend-pending', amendsTaskIds: [T16, T17], amendsPlanVersion: 2 })
    expect(s.amendsLanded).toBe(1)
  })

  test('a task-added re-emitted for a merged task keeps it completed and takes the new version', async () => {
    const { epic } = fold([added(T16, { plan_version: 2 }), merged(T16), added(T16, { plan_version: 5, task_status: 'todo' })])
    expect(epic.tasks[T16]).toMatchObject({ status: 'completed', planVersion: 5 })
  })

  test('a waived task is terminal, counts done and discharges an amendment', async () => {
    const { epic, s } = summary([added(T17, { plan_version: 2, task_status: 'blocked' }), added(T17, { plan_version: 3, task_status: 'waived' }), dispatch(T17, 'coder')])
    expect(epic.tasks[T17]?.status).toBe('waived')
    expect(s.counts).toMatchObject({ done: 2, active: 0 })
    expect(s.blockers).toEqual(CLEAR)
    expect(s.amendsLanded).toBe(1)
  })

  test('a merged task superseded later is superseded; the amendment waits on its successor', async () => {
    const replaced = [
      merged(T17),
      ev('task-superseded', T17, { epic_id: EPIC }, { actor: 'orchestrator' }),
      added(T17B, { plan_version: 3 }),
      plan(3, { successors: { [T17]: T17B } }),
      dispatch(T17B, 'coder'),
    ]
    const running = summary(replaced, amend([T17], 3))
    expect(running.epic.tasks[T17]?.status).toBe('superseded')
    expect(running.s.blockers).toEqual(BLOCKED)
    const landed = summary([...replaced, merged(T17B)], amend([T17], 3))
    expect(landed.s.blockers).toEqual(CLEAR)
    expect(landed.s.amendsLanded).toBe(1)
  })

  test('an escalated task the wave merges is completed, done, and discharges an amendment', async () => {
    const starved = [
      dispatch(T17, 'coder'),
      ev('error-logged', T17, { agent: 'a1', agent_role: 'coder', error: 'coordination.starvation', severity: 'S2-major', task_ref: T17, detail: 'd' }),
    ]
    expect(summary(starved).epic.tasks[T17]?.status).toBe('escalated')
    const { epic, s } = summary([...starved, merged(T17)])
    expect(epic.tasks[T17]?.status).toBe('completed')
    expect(s.counts).toMatchObject({ done: 2, active: 0 })
    expect(s.blockers).toEqual(CLEAR)
    expect(s.amendsLanded).toBe(1)
  })
})

describe('segments', () => {
  test('splits the bar by status, in order, summing to the width', async () => {
    expect(segments({ done: 1, review: 0, active: 1, todo: 1 }, 10)).toEqual({ done: 3, review: 0, active: 4, todo: 3 })
    expect(segments({ done: 12, review: 2, active: 1, todo: 3 }, 24)).toEqual({ done: 16, review: 3, active: 1, todo: 4 })
  })

  test('done takes the cells the plain bar fills', async () => {
    for (const c of [{ done: 5, review: 1, active: 3, todo: 9 }, { done: 1, review: 2, active: 0, todo: 0 }]) {
      const total = c.done + c.review + c.active + c.todo
      const cells = segments(c, 10)
      expect(cells.done).toBe(bar(c.done / total, 10).split('█').length - 1)
      expect(cells.done + cells.review + cells.active + cells.todo).toBe(10)
    }
  })

  test('an empty epic is all todo', async () => {
    expect(segments({ done: 0, review: 0, active: 0, todo: 0 }, 8)).toEqual({ done: 0, review: 0, active: 0, todo: 8 })
  })
})

test('pickEpic takes the pin, else the busiest epic of this session', async () => {
  const hud = emptyHud()
  ;[
    added(T16),
    ev('user_prompt', null, { prompt: 'x' }, { session_id: 'web-ux-4-2026-10-04', cli_session_id: SID }),
    ev('task-added', 'web-ux-3/task-1', { epic_id: 'web-ux-3', origin: 'user' }, { session_id: 'web-ux-3-2026-09-30' }),
    ev('session-start', null, {}, { session_id: 'maint-2026-10-07', cli_session_id: SID }),
  ].forEach((e, i) => foldEvent(hud, e, `f#${i}`, SID))
  expect(pickEpic(hud, null)?.epicId).toBe(EPIC)
  expect(pickEpic(hud, 'web-ux-3')?.epicId).toBe('web-ux-3')
  expect(pickEpic(hud, 'nope')).toBeNull()
  expect(pickEpic(emptyHud(), null)).toBeNull()
})

describe('watching', () => {
  const MIN = 60_000
  const DAY = 24 * 60 * MIN
  const log = (epic: string, mtimeMs: number, isNamed = true) => ({ epic, mtimeMs, isNamed })
  const UX3 = 'web-ux-3'

  test('the idle cutoff is the dashboard\'s seven days', async () => {
    expect(EPIC_IDLE_MS).toBe(7 * DAY)
  })

  test('newestRunning takes the epic whose newest log is newest', async () => {
    const logs = [log('a', T0 - 5 * MIN), log('b', T0 - 2 * MIN), log('a', T0 - 1 * MIN)]
    expect(newestRunning(logs, new Set(), T0)).toBe('a')
    expect(newestRunning([log('a', T0 - 9 * MIN), log('b', T0 - 2 * MIN)], new Set(), T0)).toBe('b')
    expect(newestRunning([], new Set(), T0)).toBeNull()
  })

  test('newestRunning skips an epic idle past the cutoff; exactly the cutoff still runs', async () => {
    expect(newestRunning([log('a', T0 - EPIC_IDLE_MS - 1)], new Set(), T0)).toBeNull()
    expect(newestRunning([log('a', T0 - EPIC_IDLE_MS)], new Set(), T0)).toBe('a')
    // an older file of a fresh epic does not make it idle
    expect(newestRunning([log('a', T0 - 30 * DAY), log('a', T0 - DAY)], new Set(), T0)).toBe('a')
  })

  test('newestRunning skips a closed epic for the next newest', async () => {
    expect(newestRunning([log('a', T0 - MIN), log('b', T0 - 5 * MIN)], new Set(['a']), T0)).toBe('b')
    expect(newestRunning([log('a', T0 - MIN)], new Set(['a']), T0)).toBeNull()
  })

  test('newestRunning skips an epic only a file name gives (a maint or lessons log)', async () => {
    expect(newestRunning([log('maint', T0 - MIN, false), log('a', T0 - 5 * MIN)], new Set(), T0)).toBe('a')
    // a wave file naming no epic still dates the epic its other files name
    expect(newestRunning([log('a', T0 - 9 * MIN), log('a', T0 - MIN, false), log('b', T0 - 5 * MIN)], new Set(), T0)).toBe('a')
  })

  /** web-ux-4 is this session's when `isOwn`; web-ux-3 is another session's; maint is this session's with no task */
  function hudOf(isOwn: boolean) {
    const hud = emptyHud()
    ;[
      added(T16),
      ...(isOwn ? [ev('user_prompt', null, { prompt: 'x' }, { session_id: 'web-ux-4-2026-10-04', cli_session_id: SID })] : []),
      ev('task-added', 'web-ux-3/task-1', { epic_id: UX3, origin: 'user' }, { session_id: 'web-ux-3-2026-09-30' }),
      ev('session-start', null, {}, { session_id: 'maint-2026-10-07', cli_session_id: SID }),
    ].forEach((e, i) => foldEvent(hud, e, `f#${i}`, SID))
    return hud
  }
  const view = (v: ReturnType<typeof pickView>) => (v ? `${v.kind} ${v.epic.epicId}` : null)

  test('pickView: the pin beats this session\'s own epic, which beats the watched one', async () => {
    const own = hudOf(true)
    expect(view(pickView(own, UX3, UX3))).toBe(`pinned ${UX3}`)
    expect(view(pickView(own, UX3, null))).toBe(`pinned ${UX3}`)
    expect(view(pickView(own, null, UX3))).toBe(`own ${EPIC}`)
    const none = hudOf(false)
    expect(view(pickView(none, null, UX3))).toBe(`watched ${UX3}`)
    expect(view(pickView(none, null, null))).toBeNull()
    // a pin whose epic has no log shows nothing, as pickEpic does
    expect(view(pickView(none, 'nope', UX3))).toBeNull()
  })

  test('pickView: an own epic with no task or admission does not beat the watched one', async () => {
    const hud = hudOf(false)
    expect(hud.epics.maint?.isMine).toBe(true)
    expect(view(pickView(hud, null, UX3))).toBe(`watched ${UX3}`)
    // nor is a watched epic with nothing to draw drawn
    expect(view(pickView(hud, null, 'maint'))).toBeNull()
  })
})

test('formatters', async () => {
  expect(fmtTok(9_100_000)).toBe('9.1M')
  expect(fmtTok(16_000_000)).toBe('16M')
  expect(fmtTok(300_000)).toBe('300k')
  expect(fmtTok(950)).toBe('950')
  expect(fmtElapsed(40_000)).toBe('40s')
  expect(fmtElapsed(12 * 60_000)).toBe('12m')
  expect(fmtElapsed(65 * 60_000)).toBe('1h05m')
  expect(bar(0.5, 10)).toBe('█████░░░░░')
  expect(bar(0, 4)).toBe('░░░░')
  expect(bar(2, 4)).toBe('████')
})

describe('prompt walk', () => {
  // refs as the fold mints them and as causal_parent spells them: `<session id>#<0-based line index>`
  const links = (rows: [string, string, string | null][]) => {
    const m = new Map<string, Link>(rows.map(([ref, type, parent]) => [ref, { type, parent }]))
    return (ref: string) => m.get(ref)
  }

  test('walks causal_parent to the nearest user_prompt, counting hops', async () => {
    const at = links([
      ['e#0', 'session-start', null],
      ['e#1', 'user_prompt', 'e#0'],
      ['e#2', 'user_prompt', 'e#1'],
      ['e#3', 'finding-transitioned', 'e#2'],
      ['e#4', 'wave-admitted', 'e#3'],
      ['e#5', 'wave-admitted', 'e#2'],
    ])
    // the nearest prompt wins, not the first of the session
    expect(walkToPrompt('e#4', at)).toEqual({ prompt: 'e#2', hops: 2, end: 'prompt' })
    expect(walkToPrompt('e#5', at)).toEqual({ prompt: 'e#2', hops: 1, end: 'prompt' })
  })

  test('a missing parent, a root, a cycle and the hop cap each end the walk with no prompt', async () => {
    const at = links([
      ['e#1', 'plan-version-created', 'gone#9'],
      ['e#2', 'task-added', 'e#1'],
      ['e#3', 'session-start', null],
      ['e#4', 'task-added', 'e#3'],
      ['c#0', 'edge-recorded', 'c#1'],
      ['c#1', 'edge-recorded', 'c#0'],
      ['c#2', 'task-added', 'c#0'],
    ])
    expect(walkToPrompt('e#2', at)).toEqual({ prompt: null, hops: 1, end: 'missing' })
    expect(walkToPrompt('e#4', at)).toEqual({ prompt: null, hops: 1, end: 'root' })
    expect(walkToPrompt('c#2', at)).toEqual({ prompt: null, hops: 2, end: 'cycle' })
    // an unknown start is a missing parent too
    expect(walkToPrompt('nope#0', at)).toEqual({ prompt: null, hops: 0, end: 'missing' })
    // a chain one longer than the cap stops; one at the cap still reaches its prompt
    const rows: [string, string, string | null][] = [['l#0', 'user_prompt', null]]
    for (let i = 1; i <= PROMPT_HOPS + 1; i++) rows.push([`l#${i}`, 'dispatch_decision', `l#${i - 1}`])
    const long = links(rows)
    expect(PROMPT_HOPS).toBe(50)
    expect(walkToPrompt(`l#${PROMPT_HOPS}`, long)).toEqual({ prompt: 'l#0', hops: PROMPT_HOPS, end: 'prompt' })
    expect(walkToPrompt(`l#${PROMPT_HOPS + 1}`, long)).toEqual({ prompt: null, hops: PROMPT_HOPS, end: 'cap' })
  })

  test('distinctPrompts keeps each prompt once, in first-seen order, and drops the misses', async () => {
    expect(distinctPrompts(['a#1', null, 'a#2', 'a#1', null, 'a#3', 'a#2'])).toEqual(['a#1', 'a#2', 'a#3'])
    expect(distinctPrompts([])).toEqual([])
  })
})

describe('prompts in the fold', () => {
  const ES = 'web-ux-4-2026-10-04'
  /** Folds a log the way register does: each event's ref is `<session_id>#<line index in its session's file>`. */
  function foldLog(events: BsEvent[]) {
    const hud = emptyHud()
    const lines = new Map<string, number>()
    for (const e of events) {
      const s = e.session_id ?? ''
      const n = lines.get(s) ?? 0
      lines.set(s, n + 1)
      foldEvent(hud, e, `${s}#${n}`, SID)
    }
    return { hud, epic: hud.epics[EPIC]! }
  }
  const prompt = (text: string, parent: string | null = null) =>
    ev('user_prompt', null, { prompt: text }, { session_id: ES, actor: 'user', cli_session_id: SID, causal_parent: parent })
  const cite = (e: BsEvent, parent: string | null) => ({ ...e, causal_parent: parent })

  test('a wave keeps the prompt its admission descends from, a task the prompts its task-added do', async () => {
    const long = `Group by tag now\n${'x'.repeat(300)}`
    const { hud, epic } = foldLog([
      prompt('"Open wave 7?"="Yes"\n'), // ES#0
      cite(ev('plan-version-created', null, { epic_id: EPIC, plan_version: 4 }, { session_id: ES, actor: 'planner' }), `${ES}#0`), // ES#1
      cite(added(T16), `${ES}#1`), // ES#2
      cite(added(T17), `${ES}#1`), // ES#3
      prompt(long, `${ES}#3`), // ES#4
      cite(ev('finding-transitioned', null, { epic_id: EPIC }, { session_id: ES, actor: 'orchestrator' }), `${ES}#4`), // ES#5
      cite(admitted([T16, T17]), `${ES}#5`), // ES#6
      cite(added(T18), 'gone-2026-10-01#3'), // ES#7: its parent is in no log the fold read
      cite(admitted([T18]), null), // ES#8
      prompt('never cited'), // ES#9
      cite(added(T16), `${ES}#9`), // ES#10: a re-emit asked for by a later prompt
    ])
    expect(epic.admissions!.map(a => ({ taskIds: a.taskIds, prompt: a.prompt }))).toEqual([
      { taskIds: [T16, T17], prompt: `${ES}#4` },
      { taskIds: [T18], prompt: null },
    ])
    expect(epic.admissions![0]!.ts).toBeGreaterThan(epic.prompts![`${ES}#4`]!.ts)
    expect(epic.taskPrompts).toEqual({ [T16]: [`${ES}#0`, `${ES}#9`], [T17]: [`${ES}#0`] })
    expect(Object.keys(epic.prompts!).sort()).toEqual([`${ES}#0`, `${ES}#4`, `${ES}#9`])
    // stored text is one line, at most PROMPT_CHARS long plus an ellipsis
    expect(epic.prompts![`${ES}#0`]!.text).toBe('"Open wave 7?"="Yes"')
    expect(PROMPT_CHARS).toBe(240)
    expect(epic.prompts![`${ES}#4`]!.text).toBe(`Group by tag now ${'x'.repeat(240 - 'Group by tag now '.length)}…`)
    expect(epic.prompts![`${ES}#4`]!.ts).toBeGreaterThan(epic.prompts![`${ES}#0`]!.ts)
    // the parent links stay out of what register persists
    const saved = JSON.stringify(hud)
    expect(saved.includes('finding-transitioned')).toBe(false)
    expect(saved.includes('x'.repeat(241))).toBe(false)
  })

  test('a prompt no work descends from is never kept', async () => {
    const { hud } = foldLog([prompt('just chatting'), added(T16)])
    expect(JSON.stringify(hud).includes('just chatting')).toBe(false)
  })

  test('a hud persisted before prompts were kept folds on', async () => {
    const { hud, epic } = foldLog([added(T16)])
    delete epic.prompts
    delete epic.admissions
    delete epic.taskPrompts
    const saved = JSON.parse(JSON.stringify(hud))
    foldEvent(saved, prompt('go'), `${ES}#5`, SID)
    foldEvent(saved, cite(admitted([T16]), `${ES}#5`), `${ES}#6`, SID)
    foldEvent(saved, cite(added(T17), `${ES}#5`), `${ES}#7`, SID)
    expect(saved.epics[EPIC].admissions.map((a: { prompt: string | null }) => a.prompt)).toEqual([`${ES}#5`])
    expect(saved.epics[EPIC].taskPrompts).toEqual({ [T17]: [`${ES}#5`] })
  })
})

describe('phase', () => {
  const ES = { session_id: 'web-ux-4-2026-10-04', actor: 'orchestrator' }
  const W8 = { session_id: 'web-ux-4-w8-2026-10-07' }
  const merged = (id: string, extra: Partial<BsEvent> = {}) => ev('wave-merged', id, { task_ids: [id] }, extra)
  const goalCheck = () => ev('goal-check-recorded', null, { epic_id: EPIC, uncovered_count: 0, plan_version: 4 }, ES)
  const planVersion = () => ev('plan-version-created', null, { epic_id: EPIC, plan_version: 5 }, ES)
  const at = (events: BsEvent[]) => phaseOf(fold(events).epic)

  test('planning, wave N, after wave N, closing, closed; N from the wave session that works the admission', async () => {
    const steps: BsEvent[] = [added(T16), added(T17)]
    expect(at(steps)).toEqual({ kind: 'planning', wave: null, label: 'planning' })
    // admitted, no wave session yet and none before: the admission count
    steps.push(admitted([T16]))
    expect(at(steps)).toEqual({ kind: 'wave', wave: 1, label: 'wave 1' })
    steps.push(dispatch(T16, 'coder'))
    expect(at(steps)).toEqual({ kind: 'wave', wave: 7, label: 'wave 7' })
    steps.push(merged(T16))
    expect(at(steps)).toEqual({ kind: 'after', wave: 7, label: 'after wave 7' })
    // the next admission before its session starts: the wave after the highest seen
    steps.push(admitted([T17]))
    expect(at(steps)).toEqual({ kind: 'wave', wave: 8, label: 'wave 8' })
    steps.push(ev('dispatch_decision', T17, { agent_role: 'coder' }, W8), merged(T17, W8))
    expect(at(steps)).toEqual({ kind: 'closing', wave: 8, label: 'closing' })
    steps.push(ev('epic-closed', null, { epic_id: EPIC }, ES))
    expect(at(steps)).toEqual({ kind: 'closed', wave: 8, label: 'closed' })
  })

  test('a wave that worked a re-admitted task before its admission does not name the new wave', async () => {
    const base = [added(T16), admitted([T16]), dispatch(T16, 'coder'), ev('error-logged', T16, { severity: 'S2-major', error: 'execution.test-failed' })]
    expect(at(base)).toEqual({ kind: 'wave', wave: 7, label: 'wave 7' })
    expect(at([...base, admitted([T16])])).toEqual({ kind: 'wave', wave: 8, label: 'wave 8' })
  })

  test('a goal check makes the epic closing over open work, until a later admission or plan version', async () => {
    const steps = [added(T16), added(T17), admitted([T16, T17]), dispatch(T16, 'coder'), goalCheck()]
    expect(at(steps)).toEqual({ kind: 'closing', wave: 7, label: 'closing' })
    expect(at([...steps, planVersion()])).toEqual({ kind: 'wave', wave: 7, label: 'wave 7' })
    expect(at([...steps, admitted([T17])])).toEqual({ kind: 'wave', wave: 8, label: 'wave 8' })
    // an escalation follow-up left open is no plan work: the epic is closing once the plan landed
    const followup = 'web-ux-4/followup-1'
    expect(at([added(T16), added(followup, { origin: 'escalation' }), admitted([T16]), dispatch(T16, 'coder'), merged(T16)]))
      .toEqual({ kind: 'closing', wave: 7, label: 'closing' })
  })

  test('a wave session that started after the admission names its wave before it works a task', async () => {
    const steps = [added(T16), added(T17), admitted([T16]), dispatch(T16, 'coder'), merged(T16), admitted([T17])]
    // web-ux-2 at 05:28: the w1 runner's session-start, no task yet
    expect(at([...steps, ev('session-start', null, {}, W8)])).toEqual({ kind: 'wave', wave: 8, label: 'wave 8' })
    // web-ux-4 w1r: a re-run session numbered like the wave before
    expect(at([...steps, ev('session-start', null, {}, { session_id: 'web-ux-4-w7r-2026-10-07' })])).toEqual({ kind: 'wave', wave: 7, label: 'wave 7' })
    // an older wave's land session after the admission is not the new wave
    expect(at([...steps, ev('session-start', null, {}, { session_id: 'web-ux-4-w4-2026-10-07-land' })])).toEqual({ kind: 'wave', wave: 8, label: 'wave 8' })
    // admissions kept before waveMaxAt: the wave after the highest seen, no crash
    const old = JSON.parse(JSON.stringify(fold([...steps, ev('session-start', null, {}, W8)]).epic))
    for (const a of old.admissions) delete a.waveMaxAt
    expect(phaseOf(old)).toEqual({ kind: 'wave', wave: 9, label: 'wave 9' })
  })

  test('a hud persisted before admissions and waves were kept reads its phase from the counts', async () => {
    const { hud } = fold([added(T16), added(T17), admitted([T16]), dispatch(T16, 'coder'), merged(T16)])
    const epic = epicIn(hud)
    delete epic.admissions
    delete (epic as Partial<typeof epic>).waves
    delete (epic as Partial<typeof epic>).taskWave
    const saved = JSON.parse(JSON.stringify(hud))
    expect(phaseOf(saved.epics[EPIC])).toEqual({ kind: 'after', wave: 7, label: 'after wave 7' })
    foldEvent(saved, goalCheck(), 'f#9', SID)
    expect(phaseOf(saved.epics[EPIC])).toEqual({ kind: 'closing', wave: 7, label: 'closing' })
  })

  test('a wave session with no admission: wave N while its tasks are open, N the summary\'s wave; then after wave N, closing', async () => {
    const W3 = { session_id: 'web-ux-4-w3-2026-10-05' }
    const steps: BsEvent[] = [
      ev('task-added', T16, { epic_id: EPIC, origin: 'user', task_status: 'todo', objective: `do ${T16}` }, W3),
      ev('dispatch_decision', T16, { agent_role: 'coder', model: 'opus' }, W3),
    ]
    const epic = fold(steps).epic
    expect(phaseOf(epic)).toEqual({ kind: 'wave', wave: 3, label: 'wave 3' })
    expect(summarize(epic, Date.parse(steps.at(-1)!.ts!)).wave).toBe(3)
    // a goal check and a close keep their precedence
    expect(at([...steps, goalCheck()])).toEqual({ kind: 'closing', wave: 3, label: 'closing' })
    expect(at([...steps, ev('epic-closed', null, { epic_id: EPIC }, ES)])).toEqual({ kind: 'closed', wave: 3, label: 'closed' })
    // the wave's task merged, other plan work open
    steps.push(added(T17), merged(T16, W3))
    expect(at(steps)).toEqual({ kind: 'after', wave: 3, label: 'after wave 3' })
    steps.push(merged(T17, ES))
    expect(at(steps)).toEqual({ kind: 'closing', wave: 3, label: 'closing' })
  })

  test('the status line\'s wave is the phase\'s: an admission whose wave session has not started yet', async () => {
    const steps = [added(T16), added(T17), admitted([T16]), dispatch(T16, 'coder'), merged(T16), admitted([T17])]
    const epic = fold(steps).epic
    expect(phaseOf(epic)).toEqual({ kind: 'wave', wave: 8, label: 'wave 8' })
    expect(summarize(epic, Date.parse(steps.at(-1)!.ts!)).wave).toBe(8)
  })

  test('no admission and no wave session: planning, whatever the epic session works', async () => {
    const steps = [added(T16), { ...dispatch(T16, 'coder'), ...ES }]
    const epic = fold(steps).epic
    expect(phaseOf(epic)).toEqual({ kind: 'planning', wave: null, label: 'planning' })
    expect(summarize(epic, Date.parse(steps.at(-1)!.ts!)).wave).toBe(0)
  })
})

describe('tier', () => {
  const tiered = (ids: string[], tier: unknown) => ev('wave-admitted', null, {
    epic_id: EPIC,
    task_ids: ids,
    budget: { status: 'ok', tier, cap_tokens: 52_000_000, projected_tokens: 31_140_000, wave_tokens: 1_270_000, headroom_tokens: 20_860_000 },
  }, { session_id: 'web-ux-4-2026-10-04', actor: 'system' })

  test('the newest admission naming a tier sets it; one naming none or an unknown one keeps it', async () => {
    const steps = [added(T16), added(T17), admitted([T16])]
    expect(tierOf(fold(steps).epic)).toEqual({ tier: null, source: null })
    steps.push(tiered([T16], 'huge'))
    expect(tierOf(fold(steps).epic)).toEqual({ tier: 'huge', source: 'admission' })
    // the admission's tier beats the plan's effort, which the security floor may have raised
    expect(tierOf(fold(steps).epic, 'small')).toEqual({ tier: 'huge', source: 'admission' })
    steps.push(admitted([T17]), tiered([T17], 'xl'))
    expect(tierOf(fold(steps).epic)).toEqual({ tier: 'huge', source: 'admission' })
    steps.push(tiered([T17], 'medium'))
    expect(tierOf(fold(steps).epic)).toEqual({ tier: 'medium', source: 'admission' })
  })

  test('without an admission tier the plan effort, else no tier; a hud persisted before tiers were kept folds on', async () => {
    const { hud } = fold([added(T16), admitted([T16])])
    const saved = JSON.parse(JSON.stringify(hud))
    expect(tierOf(saved.epics[EPIC], 'medium')).toEqual({ tier: 'medium', source: 'plan' })
    expect(tierOf(saved.epics[EPIC], null)).toEqual({ tier: null, source: null })
    expect(tierOf(saved.epics[EPIC])).toEqual({ tier: null, source: null })
    foldEvent(saved, tiered([T16], 'small'), 'f#9', SID)
    expect(tierOf(saved.epics[EPIC], 'medium')).toEqual({ tier: 'small', source: 'admission' })
  })

  test('planDirOf mirrors latestPlan: the work root of a state/events dir, then factory/specs/active/<epic>', async () => {
    expect(planDirOf('/home/me/blacksmith/state/events', EPIC))
      .toBe('/home/me/blacksmith/factory/specs/active/web-ux-4')
    expect(planDirOf('/w/kiosk/.blacksmith/state/events/', 'kiosk-lifecycle-1')).toBe('/w/kiosk/.blacksmith/factory/specs/active/kiosk-lifecycle-1')
    expect(planDirOf('/w/logs', EPIC)).toBeNull()
    expect(planDirOf('/w/proj/state/events', '../x')).toBeNull()
  })

  test('latestPlanName takes the highest plan-vN.json, numerically; planEffort a valid effort or null', async () => {
    expect(latestPlanName(['plan.json', 'plan-v9.json', 'plan-v10.json', 'plan-v2.json.bak', 'plan-v11.md', 'amend-v8', 'plan-vx.json'])).toBe('plan-v10.json')
    expect(latestPlanName(['plan.json'])).toBeNull()
    expect(latestPlanName([])).toBeNull()
    expect(planEffort('{"version":19,"effort":"huge","tasks":[]}')).toBe('huge')
    expect(planEffort('{"effort":"xl"}')).toBeNull()
    expect(planEffort('{"version":3}')).toBeNull()
    expect(planEffort('[]')).toBeNull()
    expect(planEffort('null')).toBeNull()
    expect(planEffort('{"effort":')).toBeNull()
  })

  test('planVersionOf: the highest plan version a task-added carried, 0 when none did', async () => {
    expect(planVersionOf(fold([added(T16), added(T17, { plan_version: 6 }), admitted([T16])]).epic)).toBe(6)
    expect(planVersionOf(fold([admitted([T16])]).epic)).toBe(0)
  })
})

describe('tab models', () => {
  const ES = { session_id: 'web-ux-4-2026-10-04', actor: 'orchestrator' }
  const W6 = { session_id: 'web-ux-4-w6-2026-10-06' }
  const T5 = 'web-ux-4/task-5-roadmap-lanes'
  const T6 = 'web-ux-4/task-6-activity-totals'
  const T19 = 'web-ux-4/task-19-sessions-tab-badge'
  const T20 = 'web-ux-4/task-20-kanban-pill'
  const T21 = 'web-ux-4/task-21-dropped-idea'
  const T22 = 'web-ux-4/task-22-escalation-followup'
  const say = (text: string) => ev('user_prompt', null, { prompt: text }, { session_id: ES.session_id, actor: 'user', cli_session_id: SID })
  /** cites the event at index `i` of the same list: `fold` refs event i as `f#i` */
  const cite = (e: BsEvent, i: number): BsEvent => ({ ...e, causal_parent: `f#${i}` })
  const lastTs = (events: BsEvent[]) => Date.parse(events.at(-1)?.ts as string)
  const merged = (id: string, extra: Partial<BsEvent> = {}) => ev('wave-merged', id, { task_ids: [id] }, extra)
  const superseded = (id: string, extra: Partial<BsEvent>) => ev('task-superseded', id, { epic_id: EPIC }, extra)
  const ids = (rows: { id: string }[]) => rows.map(r => r.id)
  const refs = (rows: { ref: string }[]) => rows.map(r => r.ref)

  // wave 6 ran T5 (merged) and T6 (superseded); wave 7 runs T16..T18; T19, T20 wait; T21 was dropped unadmitted
  const planned = () => [
    say('Cut wave 6: roadmap + activity'), // f#0
    cite(added(T5), 0), // f#1
    cite(added(T6), 0), // f#2
    say('Plan the phone fixes'), // f#3
    cite(added(T16), 3), // f#4
    cite(added(T17), 3), // f#5
    cite(added(T18, { title: 'task-18' }), 3), // f#6: a title that is the short id
    cite(added(T19), 0), // f#7
    cite(added(T20), 3), // f#8
    added(T21), // f#9
    added(T22, { origin: 'escalation' }), // f#10
  ]
  const afterWave6 = () => [
    ...planned(),
    say('"Open wave 6?"="Yes"'), // f#11
    cite(admitted([T5, T6]), 11), // f#12
    { ...dispatch(T5, 'coder'), ...W6 }, // f#13
    merged(T5, W6), // f#14
    superseded(T6, W6), // f#15
    superseded(T21, ES), // f#16
  ]
  const inWave7 = () => [
    ...afterWave6(),
    say('"Open wave 7?"="Yes, all three"'), // f#17
    cite(admitted([T16, T17, T18]), 17), // f#18
    dispatch(T16, 'coder'), // f#19, in the w7 session
    dispatch(T17, 'coder'), // f#20
    ev('gate-outcome', T17, { outcome: 'pass' }), // f#21: merging, its coder closed
    { ...dispatch(T22, 'coder'), ...ES }, // f#22: an escalation follow-up worked outside the wave
  ]

  test('capped returns the first `cap` rows and how many it left out', async () => {
    expect(capped([1, 2, 3, 4], 2)).toEqual({ rows: [1, 2], more: 2 })
    expect(capped([1, 2], 5)).toEqual({ rows: [1, 2], more: 0 })
    expect(capped([1, 2], 0)).toEqual({ rows: [], more: 2 })
    expect(capped([1, 2], Infinity)).toEqual({ rows: [1, 2], more: 0 })
  })

  test('overview: epic, phase, tier, the epic agents, the task cells and the budget with where spent comes from', async () => {
    const events = inWave7()
    const o = overviewModel(fold(events).epic, lastTs(events) + 60_000, 'medium')
    expect(o.epicId).toBe(EPIC)
    expect(o.phase).toEqual({ kind: 'wave', wave: 7, label: 'wave 7' })
    expect(o.tier).toEqual({ tier: 'medium', source: 'plan' })
    expect(o.agents).toEqual({ count: 3, roles: ['coder', 'coder', 'wave-runner'] })
    // T5 done; T17 merging; T16 in progress; T18, T19, T20 todo; T6, T21 superseded and T22 an escalation are out
    expect(o.tasks).toEqual({ done: 1, review: 1, active: 1, todo: 3, total: 6 })
    expect(o.budget).toEqual({ cap: 16_000_000, projected: 9_100_000, pct: 57, scope: 'epic', basis: 'projected' })
    expect(overviewModel(fold(planned()).epic, lastTs(planned()) + 60_000).budget).toBeNull()
  })

  test('current: the wave header, its open tasks by status with role and elapsed, its prompts newest first, its progress', async () => {
    const events = inWave7()
    const now = lastTs(events) + 60_000
    const c = currentModel(fold(events).epic, now)
    expect(c.header).toBe('wave 7')
    // the wave's open tasks plus an out-of-wave task an agent works, blocked first, then in progress, review, ready
    expect(c.tasks.rows).toEqual([
      { id: T16, short: 'task-16', title: `do ${T16}`, status: 'in-progress', role: 'coder', elapsed: fmtElapsed(now - Date.parse(events[19]!.ts!)) },
      { id: T22, short: 'task-22', title: `do ${T22}`, status: 'in-progress', role: 'coder', elapsed: fmtElapsed(now - Date.parse(events.at(-1)!.ts!)) },
      { id: T17, short: 'task-17', title: `do ${T17}`, status: 'merging', role: null, elapsed: null },
      // the task-H rule: a title that is the id is no title
      { id: T18, short: 'task-18', title: '', status: 'ready', role: null, elapsed: null },
    ])
    expect(c.tasks.more).toBe(0)
    // the admission's prompt and the wave tasks' prompts, each once, newest first
    expect(refs(c.prompts.rows)).toEqual(['f#17', 'f#3'])
    expect(c.prompts.rows[0]!.text).toBe('"Open wave 7?"="Yes, all three"')
    expect(c.prompts.rows[0]!.ts).toBe(Date.parse(events[17]!.ts!))
    expect(c.wave).toEqual({ number: 7, done: 0, review: 1, active: 1, todo: 1, total: 3 })
    // the escalation's coder is not on the wave; the w7 wave-runner is
    expect(c.agents).toEqual({ count: 2, roles: ['coder', 'wave-runner'] })
    expect(c.tokens).toEqual({ cap: 16_000_000, projected: 9_100_000, pct: 57, scope: 'epic', basis: 'projected' })

    const tight = currentModel(fold(events).epic, now, { rows: 1, prompts: 1 })
    expect(ids(tight.tasks.rows)).toEqual([T16])
    expect(tight.tasks.more).toBe(3)
    expect(refs(tight.prompts.rows)).toEqual(['f#17'])
    expect(tight.prompts.more).toBe(1)
  })

  test('current before any admission: the planning header, no wave', async () => {
    const c = currentModel(fold(planned()).epic, lastTs(planned()) + 60_000)
    expect(c.header).toBe('planning')
    expect(c.tasks).toEqual({ rows: [], more: 0 })
    expect(c.wave).toBeNull()
    expect(c.agents).toEqual({ count: 0, roles: [] })
  })

  test('next: todo plan tasks outside the current work in today\'s order, a header from the phase, their prompts', async () => {
    const at = (events: BsEvent[], caps?: { rows?: number; prompts?: number }) => nextModel(fold(events).epic, lastTs(events) + 60_000, caps)
    const before = at(planned())
    expect(before.header).toBe('planned')
    expect(ids(before.tasks.rows)).toEqual([T5, T6, T16, T17, T18, T19, T20, T21])
    expect(refs(before.prompts.rows)).toEqual(['f#3', 'f#0'])

    const between = at(afterWave6())
    expect(between.header).toBe('next wave')
    expect(ids(between.tasks.rows)).toEqual([T16, T17, T18, T19, T20])

    const during = at(inWave7())
    expect(during.header).toBe('after wave 7')
    // the wave's ready T18 is current work; the escalation T22 is not plan work
    expect(during.tasks.rows).toEqual([
      { id: T19, short: 'task-19', title: `do ${T19}`, status: 'todo', role: null, elapsed: null },
      { id: T20, short: 'task-20', title: `do ${T20}`, status: 'todo', role: null, elapsed: null },
    ])
    expect(refs(during.prompts.rows)).toEqual(['f#3', 'f#0'])
    expect(at(inWave7(), { rows: 1, prompts: 1 })).toMatchObject({ tasks: { more: 1 }, prompts: { rows: [{ ref: 'f#3' }], more: 1 } })
  })

  test('an open task admitted to an earlier wave shows in Current, failing first; one never admitted is Next', async () => {
    // wave 6 merged T5, left T6 blocked at its gate and never ran T19; wave 7 then took T16..T18
    const events = [
      ...planned(),
      say('"Open wave 6?"="Yes"'), // f#11
      cite(admitted([T5, T6, T19]), 11), // f#12
      { ...dispatch(T5, 'coder'), ...W6 }, // f#13
      merged(T5, W6), // f#14
      { ...ev('gate-outcome', T6, { outcome: 'blocked', reason: 'red' }), ...W6 }, // f#15
      superseded(T21, ES), // f#16
      say('"Open wave 7?"="Yes, all three"'), // f#17
      cite(admitted([T16, T17, T18]), 17), // f#18
    ]
    const epic = fold(events).epic
    const now = lastTs(events) + 60_000
    const current = currentModel(epic, now)
    const next = nextModel(epic, now)
    expect(ids(current.tasks.rows)).toEqual([T6, T16, T17, T18, T19])
    expect(current.tasks.rows[0]).toMatchObject({ id: T6, status: 'blocked' })
    // the wave-6 admission asked for T6 and T19, so its prompt is Current's too
    expect(refs(current.prompts.rows)).toEqual(['f#17', 'f#11', 'f#3', 'f#0'])
    expect(ids(next.tasks.rows)).toEqual([T20])
    // every open plan task sits in exactly one of the two lists
    const open = Object.entries(epic.tasks).filter(([, t]) => t.origin !== 'escalation' && !['completed', 'waived', 'superseded'].includes(t.status)).map(([id]) => id)
    const listed = [...ids(current.tasks.rows), ...ids(next.tasks.rows)]
    expect([...listed].sort()).toEqual([...open].sort())
  })

  test('a never-admitted open task is Next whatever its status: a stale dispatch, a blocked gate', async () => {
    const events = [
      ...planned(),
      { ...dispatch(T19, 'coder'), ...ES }, // f#11: in progress, its coder silent past STALE_MS by `now`
      { ...ev('gate-outcome', T20, { outcome: 'blocked', reason: 'red' }), ...ES }, // f#12
    ]
    const epic = fold(events).epic
    const now = lastTs(events) + 4 * 60 * 60_000
    expect(epic.tasks[T19]!.status).toBe('in-progress')
    expect(epic.tasks[T20]!.status).toBe('blocked')
    expect(ids(currentModel(epic, now).tasks.rows)).toEqual([])
    expect(ids(nextModel(epic, now).tasks.rows)).toEqual([T5, T6, T16, T17, T18, T19, T20, T21])
  })

  test('past: done and superseded work grouped by the wave that touched it last, newest wave first, each with its prompts', async () => {
    const events = [...inWave7(), merged(T17)]
    const p = pastModel(fold(events).epic, lastTs(events) + 60_000)
    expect(p.more).toBe(0)
    expect(p.rows.map(g => ({ wave: g.wave, label: g.label, tasks: ids(g.tasks.rows), prompts: refs(g.prompts.rows) }))).toEqual([
      { wave: 7, label: 'wave 7', tasks: [T17], prompts: ['f#17', 'f#3'] },
      // completed before superseded, as the pane sorts
      { wave: 6, label: 'wave 6', tasks: [T5, T6], prompts: ['f#11', 'f#0'] },
      // superseded before any wave took it
      { wave: null, label: 'no wave', tasks: [T21], prompts: [] },
    ])
    expect(p.rows[1]!.tasks.rows[1]).toEqual({ id: T6, short: 'task-6', title: `do ${T6}`, status: 'superseded', role: null, elapsed: null })
    const tight = pastModel(fold(events).epic, lastTs(events) + 60_000, { groups: 1, rows: 0, prompts: 1 })
    expect(tight.more).toBe(2)
    expect(tight.rows[0]!.tasks).toEqual({ rows: [], more: 1 })
    expect(tight.rows[0]!.prompts.more).toBe(1)
  })

  test('past with waves run inline (no wave session): numbered by admission', async () => {
    const events = [
      added(T5), added(T6),
      { ...admitted([T5]), ...ES }, merged(T5, ES),
      { ...admitted([T6]), ...ES }, merged(T6, ES),
    ]
    const p = pastModel(fold(events).epic, lastTs(events) + 60_000)
    expect(p.rows.map(g => [g.label, ids(g.tasks.rows)])).toEqual([['wave 2', [T6]], ['wave 1', [T5]]])
  })

  test('past: a re-plan prompt dated after the wave merged stays out of its group, one dated before stays in', async () => {
    const events = [
      ...afterWave6().slice(0, 13), // f#0..f#12: the plan, the wave-6 prompt and admission
      say('Re-plan v5: lanes keep their order'), // f#13
      cite(added(T5), 13), // f#14: re-added before the merge
      { ...dispatch(T5, 'coder'), ...W6 }, // f#15
      merged(T5, W6), // f#16: wave 6 merged
      superseded(T6, W6), // f#17
      say('Re-plan v19: phone fixes'), // f#18
      cite(added(T5), 18), // f#19: re-added after the merge, a terminal status stands
      cite(added(T6), 18), // f#20
    ]
    const p = pastModel(fold(events).epic, lastTs(events) + 60_000)
    const six = p.rows.find(g => g.wave === 6)!
    expect(ids(six.tasks.rows)).toEqual([T5, T6])
    expect(refs(six.prompts.rows)).toEqual(['f#13', 'f#11', 'f#0'])
  })

  test('past: an admission prompt dated after the wave merged stays out of its group', async () => {
    const events = [
      ...afterWave6(), // f#0..f#16: wave 6 merged T5 at f#14
      say('"Open wave 7?"="Yes, and re-run task-5"'), // f#17
      cite(admitted([T5, T16]), 17), // f#18: a merged task stays completed
    ]
    const epic = fold(events).epic
    expect(epic.tasks[T5]!.status).toBe('completed')
    const six = pastModel(epic, lastTs(events) + 60_000).rows.find(g => g.wave === 6)!
    expect(ids(six.tasks.rows)).toEqual([T5, T6])
    expect(refs(six.prompts.rows)).toEqual(['f#11', 'f#0'])
  })

  test('past: a group no wave-merged closed ends when its last task landed or was superseded', async () => {
    // waves run inline: the epic session admits and merges, no wave session exists
    const events = [
      say('Plan roadmap + activity'), // f#0
      cite(added(T5), 0), // f#1
      cite(added(T6), 0), // f#2
      say('"Open wave 1?"="Yes"'), // f#3
      cite({ ...admitted([T5, T6]), ...ES }, 3), // f#4
      merged(T5, ES), // f#5: T5 landed
      say('Re-plan v6: drop task-6'), // f#6
      cite(added(T5), 6), // f#7
      superseded(T6, ES), // f#8: the group's last task out, its cutoff
      say('Re-plan v9'), // f#9
      cite(added(T5), 9), // f#10
      cite(added(T6), 9), // f#11
      superseded(T21, ES), // f#12: no wave took it
      say('Re-plan v10'), // f#13
      cite(added(T21), 13), // f#14
    ]
    const p = pastModel(fold(events).epic, lastTs(events) + 60_000)
    expect(p.rows.map(g => ({ label: g.label, tasks: ids(g.tasks.rows), prompts: refs(g.prompts.rows) }))).toEqual([
      { label: 'wave 1', tasks: [T5, T6], prompts: ['f#6', 'f#3', 'f#0'] },
      { label: 'no wave', tasks: [T21], prompts: [] },
    ])
  })

  test('past from a hud persisted before merge times were kept: every prompt stays, as before', async () => {
    const events = [
      ...afterWave6(),
      say('Re-plan v19'), // f#17
      cite(added(T5), 17), // f#18
    ]
    const saved = JSON.parse(JSON.stringify(fold(events).hud))
    const epic = saved.epics[EPIC]
    delete epic.doneAt
    for (const w of Object.values(epic.waves) as { merged?: number }[]) delete w.merged
    const six = pastModel(epic, lastTs(events) + 60_000).rows.find(g => g.wave === 6)!
    expect(refs(six.prompts.rows)).toEqual(['f#17', 'f#11', 'f#0'])
  })

  test('current with a wave session and no admission: the wave\'s cells are the tasks its session worked', async () => {
    const W3 = { session_id: 'web-ux-4-w3-2026-10-05' }
    const events = [
      ev('task-added', T16, { epic_id: EPIC, origin: 'user', task_status: 'todo', objective: `do ${T16}` }, W3),
      ev('dispatch_decision', T16, { agent_role: 'coder', model: 'opus' }, W3),
      added(T17),
    ]
    const c = currentModel(fold(events).epic, lastTs(events) + 60_000)
    expect(c.header).toBe('wave 3')
    expect(c.wave).toEqual({ number: 3, done: 0, review: 0, active: 1, todo: 0, total: 1 })
  })

  test('the models read a hud persisted before prompts, then before waves, were kept', async () => {
    const events = inWave7()
    const now = lastTs(events) + 60_000
    const saved = JSON.parse(JSON.stringify(fold(events).hud))
    const epic = saved.epics[EPIC]
    for (const k of ['prompts', 'admissions', 'taskPrompts', 'isClosing', 'admittedTier']) delete epic[k]
    expect(currentModel(epic, now).header).toBe('wave 7')
    expect(currentModel(epic, now).prompts).toEqual({ rows: [], more: 0 })
    expect(ids(currentModel(epic, now).tasks.rows)).toEqual([T16, T22, T17, T18])
    expect(nextModel(epic, now).prompts).toEqual({ rows: [], more: 0 })
    expect(pastModel(epic, now).rows.map(g => [g.label, g.prompts.rows.length])).toEqual([['wave 6', 0], ['no wave', 0]])
    expect(overviewModel(epic, now).tasks.total).toBe(6)
    delete epic.waves
    delete epic.taskWave
    expect(pastModel(epic, now).rows.map(g => g.label)).toEqual(['no wave'])
    expect(ids(currentModel(epic, now).tasks.rows)).toEqual([T16, T22, T17, T18])
    expect(currentModel(epic, now).agents.roles).toEqual(['coder'])
  })

  test('activeSessionAgents keeps the agents mid-task: pending, running, waiting', async () => {
    const statuses: AgentStatus[] = ['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'killed']
    const list: AgentInfo[] = statuses.map(status => ({ id: `a-${status}`, description: status, type: 'general-purpose', status }))
    expect(activeSessionAgents(list).map(a => a.id)).toEqual(['a-pending', 'a-running', 'a-waiting'])
    expect(activeSessionAgents([])).toEqual([])
  })
})

describe('palette', () => {
  const mocha = {
    active: '#94e2d5', success: '#a6e3a1', error: '#f38ba8', warning: '#f9e2af', permission: '#89b4fa', planMode: '#cba6f7',
    remember: '#b4befe', claude: '#fab387', ide: '#89dceb', merged: '#f5c2e7', autoAccept: '#f2cdcd', suggestion: '#74c7ec', label: '#a6adc8',
  }
  const latte = {
    active: '#179299', success: '#40a02b', error: '#d20f39', warning: '#df8e1d', permission: '#1e66f5', planMode: '#8839ef',
    remember: '#7287fd', claude: '#fe640b', ide: '#04a5e5', merged: '#ea76cb', autoAccept: '#dd7878', suggestion: '#209fb5', label: '#6c6f85',
  }
  // today's colours: each role is the theme key it stood for, and active is the teal constant
  const keys = {
    active: '#14b8a6', success: 'success', error: 'error', warning: 'warning', permission: 'permission', planMode: 'planMode',
    remember: 'remember', claude: 'claude', ide: 'ide', merged: 'merged', autoAccept: 'autoAccept', suggestion: 'suggestion', label: 'inactive',
  }

  test('the three palettes carry Catppuccin Mocha, Latte and the theme keys', async () => {
    expect(MOCHA).toEqual(mocha)
    expect(LATTE).toEqual(latte)
    expect(THEME_KEYS).toEqual(keys)
  })

  test('a dark theme picks Mocha, a light one Latte, dark-ansi and light-ansi included', async () => {
    expect(paletteOf('dark')).toEqual(mocha)
    expect(paletteOf('dark-ansi')).toEqual(mocha)
    expect(paletteOf('light')).toEqual(latte)
    expect(paletteOf('light-ansi')).toEqual(latte)
  })

  test('a daltonized, auto, unknown or absent theme keeps the theme keys', async () => {
    for (const theme of ['dark-daltonized', 'light-daltonized', 'auto', 'solarized', '', null, undefined]) {
      expect(paletteOf(theme)).toEqual(keys)
    }
  })
})
