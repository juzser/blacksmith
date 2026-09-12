# Operator guide — Lessons and the daemon

One part of [the operator guide](../operator-guide.md). Section numbers
are the guide's, not this file's: `§5` means the same thing here as it
does wherever else this repo cites it.

## 10. How lessons get approved

1. Every gate failure and runtime error is logged with taxonomy tags. An
   offline "dreaming" pass additionally scans the event log for decision
   checkpoints (proposed / approved / modified / rejected, and why).
2. A scribe distills these into **typed, principle-level** lesson
   candidates (`fact` | `event` | `rule` — never mixed; instance-level
   transcripts are rejected at the gate).
3. A cheap novelty gate runs before you ever see anything: clearly-redundant
   candidates are auto-rejected, clearly-novel ones queue, uncertain ones
   get one LLM merge step.
4. **You review what's left** — approve, edit, or reject. Nothing
   self-modifies without this approval; it's the safety boundary against
   memory poisoning, not a formality.
5. Approved lessons compile into `factory/policies/lessons.md`, sectioned
   by `lesson_scope`, and inject **step-wise** at the matching decision
   point (a coder gets claim-path-scoped rules at dispatch; a merger gets
   integration rules at queue time) — never as one global preamble.

Built (Phase 7): `smith dream [--since]` is the "dreaming pass"
(`factory/orchestrator/src/lessons.ts`'s `extractDecisionCheckpoints`);
`checkNovelty()` is the novelty-gate scorer (deterministic word-shingle
Jaccard similarity, not SAGE's embedding-density check — the "uncertain →
one LLM merge step" middle tier from step 3 above is a documented future
upgrade, never built). `smith lessons candidates`/`approve`/`reject`/
`compile` are the CLI side of steps 4–5; the Lessons UI page (§10) is the
operator-facing side of the same review.

Step 5's injection half is `smith lessons for-dispatch <role> [--plan
plan-vN.json --task <task-id>]` (Phase 9, P9-2): it reads the compiled
`factory/policies/lessons.md` — approved lessons only, never a candidate —
filters it to the scopes that role's template declares through its
`<!-- LESSONS:<scope> -->` markers and to that task's claims, and returns the
block ready to splice into the prompt. That is what makes it step-wise rather
than a global preamble: the coder's dispatch carries claim-path lessons for
its own claims, the merger's carries integration lessons at queue time, and
neither sees the other's. The `/bs` skill calls it before every dispatch.

**Every scope carries its own selector** (D-129). Three of the five scopes
filter on exactly one field, and each entry must name it:

| scope | selector bullet | matched against |
| --- | --- | --- |
| `claim-path` | `claim_path` | the task's claims, as a glob |
| `agent-role` | `agent_role` | the dispatching role |
| `case-type` | `case_type` | the dispatching task's `case` |
| `stack-wide` | — | every dispatch |
| `security` | — | every dispatch that declares the scope |

The case comes off the immutable plan, exactly as the claims do, so
`--plan`/`--task` fills it; `--case-type` names it directly for a dispatch
with no plan file to point at. Naming neither is **not** a wildcard: a role
that declares `case-type` gets no case-type lesson and a warning saying so,
because injecting every case's lessons on the grounds that the caller did not
say which case this is, is the defect D-129 fixed. A `--case-type` outside the
taxonomy is a hard error rather than a silent empty match.

`for-dispatch` also reports, in `warnings`, any entry sitting in a selector
scope with **no** selector — such an entry reaches no dispatch at all. Three
`agent-role` lessons raised before the selector existed are in exactly that
state; they are named on every dispatch that declares the scope until someone
re-scopes them or edits one to name a role.

**Raising a lesson by hand.** `dream` only sees four checkpoint shapes (plan
sign-off, waiver decision, escalation, gate block), so a rule you distilled
yourself by reading a whole run has no way in through it. Use `smith lessons
raise` (P9-34) rather than `smith event append`:

```
smith lessons raise \
  --statement "A constraint stated only in a prompt is a request." \
  --lesson-type rule --lesson-scope stack-wide \
  --provenance dogfood-envkit-1#1 --provenance-session dogfood-envkit-1 \
  --evidence "D-29. Anchor: the plan-version-created record." \
  --session my-lessons-session
```

It runs the same novelty gate `dream` runs and writes the same two-event
shape, so a hand-authored rule is scored exactly like a distilled one.
`--session` is where the events land; `--provenance-session` is where the
provenance ids are resolved, so you can cite a closed run's log without
writing to it. **Exit 1 means the gate rejected it** (it is on disk as
`novelty-rejected`, not dropped) — check the exit code, not just the output.
Everything validates before anything is written: an out-of-taxonomy tag, an
unknown provenance id, or a lesson id already in the log leaves the log
untouched. The id defaults to a hash of the statement, so re-raising the same
text collides rather than forking a duplicate. Optional `--finding-category`,
`--claim-path` (required for `claim-path` scope), `--agent-role` (required for
`agent-role` scope), `--case-type` (required for `case-type` scope),
`--lesson-id`, `--novelty-threshold`. The three selector flags are refusals,
not warnings: a selector scope with nothing to select on compiles into a
section no dispatch reads. `lessons approve` takes `--agent-role`/`--case-type`
too, so narrowing a candidate to a selector scope can name the selector in the
same edit.

Warnings are printed, not fatal. The one you will see most is a file-scoped
`rule` with no `finding_category`: it will be injected at dispatch and will
never escalate a repeat finding, because the same-mistake match is an equality
against the finding's category. That is usually what you want for a broad
principle — a category paired with `claim_path: **` fires on every finding of
that category in the repo — but it should be a choice, not a surprise.

After approving, run `smith db apply --session <id>` before
`lessons candidates`/`compile`/`stats lessons`: appending an event does not
write to SQLite, and those verbs read the projection, so a freshly-approved
lesson is invisible to them until you do.

**The gate catches one-word re-raises; it stops there.** Measured, not
estimated (P9-35). Changing one word in an *n*-word statement drops 3-shingle
similarity to `(n-5)/(n+1)`, so at a flat 0.8 threshold a statement had to be
**29 words or longer** before a single-word edit could even reach the bar —
most lessons are shorter, and every one of them could be re-raised with a
synonym swapped. Since P9-35 (a) the threshold is corrected per pair for the
length of the *shorter* statement, and one-word substitutions, insertions and
deletions are now all caught 25/25 on the real corpus (16/25, 19/25 and 19/25
before), with no genuine pair newly judged redundant. What still passes:
**two or more changed words** (0/25 both before and after — the correction is
calibrated to exactly one edit), a short rule quoted verbatim inside a longer
one, and the same rule reworded, which scores 0.000. So read the candidate
queue as if the duplicate check catches copy-paste and near-copy-paste only,
because that is what it catches; the operator is still the check for anything
reworded. Below `2*shingle_size+1` words the correction deliberately stands
aside and the configured threshold applies unchanged — down there a near-copy
and two unrelated statements sharing one three-word run score identically, and
`novelty-rejected` is terminal, so guessing would lose real lessons for good.
The knob is `lessons.novelty_length_aware` in `factory/policies/scheduler.yml`
(default `true`); there is no CLI flag, because `--novelty-threshold` already
sets a one-run bar in the units you are thinking in.

**Approval is the second door, and it is now gated too (P9-34).** `smith
lessons approve --statement "..."` rewrites the text on the way into memory, so
it runs the same novelty gate `raise` runs, against the same corpus, before
either event is written. A duplicate edit exits 1 with `lessons.edit-not-novel`
and **leaves the log byte-identical** — no `lesson-edited`, no status change.
Three things follow from where the check sits:

- **The lesson's own row is excluded from the corpus.** A typo fix scores ~1.0
  against its own old text; scored against itself, every cosmetic edit would be
  refused. It is scored against the *other* lessons, which is the question
  actually being asked.
- **`--accept-duplicate` lets it through and says so.** The override is recorded
  on the `lesson-edited` payload as `novelty_override: true` with
  `novelty_score` and `duplicate_of`, so a bypass reads as a decision in the log
  rather than as an absence of one. The exit code stays 1.
- **Only text going *into* memory is scored.** `smith lessons reject` (and any
  transition to `superseded`) returns `novelty: null` — scoring a statement on
  its way out answers nothing.

Every approval — edited or not — now prints a `novelty` block naming the
nearest lesson in the corpus, its score, and that lesson's id (P9-35). This is
the part that matters most in practice: the mechanical gate now fires on
one-word re-raises but on nothing more reworded than that, so `mostSimilar` is
there to put the near-duplicate in front of the operator, who is the real
check. The score is reported against **the bar that pair was judged at**, and
says so when that bar was corrected down for length — a rejected candidate
reported as "scores 0.65, threshold 0.8" would be a contradiction with no way
to resolve it. **An
approval whose text is not novel exits 1 with the transition applied** — it
landed, and it is a duplicate; both are true, and the exit code reports the
second.

**The UI's lesson actions run the same gate (P9-36).** Approve, Reject and
Edit in the Lessons page all go through `transitionLesson` now, so the button
and the CLI refuse the same things: an illegal transition, an out-of-taxonomy
tag, an edit that duplicates an existing lesson. Two consequences worth
knowing before you click:

- **The session is derived from the lesson, not from what the page sends.** A
  transition folds one log, and it is always the log that raised the lesson.
  You cannot approve a lesson into a different session's history by accident.
- **A duplicate edit is refused with no override in the UI.** The error names
  the lesson it duplicates and its score. If you genuinely mean to keep the
  duplicate, do it from the CLI with `smith lessons approve --statement ...
  --accept-duplicate` — which records the override on the event. That
  asymmetry is intentional: overriding the memory gate should take a
  deliberate act, not a second click.

If a lesson's session log has been archived off disk, the action fails with
`events.unknown-session` and prints the path it expected. The lesson is still
in SQLite — the projection outlives the log — but a transition needs the log
to fold. Restore it, or leave the lesson alone.

**Known limitation — polarity conflicts.** The novelty gate additionally
never auto-rejects a near-duplicate whose imperative polarity contradicts
the lesson it matched (e.g. "always retry X" vs "never retry X") — it stays
a pending candidate with a `possible_contradiction_of` note instead, so a
genuine correction never gets silently swallowed as a duplicate (§9.6). The
polarity check itself is a small fixed marker list
(never/not/don't/do not/no longer/must not), read for whether the statement
prohibits rather than for the word — "must not" against "do not" is one lesson
spelled twice, not a contradiction, and "always retry X" against a bare "retry
X" is one instruction said with more force, not its opposite. A contradiction phrased another way
(e.g. "avoid" vs "prefer") is not caught and can still auto-novelty-reject
silently. Review the "possible contradiction" notes
Lessons candidates carry; don't assume every genuine contradiction is
flagged. Note also that the polarity check only runs on a pair that is
*already* above the similarity threshold, so the limitation above compounds
this one: a rule that flatly contradicts an approved one in different words is
never flagged, because the two are never compared in the first place.

## 10a. `smith kpi same-mistake` — the rate, and whether it could have been anything else

Architecture §9.7 names one quality target for the whole lessons pipeline: the
same-mistake rate should be **monotonically decreasing**. The mechanism to
detect a repeat has been in `severity.ts` since the severity gate landed,
`analytics()` has counted a per-day rate since the dashboard queries landed,
and nothing ever read that number against the target. This verb does, and
refuses to read it when the number could not have been anything but zero.

```bash
node factory/orchestrator/dist/cli.js kpi same-mistake <session-id> \
  [--lessons <lessons.md>]
```

Exit 0 only on `on-target`. Exit 1 on a rise, and equally on a record that
cannot show there wasn't one. `--lessons` defaults to the committed
`factory/policies/lessons.md`, because the corpus is half the measurement.

### The three zeros

A same-mistake rate of 0.00 is produced by three different worlds, and the
event log distinguishes none of them:

1. **Nothing repeated.** The one the target is about.
2. **No lesson in the corpus can escalate anything.** The match is an equality
   against the finding's `finding_category`, so an entry naming none is skipped
   before its claim path is ever consulted, and `agent-role`/`case-type` entries
   have no file to match against at all. Both kinds are still injected at
   dispatch and read by agents — they just can never be a *same mistake*. (An
   `agent-role`/`case-type` entry naming no selector is not injected either;
   `lessons for-dispatch` warns about those separately — see D-129 above.)
3. **The gate ran without lessons.** `--lessons` on `smith gate run` is
   optional. A gate holding an empty list decides `same_mistake: false` for
   every finding it sees.

So the report carries the instrument next to the reading, the way §9a carries
`projectedTokens` next to `measuredTokens`. `reach` is what the corpus could
ever detect; `lessons_escalating` on each `severity-decisions` event is what
the gate actually held at the time.

| status | meaning |
| --- | --- |
| `on-target` | Two or more measured days, non-increasing throughout, against a corpus that can escalate something. The only status that clears. |
| `off-target` | The rate rose between measured days, from a day whose every decision came from a gate equipped to escalate. |
| `insufficient-history` | The instrument is sound, but one day is a reading, not a trend. |
| `unverifiable` | Nothing provably rose, and nothing here could have shown it if it had. |

The asymmetry runs the opposite way to §9a's and lands in the same place. A
*recorded repeat is a fact* — the instrument had to fire to record it — so
`off-target` survives every hole **elsewhere** in the log. Zero repeats is a
claim about the instrument, and is only honest once the instrument is shown to
have been able to fire.

"Elsewhere" is the load-bearing word. A rise has two operands, and the earlier
one is not elsewhere: if the baseline day's decisions came from a gate holding
nothing to escalate, that day reads 0.0% whatever the work was, and the
"rise" measured against it is the corpus improving, not the factory getting
worse. Such a rise lands in `unprovenRises` and the status is `unverifiable`,
not `off-target` (D-174). A day earns the right to be a baseline either by
recording `lessons_escalating > 0` on every intake, or by recording a repeat —
`same_mistake: true` cannot be written by a gate holding nothing to escalate
against, so an intake that fired needs no separate attestation.

"Monotonically decreasing" is read as **non-increasing**: a strictly decreasing
rate is unsatisfiable the moment it reaches 0, and a target that cannot be met
is not a target.

### A day with no decisions is not a day at 0%

Only days on which the gate decided at least one finding become windows. A day
whose every intake carried `decisions: []` goes to `silentDays` and never
becomes a rate-0 datapoint — the gate saying "I found nothing to decide" is not
the gate saying "I found things and none repeated" (D-31). `smith stats
analytics` used to report the second for the first; its `rate` field is now
`null` on such a day rather than `0`.

### What it reports on the dogfood log today

```
0 same-mistake of 4 decision(s) across 1 measured window(s) — 2026-08-06 0.0%.
status: unverifiable — none of the 14 compiled lesson(s) can escalate anything
(14 name no finding_category), and 7 intake(s) record no lessons_escalating
count.
```

Four of those seven intakes decided nothing at all. Every one of the fourteen
approved lessons is category-less, so the numerator was pinned at zero by the
corpus rather than by the factory's conduct — and one calendar day is no trend
regardless. `smith stats analytics` reports the same session as a clean 0.00%.
That is the false clean this command exists to refuse.

### Getting to a readable number

- **Give the file-scoped rules a `finding_category`.** Nothing else moves
  `reach.escalating` off zero. `smith lessons raise --finding-category` already
  warns when you omit one on a file-scoped rule (§10).
- **Pass `--lessons` to every `smith gate run`.** From now on the gate records
  what it held, so a blind run is visible in the log instead of indistinguishable
  from a clean one. Every intake already on disk predates that field and is
  counted as a hole, deliberately.
- **Two days minimum.** The target is about direction.

### Limits, stated plainly

- It reads the log; it does not stop anything, and no gate consults it.
- `quorum-decision` is a second trace of the same signal, but it is only
  written when an external cross-check provider is enabled — off by default, so
  it is normally silent. When it *does* see a same mistake on a day the
  severity trace calls clean, that day is reported in `traceDisagreements` and
  the whole report goes `unverifiable`: two traces of one event disagreeing
  means one of them is wrong, and the report cannot say which.
- A per-session read. An epic spanning sessions needs one call per session
  (§5b); there is no cross-session roll-up.

## 10b. `smith lessons audit` — which entries still earn their place

`kpi same-mistake` above reads the corpus as one number. This verb reads it
entry by entry, and it exists because a lessons file only ever grows: every
incident adds a line, nothing removes one, and the corpus drifts into a set of
standing instructions that contradict each other while the escalation match
quietly stops reaching half of them.

```bash
node factory/orchestrator/dist/cli.js lessons audit <session-id> \
  [--lessons <lessons.md>] [--state-dir <dir>]
```

Order is load-bearing, which is the thing that makes this necessary.
`findMatchingLesson` is first-match-wins, so an entry an earlier one provably
covers can never fire again no matter how true it is — and nothing in the file
says so.

### Two kinds of evidence, never conflated

**Structural** death is provable from the corpus text alone. If an earlier
same-category entry's glob *provably contains* this one's, the entry is
`unreachable` and the recommendation is `retire`. No run, no log, no sampling:
`coversEntirely` decides it, and only actual containment counts. Overlap that
is not containment lands in `overlapsWith` and is informational — on the
intersection the earlier entry wins, on the rest this one is still live, and
overlapping globs are normal rather than a defect.

**Evidential** death needs the log to prove the entry was actually *loaded*.
An entry is `idle` only when decisions in its category, on files its glob
covers, were recorded by an intake whose payload shows the gate was holding it
— and went somewhere else. That denominator is what `opportunities` counts, and
it is why a severity decision now records its `finding_category` and
`file_path`: without them a decision cannot be placed against any entry, and
the audit counts it in `decisionsWithoutContext` rather than guessing.

### It recommends; it does not act

| Recommendation | What it means |
| --- | --- |
| `keep` | It fires. |
| `review` | Two standing instructions need a human to reconcile them. |
| `retire` | It cannot fire, and the corpus proves it without reference to any run. |
| `rescope` | It could fire and does not — its glob or its position is wrong. |
| `no-evidence` | This audit has nothing to say about it. **Never a reason to drop one.** |

The gap between `retire` and `no-evidence` is the point of the whole verb. A
corpus you prune on "we saw nothing" is a corpus you prune on missing telemetry.

Contradictions are reported rather than resolved. Two entries whose statements
clear a unigram-Jaccard topic threshold while their polarity differs are listed
in `contradictions` and both get `review`, because deciding which of two
standing instructions survives is not a thing a text comparison has standing to
do.

Exit 0 only on `clean`; exit 1 on `defective` and equally on `unverifiable`, so
the verb can sit in a scheduled job without anyone reading the JSON on a good
day.

### What it reports on this repository's own corpus today

Run against a session with no severity decisions, it still says something true
about the corpus itself:

```json
{"reach":{"total":24,"escalating":0,"withoutCategory":24,
          "nonFileScoped":2,"categoriesCovered":[]},
 "counts":{"keep":0,"review":0,"retire":0,"rescope":0,"no-evidence":24},
 "status":"unverifiable","ok":false}
```

**None of the 24 compiled lessons can escalate anything.** All 24 name no
`finding_category`, so none of them participates in the escalation match at
all; they are spliced into role prompts instead, and this audit is honest that
it cannot measure that path. Two are not file-scoped on top of it. That is not
a bug the audit found in itself — it is the state of the corpus, and it is why
`status` is `unverifiable` rather than `clean`: a corpus that cannot fire is
not a corpus that is working.

The fix is upstream, in what `smith dream` and the scribe write: a checkpoint
distilled without a `finding_category` compiles to an entry the severity gate
can never reach. Until those entries carry one, `kpi same-mistake` above is
reading a number the corpus could not have moved.

## 11. `smith daemon` — the same folds, without an open session

Everything above is a command you run. Most of them answer a question that has
a shelf life: is the epic over its cap, did an agent that was dispatched ever
come back, is a recheck due. Asking them means being at the terminal.

```bash
smith daemon start                  # detached, logs to state/daemon/daemon.log
smith daemon status                 # exit 1 unless one is watching and current
smith daemon stop
smith daemon run --once             # one tick in the foreground, for cron
```

A tick reads the event log, runs the same folds `smith budget alarm` (§9a) and
`smith scheduler run --dry` run plus the live-agent fold behind `/bs status`,
refreshes the SQLite read-model the dashboard serves, and writes the result to
`state/daemon/status.json`:

```json
{
  "at": "2026-08-27T09:00:00.000Z",
  "sessions": ["sess-7"],
  "findings": [
    {
      "kind": "stale-agent",
      "severity": "attention",
      "sessionId": "sess-7",
      "subject": "task-4",
      "detail": "coder (claude/mid) has been live for 6.2h with no result, error or supersession — past the 4h threshold. Dispatched 2026-08-27T02:48:00.000Z."
    }
  ],
  "attention": 1,
  "projected": 1
}
```

Two things make it safe to leave running. It never dispatches — that is
architecture §12's rule for the scheduler it wraps, applied to a process that
outlives your terminal — and its entire write surface is `state/daemon/` and
`state/smith.db`, both derived, both git-ignored, both rebuildable from the
log it only ever reads. It cannot merge, cannot touch a worktree, and cannot
spend a token.

Findings a scheduler proposal stands behind also carry the `admission` that
`smith scheduler admit` renders, and the report counts them as `autoAdmitted`
and `operatorHeld`. That is the split a morning triage actually turns on: how
much of the list a `/bs report` wave drains on its own, and how much of it is
yours whatever you do. `auto` remains a statement about policy — the daemon
still dispatches nothing, and a person still starts the wave.

`status` answers two questions, because one of them cannot be answered by the
other. `running` says a process holds the lock and answers `kill -0`; `stale`
says that process has published nothing for three of its own intervals. A
daemon wedged mid-tick holds its lock and answers `kill -0` exactly like a
healthy one, so `running` alone passed a watcher that had reported nothing for
days — and the exit code now fails on either. `reportAgeSeconds` dates the
last tick for a reader that has to decide how far to trust it, and is `null`
rather than `0` when nothing has ever ticked.

Because it re-runs the same folds rather than reimplementing them, it and
those commands cannot disagree. The full operator story — every flag, the
finding kinds, the admission codes, launchd/systemd/cron units, the health
check, what to back up — is [`../runbooks/ops.md`](../../runbooks/ops.md).
