// The PR model: what `gh` answers, read into plain values the band, the pane and the toasts draw from.
// No `$` here: every function is pure, so the tests drive it with plain JSON.
import type { Check, FixHold, MergeMethod, Pr, RepoInfo } from '../types'

export type CheckClass = 'ok' | 'bad' | 'pending'
export type RollupKind = 'green' | 'red' | 'pending' | 'none'
export type Rollup = { kind: RollupKind; failing: Check[] }
export type Counts = { open: number; green: number; red: number; conflict: number; pending: number }
export type Tone = 'success' | 'error' | 'warning' | 'pending' | 'dim'
export type Part = { text: string; tone: Tone }

const PR_FIELDS = [
  'number', 'title', 'headRefName', 'baseRefName', 'isDraft', 'author', 'mergeable', 'mergeStateStatus',
  'reviewDecision', 'statusCheckRollup', 'url', 'updatedAt', 'headRefOid',
].join(',')

export const PR_LIST_ARGV: readonly string[] = ['gh', 'pr', 'list', '--state', 'open', '--json', PR_FIELDS, '--limit', '50']
export const REPO_VIEW_ARGV: readonly string[] = ['gh', 'repo', 'view', '--json', 'nameWithOwner,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed']
/** How long a sent fix holds its button, unless the PR's head moves first. */
export const FIX_HOLD_MS = 15 * 60_000

type Json = Record<string, unknown>

function obj(v: unknown): Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {}
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function checkOf(v: unknown): Check {
  const c = obj(v)
  if (c.__typename === 'StatusContext') {
    return { type: 'StatusContext', name: str(c.context) || str(c.name), status: '', conclusion: '', state: str(c.state), url: str(c.targetUrl) }
  }
  return {
    type: 'CheckRun',
    name: str(c.name) || str(c.context),
    status: str(c.status),
    conclusion: str(c.conclusion),
    state: '',
    url: str(c.detailsUrl) || str(c.targetUrl),
  }
}

/**
 * `gh pr list --json` into Prs. An UNKNOWN merge state (GitHub still computing) keeps the state the
 * previous poll knew, so a recompute does not read as a change. Throws on anything but a JSON array.
 */
export function parsePrs(stdout: string, prev: readonly Pr[] = []): Pr[] {
  const data: unknown = JSON.parse(stdout)
  if (!Array.isArray(data)) throw new Error('gh pr list did not answer a JSON array')
  return data.map((item): Pr => {
    const p = obj(item)
    const number = typeof p.number === 'number' ? p.number : Number(p.number) || 0
    const state = str(p.mergeStateStatus)
    const rollupRaw: unknown = p.statusCheckRollup
    const lastKnownState = state && state !== 'UNKNOWN' ? state : (prev.find(x => x.number === number)?.lastKnownState ?? '')
    return {
      number,
      title: str(p.title),
      headRefName: str(p.headRefName),
      baseRefName: str(p.baseRefName),
      isDraft: p.isDraft === true,
      author: str(obj(p.author).login),
      mergeable: str(p.mergeable),
      mergeStateStatus: state,
      lastKnownState,
      reviewDecision: str(p.reviewDecision),
      checks: Array.isArray(rollupRaw) ? rollupRaw.map(checkOf) : [],
      url: str(p.url),
      updatedAt: str(p.updatedAt),
      headRefOid: str(p.headRefOid),
    }
  })
}

/** squash, else merge, else rebase; null when the repo allows none. */
export function mergeMethod(allowed: { squash: boolean; merge: boolean; rebase: boolean }): MergeMethod | null {
  if (allowed.squash) return 'squash'
  if (allowed.merge) return 'merge'
  if (allowed.rebase) return 'rebase'
  return null
}

export function parseRepo(stdout: string, cwd: string): RepoInfo {
  const data: unknown = JSON.parse(stdout)
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('gh repo view did not answer a JSON object')
  const r = data as Json
  return {
    cwd,
    nameWithOwner: str(r.nameWithOwner),
    method: mergeMethod({ squash: r.squashMergeAllowed === true, merge: r.mergeCommitAllowed === true, rebase: r.rebaseMergeAllowed === true }),
  }
}

const RUN_OK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const RUN_BAD = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

/** A StatusContext reads its state; a CheckRun its status, then its conclusion. */
export function checkClass(c: Check): CheckClass {
  if (c.type === 'StatusContext') {
    if (c.state === 'SUCCESS') return 'ok'
    if (c.state === 'FAILURE' || c.state === 'ERROR') return 'bad'
    return 'pending'
  }
  if (c.status !== 'COMPLETED') return 'pending'
  if (RUN_OK.has(c.conclusion)) return 'ok'
  if (RUN_BAD.has(c.conclusion)) return 'bad'
  return 'pending'
}

/** red if any check failed, else pending if any runs, else green; none without checks. */
export function rollup(checks: readonly Check[]): Rollup {
  if (checks.length === 0) return { kind: 'none', failing: [] }
  const classes = checks.map(checkClass)
  const failing = checks.filter((_, i) => classes[i] === 'bad')
  if (failing.length > 0) return { kind: 'red', failing }
  if (classes.includes('pending')) return { kind: 'pending', failing: [] }
  return { kind: 'green', failing: [] }
}

export function isConflict(pr: Pr): boolean {
  return pr.mergeStateStatus === 'DIRTY' || pr.mergeable === 'CONFLICTING'
}

function blocker(pr: Pr): string {
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return 'review required'
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes requested'
  const kind = rollup(pr.checks).kind
  if (kind === 'red') return 'failing checks'
  if (kind === 'pending') return 'pending checks'
  return 'branch rules'
}

/** Why Merge is not offered, or null when it is: CI green, state CLEAN, not a draft. */
export function mergeBlock(pr: Pr): string | null {
  if (pr.isDraft || pr.mergeStateStatus === 'DRAFT') return 'draft'
  const kind = rollup(pr.checks).kind
  if (kind === 'red') return 'CI red'
  if (kind === 'pending') return 'CI pending'
  if (kind === 'none') return 'no checks'
  switch (pr.mergeStateStatus) {
    case 'CLEAN': return null
    case 'DIRTY': return 'conflict'
    case 'BEHIND': return `behind ${pr.baseRefName}`
    case 'BLOCKED': return `blocked: ${blocker(pr)}`
    case 'UNSTABLE': return 'unstable'
    case 'UNKNOWN': return 'computing'
    default: return pr.mergeStateStatus.toLowerCase() || 'computing'
  }
}

export function canMerge(pr: Pr): boolean {
  return mergeBlock(pr) === null
}

export function ciPart(pr: Pr): Part {
  const r = rollup(pr.checks)
  if (r.kind === 'green') return { text: '✔ green', tone: 'success' }
  if (r.kind === 'red') return { text: `✖ CI red (${r.failing.length})`, tone: 'error' }
  if (r.kind === 'pending') return { text: '◌ pending', tone: 'pending' }
  return { text: 'no checks', tone: 'dim' }
}

/** The merge state as a mark; null where the CI part already says it. */
export function statePart(pr: Pr): Part | null {
  const s = pr.mergeStateStatus
  if (s === 'DRAFT' || (pr.isDraft && s === 'CLEAN')) return { text: 'draft', tone: 'dim' }
  switch (s) {
    case 'CLEAN': return { text: '⚑ CLEAN', tone: 'success' }
    case 'DIRTY': return { text: '⚠ conflict', tone: 'warning' }
    case 'BEHIND': return { text: `↓ behind ${pr.baseRefName}`, tone: 'warning' }
    case 'BLOCKED': return { text: `⊘ blocked: ${blocker(pr)}`, tone: 'warning' }
    case 'UNSTABLE': return rollup(pr.checks).kind === 'red' ? null : { text: '⚠ unstable', tone: 'warning' }
    case 'UNKNOWN': return { text: '… computing', tone: 'dim' }
    case '': return null
    default: return { text: s.toLowerCase(), tone: 'dim' }
  }
}

export function isMine(pr: Pr, mine: readonly string[]): boolean {
  return mine.includes(pr.url)
}

/** This session's PRs first, then the most recently updated. */
export function sortPrs(prs: readonly Pr[], mine: readonly string[]): Pr[] {
  const t = (p: Pr) => Date.parse(p.updatedAt) || 0
  return [...prs].sort(
    (a, b) => Number(isMine(b, mine)) - Number(isMine(a, mine)) || t(b) - t(a) || b.number - a.number,
  )
}

export function bandCounts(prs: readonly Pr[]): Counts {
  const out: Counts = { open: prs.length, green: 0, red: 0, conflict: 0, pending: 0 }
  for (const pr of prs) {
    const kind = rollup(pr.checks).kind
    if (kind === 'green') out.green++
    else if (kind === 'red') out.red++
    else if (kind === 'pending') out.pending++
    if (isConflict(pr)) out.conflict++
  }
  return out
}

/** A one-line, quoted copy of text from GitHub: a title cannot open a line of its own in a prompt. */
function quoted(text: string): string {
  return JSON.stringify(text.replace(/\s+/g, ' ').trim())
}

function prHeader(lead: string, pr: Pr): string[] {
  return [
    `${lead} pull request #${pr.number} ${quoted(pr.title)}.`,
    `URL: ${pr.url}`,
    `Head branch: ${pr.headRefName}`,
    `Base branch: ${pr.baseRefName}`,
  ]
}

export function fixConflictPrompt(pr: Pr): string {
  return [
    ...prHeader('Fix the merge conflict on', pr),
    '',
    'Steps:',
    `1. If ${pr.headRefName} is not checked out here, work in a separate git worktree rather than switching this checkout's branch.`,
    `2. Fetch, then merge origin/${pr.baseRefName} into ${pr.headRefName}. Do not rebase and do not force-push.`,
    "3. Resolve each conflict keeping both sides' intent.",
    "4. Run the project's checks and commit.",
    '5. Push.',
    '6. Report what conflicted and how it was resolved.',
    '',
    'Do not merge the PR.',
  ].join('\n')
}

function runId(url: string): string | null {
  return /\/actions\/runs\/(\d+)/.exec(url)?.[1] ?? null
}

export function fixCiPrompt(pr: Pr): string {
  const failing = rollup(pr.checks).failing.map(c => {
    const id = runId(c.url)
    return `- ${quoted(c.name)}${id ? ` (run ${id})` : ''}: ${c.url}`
  })
  return [
    ...prHeader('Fix the failing CI on', pr),
    '',
    'Failing checks:',
    ...failing,
    '',
    'Steps:',
    `1. Read the failure with \`gh pr checks ${pr.number}\` and \`gh run view <run-id> --log-failed\`.`,
    '2. Reproduce it locally.',
    `3. Fix it in ${pr.headRefName}. If that branch is not checked out here, work in a separate git worktree rather than switching this checkout's branch.`,
    "4. Run the project's checks, then push.",
    '5. Report the root cause.',
    '',
    'Do not merge the PR.',
  ].join('\n')
}

function conflicting(pr: Pr): boolean {
  return pr.lastKnownState === 'DIRTY' || pr.mergeable === 'CONFLICTING'
}
function known(pr: Pr): boolean {
  return pr.lastKnownState !== '' || pr.mergeable === 'MERGEABLE' || pr.mergeable === 'CONFLICTING'
}
function titleOf(pr: Pr): string {
  return pr.title.replace(/\s+/g, ' ').trim()
}

/**
 * What changed between two polls, as toast lines: CI went red (any PR), CI went green (mine),
 * turned conflicting (any PR), left the list (mine, unless this session merged it). A PR new to the
 * list toasts nothing.
 */
export function toastsBetween(prev: readonly Pr[], next: readonly Pr[], mine: readonly string[], mergedHere: readonly number[]): string[] {
  const out: string[] = []
  for (const now of next) {
    const was = prev.find(p => p.number === now.number)
    if (!was) continue
    const before = rollup(was.checks).kind
    const after = rollup(now.checks).kind
    if (after === 'red' && before !== 'red') out.push(`#${now.number} CI went red: ${titleOf(now)}`)
    if (after === 'green' && before !== 'green' && isMine(now, mine)) out.push(`#${now.number} CI is green: ${titleOf(now)}`)
    if (conflicting(now) && !conflicting(was) && known(was)) out.push(`#${now.number} has a conflict with ${now.baseRefName}: ${titleOf(now)}`)
  }
  for (const was of prev) {
    if (next.some(p => p.number === was.number)) continue
    if (!isMine(was, mine) || mergedHere.includes(was.number)) continue
    out.push(`#${was.number} left the open list (merged or closed): ${titleOf(was)}`)
  }
  return out
}

export function isHeld(hold: FixHold | undefined, pr: Pr | undefined, now: number): boolean {
  if (!hold || !pr) return false
  return hold.oid === pr.headRefOid && now < hold.at + FIX_HOLD_MS
}

export function prUrlsIn(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s"'<>]+\/pull\/\d+/g) ?? [])]
}

export function firstLine(text: string): string {
  return text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
}

export function ago(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
