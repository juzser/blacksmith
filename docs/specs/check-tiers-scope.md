# Check tiers — scope

<!-- PLANNED-NAMESPACE: checks -->

This file specifies the `bs checks` verbs before they exist; the marker above
tells `docCommands.test.ts` so, and fails the day the CLI declares the
namespace. It is a predefined architecture: the mechanism is written down
first and becomes a feature as it ships, one task at a time.
Every part below says `Status: planned.` until it has landed on main.

Flags that existing verbs gain (the integration check's tier option, the
queue's checks file, epic close's checks file, worktree create's reopen, the
integration check's `remaining` selection) and error codes that are not in
source yet are described in prose on purpose. The doc guards check flags and
error codes, and a marker covers only a namespace.

The mechanism is one thing in three parts: a check declares when it runs, the
factory runs each tier where it belongs, and the factory learns from the runs
which checks cost a lot and catch little. It is the epic `bs-check-tiers`, and
the living spec of record for it is that epic's own spec; this file is the
scope a reader meets first. It decides shape and boundaries, not code.

## Why this is a Blacksmith advantage

A factory merges many small tasks into an integration branch and then one
epic into main. That structure lets the expensive checks run less often per
task without running less often per release. A plain CI cannot do that: it
does not know which merges form a batch, which task a red belongs to, or that
the branch can take a revert that no human reviews.

main stays merge-on-green, and the epic does not change that rule. The
September 2026 evidence is why it is not negotiable. Over 400 merged pull
requests, main was red afterwards 83% of the time (15 of 18) when the pull
request merged red, 44% (7 of 16) when it merged while CI was still running,
and 6% (21 of 364) when it merged on green. main was red about 42 hours that
month and 23 pull request runs inherited the red. Post-merge testing
therefore happens only on `bs/<epic>/integration`, never on main, and the
epic pull request opens only when every tier is green.

## 1. Tier declaration

Status: planned.

Each entry in a project's `checks.json` may carry a `tier`, one of
`pre-merge`, `post-merge` or `pre-release`. `tier` sits beside `heavy`: heavy
says a check runs under the machine lock, tier says when it runs. It is
validated fail-closed where the file is read, so an unknown value is refused,
naming the entry and the file, never guessed.

### Defaults

- An absent `tier` means `pre-merge`. A project that labels nothing behaves
  exactly as it does today, with the same checks in the same order.
- An empty `checks.json` stays today's behaviour: the gate passes it, and no
  tier filter reads as a pass. A file with entries whose pre-merge selection
  is empty is refused before any stage, and so is a deferred check a gate
  stage depends on (the coverage check stays pre-merge, because deferring it
  would drop the stage silently).
- There are no per-stack defaults. No tier is guessed from a language, a
  framework or a command name. `bs new` scaffolds no `checks.json`; the
  operator writes it.
- Nothing needs GitHub Actions. The tiers are run by `bs` itself, locally.
  CI, when a project has it, is one job per tier fed by the same file.
- Every git mechanism works on git 2.38, the floor the install check states.

### Learned tiers live in an overlay

The project's checks file is the operator's declaration and may be tracked, so
`bs` never writes it. What `bs` learns lives in a bs-owned overlay,
`.blacksmith/check-tiers.json` in the project's main worktree, kept out of git
through `.git/info/exclude` and never through a tracked ignore file. The event
log is the source of truth and the overlay is its local copy, which the gate
and the queue can read without the event store.

- Resolution order: a declared `tier` wins; else an overlay entry with the
  same check name and command digest; else `pre-merge`. Every verb sees the
  effective tier and where it came from (declared, overlay or default).
- Each overlay entry is reported once, by one precedence: no file entry of
  that name is `orphaned`; a file entry that declares a tier is `shadowed`; a
  name match whose command digest differs is `orphaned`; otherwise `active`.
  A stale entry changes nothing. A shadowed one loses to the declaration, and
  an orphaned one matches nothing, so the check falls back to `pre-merge`,
  the earlier tier.
- One writer at a time: an exclusive lock file beside the overlay and a
  revision number the writer must still find. A tracked, un-excludable,
  unreadable or non-repository location refuses writes, and `bs` then asks no
  question it could not apply.
- Crash order: the earlier tier is always written first. A demotion appends
  its decision event and then writes the overlay; a promotion writes the
  overlay first and appends its event second. A reconcile at the start of
  every writing verb converges the two.

## 2. Where each tier runs

Status: planned.

- The gate runs the pre-merge tier only, names every deferred check in its
  result, and keeps every stage it has today.
- The merge queue tests the pre-merge tier before landing. When the effective
  checks hold no later-tier entry, the queue runs today's test command and
  its selection command exactly as it does now. When they do, the pre-merge
  tier replaces both, the landing event says they were not run, and the full
  pre-merge tier runs, never less. The flags stay accepted so an old playbook
  line never fails after an approved demotion.
- After merges land, the post-merge tier runs once per batch of merges, in a
  detached scratch worktree prepared with the project's setup command and the
  gate's own dependency check. A failed setup is `setup-failed`: nothing is
  bisected and nothing is reverted.
- `bs epic close` needs every check of every tier certified green at the
  integration head, pre-release included, so main never receives a red epic.
  A check is certified by its own passing result at that commit for its exact
  name, command, heavy flag and timeout. A tier move never invalidates a
  result, and a post-merge pass cannot stand in for a pre-release check.

### The post-merge batch

The queue rule above is the pre-landing half. The post-merge half is
`bs checks post-merge`, and it obeys these rules.

- **Pinned branch.** The only ref it reads, probes or moves is the epic's
  integration branch. Any other branch, the default branch included, is
  refused before a worktree is made.
- **Trigger.** The epic session starts it on each landing and waits on it. The
  verb decides whether to run, counting task merges since the base: a plan
  dependency of a not-yet-admitted task on an uncertified merge, `POST_MERGE_BATCH`
  (4) uncertified merges, no admitted task in flight, or a final run before
  close. Otherwise it answers that no batch is ready and creates nothing.
  Tasks held by an uncertified dependency wait; the others are admitted at
  once.
- **Digest-aware base.** The base is the latest ancestor of the head certified
  for every current post-merge check, so adding or editing a check moves the
  base back instead of trusting an old green. With none, the base is the
  branch's fork point from the default branch.
- **A red must have run, and must reproduce, before any bisect.**
  1. A check that failed only because the heavy lock stayed busy never ran:
     the outcome is a lock timeout, nothing is bisected, blamed or counted.
  2. A failed check whose own clock evidence shows the machine slept is an
     environment failure: no bisect.
  3. Otherwise the failed checks run once more at the head as a probe. If any
     passes, the red did not reproduce: nothing is bisected or reverted, and
     the two records are the ledger's flaky evidence. A probe never
     certifies.
  4. A base that is not yet observed green is probed first; red there means
     the failure predates the batch and no task is blamed.
  5. A reproduced red is bisected over the per-task merge commits between the
     base and the head, re-running only the failed checks at each prefix.
     A foreign commit in the range, or a later merge that depends on the
     culprit, ends the run without a revert.
- **A tested and recorded revert.** The revert is built with a merge-aware
  `git revert` in a scratch worktree, with trailers naming the reverted merge,
  the task, the red record and the failing checks, so the evidence survives in
  git even if the log loses the record. The revert is tested with the
  pre-merge tier and the whole post-merge tier, both recorded at the revert
  commit, before the ref moves. It lands through the same path every queue
  landing uses (compare-and-swap, or a fast-forward of a clean holder). Only
  then is a `wave-reverted` event written.
- **Resume.** Every run first scans the integration branch from its fork
  point for bs revert commits with no `wave-reverted` naming them, validates
  their trailers, and ends each case terminally: a bounce when the task is
  still completed and still in the live plan, otherwise a record-only event
  with one reason from a single exported list. No outcome repeats forever.
- **Reopen.** The reverted task returns under the same id, with no operator
  approval. A reopened worktree attaches to the existing task branch,
  fast-forwards it to the integration head and commits a revert of the
  revert, so the original change returns as new history. The coder's brief
  quotes the revert's log: the failing checks, the log tail and the red
  record's event id. The bounce counts as one round on the S2 ladder.
- A culprit the live plan already dropped is never reverted. The outcome goes
  to the operator once, with everything needed to decide.

### Per-tier records and close

Every integration record written after this epic carries the tiers it ran,
the tree it tested, the checks that never ran, the run's clock evidence
index-parallel to its results, and two digests per result: the command alone
(the ledger's identity) and name plus command plus heavy plus timeout (the
certification identity). Probes never certify. With a checks file, close
requires every declared check of every tier certified and blocks once per
uncertified check, naming it, its tier and why. Without one, an epic whose
records use no tiers closes exactly as today, and an epic whose records use
tiers is refused until the file is passed, so a partial post-merge record can
never shadow a pre-release check.

At close the order is fixed: the proposal batch (part 3) is asked and applied
first, then a final post-merge run, then a run of every check still uncertified
at the clone root, so no check runs twice and the runs follow the tiers just
decided.

## 3. The learning loop

Status: planned.

The loop is a read-only fold over events the factory already writes. It adds
no table.

### The ledger's definitions

Per check per run it derives the duration, the outcome, the failure class and
whether the failure was a unique catch. A check is identified by its name plus
its command digest, so an edited command starts a new history.

- **not-run**: a failure because the heavy lock stayed busy. The command never
  ran, so it is no run, no minute, no red, no catch and no flaky evidence.
- **env**: a failed check whose own clock evidence fires the sleep classifier.
  Machine load never classifies.
- **flaky**: observed, never inferred. The same identity both passed and
  failed at the same tree.
- **real**: none of the above, followed by a pass at a different tree for the
  same task, or by the culprit's confirmed revert, where the diff touches a
  path other than the checks file. An unreadable diff counts as real.
- **unconfirmed**: a failure that ran and is none of the four above. It counts
  as a run with its minutes, never as a catch, and protects its check like a
  real catch does.
- **Unique catch**: a real failure where every faster check was observed
  passing on the same tree; otherwise it is shadowed. Severity is S1 when the
  task's claims overlap the sensitive-paths policy, else S2.
- **Guards a sensitive path**: ran on a task that touches one inside the
  window, or has a real catch or an unconfirmed failure on one at any age.
  Unknown claims count as sensitive: the guardrail fails closed.
- **Importance** is the sum over unique catches of a severity weight (S1 8,
  S2 4, S3 2, S4 1) divided by measured minutes; **flake rate** is flaky
  failures over runs. Every figure names the events it came from.

Malformed inputs only ever protect. A plan file the ledger cannot read is
skipped with a warning and its tasks then count as sensitive. A session log
it cannot read marks the ledger degraded and stops proposals until repaired.

### One question, one batch

Who is proposed: only an entry that declares no `tier`, currently pre-merge,
with at least `MIN_RUNS` (20) measured runs in the window, zero real catches
and zero unconfirmed failures there, no sensitive-path guard, at least
`MIN_MEASURED_MINUTES` (30) measured minutes, no live decision and no gate
stage bound to it. A declared tier is never a question; it is a notice.

The operator is asked once, as one batch, at epic close, never per check and
never per task. Every proposal option shows runs covered, minutes spent and
minutes saved, with a basis naming how each number was measured or estimated.
For a check over the window: R is its measured runs, M their minutes, d their
median, B the post-merge head runs (or, when there are none, the number of
task merges, the worst case of one merge per batch), and E the epics with a
merge. Keeping saves 0; moving to post-merge saves max(0, M - B x d); moving
to pre-release saves max(0, M - E x d). The pinned example: R = 26, M =
124.8, d = 4.8, B = 5, E = 1 gives 0.0, 100.8 and 120.0 minutes.

The reply is one or more tokens like `1b 3c`, or the word `none`. Letter `a`
is always keep, which declines; silence is never assent. The playbook writes
`decisions.json`, a bare array, and `bs checks apply` reads it:

```json
[
  {"proposal_id": "3f9a0c1d2b4e5f60", "check": "e2e", "decision": "approve", "to_tier": "post-merge"},
  {"proposal_id": "8b7c6d5e4f3a2b1c", "check": "unit", "decision": "decline", "note": "keep while the suite is being split"}
]
```

`decision` is `approve` or `decline`; `to_tier` is required on approve and
absent on decline; unknown keys, unknown or decided ids and duplicates are
refused.

### Guardrails the apply verb enforces

The verb enforces them, never only the prompt, and one validator is shared
with the proposal list so a batch never asks about a move apply would refuse.
It refuses the whole batch, appending nothing, for: a non-operator actor, a
reply that is not an array, a shape error, a check not in the file, a declared
tier, a stage-bound check, a sensitive-path guard, an S1 or S2 catch in the
window, an unconfirmed failure in the window, and an unreadable, tracked or
un-excludable overlay. Then it appends one decision event per item and writes
the overlay; the project's file is never written. Each accepted reply ends in
one batch-answered event, so the epic is not asked twice.

### Decline and promotion

- A decided proposal never resurfaces. A declined one stays quiet for
  `DECLINE_QUIET_DAYS` (90), as `/bs audit`'s declines do.
- Promotion is automatic and needs no question: a post-merge red that
  reproduced, was neither env nor not-run and bisected to a culprit moves each
  failing check back to pre-merge when its overlay tier came from an approved
  demotion. A declared tier is never moved automatically. A red that predates
  the batch promotes nothing. Promotion only ever moves a check earlier.

### Thresholds

The window is 30 days. Together with `MIN_RUNS`, `MIN_MEASURED_MINUTES`,
`POST_MERGE_BATCH`, `DECLINE_QUIET_DAYS` and the 8/4/2/1 weights above, they
are named, exported constants in v1, each with a comment naming this scope.
A policy file waits until a second project tunes them.

The dashboard stays display-only: decisions go through the CLI and the
playbooks.

## What does not move

No check is skipped, quarantined, retried or loosened, and no timeout is
raised: a tier changes when a check runs, never whether it runs before
release. main's merge rule, the gate's stages, the judges and the review
rounds are unchanged. The `checks` verbs are `bs checks post-merge`,
`bs checks ledger`, `bs checks proposals` and `bs checks apply`.
