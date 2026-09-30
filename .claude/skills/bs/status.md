# `/bs status` — live agent count, budget burn, epic phase

Two questions, in this order: **was anything watching while no session was
open**, and **what does the log say now**. Step 2 alone has always answered
the second; it cannot answer the first, because a session that folds the log
on demand knows only what is in the log, never whether anyone was reading it.

## 1. Ask the watcher

`bs daemon status [--dir <dir>]`. It prints JSON and **exits 1 whenever a
current daemon is not watching** — that is the health check doing its job,
not a command that failed, so never report the non-zero exit as an error.
Four readings:

- `running: false` — nothing holds the lock. A fine steady state if the
  operator never started one (`bs daemon start` if they want one): say so
  in a clause and go to step 2, which folds the log live anyway. What you
  must not do is render `lastTick` as though it were current.
- `stale: true` — a daemon holds the lock and has published nothing for
  three of its own intervals. This is worse than stopped, because the pid
  file makes the box look tended while something is wedged mid-tick. Lead
  with it, say how long the silence has run (`reportAgeSeconds`, or "never
  published" when it is `null`), and point the operator at
  `<dir>/daemon.log`.
- `running: true, stale: false` — the numbers are fresh. Say how fresh
  (`reportAgeSeconds`) rather than implying "now".
- an `error` object with `code: "daemon.unreadable-state"` — the daemon's
  own state is unreadable, so nobody can say whether one is running. Lead
  with it, name the file from `error.details.path`, and pass on the
  recovery in `error.message`. Never render it as `running: false`.

When there is a `lastTick`, render its triage split before the digest below,
because it is the only record of what happened while nobody was watching:
`attention` open findings, of which `newAttention` are ones no earlier tick
had seen; then `autoAdmitted` against `operatorHeld` — the second is the
operator's actual queue, the first is what the scheduler already admitted on
its own and needs no decision.

## 2. Fold the log

`bs stats overview [--session <id>]`. Render the JSON as a short digest,
field for field — never invent numbers the query didn't return:

- **Live agents**: `liveAgents` grouped by role/model/provider,
  `liveAgentCount` as the headline (with `liveAgentCountDelta5m` as a
  ▲/▼ note).
- **Budget**: `tokensByEpic`, called out as "X% of the epic cap" — the cap
  for the epic's effort tier in `budgets.yml` (4M small / 16M medium / 32M
  huge; `bs budget alarm` prints the cap it judged each epic against) — flag any epic ≥70% (`budgets.yml` `alarm_ratio`).
  `tokensByEpic` counts recorded spend only, so it is a floor: say "at least
  X%", and run `bs budget alarm <session>` for the projection that prices
  the dispatches nothing recorded a Result for.
- **In flight**: `epicsInFlight`, `recentDispatches` (last 10).
- **Alerts**: `alerts.escalations` and `alerts.pendingWaivers` — call these
  out first if non-zero, they're what the operator came here to see.
- **Milestones**: `milestoneProgress` — one line each, `%` complete.

If the UI is already running, just point the operator at it instead of
re-rendering the same data as text.
