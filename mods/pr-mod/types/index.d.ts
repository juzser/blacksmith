// The pr-mod contract: what the mod keeps in `$.state`, and the shapes its
// pure module (hooks/prs.ts) hands the drawing.

/** One entry of `statusCheckRollup`, flattened: a CheckRun carries status/conclusion, a StatusContext state. */
export type Check = {
  type: 'CheckRun' | 'StatusContext'
  name: string
  /** CheckRun: QUEUED, IN_PROGRESS, COMPLETED, ...; '' for a StatusContext */
  status: string
  /** CheckRun once COMPLETED: SUCCESS, FAILURE, ...; '' otherwise */
  conclusion: string
  /** StatusContext: SUCCESS, FAILURE, ERROR, PENDING, EXPECTED; '' for a CheckRun */
  state: string
  /** detailsUrl or targetUrl */
  url: string
}

/** An open pull request as `gh pr list --json ...` answers it, normalized. */
export type Pr = {
  number: number
  title: string
  headRefName: string
  baseRefName: string
  isDraft: boolean
  /** the author's login */
  author: string
  mergeable: string
  mergeStateStatus: string
  /** the last mergeStateStatus that was not UNKNOWN, kept across polls so a recompute does not read as a change */
  lastKnownState: string
  reviewDecision: string
  checks: Check[]
  url: string
  updatedAt: string
  headRefOid: string
}

export type MergeMethod = 'squash' | 'merge' | 'rebase'

/** The last good `gh pr list`, when it was read, and why the latest read failed (null: it did not). */
export type PrCache = { cwd: string; prs: Pr[]; fetchedAt: number | null; error: string | null }

/** `gh repo view`, read once per session and cwd; method null when the repo allows none. */
export type RepoInfo = { cwd: string; nameWithOwner: string; method: MergeMethod | null }

/** A Merge button pressed once: the second press within `until` merges. */
export type Armed = { number: number; until: number; oid: string }

/** A fix prompt sent for a PR: held until its head moves or 15 minutes pass. */
export type FixHold = { at: number; oid: string; kind: 'conflict' | 'ci' }

declare module 'claude-code' {
  interface PluginState {
    'pr-mod': {
      cache: PrCache
      repo: RepoInfo | null
      /** URLs of the PRs this session's `gh pr create` printed */
      mine: string[]
      armed: Armed | null
      /** per PR number */
      fixSent: Record<string, FixHold>
      /** per PR number: what runs on it now (merging, updating) */
      busy: Record<string, string>
      /** the `/config` theme, read at session start and on each theme write; null when unread, so the theme keys draw (hooks/palette.ts) */
      theme: string | null
    }
  }
}
