# Runbook — running the factory unattended (`smith daemon`)

Operator procedure for Phase 10's background watcher: what it is, what it
refuses to be, how to run it under launchd or systemd, the files it owns, the
health check, and how to stop it. Companion to
[`../guide/operator-guide.md`](../guide/operator-guide.md) and
[`../specs/black-smith-architecture.md`](../specs/black-smith-architecture.md)
§12; commands assume a built CLI (`pnpm run build` →
`factory/orchestrator/dist/cli.js`, substitute `smith` if linked).

## 1. What it is, and what it is not

Before Phase 10, knowing what the factory needed meant keeping a session open
and re-running `smith budget alarm`, `smith scheduler run --dry` and
`/bs status` by hand. The daemon removes that: it wakes on an interval, reads
the event log, and publishes one report.

It removes the requirement to keep a session open **to know** what the factory
needs. It does not remove the requirement to keep a session open **to run**
agents. Concretely, the daemon:

| It does | It never does |
| --- | --- |
| Read every session log under `state/events/` | Dispatch an agent |
| Fold budgets, stalls, rechecks and cadences into findings | Merge, rebase, or enter the queue |
| Refresh the SQLite read-model the dashboard serves | Write to a worktree, a branch, or any tracked file |
| Write a lock, a status file and a log under its own dir | Call a provider, or spend a token |

Its entire write surface is `state/daemon/` and `state/smith.db` — both derived,
both git-ignored, both rebuildable from the event log it only ever reads.

That column is not an oversight to be fixed later. `scheduler.ts` already
holds the line in its own words — *"Never dispatches an agent itself
(architecture §12)"* — and a process that outlives the operator's terminal is
the last place to relax it. Everything the daemon reports comes from folds the
repo already owns (`budgetAlarm.ts`, `agents-registry.ts`, `scheduler.ts`), so
the daemon and those commands cannot disagree; they are the same arithmetic
read at different times.

## 2. The verbs

```
smith daemon run    [--interval <seconds>] [--once] [--dir <dir>]
                    [--project <dir>] [--db <path>] [--no-db] [--state-dir <dir>]
smith daemon start  [--interval <seconds>] [--dir <dir>]
                    [--project <dir>] [--db <path>] [--no-db] [--state-dir <dir>]
smith daemon status [--dir <dir>]
smith daemon stop   [--dir <dir>]
```

- **`run`** is the loop itself, in the foreground. This is what a service
  manager should execute — launchd and systemd want a process that stays in
  the foreground and dies when told to, which is exactly this.
- **`run --once`** ticks once and exits 0. This is the cron shape, and the
  shape to reach for when you want a report now without leaving anything
  behind.
- **`start`** is the convenience: it spawns `run` detached, appends stdout and
  stderr to `daemon.log`, and prints the child's pid. Use it when there is no
  service manager. It refuses (`daemon.already-running`, exit 1) while a live
  daemon holds the directory.
- **`status`** prints the lock, the last tick, and whether anyone is watching.
- **`stop`** sends SIGTERM to the pid in the lock and clears the file.

Flags worth knowing:

- `--interval` defaults to **300** seconds. It must be a whole number greater
  than zero; anything else is `cli.invalid-flag` and exit 1, at startup rather
  than at the first sleep.
- `--dir` defaults to `state/daemon/`. Give it an explicit path if you run more
  than one factory checkout on one machine — the lock is per-directory, so two
  daemons on two checkouts with the default dir are two daemons on two
  different locks, which is correct, while two daemons on one checkout is what
  the lock exists to prevent.
- `--project <dir>` enables the maintenance pass for that repo: a best-effort
  `pnpm outdated --json` in that directory. Omitted, the check does not run at
  all; present but with no pnpm or no lockfile, it returns nothing rather than
  failing the tick.
- `--no-db` skips the read-model refresh. The findings still come out; the
  dashboard just goes on serving whatever the last projection wrote. Use it if
  the SQLite file lives somewhere the daemon's user cannot write.
- `--state-dir` points at an event-log directory other than `state/events/`.

## 3. What one tick reports

`status.json` and the tail of `daemon.log` both carry a `TickReport`:

```json
{
  "at": "2026-08-27T09:00:00.000Z",
  "sessions": ["dogfood-envkit-1"],
  "findings": [
    {
      "kind": "budget",
      "severity": "attention",
      "sessionId": "dogfood-envkit-1",
      "subject": "envkit-config-loader",
      "detail": "alarm: 412,000 tokens measured across 4 of 6 task(s), 486,000 projected, against a 400,000 alarm and a 500,000 cap. Measured spend alone has reached the alarm — re-plan the remaining work to fit, or ask the operator to extend. Unrecorded spend can only add to this.",
      "firstSeen": "2026-08-25T14:00:00.000Z",
      "isNew": false
    },
    {
      "kind": "recheck",
      "severity": "info",
      "sessionId": "dogfood-envkit-1",
      "subject": "envkit-config-loader/task-3",
      "detail": "Recheck due (merge-threshold): 6 later overlapping merge(s), 3 day(s) elapsed, confidence 0.9.",
      "admission": {
        "decision": "auto",
        "code": "admitted",
        "reason": "Every reason (merge-threshold) is whitelisted."
      },
      "firstSeen": "2026-08-27T09:00:00.000Z",
      "isNew": true
    }
  ],
  "attention": 1,
  "newAttention": 0,
  "autoAdmitted": 1,
  "operatorHeld": 0,
  "projected": 1
}
```

`sessions` lists **lineage leaves**, not every log on disk. A continuation
session covers its ancestors, so a five-session lineage produces one budget
alarm rather than five.

Finding kinds, and where each one comes from:

| `kind` | Severity | Means |
| --- | --- | --- |
| `budget` | `attention` (`info` when `unverifiable`) | An epic is at or over its token cap. `detail` is `budgetAlarm.ts`'s own sentence. |
| `unattributed-spend` | `info` | Dispatches nobody can be billed to an epic for. |
| `stale-agent` | `attention` | An agent was dispatched and never came back inside the 4-hour stale window. |
| `recheck` | `info` | Completed work `scheduler.yml`'s recheck policy says is due another look. |
| `spec-change` | `attention` when the worker called it `blocking`, `info` otherwise | A worker proposed amending an acceptance criterion and nobody has answered. `detail` names the criterion, the assumption and both answering commands. |
| `maintenance` | `info` | Dependencies `pnpm outdated` reports behind, with the scheduler's confidence. Needs `--project`; repo-scoped. |
| `growth-review` | `info` | The 30-day growth review is due. Repo-scoped: `sessionId` is `null`. |
| `factory-width` | `attention` when the newest close ran narrow, `info` when nothing has been measured | The last epic this factory closed was admitted wide and dispatched serially — or every close here recorded no width at all. Repo-scoped. |
| `unreadable-log` | `attention` | A session log could not be read. |
| `projection-failed` | `attention` | A session's read-model refresh threw. |

The `info` / `attention` split is the whole point of the `attention` count:
`attention > 0` means something is wrong **now**, and it stops meaning that the
moment a routine 30-day cadence is filed under the same word.

### How long a finding has been standing

Every finding also carries `firstSeen` and `isNew`, and the report carries
`newAttention` beside `attention`. The distinction is the one you triage on: a
daemon ticking every five minutes reports the same standing alarm 288 times a
day, so `attention` is the number worth **looking at** and `newAttention` the
number worth **waking someone for**. An alert rule wants `newAttention > 0`; a
morning review wants `attention` and the oldest `firstSeen`.

Two findings count as the same finding across ticks when their `kind`,
`sessionId` and `subject` agree. `detail` is deliberately excluded — it carries
the moving parts, and a `recheck` whose "N day(s) elapsed" climbs daily would
otherwise report itself as new every day it stood. `severity` is excluded too:
a finding that changes severity has not changed what it is about.

Two consequences worth knowing before you build an alert on this:

- `unattributed-spend` and `maintenance` put a **count in their subject**
  ("4 dispatch(es)", "3 package(s)"), so a growing count reads as a new
  finding. That is intended — the count moved because something new went
  unattributed or another package fell behind, and that happened *now*.
- A finding that **cleared and came back is new again**. Its clock is not
  restored from before the fix, because "broken since March" is false about a
  factory that was fixed in April and broke again this morning.

`spec-change` is the one kind whose severity the *worker* chose: `blocking`
means the task cannot go further without the amendment, so an unanswered
blocking proposal is a stalled task rather than a queue item. The finding says
only that a decision is outstanding, which stays true whichever way it is
answered; whether the proposal's diff has since been overtaken by a later plan
version is a second question, and `smith plan proposals` is where it is asked.

`factory-width` is the one kind that deliberately reads **only the newest
close**, and the reason is the severity rule above. Closes are immutable, so an
epic that ran narrow in March is narrow forever; a finding folded over all of
history would therefore raise the same `attention` on every tick for the life
of the repo, over something nobody can go back and fix. An attention count that
can never return to zero is worse than no count — it trains you to stop reading
it. The newest close is a claim about *now*: it clears itself the moment a wide
epic closes. The history is not lost, it is one `smith epic width` away (§7f of
the operator guide), which folds every close and is the right place to ask
whether the factory has been narrow for a month.

Its `info` form is the opposite state of knowledge, not a milder version of the
same one: closes exist and none of them recorded how wide it ran, so the factory
cannot say whether it builds in parallel. That is work to schedule — close a
current epic, or read a live log back with `smith wave audit` — and never an
alarm, because nothing here is known to be wrong.

The last two kinds are why a tick never aborts. One corrupt line, or one
SQLite file the daemon cannot write, becomes a finding and the tick carries
on — a watchdog that dies on the first corrupt log is silent exactly when
something is wrong.

### Whose queue a finding is in

Findings that a scheduler proposal stands behind — `recheck`, `maintenance`,
`growth-review` — also carry an `admission`, and the report carries
`autoAdmitted` and `operatorHeld` beside `attention`. This is the same verdict
`smith scheduler admit --session <id>` renders (operator guide, *Limitations
today*; step 2 of the `/bs report` playbook), computed against the same two
files and reported per finding instead of per session:

- `scheduler.yml` `autonomy:` — what may run unattended at all.
- `crosscheck.yml` `plan_quorum.security_keywords` — which claimed paths make a
  change a security surface.

An `admission` has three fields: `decision` (`auto` or `operator`), `code`, and
a `reason` written to be argued with. The codes are `autonomy.ts`'s, and every
one of them can only **deny**:

| `code` | Means |
| --- | --- |
| `admitted` | Nothing denied it. |
| `autonomy-disabled` | `autonomy.enabled` is `false`. Nothing else was even read. |
| `growth-never-auto` | A growth review proposes *scope*, which is the operator's regardless of the whitelist. |
| `kind-not-whitelisted` | The proposal kind is not in `auto_dispatch_kinds`. |
| `security-surface` | The task claims a path matching a security keyword. The one denial no edit to `scheduler.yml` can lift. |
| `reason-not-whitelisted` | A recheck fired for a reason outside `auto_dispatch_recheck_reasons`. |
| `below-confidence-floor` | The proposal's confidence is under `confidence_floor`. |

Read the two counts as the split you actually triage on: `autoAdmitted` is how
much of the list drains itself once you start a `/bs report` wave, and
`operatorHeld` is how much of it is yours no matter how long you wait. A
morning where `operatorHeld` is 0 is a morning you can skip.

Three things `auto` does **not** mean:

- **Not "it ran."** The daemon dispatches nothing; §1 is unchanged by this. An
  `auto` is a statement about policy, and a person still has to start the wave.
- **Not "it is safe."** It means no rule in `autonomy.ts` denied it. The rules
  can only deny; none of them ever approves anything on the merits.
- **Not the default.** A finding with **no** `admission` key at all is one no
  proposal stands behind (a blown budget is a condition, not queued work), or a
  call into `inspectSession` / `inspectFactory` that passed no policy. Absent
  reads as *nobody asked* — never as *anything may run*. If you build an alert
  on this, treat a missing `admission` as neither half of the split, which is
  exactly what `autoAdmitted + operatorHeld < findings.length` is telling you.

Editing `scheduler.yml` does **not** restart a finding's clock: `admission` is
not part of the identity above, so a six-day-old recheck that flips from
`operator` to `auto` keeps its `firstSeen`. And the standing rule from the
`/bs report` playbook holds here too — widening `auto_dispatch_kinds`,
`auto_dispatch_recheck_reasons` or `confidence_floor` to clear one denial is a
decision about standing policy, not a way past one finding.

## 4. Files the daemon owns

All four live in `--dir` (default `state/daemon/`, git-ignored with the rest
of `state/`):

| File | Written by | Lifetime |
| --- | --- | --- |
| `daemon.pid` | `run`, at startup | Removed by the daemon's own exit path, or by `stop`. |
| `status.json` | `run`, after every tick | Overwritten each tick; survives the daemon. |
| `findings.json` | `run`, after every tick | Overwritten each tick; survives the daemon. |
| `daemon.log` | `start` only | Appended forever — see the rotation note below. |

`daemon.pid` is a JSON document (`{pid, startedAt, intervalSeconds}`), taken
with `O_EXCL`. If the file exists, the incumbent pid is checked for liveness:
alive means the new daemon refuses to start, dead means the stale lock is
overwritten and the run proceeds. So a machine that lost power does not need a
human to delete a file before the factory can watch itself again.

`status.json` is written tmp-then-rename, so a reader polling it never sees
half a document.

`findings.json` is the daemon's only memory: finding identity to the timestamp
it was first seen, and nothing else. It is what makes `firstSeen` possible at
all, because the event log records what *happened* and not what the watcher
*noticed*, so this one fact cannot be recomputed from scratch the way every
other fact in this factory can. It is also deliberately disposable — deleting
it costs one tick in which every standing finding reads as new, and nothing
else. A missing or corrupt file is read as an empty memory rather than failing
the tick, for the same reason `unreadable-log` is a finding and not a crash.

`daemon.log` is only produced by `smith daemon start`, and **nothing rotates
it**. Under launchd or systemd, let the service manager own the output stream
(§5) and this file never exists. If you do use `start` long-term, point
`newsyslog`/`logrotate` at it, or restart the daemon periodically.

## 5. Running it under a service manager

Prefer this to `smith daemon start`: a service manager restarts the daemon
after a reboot or a crash, and owns log rotation.

Both examples assume the repo is at `/srv/blacksmith` and the CLI has been
built. Substitute your absolute node path — neither launchd nor systemd reads
your shell profile, so `node` on bare `PATH` is not a safe assumption.

### macOS — launchd

`~/Library/LaunchAgents/com.blacksmith.daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.blacksmith.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/.nvm/versions/node/v26.5.0/bin/node</string>
    <string>/srv/blacksmith/factory/orchestrator/dist/cli.js</string>
    <string>daemon</string><string>run</string>
    <string>--interval</string><string>300</string>
  </array>
  <key>WorkingDirectory</key><string>/srv/blacksmith</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/srv/blacksmith/state/daemon/launchd.out.log</string>
  <key>StandardErrorPath</key><string>/srv/blacksmith/state/daemon/launchd.err.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.blacksmith.daemon.plist
launchctl print gui/$(id -u)/com.blacksmith.daemon | head
```

Use a **LaunchAgent**, not a LaunchDaemon: the factory's state, git config and
provider credentials belong to your user, and a root-owned daemon writing into
`state/` leaves files your own session cannot rewrite.

### Linux — systemd (user unit)

`~/.config/systemd/user/blacksmith-daemon.service`:

```ini
[Unit]
Description=Blacksmith factory watcher
After=network.target

[Service]
Type=simple
WorkingDirectory=/srv/blacksmith
ExecStart=/usr/bin/node /srv/blacksmith/factory/orchestrator/dist/cli.js daemon run --interval 300
Restart=on-failure
RestartSec=30
# SIGTERM is the daemon's own stop path: it interrupts the sleep, finishes
# the tick loop, and releases the lock in a `finally`. SIGKILL skips that and
# strands a pid file, so give it room to exit cleanly.
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now blacksmith-daemon
systemctl --user status blacksmith-daemon
loginctl enable-linger "$USER"   # so it survives logout
```

Under a service manager, do **not** also run `smith daemon start` — the lock
would refuse the second one anyway, which is the failure working as designed,
but the error is easier to not cause than to diagnose.

### cron, if you would rather not have a resident process

```
*/5 * * * * cd /srv/blacksmith && /usr/bin/node factory/orchestrator/dist/cli.js daemon run --once >> state/daemon/cron.log 2>&1
```

`--once` takes the lock, ticks, publishes, and releases it, so overlapping cron
invocations refuse rather than interleave.

## 6. Health check

`smith daemon status` **exits 1 when nothing is watching**. That is the whole
probe — no JSON parsing in a shell script:

```bash
smith daemon status >/dev/null || echo "blacksmith watcher is down"
```

Exit 0 means the lock exists and names a live process. The JSON on stdout also
carries the last tick either way, so a health check that *does* parse gets the
findings for free:

```console
$ smith daemon status
{
  "running": true,
  "dir": "/srv/blacksmith/state/daemon",
  "lock": { "pid": 96054, "startedAt": "2026-08-27T09:00:00.000Z", "intervalSeconds": 300 },
  "lastTick": { "at": "2026-08-27T09:35:00.000Z", "sessions": ["dogfood-envkit-1"], "findings": [], "attention": 0, "projected": 1 }
}
```

Two states a single boolean would hide, and why the report keeps them apart:

- `running: false` with a non-null `lastTick` — the daemon died, but its
  findings are still the truth as of `lastTick.at`. Check that timestamp
  before trusting them.
- `running: true` with `attention: 0` — the watcher is up and the factory is
  quiet. This is the only combination that means "nothing to do".

## 7. Stopping it

```console
$ smith daemon stop
{"stopped":true,"pid":96054}
```

`stopped` answers *"did this call signal a running daemon"*, not *"is the lock
gone"* — the lock is cleared either way. So a lock left behind by a crash
reports `stopped: false` with the pid it cleared, and you learn the daemon was
already gone rather than being told this call is what ended it:

```console
$ smith daemon stop
{"stopped":false,"pid":4194304}
```

`{"stopped":false,"pid":null}` means there was no lock at all.

Under a service manager, use the service manager (`launchctl bootout`,
`systemctl --user stop`) — both send SIGTERM, which is the same path
`smith daemon stop` uses. `kill -9` is the one thing to avoid: it skips the
release and leaves a lock naming a dead pid. That is recoverable (the next
`start` overwrites a stale lock, and `stop` clears it) but it costs you the
final tick.

## 8. Deploying the dashboard — deferred, and why

Phase 10's other half, the Cloudflare port of the UI, is **not** shipped and is
not described here as if it were. The dashboard is local-only
(`smith ui serve`, or `pnpm run dev:ui` for the Vite dev server), the two
Cloudflare publish commands are deny-listed for agents by
`.claude/settings.json`, and no deploy path has been designed. See
[`../../factory/specs/roadmap.md`](../../factory/specs/roadmap.md) for the
current status rather than assuming from this file's title.

What the daemon does give the dashboard today is a read-model that stays fresh
without an operator session: each tick reprojects every inspected lineage into
`state/smith.db`, which is the file `ui/server` reads. Start the UI whenever
you want to look; the data is already current.

## 9. Backing up state

`state/` is git-ignored, and it is the only copy of what the factory has done:

| Path | Losing it costs |
| --- | --- |
| `state/events/*.jsonl` | Everything. The event log is the source of truth; every projection is derived from it. |
| `state/smith.db` | Nothing permanent — rebuild with `smith db rebuild`. |
| `state/artifacts/` | Reports and screenshots referenced from the timeline. |
| `state/daemon/` | Nothing. The lock is transient and `status.json` is one tick old by design. |

Back up `state/events/` and `state/artifacts/`. Everything else in `state/` is
reproducible from them.
