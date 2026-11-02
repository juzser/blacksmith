# Epic bs-check-tiers: checks run in tiers, and the factory learns where each belongs

Status: **plan v2, signed off by the operator (1c 2a 3b 4a), pending ingest.**
v2 amends plan v1 (signed off 2026-10-28, `bs-check-tiers-2026-10-28#40`,
all six open questions at option a) against main `c13458d8`; the operator's
answers are `bs-check-tiers-run-2026-10-30#40`. Effort tier: huge (`budgets.yml`: epic cap 32M tokens,
alarm at 70% = 22.4M; every `task:` number x2, so the coder task cap is
440,000 tokens / 1,400 diff lines). Opening approved 2026-10-28
(`bs-optimize-2026-10-21#207`). Operator priority for every trade-off:
**quality first, speed second, tokens third.**

This is the living spec. Every worker reads it before starting. No worker
edits it, because it sits outside every task's claims: each worker puts one
Progress line in its result `notes`, and the epic session copies it in at
merge. The planner owns its accuracy.

## Goal

One mechanism in three parts, built so it works for any project on any stack
with safe defaults.

1. **Tier declaration.** Each entry in a project's `checks.json` may carry a
   `tier`: `pre-merge` (the default), `post-merge` or `pre-release`. An entry
   without `tier` is `pre-merge`, so an unlabelled project behaves exactly as
   today. `tier` sits beside `heavy` (heavy = run under the machine lock;
   tier = when it runs) and is validated fail-closed where the file is read.
   Tiers bs learns are kept in a bs-owned overlay, never written into the
   project's own file (D8).
2. **Where each tier runs.** `bs gate run` runs only the pre-merge tier; the
   merge queue tests the pre-merge tier when the checks declare tiers. After
   merges land on `bs/<epic>/integration`, the post-merge tier runs once per
   batch of merges, in a prepared scratch worktree. On a red that
   reproduces, bs bisects the batch's task merges, tests a revert of the
   culprit before landing it, lands it, and returns the task to its coder
   with the log. `bs epic close` needs every tier green at the integration
   head, pre-release included, so main never receives a red epic PR.
3. **Learning loop.** Per check per run, bs derives the duration, the
   outcome, the failure class (real, flaky, env, not-run or unconfirmed) and whether the
   failure was a unique catch. After enough runs it computes importance and
   flake rate and proposes moving costly, low-value checks later, with runs,
   minutes spent and minutes saved for every option. The operator is asked
   **once per batch**, and only about moves bs can apply. A demoted check
   that catches a real defect after merge is promoted back automatically.
   Guardrails are enforced by the verbs themselves, not by the prompt.

This is documented as a predefined architecture (a scope doc under
`docs/specs/`) that becomes a feature as the tasks land.

## Evidence this rests on

- **Research A** (`state/results/bs-check-tiers.research-pipeline.json`):
  hook points and claims. Code citations on `bs/bs-optimize/integration`
  (1d35c16f) and origin/main (59626bdc).
- **Research B** (`state/results/bs-check-tiers.research-loop.json`): the
  waivers batch as the approval model, the ledger's missing inputs, `bs new`
  scaffolding, doc placement. Code and repo-doc citations, no web sources.
- **CI loop study, 2026-10-28** (session scratchpad `ci-loop-report.md`,
  measured from GitHub data): CI takes 12.2 min median. `cli.test.ts` is
  about the whole orchestrator vitest run (398-712 s per run, 474 s median
  for the run). September's natural experiment over 400 merged PRs:
  post-merge `main` was red 83% (15/18) when the PR merged red, 44% (7/16)
  when it merged while CI ran, and 6% (21/364) when it merged on green.
  `main` was red about 42 h that month and 23 PR runs inherited the red.
  The same study counts 5 flake or infra `main` reds since 2026-10-09 that an
  auto-revert bot would have reverted wrongly, which is why a red must
  reproduce, and a check must have actually run, before anything is
  reverted (D4).
- **Speed forecast, 2026-10-27** (scratchpad `forecast-bs-review-speed.md`,
  measured on bs-review): full-suite runs held the machine 49.4% of awake
  time, about 73.4 heavy minutes per merged task (gate 20.0 min, tester
  check.sh 12.2 + suite 7.7 min, merge-queue suite 7.8 min, plus re-runs).
  bs-optimize keeps every run and serialises them; the next lever is running
  the costly ones less often per task, without running them less often per
  release.

So post-merge testing happens only on the integration branch, never on main.
main stays merge-on-green; this epic does not change main's merge rule.

## Base: bs-optimize and bs-gate-bounce have landed

Both epics are on main (bs-optimize #501, bs-gate-bounce #510), with the CI
quick wins (#502) and the diff-cap fix (#511). main is at `c13458d8`, and
plan v2's claims are cut against it:

| Upstream | What this epic consumes | Shared files |
|---|---|---|
| bs-optimize (#501, merged) | `checks.json` `heavy`, `isHeavyCheck`, the heavy lock in `testgate.run` (re-entered only through `BS_HEAVY_LOCK_TOKEN`, which `heavyChildEnv` puts in a held lease's env) and its `heavy.wait-timeout` result, the queue's `step` holding the lock from rebase to merge, `bs heavy run`, rolling admission (`admission.ts`, `waveNext.ts`; the epic session admits at once on each landing) | `testgate.ts`, `cli.ts`, `usage.ts`, `queue.ts`, `projector.ts`, `taxonomy.yml`, `.claude/skills/bs/*.md`, `CHANGELOG.md` |
| bs-gate-bounce (#510, merged) | `RunResult.environment`, a `CheckEnvironment[]` index-parallel to `results` (`name`, `window`, `wall_ms`, `monotonic_ms`, `clock_gap_ms`, loads, `cpus`), which gate.ts writes as `testgate-result.payload.environment` beside `results` (no result carries its own); the pure sleep classifier `sleptDuringCheck` and `SLEEP_GAP_MS`, `error_class: execution.env-failure`, `bs results check` parsing the gate line's checks file, `bs brief compose --checks` listing the gate's checks; gate.ts keeps every export, so `checkWorktreeDeps` stays importable | `testgate.ts`, `gate.ts`, `cli.ts`, `usage.ts`, `wave.md`, `queue-and-gate.md`, `CHANGELOG.md` |
| CI quick wins (#502, merged) | this repo's `.github/workflows/ci.yml`: one gate script (`scripts/check.sh`) as the CI gate, e2e in shards with a cached Chromium download, a non-fatal screenshot upload, PR-scoped cancel-in-progress; task-18 carries them into the scaffold | none (task-18 reads it) |
| diff-cap fix (#511, merged) | `diff_lines` counts non-test lines only (`diffstat.ts` `isTestDiffPath`); test lines are measured as `testLines` and never capped | none |

Every worktree in this epic is cut from main at `c13458d8` or later. A task that
finds an upstream export named here missing stops and reports it; it does not
re-implement it.

Git floor: every git mechanism in this epic works on git 2.38, the floor
`bs install check` states (installCheck.ts:217). No task uses
`merge-tree --merge-base` (git 2.40).

## Decisions

### D1. A reverted task returns through a new `wave-reverted` event

`wave-merged` is terminal today: the projector folds the row to `completed`,
and every later event skips terminal rows (Research A F9). Two ways back:

- **Plan amend** (supersede plus successor): needs spec-scoped findings,
  `--sites`, a new plan version, and in practice an operator tick per amend.
  The task's contract did not change; the merged code broke a later check.
  It also mints a new task id, which loses the bounce ladder's round count.
- **`wave-reverted` (chosen).** A new `graph_event`, written by the
  post-merge verb for a revert that landed. Same task id, same plan version,
  no operator approval, so a revert never adds a per-task question. The
  bounce counts as one round on severity.yml's S2 ladder (2 rounds -> model
  tier, 3 -> operator). A revert is an appended commit on a factory branch,
  never a history rewrite, and main is never touched.

**The task reopens everywhere the lifecycle is read**, not only in the
projector. `finishedInLog` (taskLifecycle.ts) is the one reader the others go
through: `creditableTaskIds` (goalCheck.ts), `markFinishedFromLog` and
`draftNextVersion` (plan.ts, called from specChange.ts and spec.ts). A task
whose latest `wave-merged` is followed by a `wave-reverted` with
`disposition: bounce` is not finished (a `record-only` event, D4's resume
exit, records a revert without reopening anything):
an amend keeps it live in v(n+1), a goal-check does not credit it, epic
readiness is false, `bs wave next` offers it and admission accepts it.
`reinstatementBlocker` treats a reverted merge as no merge. The projector
folds `completed` back to `todo` like the existing `task-reinstated`
corrective, and a later `wave-merged` completes it again.

**Re-cut path.** Re-merging a reverted branch brings nothing back: its
commits are already ancestors of the integration head. So the coder's
branch is reopened, not recreated:
`bs worktree create <project> <epic> <task> --reopen --revert <revert-sha>`
attaches a worktree to the existing task branch (or reuses a clean one),
fast-forwards the branch to the integration head (the old tip is an ancestor
of it, so this is never a rewrite), and commits `git revert <revert-sha>`, so
the original change returns as new history. It refuses a dirty worktree, a
branch tip that is not an ancestor of the head, and a revert sha that is not
on the integration branch. A deleted task branch is cut fresh from the head,
then the same revert commit is made.

**The coder is told why.** wave.md step 9's brief for a reopened task quotes
the latest `wave-reverted` for it: `failing_checks`, `log_tail` and the red
record's event id. The fix goes on top of the re-apply commit.

### D2. The queue keeps today's command unless the checks declare tiers

`bs queue run` runs one `--test-cmd` string today (Research A F6), with
`--select-test-cmd` to narrow it. The queue gains `--checks <file>`, and the
playbook always passes it beside today's flags. The queue decides,
mechanically, from the effective tiers (declared plus overlay, D8):

- **No entry in a later tier** (an unlabelled file with no overlay moves,
  or an empty file): `--test-cmd` and `--select-test-cmd` run exactly as
  today; the file is only validated. An unlabelled project keeps today's
  queue command and cost.
- **An entry in post-merge or pre-release**: the pre-merge tier, run through
  `testgate.run`, is the pre-landing test in sequential and `--batch` mode.
  Neither `--test-cmd` nor `--select-test-cmd` is run, and the landing event
  says so (`test_cmd_not_run`, `select_test_cmd_not_run`). Selection narrows
  one command string and the tier is a list, so it does not apply; not
  running it means the full pre-merge tier runs, never less. The flags stay
  accepted, so a playbook line that passes them never fails with
  `cli.invalid-flag` after an approved demotion. Otherwise the project's own
  cumulative command would keep running its demoted full suite per task.

The landing and blocked events record `pre_landing: test-cmd | pre-merge-tier`
and, for the tier, a `pre_landing_run_id`. Every tier run the queue makes
writes one `queue-tier-run` record when it finishes (its `task_ids`,
`tree_sha`, results and `environment` side by side, a red multi-task
`--batch` candidate included), and the landing and blocked events name it by
that id, so the ledger measures queue runs rather than estimating them and
counts each run once. The tier runs
under the heavy lock the queue already holds: `step` holds it from rebase to
merge, so the tier run's lock env is `heavyChildEnv` of that lease and each
heavy check re-enters it instead of waiting on it; a `--batch` candidate
takes the lock once for its whole tier run, as `runTestCmd` does today.

### D3. Where each run happens, and how its worktree is prepared

- **`bs integration check`**, with or without `--tier`, keeps today's
  clone-root contract: the clone must be on the integration branch with a
  clean tree. The close-time run therefore uses the operator's prepared
  clone, and an unlabelled project closes exactly as today.
- **Post-merge runs** (`bs checks post-merge`, mid-epic, while other work is
  live) never touch the clone. They run in a detached scratch worktree at the
  commit under test, created under the `.wt/<project>/` root the queue's
  `--batch` candidates use and always removed. Preparation, in order:
  `--setup-cmd "<cmd>"` when given (the playbook passes the same install
  command it runs in task worktrees; its result is recorded as `setup`, never
  as a check); then the gate's own deps check (`checkWorktreeDeps`, P9-16).
  A failed setup or a deps block is outcome `setup-failed`: nothing is
  bisected, nothing is reverted, the record is not a pass. Bisect probes and
  the revert candidate are prepared the same way.
- Safe default: a project with no post-merge entry never creates a scratch
  worktree (`no-checks-in-tier` comes first). Heavy checks take
  bs-optimize's heavy lock through `testgate.run` wherever they run.

### D4. The post-merge batch: when it runs, and what a red must prove

**The branch.** The only ref `bs checks post-merge` reads, probes or moves is
`integrationBranchName(epic, epicBranchPrefix(project, epic))`, which must
have the shape `<prefix>/<epic>/integration` and must not be the default
branch (`detectDefaultBranch`); anything else is refused with
`postmerge.not-integration-branch` before any worktree is made.

**Certification is per check (D5).** A commit is certified for a check when a
non-probe integration record at that commit holds a passing result for it
whose `check_sha256` (name, command, heavy, timeout) equals the current
check's. A tier move never changes `check_sha256`, so it never invalidates a
result; an edited command, heavy flag or timeout does.

**The base.** The latest ancestor of the head that is certified for every
current post-merge check. When none is (a check was added or edited since),
the base is the integration branch's fork point from the default branch,
which is not yet observed green. `no-new-merges` is returned only when the
head itself is certified for every current post-merge check.

**Trigger, enforced by the verb.** The epic session, the only session that
admits (run.md rolling admission), starts `bs checks post-merge` on each
landing as a background task it waits on. Meanwhile it admits every task
`bs wave next` returns that the read-only `bs checks post-merge --held`
does not list, and admits the held ones after a proceed outcome: one of the
five outcomes the verb exits 0 on (`green`, `reverted`, `no-checks-in-tier`,
`no-new-merges`, `batch-not-ready`), after which it re-reads `--held` and
admits what that no longer lists (2010bf19). A held task
is a not-yet-admitted task with a plan dependency on an uncertified merge:
the dependency arm's set, computed by one function (`heldByPostMerge`).
`bs wave check` refuses a held task with `wave.held-by-post-merge`, and on an
epic whose records use tiers (task-5's `lastTieredRecordId`, the predicate
the close refusal uses, so a post-merge, a pre-release-only and a probe
record all count; 5bad56cc) refuses a check without `--checks` with
`wave.checks-required` (OQ-v2-1, answered (c), `bs-check-tiers-run-2026-10-30#40`).
Both read the `integration-check` records of the epic session's lineage
(`--session`, `--state-dir` honoured), where the batch and the close-time
runs write them, so every one of these lines carries `--session` (dc4b6bce); a `wave check` without it admits nothing (AC6, 873a98f6). The runner never
calls the verb. The verb decides whether to run. It runs when any of these holds,
counting only task merges since the base ("uncertified merges"):

1. **Dependency arm.** A task of the epic that is not yet admitted (`todo`
   or `ready`) has a plan dependency on an uncertified merge. Dependents are
   never built on unverified work, which is what makes the automatic revert
   possible for chain plans: the culprit has no merged dependents.
2. **Batch arm.** At least `POST_MERGE_BATCH = 4` uncertified merges.
3. **Idle arm.** No admitted task of the epic is in flight, not counting
   tasks the operator holds open (`failed`, `escalated`;
   `HELD_OPEN_BY_AN_OPERATOR`). A stuck task does not postpone the others'
   certification to close.
4. **`--final`** (run.md step 12, before close). It is an arm, so it never
   returns `batch-not-ready`; a head already certified for every current
   post-merge check still returns `no-new-merges` first and runs nothing
   (08764ccf).

Otherwise it returns `batch-not-ready` and creates nothing. For a chain plan
the dependency arm fires after nearly every merge, so the batch is small and
the saving is smaller; D7's formula measures the batches that really ran, so
a proposal never claims a saving the trigger cannot deliver. The ledger
reports merges per post-merge run.

**A red must have run, and must reproduce.** On a red head run:

1. Any failed check with `reason: heavy.wait-timeout` never ran its command
   (the heavy lock was busy): outcome `lock-timeout`. Nothing is bisected,
   blamed or recorded as a catch; the playbook calls the verb again after the
   lock frees. The same applies to a wait-timeout in any probe or in the
   revert candidate's test: the run stops with `lock-timeout` and moves no
   ref.
2. Every failed check env-classified by bs-gate-bounce's classifier (its own
   `clock_gap_ms >= SLEEP_GAP_MS`) -> `env-failure`, no bisect.
3. Otherwise the failed checks are re-run once at the head, as a probe. If
   any passes, the outcome is `not-reproduced`: nothing is bisected or
   reverted, no task is blamed, and the two records are the ledger's flaky
   evidence (same check, same tree, both outcomes). A probe never certifies,
   so the head stays uncertified.
4. A base that is not yet observed green is probed first; red there ->
   `red-at-base` (here the failure predates the batch; no task is blamed).
5. A reproduced red is bisected over the per-task merge commits
   (`Merge <task-id> into <branch>`) between the base and the head, re-running
   only the failed checks at each prefix as probes. The culprit is the first
   merge whose prefix is red after an observed-green prefix. A commit in the
   range that is neither a task merge nor a bs revert commit (trailers below)
   -> `batch-has-foreign-commit`; a bs revert commit never is. A later merge
   with a plan dependency on the culprit -> `revert-has-dependents`. When
   every task-merge prefix is green and the head is red only after a landed
   bs revert commit, there is no culprit: the outcome is `red-at-base` too,
   no task is blamed, nothing is promoted (AC10), and the result's
   `red_after_revert` names the revert shas (d1a46ec1).

**The revert is built, tested and recorded before the ref moves.**

1. Preflight: task-2's `waveRevertBlocker` must report nothing for the
   culprit (it is `completed`, its merge is on the log, it is not
   superseded, and the live plan still holds it); otherwise
   `revert-not-applicable` with the reason, nothing built. Then the
   effective checks must hold a pre-merge entry, because step 3 tests R
   with that tier (D10 refuses an empty pre-merge selection elsewhere);
   otherwise `revert-not-applicable` with reason `no-pre-merge-checks`:
   nothing is built and no ref moves, but the culprit is still returned,
   so AC10's promotion still runs (9c2b1d5e).
2. Build: in a scratch worktree detached at the head,
   `git revert -m 1 --no-edit <culprit-merge>` with a message carrying the
   trailers `Bs-Revert-Of: <merge-sha>`, `Bs-Task: <task-id>`,
   `Bs-Red-Record: <event-id>` and `Bs-Failing-Checks: <name>,...`, so the
   revert's evidence survives in git even if the log loses the record (git
   2.38 has this; no `merge-tree
   --merge-base`). A conflict is aborted -> `revert-conflict`.
3. Test the revert commit R with the pre-merge tier (what the queue tests
   before any landing) and the whole post-merge tier, prepared as in D3; any
   real red -> `revert-red`. Both runs are written as certifying records at
   R, so R is never tested twice.
4. Land R through queue.ts's `landCandidate`, the path every queue landing
   uses: compare-and-swap when no worktree holds the integration branch, a
   fast-forward of a clean holder (the clone or the epic worktree) so its
   tree follows the ref, and `integration-dirty` with nothing landed when the
   holder has tracked changes; a moved ref -> `integration-moved`.
5. Write `wave-reverted` with `disposition: bounce` -> `reverted`.

**Resume, with a terminal exit for every case.** Step 5 can still fail after
the ref moved (a crash, or the task changed in between). So every
`bs checks post-merge` run begins with one scan, defined once (task-7
`landedBsReverts`, used by task-16's resume) and used by both the resume and the bisect's
foreign-commit check: every first-parent commit from the integration
branch's fork point from the default branch to the head whose message
carries a `Bs-Revert-Of` trailer. Its bound never depends on the base, so a revert
whose own records made it the base is still found. For each bs revert commit
R with no `wave-reverted` naming R:

The trailers are validated first: `Bs-Revert-Of` 40-hex and a merge
commit on the integration branch's first-parent history, `Bs-Task` a task id
of this epic (qualified or bare), `Bs-Red-Record` an event id that parses,
`Bs-Failing-Checks` a non-empty list of names. Then:

- the trailers are valid, the task is still `completed`, its merge is on the
  log, it has not been merged again since R, and the live plan still holds
  it (`waveRevertBlocker` null):
  write `wave-reverted` (`disposition: bounce`) -> `reverted` with
  `resumed: true` on the verb's result; the task reopens. `failing_checks`
  come from the trailer, the log tail from the red record when it can be
  read, and `evidence: record` or `evidence: trailers-only` says which.
- otherwise: write `wave-reverted` with `disposition: record-only` and one
  reason from the single list task-2 exports (`RECORD_ONLY_REASONS`):
  `superseded`, `re-merged`, `not-merged`, `not-in-live-plan`,
  `unknown-task`, `invalid-trailers` (plan v4 removed `waived` and
  `held-by-operator`, which no real log reaches) -> `revert-recorded`,
  exit 1, naming the
  task (when known), R and the reason, so the operator learns once that the
  revert stands without a bounce. A record-only event needs only
  `revert_sha` (R's own sha, always valid), `integration_branch`,
  `disposition` and `reason`; `task_ids` is the named task or empty,
  `reverted_merge_sha` the trailer's value or null, and `failing_checks`,
  `evidence_event_ids` and `log_tail` may be empty with
  `evidence: unreadable`. So `recordWaveReverted` always accepts it, except
  as a second record for the same R, which the scan never asks for. A
  `record-only` event never reopens a task (D1).

**A culprit the plan already dropped is not reverted.** The batch can wait
several merges, so a plan amendment can land between a task's merge and the
batch that blames it, and `draftNextVersion` (plan.ts) drops a finished task
from v(n+1). A bounce would then reopen the task in the projector only:
`bs wave next`, readiness and goal-check read the live plan, which no longer
holds it, and its change would already be gone from integration. So
`waveRevertBlocker` takes `liveTaskIds` (the live plan's records that are not
`superseded`, read from the plan file `bs wave next` reads) and returns
`not-in-live-plan` for a culprit outside them. The preflight then builds
nothing: the culprit's change stays on the integration branch, the head stays
uncertified, so close keeps refusing, and the outcome goes to the operator
once, carrying the culprit, the failing checks and the red record. The answer
is one of three things, each of which re-certifies the head: a plan
amendment that re-adds the task (`draftNextVersion` accepts an added id the
previous version does not hold live, so the next batch reverts and bounces
it), a plan amendment adding a task that fixes the defect, or an edit to the
failing check. No verb waives a red tier, so no waiver is offered. The other order (the revert landed, then
an amendment dropped the task before the record was written) ends in the
resume as `record-only` with reason `not-in-live-plan`, told once like every
record-only exit; re-adding the work is again an amendment, whose new task
can restore the change with `--reopen --revert R`. The bounce never adds the
task back itself. That would give two answers to "does this task exist" (the
plan file and the log), and it would amend a plan with no planner and no
operator, which architecture §12 forbids. "Ask the operator once" holds:
one stop per culprit, with everything needed to decide, and no revert and no
plan version the operator did not choose.

**Re-merged is decided from the log and git, never from event order.**
From this epic on, every `wave-merged` the queue writes carries `merge_sha`,
the merge commit that landed the task on the integration branch (task-4).
A task counts as re-merged after R exactly when some `wave-merged` for it
carries a `merge_sha` that has R as an ancestor. The merge R reverts can
never qualify: R was built on a head that contains that merge, so the merge
is an ancestor of R, and a commit cannot be both an ancestor and a strict
descendant of R. A `wave-merged` without `merge_sha` (written before this
epic) is never counted as a re-merge, because a merge recorded before this
epic cannot have R, a commit this epic creates, as an ancestor.

After either write, R has a `wave-reverted` naming it, so the next run's scan
passes it and the verb continues to the normal flow. No outcome repeats
forever, and there is no state in which a revert landed and the log carries
no record of it after the next run.

Every outcome other than `green`, `reverted`, `no-checks-in-tier`,
`no-new-merges` and `batch-not-ready` moves no ref, and only `reverted` and
`revert-recorded` write `wave-reverted`.

### D5. Integration records carry per-check identities, and close certifies every declared check

`testgate.run` sets two digests on every result: `cmd_sha256` (the command
alone, the ledger's identity, D6) and `check_sha256` (name, command, heavy
and timeout, the certification identity). Every `integration-check` record
written after this epic also carries `tiers` (the tiers whose checks this run
executed, an array), `tiers_present`, `tree_sha`, `not_run` (names that
failed with `heavy.wait-timeout`), `environment` (the run's
`RunResult.environment`, index-parallel to `results`, as gate.ts writes it on
`testgate-result`), and `probe_of` on probes. A record names the commit its checks ran at:
for a scratch run `head_sha` is that commit and `tree_sha` its tree, filed
under the integration branch name, so a record at a revert candidate
certifies it once it lands (a5a7af62).
`bs integration check --tier` takes one tier, `all`, or `remaining`: every
current check (any tier) the head is not certified for (D4), run together as
one record.

`bs epic close` and `bs epic verdict` take an optional `--checks <file>`
(task-14 passes it as task-6's `EpicVerdictInput.checks`). Which rule applies
depends only on whether it was passed. This replaces the outcome table of
plan v2 review rounds 7 to 11; see "Re-specification of task-5 and task-6 —
changes" below.

- **With `--checks`** (every close the factory runs: run.md always passes
  it). The required checks are the declared ones, every check of every tier
  in the effective checks, and nothing in the records can add to, drop from
  or shadow that set. Each must be certified at the current head. An empty
  declaration blocks once; an unreadable head blocks once; otherwise each
  uncertified check is one blocker naming the check, its tier and one
  reason, in declaration order. An epic with no record at all therefore
  blocks once per declared check. A record written before this epic carries
  no `check_sha256` and certifies nothing: a deliberate change from main,
  cured by `--tier remaining`, which then runs every check.
- **Without `--checks`.** On an epic whose records use no tiers (records
  written before this epic, and every record of an unlabelled project, whose
  `tiers` and `tiers_present` are both `['pre-merge']`), the close is main's:
  the single last-wins record, today's blocker strings and today's
  `summary.integration.check`, byte for byte (hard constraint 1). On an epic
  whose records use tiers (a `probe_of` key, or `tiers` or `tiers_present`
  other than a non-empty list of only `pre-merge`, malformed values
  included), the close is refused with one blocker that names the latest
  such record and asks for `--checks`. There, main's last-wins record is
  typically a post-merge batch run or a probe that ran part of the checks,
  and certifying the epic on it is the shadowing d6c28b83 describes. The verb
  refuses rather than trusting the playbook to pass the flag (hard
  constraint 7), the way `bs wave check` already refuses to run without
  `--checks` on an epic whose records use tiers, by this same predicate
  (task-14; 5bad56cc).

**Certified**, defined once (task-5's `certifyChecks`, also read by
`--tier remaining` and by the bisect base): a check, named with its
`check_sha256`, is certified at commit C when the last matching result at C
passed and did not time out on the heavy lock. Matching results come from the
epic's `integration-check` records that are not probes (no `probe_of` key at
all) and whose `head_sha` is C, and carry the check's name and exactly its
`check_sha256`. "Last" is the order of the lineage events the caller read,
never `ts`. A pass followed by a fail is not certified. A field of the wrong
type takes that record or result out of the evidence, so a malformed record
can withhold certification and never grant it.

**Reason**, for an uncertified check: `failed` or `not-run` from the deciding
result; with no matching result, `changed` when C has a result for the name
under another `check_sha256`, else `no-result`.

**What readers see.** `summary.integration.check` is main's record without
`--checks`, and the last non-probe record at the head with it, so on every
close that passes it sits at the head, and run.md's PR fact pack, which
selects records by `summary.integration.check.head_sha`, needs no change
(80191705). With `--checks` the judge prompt lists each declared check with
its command and exit code, and the `epic-closed` payload's `integration`
gains `declared`; without it both are main's, plus `tiered_record_id` when
the refusal applies. The exact strings and types are in task-6's objective.

A tier move changes when a check runs, never what it runs, so it never
invalidates a result: the operator's answer to the proposal batch never
forces a re-run, and a result at the head for the exact command is never
stale. A post-merge pass cannot stand in for a pre-release check, because
certification names each check.

At close, run.md first asks and applies the proposal batch (D7), then step
12 runs `bs checks post-merge --final` (certifying the post-merge checks in a
scratch worktree) and then `bs integration check --tier remaining` at the
clone root, so no check runs twice and the runs follow the tiers just
decided. For an unlabelled project the first returns `no-checks-in-tier` and
the second runs the whole file, exactly today's close.

### D6. The ledger: inputs, identity, classes, catches, severity, guards

The ledger is a read-only fold over events (`testgate-result`,
`integration-check`, `queue-tier-run`,
`wave-reverted`), like bs-optimize's `bs stats effectiveness`. No new table.

- **Inputs** (task-13). Flags across the `checks` namespace mean what they
  mean on every existing verb: `--project <dir>` is the project directory,
  `--specs-dir <dir>` the parent holding `<epic>/plan.json` and
  `<epic>/plan-v<n>.json`, `--state-dir <dir>` the event store, `--now` the
  clock. The project scope is the `project` field of the readable plans
  under `--specs-dir`; more than one distinct value is refused with
  `checks.mixed-projects`. Events: every session log in the state dir, kept
  when the event belongs to one of those epics, or when its session's
  lineage touches one of them (an event whose own task id cannot be
  qualified is kept as `unattributed`, never dropped), across lineages.
  The reader does not filter by time: the window applies to the cost and
  benefit numbers only (runs, minutes, flake rate, importance, the D7
  formula, and the "S1 or S2 catch recently" guard), while the
  sensitive-path guard reads catches over every kept event, as "ever"
  requires.
- **Task ids.** The log mixes bare (`task-3`) and qualified (`epic/task-3`)
  ids. Every event's task id is qualified before any join: a qualified id as
  is; a bare id with the epic of its session (the one epic its session or
  lineage names); otherwise `unattributed`. Claims are keyed by qualified id
  (latest spec across the plan files, then `task-added` for follow-ups).
  An unattributed task, or one with no claims entry, counts as touching a
  sensitive path: the guardrail fails closed, as an unreadable diff does.
- **Malformed inputs, scoped so they only ever protect.** The ledger reads
  four fields of a plan: `project`, `tasks`, each task's `task_id` and
  `claims`. A plan file that does not parse or lacks them (an old schema, a
  half-written draft) is skipped with the warning `checks.plan-skipped`
  naming the path; full plan validation is not required. Skipping is
  fail-safe: the epic's events are still kept (they name the epic), and its
  tasks have no claims entry, so they count as sensitive and protect every
  check that ran on them. Only a specs dir with no readable plan stops the
  ledger (`checks.no-plans`). A session log `readEvents` cannot read is
  different: a lost line could hide a catch, and hiding a catch is the unsafe
  direction. So the ledger still prints, marked `degraded` with the file
  named (`checks.session-unreadable`), `bs checks proposals` returns no
  items and a notice until it is repaired, and automatic promotion, which
  only moves checks earlier, still runs.
- **Identity**: check name plus `cmd_sha256`, which `testgate.run` sets on
  every result (gate, queue and integration alike). Rows written before this
  epic have no digest: they count toward catches and guardrails, never toward
  runs or minutes, so missing history can only protect a check. A name-only
  unconfirmed failure protects the same way: it counts in that check's
  unconfirmed failures and in the sensitive-path guard's catch arm (cb11d7ec).
- **not-run**: a failure with `reason: heavy.wait-timeout`. The command never
  ran, so it is no outcome at all: never a run, a minute, a red, a catch or
  flaky evidence; it is counted only as `not_run`.
- **env**: a failed check whose own `CheckEnvironment` (the entry at its
  index in the record's `environment` array, never a field of the result)
  fires bs-gate-bounce's classifier `sleptDuringCheck`. Load never
  classifies. A run's duration is that entry's `monotonic_ms`; an absent,
  mismatched or `window: 'none'` entry is unmeasured.
- **flaky**: observed, never inferred. The same identity both passed and
  failed at the same `tree_sha` (the D4 head re-run, a re-gate at the same
  HEAD, a queue candidate and its landed tree).
- **real**: none of the above, followed by a pass of the same identity at a
  different tree for the same task, or after the culprit's confirmed revert,
  where the tree diff (`git diff --name-only --no-renames`) touches a path
  other than the checks file. An unreadable diff counts as real: an
  unverifiable catch protects the check, never exposes it.
- **unconfirmed**: a failure that ran and is none of the four above: no
  later pass of its identity at a different tree for the same task whose
  diff touches a path other than the checks file, and no confirmed revert of
  its culprit (a red still unresolved, or one cured only by editing the
  checks file). It counts as a run with its minutes, never as a catch or
  flaky evidence (no real or unique catch, no importance). Being
  unverifiable, it protects the check as a real catch does, by the rule
  that lets an unreadable diff count as real: it blocks a proposal under
  D7 (its own reason, whatever its severity), and it counts in the
  sensitive-path guard's catch arm (c9adc1ac). The five class strings are one exported
  list (task-8's `FAILURE_CLASSES`), decided in the order not-run, env,
  flaky, real, unconfirmed (3661495f).
- **unique catch**: a real failure of C where every faster check that would
  have run beside it was observed passing, in the same record or at the same
  tree.
  Records never name a check `run()`'s short-circuit skipped, so that set
  comes from each check's own records: a check with a lower median duration
  so far whose tier, read from its latest single-tier record at or before
  the catch's record (a record with no tier counts as pre-merge), is one
  the catch's record ran. A record with more than one tier never decides a
  check's tier; its results still count as runs, catches and evidence. A
  check of that set left unobserved makes the catch `shadowed`. A check
  with no single-tier record at or before the catch shadows nothing, so
  this is the one place the ledger can over-count a unique catch
  (71a5b931). A post-merge catch is unique against the pre-merge tier,
  which passed on the landed tree.
- **severity**: `S1-stop-the-line` when the caught task's claims overlap
  `factory/policies/sensitive-paths.yml` (security.ts `claimTouchesGlob`, as
  `bs security triggers` matches), else `S2-major`.
- **guards a sensitive path**: the check ran, with any outcome other than
  not-run, on a task gate or queue landing of a task that touches a
  sensitive path (as above, fail closed) inside the window, or has a real
  catch or an unconfirmed failure on such a task in any kept event, however old. Exposure, not only catches: a security check
  that never failed is still protected (OQ3).
- **importance** = sum over unique catches of a severity weight (S1 8, S2 4,
  S3 2, S4 1) / measured minutes; **flake rate** = flaky failures / runs.
  Window: last 30 days. Every figure names the event ids it came from.
  Importance is reported for every check in the ledger and on every proposal
  item. Eligibility for a proposal is the stricter rule of D7 (zero real
  catches and zero unconfirmed failures in the window), so an eligible item's importance is always 0; the
  figure is shown so the operator sees why other checks are not proposed,
  and it is the input a later threshold rule would use.

### D7. One proposal batch, modelled on waivers

**Who is proposed.** Only a check bs can actually move: an entry that
declares no `tier` in the project's file (its effective tier comes from the
default or the overlay, D8), currently pre-merge, with at least
`MIN_RUNS = 20` measured runs in the window, zero real catches and zero
unconfirmed failures in the window (an unconfirmed failure protects as a
real catch does, D6; c9adc1ac), no sensitive-path guard, at least `MIN_MEASURED_MINUTES = 30`
measured minutes, no live decision, and not stage-bound (D9). Proposals and
apply share one validator, so the batch never asks about a move apply would
refuse. A check whose tier the project declares is never a question:
`bs checks proposals` lists it under `notices` (for example a declared
post-merge check with a real catch: "consider moving it in your file").

**Minutes saved, per option.** For check C over window W:

- R = measured runs of C in W in its current tier, from task gates, queue
  landings and close-time integration runs; M = their summed minutes; d =
  their median minutes.
- B = post-merge head runs for the project in W, `--final` runs included,
  when there is at least one (`measured`); else the number of task merges in
  W (`estimated`: the worst case of one merge per batch, so a saving is never
  overstated).
- E = distinct epics with at least one merge in W (one pre-release run each).
- Demote item: keep saves 0; post-merge saves max(0, M - B*d); pre-release
  saves max(0, M - E*d).
- Every option shows `runs_covered` = R, `minutes_spent` = M,
  `minutes_saved`, and a `basis` naming R, d, B and E and whether each was
  measured or estimated. Bisect probes and not-run results are excluded and
  named in `basis`. Minutes round to 0.1.

Example the test pins: R = 26 (25 gate and queue runs plus 1 close run),
M = 124.8, d = 4.8, B = 5 (measured), E = 1 -> keep 0.0, post-merge 100.8,
pre-release 120.0. With no post-merge runs and 20 merges in W, B = 20
(estimated) and post-merge saves 28.8.

**Proposal shape** (`bs checks proposals`; it writes only what `reconcileOverlay` owes, D8): `proposal_id` (first
16 hex of sha256 of `check|cmd_sha256|from_tier`), `check`, `cmd_sha256`,
`from_tier`, `options` (each `{to_tier, runs_covered, minutes_spent,
minutes_saved, basis}`; `keep` is `to_tier` = `from_tier`), `flake_rate`,
`importance`, `real_catches`, `evidence_event_ids`; plus `notices`, the
overlay report of D8, and `answered_in_epic` (below). Items are ordered by
their post-merge `minutes_saved`, largest first, then by `check`. The
`bs checks proposals` verb runs `reconcileOverlay` under the overlay lock,
only when `overlayOwes` reports a write to make (D8), before the pure
`pendingProposals` fold; it writes nothing else, and on a consistent overlay
it takes no lock and writes nothing at all. The fold reads only its
arguments: the ledger, the events, the effective checks, the overlay as
read, and `{epicId, writable, now}`, where `writable` is `overlayWritable`'s
answer for the project and `epicId` the `--epic`, both computed by the verb,
so the fold runs no git command and opens no file. `bs checks ledger` never
reconciles and never writes.

**decisions.json**, written by the playbook from the one answer and read by
`bs checks apply`, is a bare array:

```json
[
  {"proposal_id": "3f9a0c1d2b4e5f60", "check": "e2e", "decision": "approve", "to_tier": "post-merge"},
  {"proposal_id": "8b7c6d5e4f3a2b1c", "check": "unit", "decision": "decline", "note": "keep while the suite is being split"}
]
```

`decision` is `approve` or `decline`. `to_tier` is required on `approve`,
must be one of that item's non-keep options, and is absent on `decline`.
`note` is optional. Unknown keys, an unknown or decided `proposal_id`, a
`check` that does not match the proposal, and duplicates are refused. Items
not in the array stay pending.

**Apply.** `bs checks apply decisions.json --checks <file> --project <dir>
--specs-dir <dir> --epic <id> --actor operator` refuses a reply that is not an
array, and a non-operator actor, before any lock (55ecfc3c); it then takes the overlay lock, reconciles the
overlay (D8), re-runs the proposal validator over the current log and refuses
the whole batch if any item fails it, or if the overlay is not writable: a
non-operator actor, a shape error, a check not in the file, a declared tier,
a stage-bound check, a sensitive-path guard, an S1 or S2 catch in the
window, an unconfirmed failure in the window, an unreadable, tracked or
un-excludable overlay. A refusal appends none of the batch's events
(no `check-tier-decided`, no `check-tier-batch-answered`) and writes none of
its decisions; the only changes it may leave are the reconcile's repair of
what the log and the overlay already owed and the empty `.blacksmith/`
directory the lock creates when it is absent (git tracks no empty
directory), so on a consistent overlay it changes neither the log nor the
overlay (0cb51329, 6376bd4d). A validator refusal
is only possible when the log changed between the question and the answer,
and it names the item and what changed; the overlay refusals are checked
before the question is asked, so they surface as a notice, never as a
refused answer. Then, in this order, it appends one `check-tier-decided` per
item and writes the approved tiers into the overlay (D8's crash order: a
crash between leaves the checks in their earlier tier, and the next
reconcile writes them); the project's file is never written. A decided proposal never resurfaces; a declined one stays
quiet for `DECLINE_QUIET_DAYS = 90`, like `/bs audit`'s expiring decline.

**One question.** The playbook asks the whole batch as one question at
epic close (OQ5), before step 12's close-time runs (D5), each item with its
options' runs, minutes spent and minutes saved. Items are numbered 1..n in
the proposals' order and each item's options are lettered in its `options`
order (`a` is always keep). The reply grammar is one or more tokens
`<n><letter>` separated by spaces, commas or new lines (for example
`1b 3c`), or the single word `none`. `<n>a` is a decline; any other letter
is an approve with that option's `to_tier`; an item not mentioned stays
pending. A reply that does not parse, names an unknown item or letter, or
names an item twice decides nothing. Silence is never assent.

Every reply, `none` and an unparseable one included, ends with one
accepted `bs checks apply` for this epic (with an empty array when
nothing was decided), which appends one `check-tier-batch-answered` event
(`epic_id`, items decided, items left pending). A refused apply appends
none, and its refusal lists in `items` every item whose guardrail or shape
now fails, which happens only when the log changed between the question
and the answer. The playbook reports each listed item to the operator and
runs apply once more with the same decisions minus those items:
guardrails win over a reply, and the operator is not asked twice. A
refusal with no `items` (the actor, the overlay, a failed repair), or a
second refusal, goes to the operator with the reply's decisions.json,
and the playbook records the hand-off with `bs checks apply --hand-off
<refusal-code>`: a `check-tier-batch-answered` that decides nothing and
carries `handed_off`. That record is what makes `answered_in_epic` true,
so no later entry to step 12 asks again; the operator ends the hand-off
with an accepted `bs checks apply` of that decisions.json (b12b69b2,
852a2111). `bs checks proposals --epic
<id>` reports `answered_in_epic: true` once that event is in the epic's
lineage, and the playbook asks only when it is false. run.md step 12 is
re-entered after every fix; only its first pass asks.

**Automatic promotion.** Its evidence is the post-merge run itself, not the
ledger: a red that reproduced at the head (D4 step 3), was neither env nor
not-run, and bisected to a culprit merge. Every outcome reached after the
culprit is found carries that evidence (`reverted`, `revert-has-dependents`,
`revert-not-applicable`, `revert-conflict`, `revert-red`,
`integration-dirty`, `integration-moved`, and `setup-failed` and
`lock-timeout` in the revert test), so promotion runs on all of them, not
only when the revert lands.
For each failing check whose overlay tier came from an approved
`check-tier-decided`, `bs checks post-merge` sets that overlay entry back to
`pre-merge` (overlay first, with the event in `pending_event`) and then
appends `check-tier-promoted`. A culprit recorded by the resume (D4) after a
crash promotes the same way: task-16 rebuilds it from the revert commit's
valid trailers (`Bs-Task`, `Bs-Revert-Of`, `Bs-Failing-Checks`,
`Bs-Red-Record`), because a bs revert commit is built only after the bisect
found its culprit, and the promotion reads each check's own result from the
red record, as on every path; with that record lost it promotes nothing and
reports `promotion-skipped` (`red-record-unreadable`). A `red-at-base` red
is not a catch from a task and promotes nothing. It is logged, never asked, and only ever moves a check
earlier. A check whose tier the project declares is never moved
automatically (OQ1); the verb reports `declared-tier-wins`.

The dashboard stays display-only: no approve buttons. Thresholds are named,
exported constants with a comment that names this section (OQ4).

### D8. Learned tiers live in a bs-owned overlay; the project's file is never rewritten

The project's checks file is the operator's declaration and may be tracked
in git (the documented example is a bare `checks.json`). bs never writes it.
What bs learns lives in an overlay it owns. The log is the source of truth;
the overlay is its local materialisation, which the gate and the queue can
read without the event store.

- **Where.** `<project-root>/.blacksmith/check-tiers.json`, where the project
  root is the main worktree of the repository holding the directory a verb
  runs in: the first entry of `git worktree list --porcelain`, run with git's
  location variables stripped (tierOverlay.ts `overlayPath`), so a task
  worktree, the epic worktree and the clone read one overlay. It is
  kept out of git the way `bs init` keeps its local files out (workroot.ts
  `excludeFromGit`, `.git/info/exclude`), never through a tracked
  `.gitignore`, and is beside the audit findings store
  (`<project>/.blacksmith/findings.jsonl`).
- **Where there is no overlay.** `overlayPath` is null outside a git
  repository; in a bare repository and its linked worktrees; in an absorbed
  submodule (its git dir under the superproject's `.git/modules/`) and its
  linked worktrees; and in a `--separate-git-dir` layout's main work tree
  and its linked worktrees, except one class (f82435f9, deaf22c9). A
  submodule whose `.git` is its own directory is an ordinary repository and
  keeps its overlay at its own root. The exception is known wrong: from
  every linked worktree of a `--separate-git-dir` layout whose git dir is
  named `.git`, git reports nothing that tells it from an ordinary clone,
  and the overlay resolves to that git dir's parent. Where
  `overlayPath` is null, every undeclared entry resolves to `pre-merge`,
  writes are refused (`checks.overlay-not-a-repo`), and proposals carry no
  items, only a notice saying why. bs never asks a question it cannot
  apply. No lock is taken and nothing is created there: every caller checks
  `overlayPath` before `withOverlayLock`, which is never called where it is
  null.
- **Nothing to write, no lock.** The lock is taken only by a call about to
  write (apply, promotion, or a proposals call whose lock-free read finds
  something owed), and it creates `.blacksmith/` when absent. A project with
  no `.blacksmith/` directory has never been applied to, so nothing is owed:
  `bs checks proposals` there prints its items and creates no directory, lock
  or file.
- **Exclude result.** `writeOverlay` reads `excludeFromGit`'s result:
  `added` and `already-ignored` proceed; `tracked` refuses
  (`checks.overlay-tracked`: bs never edits a tracked file); `failed` and
  `not-a-repo` refuse (`checks.overlay-exclude-failed`,
  `checks.overlay-not-a-repo`). Proposals check writability first, so a
  refusal here also yields no items and a notice.
- **What.** `{version: 1, revision, entries: [{check, cmd_sha256, tier,
  decided_by_event_id, decided_at, pending_event?}]}`. Valid means: a JSON
  object with exactly those keys; `version` 1; `revision` a non-negative
  integer; each `check` a non-empty string; each `cmd_sha256` 64 lowercase
  hex; each `tier` one of the three tiers; `decided_by_event_id` a non-empty
  string; `decided_at` an ISO-8601 time; `pending_event`, when present,
  exactly `{event_type: check-tier-promoted, payload: {...}}`, appended as
  stored; no unknown keys; no two entries with
  the same `check` and `cmd_sha256`. Anything else is unreadable, with the
  first violation named; an unreadable overlay resolves every undeclared
  entry to `pre-merge` and refuses writes (`checks.overlay-unreadable`).
- **Resolution order.** For each entry in the file: its declared `tier` wins;
  else an overlay entry with the same name and `cmd_sha256`; else
  `pre-merge`. The declaration wins because it is the operator's explicit,
  reviewable statement (declarations over state, AGENTS.md); the overlay only
  fills entries the operator left to the default. `readChecksFile` resolves
  this once, and every verb (gate, queue, integration check, checks) gets the
  effective tier and its source (`declared`, `overlay`, `default`).
- **One writer at a time.** Every read-modify-write of the overlay runs under
  an exclusive lock file beside it (`check-tiers.lock`, created with
  `O_EXCL` like the heavy lock's mutex, holding the writer's pid; a lock
  whose pid is dead is broken), and `writeOverlay` also requires the
  `revision` it read and refuses `checks.overlay-moved` when the file
  changed. `bs checks apply` and the automatic promotion are the only
  writers, so neither can erase the other's entry.
- **Crash order: the earlier tier is always written first.** A demotion
  (apply) appends its `check-tier-decided` events first and writes the
  overlay second; a crash between leaves the check in its earlier tier. A
  promotion writes the overlay first, with the event it owes in
  `pending_event`, and appends `check-tier-promoted` second; a crash between
  leaves the check already earlier. `reconcileOverlay`, run under the lock
  at the start of every apply, of every promotion that will write (one
  that promotes nothing takes no lock, task-9; 6376bd4d), and of every `bs checks
  proposals` call that finds something owed (task-10 calls it before the
  pure `pendingProposals`),
  writes
  any approved decision missing from the overlay and appends any
  `pending_event` still owed, so the log and the overlay converge on the next
  call. Every verb that can reach that append carries the event envelope:
  `bs checks apply`, `bs checks post-merge` and `bs checks proposals` all
  require `--session`, `--plan-version` and `--causal-parent`, so an owed
  event lands in the caller's session and lineage; `bs checks ledger` never
  writes and takes none.
- **Stale entries are reported, not hidden.** Each entry is reported with
  one precedence: no file entry with that name -> `orphaned`; a file entry
  with that name declares a tier -> `shadowed` (also when its command
  changed); the name matches but `cmd_sha256` does not -> `orphaned`;
  otherwise `active`. `bs checks ledger --checks`, `bs checks proposals` and
  the post-merge outcome report every entry. A stale entry changes nothing:
  shadowed loses to the declaration, orphaned matches nothing (so the check
  falls back to `pre-merge`, the earlier tier).

### D9. Checks a gate stage depends on stay pre-merge

The gate's coverage-evidence stage reads the check named `coverage` (or the
gate's configured coverage check name) from the gate's own check list
(gate.ts `gatherCoverageEvidence`, keyed at gate.ts:1052). Deferring that
check would drop the stage silently. So `runGate` refuses a stage-bound check
whose effective tier is later (`gate.stage-check-deferred`), `bs checks
proposals` never proposes one, and `bs checks apply` refuses one. gate.ts
exports the stage-bound names.

### D10. An empty file is today's behaviour; an empty selection is refused

A checks file with no entries passes the gate today (`run([])` is a pass) and
still does: that is today's contract, not a tier filter. A file with at least
one entry whose pre-merge selection is empty is refused with
`gate.no-pre-merge-checks` before any stage, so no tier filter ever reads as
a pass. The queue follows D2 (an empty file keeps today's `--test-cmd`), and
`bs integration check --tier` refuses an empty selection as today
(`integration.no-checks`). `--tier remaining` with every check already
certified at the head is refused with its own nothing-remaining code and
writes no record; run.md step 12 reads that refusal as nothing left to run
and goes on to the close (059cacdc).

Where an empty selection does not refuse, it still never reads as a pass
(3c48b247). `bs checks post-merge` returns `no-checks-in-tier` (exit 0) when
the effective checks hold no post-merge entry. That exit says no batch is
due, never that a tier passed: like `no-new-merges` and `batch-not-ready`,
it runs nothing and writes no record, so it certifies no check at close and
releases no held task (`bs wave check` recomputes the hold from records),
and the playbook calls only `green` passed. The scaffold's gate script
refuses a run whose selection is empty (exit 1, as
`bs integration check --tier` does). The scaffolded CI skips a tier job with nothing to run as a
whole job, which GitHub shows as skipped, never as passed, and only a
listing job that succeeded and listed that tier empty can skip it. The `ui`
layer's e2e workflow skips its shard and summary jobs the same way while
there is no suite. So hard constraint 4 holds beside OQ-v2-2 (a), where
every tier that holds a check runs on every pull request and push, and
OQ-v2-3 (b), where the e2e workflow ships dormant behind its detect job.

## Acceptance criteria

| # | Criterion | Tasks |
|---|---|---|
| AC1 | **Tier declaration, fail-closed.** `readChecksFile` refuses a `tier` that is not one of the three strings with `gate.invalid-check-tier`, naming the entry and the file. `heavy` and `timeout_ms` validation are unchanged and coexist with `tier`. An absent `tier` means `pre-merge` unless the overlay says otherwise (D8). On an unlabelled file with no overlay, and on an empty file, `bs gate run` runs the same checks in the same order with the same outcome as before. `testgate.run` sets `cmd_sha256` and `check_sha256` on every result. | task-1, task-10 |
| AC2 | **The gate runs the pre-merge tier only, and drops no stage.** `testgate-result` names `tier: pre-merge`, the `tree_sha` it tested, and every deferred check by name, tier and tier source. A non-empty file with zero pre-merge checks is refused with `gate.no-pre-merge-checks`, and a deferred stage-bound check with `gate.stage-check-deferred`, both before any stage, with no `gate-outcome` written. The selection and both refusals live in one function, `selectGateChecks`: `bs results check --as gate` reports either refusal with the gate's code and message and runs no check (94908473), and a brief that lists checks (`bs brief compose --checks` for a coder or a tester, both of which refuse without `--worktree` with `brief.worktree-required`) lists only the checks the gate runs, names the deferred ones, and refuses as the gate does, with the overlay of the brief's `--worktree` (7cd42a04, fd5faa29). Given `--checks` and no `--worktree`, `bs brief compose` applies no overlay and says so on stderr; only a role whose brief lists no checks (a planner brief, as the test pins) can then compose, and it lists none (0b723971). Every exact pin of the `testgate-result` payload (`test/paperwork.test.ts`, `test/testgate.test.ts`) gains only the new fields, both digests included (575023cb, 35bdf960). | task-1, task-10 |
| AC3 | **The queue keeps today's command for an unlabelled file.** With `--checks` and no later effective tier, the queue runs `--test-cmd` and `--select-test-cmd` exactly as today. With a later tier (declared or from the overlay), it runs the pre-merge tier in sequential and `--batch` mode, runs neither `--test-cmd` nor `--select-test-cmd` and records that, and records `pre_landing`, per-check results and each task's `merge_sha` on its events. The tier runs under the lease the queue holds, so a heavy pre-merge check re-enters it (proved with a heavy-named check and a temporary lock directory, e28861ce), and every queue tier run writes one `queue-tier-run` record with each check's result and `environment` entry side by side, which the landing and blocked events name by `pre_landing_run_id` (78c887e5, aabfcf57). | task-4, task-10, task-11 |
| AC4 | **Integration runs carry their tiers and per-check identities.** `bs integration check --tier <tier\|all\|remaining>` runs at the clone root under today's contract; every result carries `cmd_sha256` and `check_sha256`, and the record carries `tiers`, `tiers_present`, `tree_sha`, `not_run`, and `error_class: execution.env-failure` when a failed check's own evidence fires the classifier. Scratch runs (`runChecksAt`) use a unique per-run name, remove stale scratch worktrees of dead runs first, run the setup command and the deps check, never touch the clone, and always remove their worktree; a failed setup or deps block is a refusal the caller maps to `setup-failed`, never a record (ead87064). Every record, probes and scratch runs included, carries `environment` index-parallel to `results` (78c887e5). A scratch run's record names the commit it ran at: `head_sha` is that commit and `tree_sha` its tree, under the integration branch's name (a5a7af62). | task-5, task-14 |
| AC5 | **Close needs every check of every tier green, and runs none twice.** With `--checks`, `epic close` and `epic verdict` require each declared check certified at the head by D5's one definition (task-5's `certifyChecks`), and block once per uncovered check, naming the check, its tier and one reason (failed, not-run, changed `check_sha256`, or no result), in declaration order; an empty declaration and an unreadable head each block once. Probes never certify, and neither does a record written before this epic: a deliberate change from main, cured by `--tier remaining` (a3bc5e33). A tier move never invalidates a result. Without `--checks`, an epic whose records use no tiers closes exactly as on main (rule, strings, `summary.integration.check`), and an epic whose records use tiers is refused with one blocker asking for `--checks`, so a post-merge record can never shadow a pre-release check (d6c28b83). On every passing close `summary.integration.check` is a record at the head (80191705). The proposal batch is applied before the close-time runs, and `--tier remaining` after `--final` runs no check already certified at the head. | task-6, task-5, task-14, task-11 |
| AC6 | **Post-merge batch: right branch, real reds only, tested revert, terminal resume.** `bs checks post-merge` refuses any branch but `<prefix>/<epic>/integration`; enforces the D4 trigger and per-check base; returns `lock-timeout` for a never-run check and `env-failure`, `not-reproduced`, `red-at-base` and `setup-failed` without blaming a task; builds the revert with `git revert -m 1` (git 2.38) and four trailers, tests it with the pre-merge and post-merge tiers and records those runs at the revert commit, lands it through `landCandidate`, and writes `wave-reverted`. Its resume scans from the fork point, validates the trailers, and every landed bs revert without a record ends, on the next run, as `reverted` (bounce, `resumed: true`) or `revert-recorded` (record-only, one reason from `RECORD_ONLY_REASONS`, always accepted); re-merged is decided by `merge_sha` ancestry. No outcome repeats. Every refusal moves no ref. The dependency arm and the admission hold are one function (`heldByPostMerge`): `bs checks post-merge --held` lists the held tasks read-only, `bs wave check --checks` refuses each with `wave.held-by-post-merge` while an independent task is admitted, and admits it after a proceed outcome; a `wave check` without `--checks` on an epic whose records use tiers (task-5's `lastTieredRecordId`, the predicate the close refusal uses, so pre-release-only and probe records count too) is refused with `wave.checks-required` (OQ-v2-1 (c); 5bad56cc). Both read the records from the `--session` lineage, where the batch writes them (dc4b6bce), and both bind every admission, because nothing is admitted without `--session`: `wave-admitted` is written only with `--session` and `--causal-parent`. A `wave check` without `--session` reads no log and checks neither: it prints its verdict for a wave refused for claims, coupling or budget, stops at `cli.missing-flag` before writing for an admissible wave, and with `--dry` writes nothing (873a98f6, a11671d4). | task-7, task-16, task-12, task-2, task-4, task-14, task-17 |
| AC7 | **A reverted task reopens everywhere, with no operator tick, and its coder is told why.** After a `bounce` `wave-reverted`: the projector folds it to `todo`; `finishedInLog` omits it; a goal-check does not credit it; an amend keeps it live in v(n+1); `bs wave next` offers it; admission accepts it; the epic is not ready. A `record-only` event changes none of these. A second `wave-merged` completes it. `bs worktree create --reopen --revert` re-cuts it as D1 says; the reopened coder's brief quotes `failing_checks`, `log_tail` and the red record's id; the round counts on the S2 ladder. | task-17, task-2, task-14, task-11 |
| AC8 | **The ledger.** `bs checks ledger --project <dir> --specs-dir <dir> [--checks <file>]` reports per check per run: duration, outcome, class (real, flaky, env, not-run, unconfirmed; 3661495f), unique or shadowed, severity, tree, identity and event id; per check: runs, minutes, flake rate, importance and merges per post-merge run over the window, across lineages for that project only; and, with `--checks`, the overlay report. The sensitive-path guard reads catches over every kept event, however old; only the numbers are windowed. Task ids are qualified before every join, unattributed events are kept, and an unattributed or claimless task counts as sensitive. A plan file the ledger cannot read is skipped with a warning (its tasks then count as sensitive); an unreadable session log marks the ledger `degraded` and stops proposals. Each class has a fixture whose expected output differs from the others'. Duration is the `monotonic_ms` of the result's entry in the record's `environment` array on every record type; the fixtures are built from real `testgate.run` results, and an event with a per-result `environment` reads as unmeasured (5d4a0377). | task-8, task-13, task-10 |
| AC9 | **One-question proposal batch, only about applicable moves.** `bs checks proposals` shows per item and per option the runs covered, minutes spent and minutes saved by D7's formula (pinned by the D7 example), plus importance, orders items by post-merge minutes saved, proposes only undeclared entries when the overlay is writable and the ledger not degraded, lists everything else as notices, and reports `answered_in_epic`. The playbook asks once per epic, on step 12's first pass, with D7's reply grammar; every reply ends in one accepted `bs checks apply` and one `check-tier-batch-answered`. A refusal that names items is reported, and apply runs once more without them. Any other refusal, or a second one, goes to the operator and is recorded by `bs checks apply --hand-off`, a `check-tier-batch-answered` that decides nothing, so the batch is not asked again (b12b69b2, 852a2111). `bs checks apply` takes the overlay lock, reconciles, re-validates the decisions.json and every guardrail before writing anything of the batch (a refusal leaves only the reconcile's repair of what was already owed and the empty `.blacksmith/` directory the lock may create; 0cb51329, 6376bd4d), appends one `check-tier-decided` per item and then writes the overlay, and never writes the project's file; a crash between the two converges on the next call. A decided item never resurfaces; a declined one returns after 90 days. | task-9, task-15, task-10, task-11 |
| AC10 | **Automatic promotion and the overlay's integrity.** A reproduced, bisected post-merge red on an overlay-demoted check sets it back to `pre-merge` (overlay first, then `check-tier-promoted`) on every outcome reached after the culprit is found, with no question; `red-at-base` promotes nothing. A declared tier is never moved automatically (`declared-tier-wins`). Overlay writes are serialised by a lock and a revision check, refuse a tracked, un-excludable or non-git location, and never touch the project's file; an invalid overlay is named and resolves undeclared checks to `pre-merge`. Every entry is reported `active`, `shadowed` or `orphaned` by one precedence. | task-9, task-15, task-12, task-14 |
| AC11 | **Playbooks.** wave.md step 7 gates the pre-merge tier and keeps the full-test-command rule in whatever tier the full suite sits; step 10 passes `--checks` beside today's queue flags and leaves the post-merge batch to the epic session; run.md's rolling admission runs `bs checks post-merge` on each landing as a background task it waits on, never inside `bs heavy run`, admits at once every task `bs wave next` returns that `bs checks post-merge --held` does not list and the held ones after a proceed outcome (OQ-v2-1 (c)), handling every outcome (673a9c3e, 79215b80); step 9 reopens a reverted task with `--reopen --revert` and quotes the revert's log in the brief. run.md step 12 runs `--final` then `--tier remaining`, close passes `--checks`, and the proposal batch is one question. A test pins each line. The tests that already pin those paragraphs (`queuePlaybook`, `handbackPreflight`, `briefComposeDocs`, `playbookCitations` and the others task-11 names) pass unchanged (92be2499). The post-merge rule is a run.md block of its own (`**Post-merge and held tasks.**`) that says 'right away' and 'at once' apply to every task `--held` does not list, while held tasks wait for a proceed outcome, and the offset test reads that block only (8a0a6d8d, 6258503a; OQ-v2-1 (c)). Every `bs wave check`, `--held` and post-merge line carries the epic session's `--session` (dc4b6bce). | task-11 |
| AC12 | **Docs as a predefined architecture.** `docs/specs/check-tiers-scope.md` describes the three parts as one mechanism, the defaults, the overlay, the guardrails and the one-question batch, with a `PLANNED-NAMESPACE` marker for the `checks` namespace until it ships. It is indexed in `docs/specs/README.md` and `docs/README.md` and linked from `queue-and-gate.md` §5. `docCommands` and `docErrorCodes` stay green on every task's tree. | task-3, task-10, task-14, task-11 |
| AC13 | **Nothing is skipped or weakened; any stack.** No check is removed: a tier changes when a check runs, never whether it runs before release. No test, timeout, gate stage, judge or review round is loosened. main's merge rule is unchanged. Nothing needs GitHub Actions or a git newer than 2.38. `bs new` still scaffolds no `checks.json`, and no per-stack tier default exists. Each task owns a diff-grep criterion. task-18's scaffold keeps every clause of this row. | all |
| AC14 | **Vocabulary is shown.** `wave-reverted`, `queue-tier-run` (aabfcf57), `check-tier-decided`, `check-tier-promoted` and `check-tier-batch-answered` are in `taxonomy.yml`; `RECORD_ONLY_REASONS` is one exported list; and every new error code appears in source before any doc names it. Each name enters the taxonomy with the task that first writes it (`test/eventTypes.test.ts`). | task-2, task-4, task-9 |
| AC15 | **The CI flow reaches every user.** What `bs new` scaffolds runs one gate script (`pnpm run check`) the same way locally and in CI. CI runs one job per tier on every pull request and push, with PR-scoped cancel-in-progress; a listing job skips a tier job whose selection, counted after the e2e omission, is empty, so it shows as skipped, never as passed, and the gate script refuses an empty run (3c48b247, 54e32479); and reads tiers only from a committed `checks.json` the project's operator writes: none is scaffolded and no tier default exists. The `ui` layer ships a sharded e2e workflow with a cached browser download and a non-fatal screenshot upload, kept dormant by one detect job that gates the shard and summary jobs until the project has a `test:e2e` script (OQ-v2-3 (b)), and fires on exactly ci.yml's events (e5848d67). The gate script's tier selection and validation are pinned to testgate.ts by a derived test; nothing needs GitHub Actions; nothing a project declares is dropped from CI (a46729fa; OQ-v2-2, OQ-v2-3). CI calls the gate script with node, and the script tolerates the `--` pnpm forwards (541a89dd); each workflow has its own concurrency group (dbfb36ae); an `e2e` entry is left to the e2e workflow only when its command is the one that workflow shards (dd3d51bc). | task-18 |

## Plan shape (v2)

Eighteen tasks, seven waves, widest five. Hot files are never claimed by
two concurrent tasks: `cli.ts` and `usage.ts` run as a chain (task-1 ->
task-4 -> task-10 -> task-14); `testgate.ts`, `gate.ts` and `briefCompose.ts` belong to task-1;
`queue.ts` and `taskEvents.ts` to task-4 (taskEvents.ts gains one export),
then `queue.ts` to task-12 (which only adds an export); `integration.ts` to
task-5; `epic.ts` to task-6; `taxonomy.yml` to task-2, then task-4, then task-9 (each adds
the event names it is first to write); `revert.ts` to task-2;
`projector.ts`, `taskLifecycle.ts` and `db/foldPredicates.ts` to task-17; `workroot.ts` to task-15
(which only adds an export); `worktree.ts` to task-14; `scaffold.ts` (which keeps every export) and
`factory/scaffold/` to task-18; `test/checkTiersScopeDoc.test.ts` to task-3,
then task-10 and task-11 (one sanctioned assertion edit each, a24cf08b); and `wave.md`,
`run.md`, `queue-and-gate.md`, `closing-an-epic.md` and `CHANGELOG.md` to
task-11. Every new verb lives in one new namespace, `checks`. task-10 ships
the namespace and removes the scope doc's `PLANNED-NAMESPACE: checks`
marker in that commit, turning the not-yet-built `checks post-merge` spans
into prose; task-14 ships that verb and restores them. Flags added to
existing verbs stay in prose in the scope doc until they ship, because the
doc guard checks flags and a marker covers only a namespace.

| Wave | Tasks | Why it waits |
|---|---|---|
| W1 | task-1, task-2, task-3, task-13, task-17 | nothing |
| W2 | task-4, task-5, task-15, task-18 | all import task-1's `testgate.ts` changes (task-15 its `commandDigest`, task-18 its tier vocabulary for the drift test); task-4 follows task-1 on `cli.ts` |
| W3 | task-6, task-7, task-8 | they read task-5's record shape and runner; task-8 also reads task-4's queue fields, task-2's event and task-13's inputs |
| W4 | task-9, task-16 | task-9 reads task-8's ledger, writes task-15's overlay and adds its event names to `taxonomy.yml` after task-2; task-16 reads task-7's trailers, writes task-2's event and relies on task-17's reopen |
| W5 | task-10, task-12 | task-10: `cli.ts` after task-4, wires tasks 8, 9, 13 and 15; task-12 drives task-16's resume, task-7's bisect and task-4's `queue.ts` |
| W6 | task-14 | `cli.ts` after task-10; wires tasks 5, 6, 9, 12 and 15 |
| W7 | task-11 | documents and pins what every other task built, task-18's scaffold CI included; sole `CHANGELOG.md` owner |

`plan.json`'s `planner_notes` record the `claims impact` read-back and each
crossing's resolution (v2: depth 7, widest 5, the same seven crossings as
v1, each on an edge).

## Factory-level and repo-level split

| Level | Tasks | What it changes |
|---|---|---|
| factory-level | task-1 to task-17 | the orchestrator, playbooks and operator docs bs ships |
| factory-level | task-18 | what `bs new` writes into every user's project: the scaffold's gate script and CI |
| repo-level | none | |

## Hard constraints

1. Open source, any stack. Absent `tier` = `pre-merge`. No per-stack tier
   defaults; `bs new` scaffolds no `checks.json`. Works without GitHub
   Actions and on git 2.38. No other project's name in any file this epic
   writes.
2. main stays merge-on-green. Post-merge testing only on
   `bs/<epic>/integration`, and the post-merge verb refuses any other ref.
   The epic PR opens only when every tier is green.
3. No check is ever skipped. Moving a check changes when it runs, never
   whether it runs before release. wave.md's rule that the unit check is the
   project's full test command holds in whatever tier the full suite sits.
4. A tier filter that leaves zero checks never reads as a pass (D10). A check
   that never ran never reads as a red, a catch or a culprit (D4, D6).
5. Never skip, quarantine, auto-retry or loosen a test, raise a timeout, or
   drop, weaken or reorder a gate stage, judge, review round or verifier.
   The D4 head re-run is a probe that can only withhold blame; it never
   turns a red record green.
6. The dashboard is display-only. Decisions go through the CLI and the
   playbooks. bs never writes the project's checks file.
7. A guardrail is enforced by the verb that applies the decision, never only
   by playbook prose.

## Out of scope

- The "paths" (changed-area) check selection idea: a later epic, once the
  ledger has data.
- This repo's own CI: splitting `cli.test.ts` and sharding e2e have landed
  (#501, #502); auto-merge is not this epic's. Carrying #502's patterns into
  what `bs new` scaffolds is in scope (task-18).
- Any change to main's merge rule.
- Bisecting a red pre-release run at close: v1 keeps run.md step 12's
  finding-then-fix-task path.
- More than one culprit per post-merge run: a revert that is still red lands
  nothing and goes to the operator (`revert-red`). Bisecting on top of a
  revert is a later step once the ledger shows how often it happens.

## Open questions (the operator's calls; the plan follows each recommendation)

Six, asked as one batch; each answers by letter. Answered at v1 sign-off
(2026-10-28, `bs-check-tiers-2026-10-28#40`): all six at (a). Plan v2's
three questions and their answers are under 'Operator answers (v2)'.

- **OQ1. Which checks promote automatically?** (a) only checks whose
  overlay tier came from an approved demotion (recommended: a declared tier
  is the operator's own statement, so a catch there becomes a notice); (b)
  every post-merge check with a real catch, overriding the declaration
  (would mean bs writes the project's file, against D8).
- **OQ2. Where a catch's severity comes from.** (a) the fixed rule in D6,
  S1 on a sensitive task else S2 (recommended for v1: conservative, needs no
  new field); (b) an optional per-check `severity` in `checks.json`, absent
  = S2; (c) a join to the task's later findings.
- **OQ3. "Guards a sensitive path".** (a) exposure: ran on a sensitive task
  in the window, or caught a real defect on one ever, with unknown claims
  counted as sensitive (recommended and implemented: a security check that
  never failed stays protected; the cost is fewer proposals while sensitive
  work is active); (b) real catches only (a scan that never failed becomes
  demotable); (c) a declared per-check flag.
- **OQ4. Thresholds** (20 runs, 30-day window, 30 measured minutes, batch of
  4 merges, 90-day decline, weights 8/4/2/1). (a) named constants in code
  for v1, moved to a policy file once a second project tunes them
  (recommended: no policy surface before there is data to tune it); (b) a
  policy file now (`factory/policies/check-tiers.yml`, pinned by
  docPolicyValues); (c) the same numbers as flags on the `checks` verbs, per
  run.
- **OQ5. When the batch question is asked.** (a) at epic close, beside the
  closing report (recommended: an existing operator touchpoint, once per
  epic); (b) a standalone verb the operator runs.
- **OQ6. After `env-failure`, `not-reproduced` or `lock-timeout` at the
  head.** (a) the playbook calls `bs checks post-merge` once more, and a
  second such outcome at the same head goes to the operator (recommended:
  bounded, and the same shape as bs-gate-bounce's re-gate rule); (b) go to
  the operator at once; (c) wait for the next landing or `--final` to run it
  again, with no extra call.

## Progress

One line per task, copied in by the epic session from the worker's result
`notes` at merge: task id, merged commit, and anything a later task must
know.

- **task-17** (merged 9338deb0, code 6b602797): a bounce `wave-reverted` reopens a completed task in the projector, `finishedInLog` and `reinstatementBlocker` through the shared `bounceRevertedIds` (taskLifecycle.ts). It matches the envelope `task_id` plus payload `task_ids`, for `disposition: 'bounce'` only. It adds `assertNotHeld`/`HeldByPostMergeError` to admission.ts for task-14 to call with task-7's held map. Later tasks: every `wave-reverted` must carry a `disposition` and name its task in `task_id` or `task_ids`.
- **task-13** (merged a433558c): ledgerInputs.ts `gatherLedgerInputs()` returns `events` (every kept event, no time filter), `window` {from,to}, `taskIdOf` (event_id → qualified id or `'unattributed'`, no entry for an event naming no task), `taskClaims` (from the highest-version plan; `followup-` ids from task-added only when no readable plan holds them), `sensitiveGlobs`, `epics`, `project`, `sessionsRead` (excludes unreadable logs), `warnings` and `degraded`. It throws `LedgerInputsError` with `checks.no-plans` (also for an unlistable specs dir) or `checks.mixed-projects`. An unreadable plan file or epic dir is skipped with `checks.plan-skipped`; an unlistable state dir warns `checks.session-unreadable` and sets `degraded`. `loadSensitivePathsPolicy` stays fail-closed.
- **task-1** (merged 66de19cb, final head 71342e62): `tier` on `CheckCommand` and the pre-merge gate filter. Later tasks consume `selectGateChecks`, `checkDigest`, `commandDigest`, `isNotRun`, `sleptFailedChecks`, `stageBoundCheckNames` (gate.ts) and `tierSource` (task-10 adds `'overlay'`). `testgate-result` gains `tier`, `tree_sha` and `deferred`, and every `CheckResult` carries `cmd_sha256` and `check_sha256`.
- **task-3** (merged caa9823c, head b574306c): docs/specs/check-tiers-scope.md is done and indexed in both READMEs. Its Thresholds section carries every value; its test pins the thresholds and the D7–D9 guardrails, including the mismatched-check and `to_tier` refusals. Later tasks keep the marker and `Status: planned.` assertions in sync: task-10 changes the marker assertion, task-11 the status assertion.
- **task-18** (merged a28facd2): `bs new` scaffolds scripts/check.mjs (`pnpm run check`, Node built-ins only; tiers read only from a committed checks.json, absent tier = pre-merge, an empty run exits 1, `--list` is a read-only query, one leading `--` dropped), a ci.yml with a `tiers` job plus one job per tier (PR-scoped cancel-in-progress; a tier with nothing to run is skipped), and in the ui layer a dormant sharded e2e.yml (a `detect` job gates `shard` and the summary; own concurrency group; same `on:` as ci.yml). `TOOLCHAIN_STEPS` is now exported. Later tasks: check.mjs omits only an `e2e` entry whose cmd is exactly `pnpm run test:e2e`, and only when e2e.yml exists and package.json has that script; the e2e workflow's shard job key is `shard`. Reviewer rounds 2–4 found signal-handling gaps (SIGQUIT forwarding, exit codes from the signal table), closed as a class.
- **task-5** (merged 1d7db6ac, head 9ddbace7): integration.ts tier runs (tier/workspace/commit/setupCmd/probeOf/environmentSources), `runChecksAt` (scratch-<pid>-<uuid> under .wt/<project>/, dead-pid sweep, setup then `checkWorktreeDeps`, always removed), `certifyChecks` (the one certification rule), `latestIntegrationCheckAt` and `lastTieredRecordId`. Later tasks read the thrown `integration.setup-failed` (details epicId, commit, setup, deps), `integration.nothing-remaining`, `integration.unknown-commit` and `integration.bad-input`. `checkWorktreeDeps` is imported lazily inside `runChecksAt`: a static gate.js import pulls dist/db/schema.js into CLI boot and fails cliBoot.test.ts.
- **task-2** (merged dac4b89a, plan v3): adds `wave-reverted` (taxonomy v13) and src/revert.ts. `waveRevertBlocker` is epic-scoped and ignores a malformed `merge_sha`; `recordWaveReverted` stores lower-case shas, refuses a bounce without `epic_id` (`revert.epic-required`), and checks duplicates inside the per-session lock. The `waived` and `held-by-operator` reasons are unreachable until the projector can fold past `wave-merged` (finding d3d30c6d, open, needs db/projector.ts), and the duplicate check is not lineage-wide (finding 9000f648, open, needs events.ts); task-16 must not rely on either. The vocabulary-sweep row `'wave-reverted': ['Wave reverted', '']` is in ui/test/timelineDisplay.test.ts; task-4 and task-9 add theirs to the same map.
- **task-15** (merged 157bfb56, after 9 review rounds): tierOverlay.ts keeps the overlay at `<main worktree>/.blacksmith/check-tiers.json`. The main worktree is the first entry of `git worktree list --porcelain`, run with the git location variables stripped (one `gitEnv` helper); outside git, bare, absorbed submodule and the main clone of a `--separate-git-dir` layout give null and callers answer `checks.overlay-not-a-repo` (known gap: a linked worktree of a `--separate-git-dir <S>/sgdir/.git` layout resolves to `sgdir`; documented in code, for task-11's docs; D8 states it since plan v5, and task-21 carries it into queue-and-gate.md section 5, f82435f9). The lock `check-tiers.lock` (`<pid>\n`) is published by temp file + `link()` exactly as heavyLock.ts does; only a dead pid's lock is reclaimed, under the `check-tiers.lock.reclaim` `wx` mutex (broken past `RECLAIM_BREAK_MS` = 10000); unreadable or non-pid content is refused (`checks.overlay-lock-unusable`), never broken. Exports `overlayOwes` → {missing, pending, settled}, `resolveEffectiveTiers` (CheckCommand copies with `tier` and `tierSource`), `reconcileOverlay`; `workroot.ts` gained only the `excludeFromGit` export. Full line in the coder's notes, state/results/bs-check-tiers/task-15-tier-overlay.json.
- **task-6** (merged c4b6cbce, head 838ed057): epic.ts close/verdict take optional `EpicVerdictInput.checks` (DeclaredCheck[]); `IntegrationStatus` gains optional `declared` and `tieredRecordId`; `certificationReasonText` is exported; `summary.integration.check` with a declaration is `latestIntegrationCheckAt(head)`; the `epic-closed` payload's `integration` gains `declared[]` and `tiered_record_id`. task-14 only has to set `input.checks` from `--checks`.
- **Decision (epic session, 2026-10-31, task-7 finding 32dd16cb):** D4 step 5 names no outcome for a head that is red only because of a trailing bs revert commit (every task-merge prefix green). It returns `red-at-base`: no task is blamed and nothing is promoted (AC10). The result's detail names the bs revert sha, so the report does not claim the failure predates the batch. A bs revert commit is never `batch-has-foreign-commit`. D4 step 5 states both (plan v5, d1a46ec1).
- **task-7** (merged 4d816dd4, head ee602e0b): postMergeBisect.ts exports `POST_MERGE_BATCH`, `assertIntegrationBranch` (also refuses a clone on the integration branch with no `origin/HEAD`), `isBsRevertCommit`, `postMergeBase`, `heldByPostMerge` (Map task id → merged task ids it waits on), `landedBsReverts`, `findPostMergeCulprit` (returns merges, recordIds, base, baseObserved, head, culprit, dependents, step, commit, foreign; optional `statusOf` defaults to `foldTasks` over `input.events`, plan record only as fallback). `PostMergeResult.redAfterRevert` names the landed bs revert shas when only a revert turns the head red (outcome `red-at-base`); task-12's report must read it. Probes are not env-classified. test/helpers/integrationRepo.ts is the shared repo builder for task-12 and task-16. Reviewer note for the closing review: after an edited check moves the base back before a landed revert, the bisect could blame a task that revert already undid; task-12's `waveRevertBlocker` would refuse that revert.
- **task-4** (merged f73f2a27): `queue run --checks` (`resolveQueueChecks` in queue.ts), the pre-merge tier as the pre-landing test, the `queue-tier-run` event (taxonomy 14, kind Gate, ui row `'Queue tier run'`), and `merge_sha` on every `wave-merged` (step, batch fold commit, adopt) via `emitWaveMergedWith`. Later tasks: `merge_sha` ancestry is available for task-16's re-merge decision; task-9 bumps taxonomy from 14 and adds its rows after `queue-tier-run` in the ui map and the queries.ts switch; task-10's overlay only feeds its effective tiers into `resolveQueueChecks`.
- **Decision (epic session, 2026-10-31, task-8 finding 242087f0 and the four shadowing findings before it; revised):** records never name a check skipped by `run()`'s short-circuit, so a catch's comparison set must still come from each check's own records, as `runsBeside` does, and task-8's criterion 3 stands. Three refinements: (1) a record with more than one tier never decides which tier a check belongs to (it cannot attribute a check to a tier); its results still count as runs, catches and evidence. (2) A check's membership for a catch comes from its latest single-tier record (a pre-tier record counts as pre-merge) at or before that catch's record, never a later one, so later or unrelated runs cannot flip a verdict. (3) A check with no such record does not shadow the catch; this is the one place the ledger can over-count a unique catch. D6's unique-catch bullet states all three (plan v5, 71a5b931).
- **Note for task-12 (from task-16, in flight):** on a mid-write failure the resume rethrows with the writes it already made attached as `err.wrote`; task-12 must read it to keep their culprits. An absent `merge_sha` in the clone is read as not-an-ancestor (not re-merged), never as an error (finding 27981ad9).
- **task-16** (merged 12f18af6, head 15f97d9e): `resumeLandedReverts` finishes every landed bs revert with one `wave-reverted`. It proves the revert (first-parent merge, tree equals `git revert -m 1`, passing pre-merge and post-merge records at the sha), treats only real git verdicts (merge-tree conflict, merge-base exit 1) as answers and lets every other git fault throw for a retry, decides every revert before writing any, and on a failed write rethrows with the writes already made as `err.wrote`. An absent `merge_sha` is not-an-ancestor (27981ad9). task-12 passes {projectDir, epicId, integration, events, liveTaskIds}, must write both tier records at the revert sha, and must collect culprits from `err.wrote` when the resume rejects. task-20 removes the mocked waived/held-by-operator fixtures and adds the `revert.already-recorded` catch.
- **task-8** (merged 2956d4ed, code 7c6a2408): factory/orchestrator/src/checkLedger.ts exports `checkLedger(inputs, opts)` (inputs are task-13's {events, taskIdOf, taskClaims, sensitiveGlobs}; opts {window, treeDiff?, projectDir?, checksFile? = 'checks.json'}), `LEDGER_WINDOW_DAYS`, `SEVERITY_WEIGHTS` (S1..S4), `FAILURE_CLASSES`, and types `CheckLedger`, `LedgerCheck`, `LedgerRow`. Result {rows, checks, project}; each check (one per name+cmd_sha256, plus a `name-only` identity) has runs, minutes, unmeasured, not_run, median_minutes, flake_rate, importance, real_catches, unique_catches, s1_catches, s2_catches, unconfirmed [{event_id, severity}], guards_sensitive, by_source {gate, queue, close, probe} (probe kept apart so task-9 can exclude it) and event_ids per number. A name-only row's catches, unconfirmed failures and guard arms are added to every identity of that name, never its runs or minutes. A `wave-reverted` (either disposition) confirms a red row listed in its evidence_event_ids whose name is in failing_checks. project = {post_merge_runs, post_merge_run_ids, task_merges, epics_with_merges, merges_per_post_merge_run|null}. Shadowing follows the epic decision above (a check seen only in multi-tier records does not shadow). test/helpers/ledgerEvents.ts is reusable by task-9 and task-10.
- **task-20** (merged ca10b828): `RECORD_ONLY_REASONS` is now six (`waived` and `held-by-operator` and their two `waveRevertBlocker` lines removed, with the mock-only tests). `recordWaveReverted` checks a duplicate `revert_sha` over the root's session tree and appends under one lock (`<root>.jsonl.wave-reverted.lock`), refusing the loser with `revert.already-recorded`, which `resumeLandedReverts` reads as recorded. `sweepDeadScratch` removes only detached `scratch-<pid>-<uuid>` worktrees of dead pids. events.ts changed only by `export` on `withLogLock` and `logPath`. Later tasks: the duplicate check runs after all other validation, so a duplicate bounce that is also blocked reports `revert.blocked`, not `already-recorded`. Findings d3d30c6d, 9000f648 and 0f865e45 are fix-verified.
- **Decision (epic session, 2026-11-02, task-12 finding 5818f717):** when the effective checks at the head hold no pre-merge entry, a revert cannot be tested as D4 requires (D10 already refuses an empty pre-merge selection). So `runPostMerge` builds no revert and moves no ref: it returns `revert-not-applicable` with a reason naming the empty pre-merge tier and still returns `culprit`, so AC10's promotion puts the demoted check back into pre-merge. task-16's `provesRevert` is unchanged (it keeps requiring both tier records at R). D4 revert step 1 states it (plan v5, 9c2b1d5e).
- **task-12** (merged ec2daf32, head 4a146f78): src/postMerge.ts exports `runPostMerge(input, ctx, opts)` (`opts.onScratch` is a test seam only). Result `{outcome, resumed, reason?, setup_failed?, dependents?, culprits, revert_sha?, red_after_revert?, event_ids}`. queue.ts gains only `export` on `landCandidate`; integrationRepo.ts gains `builderDir` and `release()`. Step 0 is task-16's resume; a rejection is rethrown with `culprits` from `err.wrote`. R's pre-merge and post-merge records are written at R before landing; `revert.already-recorded` on the post-landing write counts as recorded. An empty effective pre-merge tier returns `revert-not-applicable`, reason `no-pre-merge-checks`, with the culprit. A revert-only red returns `red-at-base` with `red_after_revert`. task-14 must pass the plan's non-superseded ids as `liveTaskIds` and read `culprits` from both a result and a rejected error.
- **Decision (epic session, 2026-11-02, task-9 findings 53342de1 and c83db80f and the chain before them):** under the overlay lock, apply and `promoteAfterCatch` re-read the project's events by calling task-13's `gatherLedgerInputs()` with the caller's project, specs-dir and state-dir options (project-scoped, every session of the project's epics across lineages); a `degraded` result refuses. The bespoke `currentLog` is deleted. tasks 10 and 14 pass the gather options rather than a state dir.
- **task-9** (merged f9d364c9, head c59bde72): `pendingProposals`, `applyTierDecisions(…, {epicId…})` (throws `TierApplyRefusal`: `checks.overlay-not-a-repo`, `checks.apply-not-operator`, `checks.decisions-not-array`, `checks.overlay-tracked`, `checks.overlay-unreadable`, `checks.apply-refused` with `items`, `checks.session-unreadable` and `checks.overlay-busy` with `items: []`; returns `{decided, pending, batch_answered_event_id}`) and `promoteAfterCatch({dir, checks, events, gather})`. Apply and promotion take `gather: LedgerInputsOptions` (the ledger's options; `opts.events.stateDir` must equal `gather.stateDir`) and re-read the project log through `gatherLedgerInputs` under the overlay lock, merged with the snapshot by `ts`, deduped by `event_id`; a corrupt log or two-project plans refuse (`checks.session-unreadable`; promotion answers `promotion-skipped`). The module's events carry `payload.epic_id`; the caller's session must name the epic; a culprit's red record without `payload.epic_id` gives `promotion-skipped`/`red-record-unreadable`. The ledger passed in must carry `degraded`. Import tierProposals lazily from cli.ts. Taxonomy is v15 with `check-tier-decided`, `check-tier-promoted`, `check-tier-batch-answered` in `gate_event`. Known limit: a gather-error refusal names an unreadable log or mixed projects even when `checks.no-plans` caused it.
- **task-19** (merged 43ec5aa3, code 62056e3f): four `GATE_CHECK_NAME` entries in ui/src/lib/timelineDisplay.ts (`queue-tier-run` 'Pre-merge checks', `check-tier-decided` 'Check tier decision', `check-tier-promoted` 'Check tier promotion', `check-tier-batch-answered` 'Check tier proposals'), so Gate-kind tier rows never print a raw slug in meta; kindFor, titleFor, other maps and the sweep rows unchanged. Later tasks: none.
- **task-10** (merged 61b82e98, code b2f2cd78): `readChecksFile(file, {dir})` resolves effective tiers through task-15's `resolveEffectiveTiers` against the overlay of `dir`'s repository. With no dir it uses declared tiers only. An unreadable overlay resolves to pre-merge and says so on stderr. `gate run` and `results check --as gate` pass `--worktree`; `queue run` and `integration check` pass `--project`; `brief compose` passes `--worktree` and prints a stderr line when it is absent. `bs checks ledger|proposals|apply` ship. `proposals` takes the envelope flags and locks and reconciles only when `overlayOwes` reports a write. `apply` exits 1 on refusal with `{error:{code,message}, items}`; a decisions file that is not JSON refuses with a code too (f5f3f69e). `apply --hand-off <code>` records the hand-off and prints `{event_id}`. The scope doc lost its PLANNED-NAMESPACE marker. `gatherChecks(flags)` in cli.ts builds the gather options for reuse. task-14 adds `bs checks post-merge` and passes `--checks` with a dir to `epic close` and `epic verdict`.
- **Decision (epic session, 2026-11-02, two task-10 questions):** (a) `brief compose` for coder and tester refuses without `--worktree` (`brief.worktree-required`), so the plan clause "lists e2e and exits 0 with no worktree" cannot be reached for those roles; the not-applied line goes to stderr and is pinned with a planner brief. The closing spec review reconciles the clause's wording: AC2 states it, and line 1 of the Plan v5 closing-review section reads the clause (plan v5, 0b723971). (b) `bs results check --as gate` prints `selection` only when a later tier defers something, which keeps main's output shape when nothing is deferred (cliResultsCheck's documented-keys test is unchanged).
- **task-14** (merged cdca96ac, code 3809416d + fixes 572819f3, ffbae3ed, 4f12dd2b): `bs checks post-merge` prints outcome JSON and exits 0 only for green, reverted, no-checks-in-tier, no-new-merges and batch-not-ready. It promotes per culprit via `promoteAfterCatch` and reports the overlay; `--held` is read-only. `bs wave check --checks --project` refuses `wave.held-by-post-merge` through `assertNotHeld` and `wave.checks-required` via `lastTieredRecordId`. A project with no post-merge entry reads no git state, and only `postmerge.branch-missing` is absorbed (8d0ec0f3). Also ships `integration check --tier`, `epic close|verdict --checks`, and `worktree create --reopen --revert` (new export `reopenTaskWorktree` in worktree.ts). The verb takes no `--specs-dir`; promotion's gather `specsDir` is the plan's parent's parent. The CLI re-reads the lineage after the run so the red record is found. `promoteAfterCatch` gets the declared checks without the overlay, so a declared tier answers `declared-tier-wins`. Promotion also runs on the culprits of a rejected `runPostMerge`, then the error is rethrown (f88d6925); a failed promotion there is written to stderr (a8214d29).
- **task-11** (merged 2c89aa5a, code c588f6fe): wave.md step 10 passes `--checks` beside `--test-cmd` and says the post-merge batch is the epic session's; steps 7, 8 and 9 gained the tier, brief and reopen sentences. run.md has the **Post-merge and held tasks.** block, bullets (a) to (d). Step 12 runs proposals as one question, then Apply / Re-run / Hand-off, `bs checks post-merge --final` and `bs integration check --tier remaining`; any refusal step 12 does not name means a broken branch, and the named outcomes follow their own rules. queue-and-gate.md section 5 documents tier and the overlay; closing-an-epic.md 7a documents per-tier close. The scope doc says `Status: shipped.` CHANGELOG has one Check tiers entry. A test guards that every numbered step of run.md follows a blank line (0990c59f). Left for the closing review: docs/guide/operator-guide/wave.md:15 shows `bs wave check` without the new flags (outside task-11's claims). task-21 fixes it (plan v5, 5e675a89).
- **task-21** (merged 1948abdf, code e09f9f2d): reworded 9 docs in place: the admitting form and refusals of `bs wave check`, the index rows marked shipped, closing-an-epic 7a, limitations and status no longer calling `bs integration check` the only run that sees the branch, queue-and-gate sections 4 and 5, and the scope doc's red-at-base and `no-pre-merge-checks`. No code, test or heading other than 7a changed; the 7a anchor is now `#7a-bs-integration-check--the-clone-root-run-that-close-requires`.
- **task-22** (merged bf6f36f1, code 9390f830): rewords the run.md post-merge block, wave.md steps 7, 8 and 10, queue-and-gate.md section 5 (tier and overlay bullets), the scope doc's Defaults, closing-an-epic 7a's per-tier close and the CHANGELOG Check tiers entry to decide from the effective tiers (declared plus overlay). Wording only, no test or code change; 67 non-test diff lines.
- **task-23** (merged 996f1bba, code e31720d2): wave.md step 8's compose command gains `--worktree <absolute worktree path> --artifact <absolute path>` after the pinned prefix; its refusal clause and dispatch.md's 'Compose requires' sentence name the absolute `--worktree` (coder, tester and every judge turn but the spec-reviewer's and the auditor's) and the absolute `--artifact` (every judge turn). One regex in handbackPreflight.test.ts changed by the same words.
- **Epic notes for later tasks:** `foldTasks` never folds a task to `waived`, `failed` or `escalated` once a `wave-merged` names it, so the `waived` and `held-by-operator` blocker reasons cannot fire from a real log today; their tests mock `foldTasks` (from the task-2 runner). Each coder's CHANGELOG paragraph for task-11 is in its result `notes` under state/results/.

## Review round 1 — changes

Findings are numbered as in `state/results/bs-check-tiers.spec-review.json`.
Each was checked against `bs/bs-optimize/integration` before changing the
plan.

1. fixed: confirmed `finishedInLog` (taskLifecycle.ts:107) reads `wave-merged` directly and feeds goalCheck.ts:270, specChange.ts:291 and spec.ts:658. D1 now reopens the task in `finishedInLog` and `reinstatementBlocker`; task-2 claims taskLifecycle.ts and tests the goal-check credit, amend draft, readiness, wave next and admission.
2. fixed: D4 step 2 re-runs the failed checks at the head before any bisect; a non-reproducing red is `not-reproduced`, blames no task and is flaky evidence; env-classified reds skip bisect. task-7.
3. fixed: confirmed queue.ts `landCandidate` (:465) fast-forwards a clean holder and refuses a dirty one. The revert lands through it (task-12 exports it from queue.ts on a keeps_exports promise); the clone criterion now says the holder follows the ref. task-12.
4. fixed: confirmed gate.ts:1052 keys coverage evidence on the check name. New D9: `runGate` refuses a deferred stage-bound check, proposals skip it, apply refuses it. task-1, task-9.
5. fixed: D3 keeps `bs integration check` (including `--tier all` at close) at the clone root under today's contract; only post-merge runs use a scratch worktree, prepared by `--setup-cmd` and the gate's deps check (`setup-failed` otherwise). OQ5 of round 0 is now a decision. task-5, task-11.
6. fixed: D2 keeps `--test-cmd`/`--select-test-cmd` exactly as today when the file declares no later tier; the queue decides, and a test pins it. task-4, task-11.
7. fixed: D7 gives the minutes-saved formula per option with a worked example the test pins; every option shows runs covered, minutes spent and minutes saved. task-9.
8. fixed: D7 shows the decisions.json shape and vocabulary (approve/decline, `to_tier`, promote items); task-9 validates it and task-11's test checks the playbook example against the validator.
9. fixed: new task-13 gathers ledger inputs across lineages for one project from `--specs-dir` plan files, with the claims map; task-10 exposes `--project`/`--specs-dir`.
10. fixed: D10 keeps an empty file's pass as today's contract and refuses only a non-empty file with an empty pre-merge selection; a test pins both. task-1.
11. fixed: the revert candidate is tested with the pre-merge and post-merge tiers before landing (D4). task-12.
12. fixed: task-7 is split along the bisect/revert seam into task-7 (reproduce and bisect) and task-12 (revert, land, bounce); ledger input gathering moved to task-13; the CLI is split into task-10 and task-14. Every task is now at most 91% of the token cap and 82% of the diff cap.
13. fixed: D4's trigger is enforced by the verb (4 merges, or no task in flight, or `--final`; else `batch-not-ready`), and the ledger reports merges per post-merge run. task-7, task-8.
14. fixed: confirmed `createTaskWorktree` uses `worktree add -b` (worktree.ts:252). D1 defines `bs worktree create --reopen --revert`, which fast-forwards the existing branch and commits the revert of the revert. task-14, task-11.
15. fixed: OQ3's default is now exposure-based (ran on a sensitive-claim task in the window, or a real catch there ever), so a security check that never failed is protected. task-8, task-9.
16. fixed: confirmed `CheckResult.cmd` is set only on integration records (testgate.ts:55). `testgate.run` now sets `cmd_sha256` on every result (task-1); rows without it count only toward catches and guardrails (D6, task-8).
17. fixed: D5 adds `--checks` to `epic close`/`epic verdict` (the file supplies tiers and digest), defines the no-flag case, and reads pre-epic records exactly as today. task-6, task-14, task-11.
18. fixed: new D8 says the checks file lives at an untracked path, and apply and promotion refuse a tracked file. task-9, task-11.
19. kept: a coverage note, not a defect. For round 2, task-3 and every task's nonfunctional clauses are unchanged in substance and were not read in depth in round 1; task-13 and task-14 are new.

## Review round 2 — changes

Findings are numbered as in the round-2 `state/results/bs-check-tiers.spec-review.json`.
Each was checked against `bs/bs-optimize/integration`. Where a round-1 line
above describes something changed here, this list is the current answer.

1. fixed: D4 now records the revert's two test runs at the revert commit before the ref moves (no second whole-tier run), preflights the bounce with task-2's new `waveRevertBlocker`, and makes the post-landing step resumable: every run first scans for bs revert commits (trailers `Bs-Revert-Of`, `Bs-Task`, `Bs-Red-Record`) without a `wave-reverted` and completes it, or returns `revert-landed-unrecorded` on every run until resolved. task-2, task-12 (crash-after-landing and amended-away tests).
2. fixed: `--project` means the project directory across the `checks` namespace, as on all 18 existing uses in usage.ts; the project scope comes from the plans under `--specs-dir` (`checks.mixed-projects` on more than one). `bs checks post-merge` takes `--specs-dir`, `--state-dir` and `--now` for promotion (D6). task-10, task-13, task-14. (Superseded by review round 4 item 7 and the consistency sweep, fd7db283: `bs checks post-merge` takes no `--specs-dir`, and run.md's line carries none.)
3. fixed: new D8. bs never writes the project's checks file; learned tiers live in `<project-root>/.blacksmith/check-tiers.json`, git-excluded like `bs init`'s local files (workroot.ts `excludeFromGit`); the declared tier wins over the overlay, and stale entries are reported `shadowed` or `orphaned`. Only undeclared entries are proposed, with one validator for proposals and apply, so the batch never asks about a move apply would refuse. New task-15 (overlay module); task-9 (apply and promotion write only the overlay and the event); task-10 (`readChecksFile` resolves the overlay).
4. fixed: D4's trigger gains a dependency arm (any not-yet-admitted task depending on an uncertified merge makes the run due, and the playbook calls the verb before admission), and the idle arm ignores tasks the operator holds open (`HELD_OPEN_BY_AN_OPERATOR`, taskStatus.ts:77). D7 measures the batches that really ran. task-7, task-11.
5. fixed: confirmed the floor at installCheck.ts:217 (git 2.38) and that `merge-tree --merge-base` needs 2.40. The revert is now built with `git revert -m 1 --no-edit` in a scratch worktree, which 2.38 has; the floor is unchanged and the spec states it. task-12.
6. fixed: D6 qualifies every task id before any join (bare ids take their session's single epic, else `unattributed`), and an unattributed or claimless task counts as sensitive, so the guardrail fails closed. task-13 (qualification), task-8 (fail-closed join), both with tests for both spellings.
7. fixed: close runs `bs checks post-merge --final` then `bs integration check --tier remaining`, which runs only tiers with no current passing record, so no tier runs twice; records now carry `tiers` (an array). D7's R and M include close-time runs and B includes `--final` runs, with a re-pinned example. task-5, task-6, task-9, task-11, task-14.
8. fixed: D4's base must carry the current effective checks' digest; without one the base is the fork point, probed first (`red-at-base` blames no task), and `no-new-merges` needs a record at the head with that digest. task-7.
9. fixed: D1 and wave.md step 9 put `failing_checks`, `log_tail` and the red record's id from the latest `wave-reverted` into the reopened coder's brief; task-11's playbook test pins it.
10. fixed: D4 derives the branch only from `integrationBranchName(epic, epicBranchPrefix(...))`, requires the `<prefix>/<epic>/integration` shape and refuses the default branch (`postmerge.not-integration-branch`); task-12 tests a call naming `main`.
11. fixed: OQ4 and OQ6 now list options (a)/(b)/(c) with a recommendation. D8 no longer refuses the operator anything, so it is a decision, not a question; OQ1 names what its option (b) would cost under D8.
12. fixed: D6 states the specs-dir layout (`<specs-dir>/<epic>/plan.json` and `plan-v<n>.json`) and makes an unreadable plan file or session log line stop the ledger with the path named (`checks.plan-unreadable`, `checks.session-unreadable`), never a silent skip; post-merge reports `promotion-skipped` and still reverts. task-13, task-14.
13. fixed: confirmed testgate.ts runHeavy returns `reason: 'heavy.wait-timeout'` without running the command (testgate.ts:70, :349). D4 returns `lock-timeout` for it at the head, in any probe and in the revert test, and D6 classes it `not-run`: never a run, minute, red, catch or flaky evidence. task-1 (`isNotRun`), task-5 (`not_run` on records), task-7, task-8, task-12, each with a test.

## Review round 3 — changes

Findings are numbered as in the round-3 `state/results/bs-check-tiers.spec-review.json`.
Each was checked against `bs/bs-optimize/integration` and this design. Where
an earlier round's line describes something changed here, this list is the
current answer.

1. fixed: confirmed workroot.ts `excludeFromGit` swallows failures and returns `tracked`, `not-a-repo` or `failed` without excluding (workroot.ts:272-313). D8 now reads that result: `added`/`already-ignored` proceed, `tracked` refuses `checks.overlay-tracked`, `failed` refuses `checks.overlay-exclude-failed`; outside a git repository there is no overlay (`overlayPath` null, undeclared entries resolve to `pre-merge`, writes refused, proposals carry only a notice). task-15, task-9.
2. fixed: D8 serialises every overlay read-modify-write with an `O_EXCL` lock file beside it (the heavy lock's mutex pattern, heavyLock.ts:135) plus a `revision` check (`checks.overlay-moved`); task-15 tests two concurrent writers and a stale revision.
3. fixed: D8 names the validity rules (keys, version, revision, 64-hex digest, tier values, no duplicate check and digest), one report precedence (a declared entry is `shadowed` even with an edited command), the crash seam (`opts.beforeRename`), and replaces the grep criterion with a test that runs every function against a mode-0444 checks file. task-15.
4. fixed: the resume now has a terminal exit for every case: a bounce when the task is still completed and not re-merged, else a `record-only` `wave-reverted` with the reason (`superseded`, `waived`, `held-by-operator`, `re-merged`, `unknown-task`) and outcome `revert-recorded` once; `revert-landed-unrecorded` is gone. D4 and the resume share one scan (task-7 `landedBsReverts`), bounded by the fork point, never by the base. New task-16 owns the resume with a test per exit; task-2 adds `disposition`; task-12 calls the resume first.
5. fixed: D6 and task-13 keep an event whose session lineage touches one of the epics even when its own task id cannot be qualified, as `unattributed`; the test asserts it is in `events` and, through task-8, marks the check guarding.
6. fixed: the ledger reads four plan fields only; a plan file that does not parse or lacks them is skipped with a `checks.plan-skipped` warning, and its tasks then have no claims entry, so they count as sensitive: skipping can only protect a check. Only a specs dir with no readable plan stops the ledger. An unreadable session log instead marks the ledger `degraded` and stops proposals (a lost line could hide a catch), while promotion, which only moves checks earlier, still runs. task-13, task-9, task-10.
7. fixed: D8's crash order writes the earlier tier first: apply appends `check-tier-decided` then writes the overlay; promotion writes the overlay (with `pending_event`) then appends `check-tier-promoted`; `reconcileOverlay` runs under the lock at the start of every apply, promotion and proposals call. Overlay writability is pre-validated with the rest, and proposals carry no items when it fails. task-15, task-9, each with a crash test.
8. fixed: `bs checks ledger` takes an optional `--checks` and then prints the overlay report; D8 and AC8 say so. task-10.
9. fixed: certification is now per check (D5): every result carries `check_sha256` (name, command, heavy, timeout, never the tier), and close needs each current check certified at the head. A tier move never invalidates a result, so the operator's answer never forces a re-run and close never passes on a result for another command. run.md asks and applies the batch before step 12's runs, and task-11's test compares the line offsets. task-1, task-5, task-6, task-7, task-11, task-14.
10. fixed: task-6 gains a test for each fail-closed branch: an unresolvable head, a post-epic record with no `tiers`, and one whose `results` is not an array; task-5's `latestTierChecks` reports such records `malformed`, never empty.
    > **Superseded** by "Re-specification of task-5 and task-6 — changes": `latestTierChecks` no longer exists; a malformed record now withholds certification and never blocks as such (88e1ffec).
11. fixed: `runChecksAt` names each scratch worktree `scratch-<pid>-<uuid>`, removes registered scratch worktrees of dead pids (heavyLock.ts `pidIsAlive`) and runs `git worktree prune` before adding; task-5 tests concurrent runs and a dead run's leftover.
12. fixed: task-3's doc test asserts the operator's three asks (per-option runs covered, minutes spent and minutes saved; one batch question; a predefined architecture that becomes a feature) and a `Status: planned.` line under each part's heading; task-11 flips them to `Status: shipped.` and its test asserts that.

## Review round 4 — changes

Findings are numbered as in the round-4 `state/results/bs-check-tiers.spec-review.json`.
Each was checked against `bs/bs-optimize/integration` and this design. Where
an earlier round's line describes something changed here, this list is the
current answer.

1. fixed: task-2 exports one `RECORD_ONLY_REASONS` list (`superseded`, `waived`, `held-by-operator`, `re-merged`, `not-merged`, `unknown-task`, `invalid-trailers`) that task-16 uses, and `recordWaveReverted` accepts any record-only call with a listed reason and a fresh `revert_sha`: `task_ids` may be empty, `reverted_merge_sha` null, and the evidence lists empty with `evidence: unreadable`. D4 validates the trailers first (invalid -> `invalid-trailers`), and the revert commit gains `Bs-Failing-Checks`, so a bounce never needs the red record (`evidence: trailers-only`). task-2 and task-16 each test every case.
2. fixed: confirmed `emitWaveMerged` writes only `task_ids` and `files_changed` (taskEvents.ts:687-688). task-4 now records `merge_sha` on every `wave-merged` the queue writes (queue.ts:367, :649, :942) through a new `emitWaveMergedWith` export (taskEvents.ts claimed, keeps_exports). Re-merged means some `wave-merged` for the task carries a `merge_sha` that has R as an ancestor; D4 proves the reverted merge itself can never qualify (it is an ancestor of R), and a `wave-merged` without `merge_sha` never counts. `waveRevertBlocker` takes `revertSha` and an injected `isAncestor`; task-2 and task-16 test the mislabel case.
3. fixed: `bs checks proposals` (task-10) runs `reconcileOverlay` under the lock before the pure `pendingProposals`; its contract now says it writes nothing on a consistent overlay and only owed entries or events otherwise. `bs checks ledger` never writes. task-9's crash criterion names the CLI as the caller.
4. fixed: D7 defines the reply grammar (items numbered, options lettered with `a` = keep, `<n><letter>` tokens or `none`; an unparseable reply decides nothing), and every reply ends in one `bs checks apply --epic`, which appends `check-tier-batch-answered`; the playbook asks only while `answered_in_epic` is false, so only step 12's first pass asks. task-2 adds the event name; task-9, task-10 and task-11 implement and test it, task-11 by parsing the run.md example. (Refined by the after-#514 sweep, b12b69b2: every reply ends in one accepted apply; a refused one is re-run once without the items its refusal lists, or goes to the operator.)
5. fixed: promotion no longer reads the ledger (round 4's finding 7 below), so the truncated-plan fixture is gone from task-14; its criterion now uses an overlay whose location is tracked by git, which really skips promotion (`checks.overlay-tracked`) while the outcome stands. `checks.plan-unreadable` no longer exists anywhere in the plan; task-13 skips such a plan with `checks.plan-skipped`.
6. fixed: task-13 no longer filters by time; it returns every kept event and the window bounds, and task-8 applies the window to the numbers only, while the sensitive-path guard reads catches over every kept event. task-8 tests a real catch 40 days old still blocking demotion.
7. fixed: promotion evidence is the post-merge run itself (a red reproduced at the head, neither env nor not-run, bisected to a culprit), so it fires on every outcome reached after the culprit is found (`reverted`, `revert-has-dependents`, `revert-not-applicable`, `revert-conflict`, `revert-red`, `integration-dirty`, `integration-moved`, `lock-timeout` in the revert test), not only on `reverted`; `red-at-base` promotes nothing. task-12 returns `culprit` on those outcomes, task-9's `promoteAfterCatch` takes it, task-14 calls it on all of them and no longer needs `--specs-dir`.
8. fixed: D2 no longer refuses `--select-test-cmd` with tiers: neither command runs and the landing event says so, so a playbook that passes the flag never meets `cli.invalid-flag` after an approved demotion. task-10 adds a queue fixture with an overlay-only demotion; task-4's criterion changed to match.
9. fixed: `runPostMerge` and `resumeLandedReverts` share one result shape with `resumed` on the result (`{outcome, resumed, ...}`), and task-12's criterion asserts `{outcome: 'reverted', resumed: true}`. task-16 builds its fixtures in its own test file with the repo builder task-7 exports from test/helpers/integrationRepo.ts (imported, not edited).
10. fixed: each proposal item carries task-8's `importance`, and the batch is ordered by post-merge minutes saved. D6 says why an eligible item's importance is always 0 (eligibility requires zero real catches, which is stricter) and why the figure is still shown. task-9 tests the order.

Re-slice this round: task-2 is split into task-2 (taxonomy and `revert.ts`, the event's vocabulary and writer) and new task-17 (the lifecycle readers that reopen a bounced task), so both stay well under the cap.

Budgets after this round (measured from plan.json): seventeen tasks, at
most 93% of the coder token cap (task-5, task-9 and task-10, 410,000 of
440,000) and 86% of the diff cap (task-5, 1,200 of 1,400). Earlier rounds'
budget lines describe earlier plans.

## Review round 5 — changes

Findings are numbered as in the round-6 dispatch (the round-5
`state/results/bs-check-tiers.spec-review.json`). Each was checked against
`bs/bs-optimize/integration` (430dc5b7). Where an earlier round's line
describes something changed here, this list is the current answer.

1. fixed: confirmed: db/foldPredicates.ts:12 `TASK_TYPES` is pinned by test/db/foldPredicates.test.ts:395 to every type `projectTasks` and its callees compare. task-17 now claims foldPredicates.ts (keeps_exports, one `'wave-reverted'` entry) and has a criterion that runs the guard and fails it by name without the entry. No other task claims the file, and its only importer is projector.ts, which is task-17's, so no edge is needed.
2. fixed: confirmed: test/eventTypes.test.ts:274 fails a taxonomy value that nothing in src writes, and the excuse list (eventTypeScan.ts:262) is unclaimed. task-2 now adds only `wave-reverted`, which its own `recordWaveReverted` writes. task-9 adds `check-tier-decided`, `check-tier-promoted` and `check-tier-batch-answered`, which it writes through module-level constants in `event_type:` properties, the promotion one inside the stored `pending_event`. task-15 writes no event name: it appends `pending_event` as stored. Each taxonomy editor also bumps `version` (taxonomy.yml:9), mirrors §8 (taxonomy.test.ts:305) and the pinned version (taxonomy.test.ts:205), so task-2 claims test/taxonomy.test.ts, and task-9 claims taxonomy.yml, the architecture doc and that test. A new claim-order edge task-9 -> task-2 serialises them. Checked against the same rule: `wave-reverted` (task-2) and the three `check-tier-*` names (task-9) are the only event types the plan adds. task-2's old criterion was also vacuous: `appendEvent` never refused an unknown type (events.ts:26), so it now runs eventTypes.test.ts both ways.
3. fixed: confirmed: plan.ts:956-964 drops a finished task from v(n+1). Chosen: refuse, not re-add. `waveRevertBlocker` takes `liveTaskIds` and returns `not-in-live-plan`. task-12's preflight then builds no revert, the outcome goes to the operator once and the head stays red. task-16's resume records an already-landed revert of such a task as `record-only` with that reason, which joins `RECORD_ONLY_REASONS`. Re-adding the task from the bounce would give two answers to "does this task exist" and would amend a plan without a planner or an operator. D4 has the reasoning against "ask the operator once". Fixtures: task-2 (the blocker), task-12 (merge, amend, post-merge red, outcome, against the same run without the amendment), task-16 (landed, then amended), task-17 (the record-only event leaves every reader finished).
4. fixed: task-9's crash criterion names only `applyTierDecisions` (and `promoteAfterCatch` for the promotion half) as the reconciling caller and says `pendingProposals` is a pure fold. task-10's contract says `bs checks ledger` is read-only, and `bs checks proposals` is read-only except for the writes `reconcileOverlay` owes, which carry the envelope. task-10 gains the CLI fixture for an owed overlay entry.
5. fixed: flags added. `bs checks proposals` requires `--session`, `--plan-version` and `--causal-parent`, meaning what they mean on `apply` and `post-merge`. A missing one exits 1 before anything is read or written, and an owed `check-tier-promoted` lands with that envelope (task-10 criterion). The reconcile stays on proposals, because D8 promises convergence on the next proposals call. task-11's run.md line passes the three flags, and D8 states the rule for every verb.
6. fixed: task-13's summary now says it returns every kept event with the window bounds and no time filter. Its first criterion, which said "in-window", now says in or out of the window.
7. fixed: a resumed write carries its culprit, rebuilt from the valid trailers. A bs revert commit exists only after a culprit was found, and there is no culprit for `invalid-trailers`, `unknown-task` or `not-merged`. task-12's result field is now the list `culprits`, so a resumed return can carry each culprit. task-14 promotes on every entry, and task-9's promotion reads each check's own result from the red record, returning `red-record-unreadable` (reported as `promotion-skipped`) when that record is lost. Fixtures: task-16, task-12 (crash after landing) and task-14 (a resumed `reverted` promotes; with no red record, `promotion-skipped`).
8. fixed: task-16's criterion adds `not-merged` (a known task with no `wave-merged`) and `not-in-live-plan`. task-7's repo builder takes the four trailers as parameters (`{revertOf, task, redRecord, failingChecks}`), each defaulting to its valid value, replaceable by any string, or omitted. task-7 tests that and task-16 writes every bad trailer through it.

No re-slice this round: the slicing and waves are unchanged (`bs wave schedule`: depth 7, widest 5, no constraints; `bs claims impact` on the base export: 7 symbol crossings across 6 ordered pairs and 17 on keeps_exports promises, as in round 5).

Budgets after this round (measured from plan.json): seventeen tasks summing to
6,435,000 declared coder tokens; the largest token budget is 420,000 of
440,000 (task-9, task-10, 95%) and the largest diff budget
1,200 of 1,400 (task-5, task-9, task-10, task-14, 86%). Earlier rounds'
budget lines describe earlier plans.

## Review round 6 — changes

Findings are numbered as in the round-7 dispatch (the round-6
`state/results/bs-check-tiers.spec-review.json`). The round-6 review
confirmed all eight round-5 answers; these four are what it left.

1. fixed: `pendingProposals(ledger, events, effectiveChecks, overlay, {epicId, writable, now})` names every input it reads. `writable` is task-15's `overlayWritable(dir)` answer and `epicId` the `--epic`, both computed by task-10's `bs checks proposals`, so the fold takes no `dir` and runs no git command. task-9's criterion 7 passes `unreadable`, `tracked` and `not-a-repo` in as arguments, and its batch-answered criterion passes `epicId`. D7 says the same.
2. fixed: `bs checks proposals` takes the lock only when task-15's new pure `overlayOwes` finds a write to make, after a lock-free read. With `overlayPath` null it prints the `not-a-repo` notice (no items, exit 0) and takes no lock. With no `.blacksmith/` directory nothing can be owed, so it prints its items and creates no directory, lock or file. task-10's criterion 4 tests both cases. task-15 says `withOverlayLock` is never called when `overlayPath` is null (a call made anyway throws `checks.overlay-not-a-repo` and creates nothing), and that it creates `.blacksmith/` when absent, because only a caller about to write takes it. Without that, the first apply in a fresh project would hit the same missing directory. task-9's apply and promotion check `overlayPath` before the lock. D8 states the rule.
3. fixed: task-12's criterion 8 names `setup-failed` and `lock-timeout` raised while R is tested as carrying the culprit, one fixture each, and keeps them empty when they come before a culprit. D7's promotion list now includes `setup-failed` in the revert test.
4. fixed: task-12's step 2 and D4 offer only what exists, each of which re-certifies the head: a plan amendment that re-adds the task (`draftNextVersion` accepts an added id the previous version does not hold live, plan.ts `oneLiveRecordPerId`), an amendment adding a task that fixes the defect, or an edit to the failing check. No verb waives a red tier, so none is offered. task-12's criterion 9 shows that re-adding works (the next call is `reverted`). task-11's playbook names the same three for `not-in-live-plan`, with a test.

No re-slice this round: tasks, claims, edges and waves are unchanged.

Budgets after this round (measured from plan.json): seventeen tasks summing to
6,455,000 declared coder tokens; the largest token budget is 425,000 of
440,000 (task-10, 97%) and the largest diff budget
1,240 of 1,400 (task-10, 89%). Earlier rounds'
budget lines describe earlier plans.

## Operator answers (v2)

The operator answered all three questions in one batch at event
`bs-check-tiers-run-2026-10-30#40`: "1c 2a 3b 4a", where 4a is the sign-off
of plan v2.

- **OQ-v2-1. Where the post-merge batch sits against rolling admission.**
  Answer: **(c)**. The two other options were:
  - (a): every admission waits while a due batch runs;
  - (b): only the dependents wait, with the hold kept as a playbook rule.

  What (c) changed:
  - The epic session starts the batch in the background. It admits at once
    every task `bs wave next` returns that `bs checks post-merge --held` does
    not list, and admits the held ones after a proceed outcome.
  - A verb enforces the hold. `bs wave check --checks --project` refuses a
    held task with `wave.held-by-post-merge`. On an epic with post-merge
    records, it refuses a check without `--checks` with
    `wave.checks-required`. (Stated exactly by the consistency sweep,
    5bad56cc: the predicate is any record that uses tiers, task-5's
    `lastTieredRecordId`, of which every post-merge record is one.)
  - task-7 exports `postMergeBase` and the pure `heldByPostMerge`, which is
    also the trigger's dependency arm.
  - task-17 adds the pure `assertNotHeld` to admission.ts.
  - task-14 ships `--held` and the `wave check` flags, and does the read.
  - task-11's run.md block runs the flow above.
  - Two edges are added: task-14 -> task-7 and task-14 -> task-17.
  - The question's option text named an edge task-17 -> task-5. It is not
    drawn, because admission.ts takes the held map as an argument and reads
    no record (see "Operator answers — changes").
- **OQ-v2-2. Which CI event runs which tier in what `bs new` scaffolds.**
  Answer: **(a)**: every tier runs on every pull request and push, one
  parallel job per tier, reading a committed `checks.json` when there is one.
  The other options were (b), later tiers run on later events, and (c), CI
  reads no tiers.
  - This option costs more CI minutes than today: one checkout and install
    per non-empty tier job. Its wall time can drop. (Since the consistency
    sweep, 3c48b247: plus one small listing job with no install, while an
    empty tier's job is skipped before any runner starts.)
  - main's merge rule is unchanged.
  - (a) was already the draft, so the plan does not change.
- **OQ-v2-3. e2e in what `bs new --ui` scaffolds.** Answer: **(b)**: the e2e
  workflow ships dormant in the `ui` layer. The other options were (a), add
  a Playwright suite to the `ui` layer, and (c), layer the workflow only
  when a suite exists.
  - Where the workflow lives: task-18's e2e.yml moves into
    `factory/scaffold/ui/`. The existing layer copy carries it, so scaffold.ts
    gains no branch.
  - How it stays dormant: one small `detect` job reads package.json for a
    `test:e2e` script. The shard job `needs` it and runs only when it reports
    one, so no shard runner starts while there is no suite.
  - check.mjs leaves an `e2e` entry to the workflow only when that script
    exists.
  - Both cases are pinned on real scaffold output, and the forge-mark scan
    still passes.

## Re-check against main (round 7) — changes

**History.** This section and the review-round lists after it record what
each round changed at the time. Where a passage describes an option the
operator did not choose, 'Operator answers (v2)' and 'Operator answers —
changes' supersede it; each such passage is marked (6499e401).

The round-7 spec review checked plan v1 against main and found fourteen
places where it no longer holds (`state/results/bs-check-tiers.spec-review-r7.json`).
The operator added one more, a46729fa. Each line names the finding id
(`f-bs-check-tiers/integration-<id>`). Line numbers are on `c13458d8`.

1. a46729fa — fixed by task-18. What `bs new` scaffolds now gets:
   - one gate script (`scripts/check.mjs`, run as `pnpm run check`), the
     same locally and in CI;
   - one CI job per tier on every pull request and push, with #502's
     PR-scoped cancel-in-progress;
   - a sharded e2e workflow with a cached Chromium and a non-fatal screenshot
     upload, layered only when the composed stack has an e2e suite. (Superseded by 'Operator answers (v2)':
     OQ-v2-3 (b) ships it dormant in the `ui` layer, gated by a detect job.)

   No `checks.json` is scaffolded, no tier default exists, and nothing needs
   GitHub Actions (AC15). Two conflicts with hard constraint 1 and AC13 remain
   for the operator. OQ-v2-2 asks which event runs which tier. OQ-v2-3 asks
   about e2e, because `factory/scaffold/ui/` holds `index.html`,
   `package.fragment.json`, `src/` and `vite.config.ts`, and no `test:e2e`.
   (Superseded by 'Operator answers (v2)': both were answered, OQ-v2-2 (a) and OQ-v2-3 (b).)
2. e28861ce — fixed by task-4. Confirmed on main:
   - queue.ts:332 `step` runs `stepUnderLock` inside `withHeavyLock` with
     `env: process.env`;
   - :348 builds `heavyChildEnv(process.env, lease)`;
   - testgate.ts:400 takes `opts.heavyLock?.env ?? process.env`;
   - heavyLock.ts:197-199 re-enters only on a matching `BS_HEAVY_LOCK_TOKEN`.

   The tier run now gets the lease as its lock env. `attemptCandidate` takes
   one lock for the candidate's whole tier run. New criterion 8 uses `unit`
   and `test-e2e` with a temporary lock directory, plus a mutation that must
   fail with `heavy.wait-timeout`. D2 states the rule. Sibling sweep: this is
   the only place a tier run sits inside a held lease. `runChecksAt` (task-5)
   and the revert test (task-12) hold none, and `bs heavy run` children
   re-enter through the token their env already carries.
3. 575023cb — fixed by task-1. Confirmed: paperwork.test.ts:94-103 pins
   `testgate-result` in inline snapshots, and only 40-hex values are
   normalised (:81). task-1 now claims the file. Criterion 9 names it, and
   testgate.test.ts:90's `results` `toEqual`, as gaining exactly the new
   fields. A grep of test/ for inline snapshots, `lock_wait_ms` and exact
   `results` matches finds no other exact pin of the payload.
4. 7cd42a04 — fixed by task-1, with task-10 for the overlay directory.
   Confirmed: briefCompose.ts:249-299 lists every entry under
   `GATE_CHECKS_HEADING`, called from cli.ts:6117. `selectGateChecks` is now
   the one selection that `runGate`, `results check --as gate` and
   `brief compose` all call. The brief lists the selected checks and names
   the deferred ones. task-1 claims briefCompose.ts and briefCompose.test.ts
   (criterion 10). briefComposeDocs.test.ts pins the documented commands, not
   this output, so it passes unchanged (task-11's criterion 5).
5. 5d4a0377 — fixed by task-8. Confirmed:
   - testgate.ts:115-120 `RunResult.environment` is index-parallel to
     `results`;
   - gate.ts:1262-1268 writes it beside `results`;
   - `CheckResult` (testgate.ts:47) has no `environment`.

   The ledger now pairs `environment[i]` with `results[i]` by name and treats
   `window: 'none'` as unmeasured. Its fixtures come from real `run` results,
   and an old-shape event cannot pass (criteria 6 and 9). D6 states this.
6. 78c887e5 — fixed by task-5 and task-4. Confirmed: integration.ts:192-226
   drops `outcome.environment` and writes `results` only. task-5 now writes
   `environment` on every record (clone, probe, scratch), with injectable
   `environmentSources` (criterion 8). task-4 writes
   `pre_landing_environment` and one `pre_landing_run_id` per run. D2 and D5
   state this.
7. 673a9c3e — fixed by task-11, with OQ-v2-1 open (since answered (c)). Confirmed: run.md:138-155
   (the epic session admits at once on each `wave-merged`, and the runner
   never admits) and queuePlaybook.test.ts:34-106. The post-merge rule moves
   to run.md's rolling admission: the epic session runs it, then
   `bs wave next`. wave.md step 10 leaves the batch to the epic session.
   Criterion 1 says the offset test means admission to work, not merge-queue
   admission. Holding this order makes admission wait while a due batch runs.
   Whether to hold only the dependents instead is OQ-v2-1. D4 states this.
   (Superseded by 'Operator answers (v2)': OQ-v2-1 (c) holds only the dependents, admits every
   other task at once, and has `bs wave check` refuse a held task.)
8. 35bdf960 — fixed by task-1. Criterion 8 lists `check_sha256` beside
   `cmd_sha256`.
9. 92be2499 — fixed by task-11. Criterion 5 names every test that reads the
   edited text and the sentences each one pins: queuePlaybook,
   handbackPreflight, briefComposeDocs, playbookCitations, playbookSlice,
   playbookOptimize, cliOptimize, heavyWait, wavePlaybook, docCommands,
   docErrorCodes and docCitations. None changes, and none is claimed. A
   sentence that would have to change is reported, not edited.
10. 79215b80 — fixed by task-11. The rule runs `bs checks post-merge` as a
    background task and waits for its completion notification or Monitor. It
    never runs inside `bs heavy run`. This is what wave.md step 10 (about
    :575-586) already says for `bs queue run`, and criterion 1 pins all three
    points.
11. fd5faa29 — fixed by task-10. Confirmed the `readChecksFile` callers on
    main:
    - cli.ts:1384, `results check --as gate`;
    - :4569, `gate run`;
    - :4872, `integration check`;
    - :6117, `brief compose`, which has no `--project`.

    `dir` is now optional and each caller names its own. `results check`
    passes `--worktree`. `brief compose` passes its `--worktree` when given;
    without one it reads declared tiers only and prints a line saying so (new
    criterion 8).
12. 2388b800 — fixed by task-4. The citations are queue.ts:419
    (`stepUnderLock`), :728 (`attemptCandidate`) and :1021 (`adopt`), with
    the function name first. Criterion 7 reaches each one by name.
13. ec6b37dd — fixed in all seventeen tasks. The Base clause now names main's
    exports: `RunResult.environment`, `CheckEnvironment`, `sleptDuringCheck`,
    `SLEEP_GAP_MS`, `heavyChildEnv`, and `withHeavyLock`'s token re-entry. It
    says no result carries its own evidence. The base table says the same.
14. 94908473 — fixed by task-1. Confirmed: cli.ts:1382-1384 only reads the
    file in the `checks` attempt. That attempt now calls `selectGateChecks`,
    so the dry run reports both refusals with the gate's code and message. It
    runs no check and writes no event (criterion 6).
15. 5e0e8518 — fixed in this spec. The status line, the base table (now with
    #502 and #511 rows) and "Out of scope" describe main at `c13458d8`.

The re-slice is one added task, task-18, with edges task-18 -> task-1 and
task-11 -> task-18. task-1 gains four claims: briefCompose.ts,
briefCompose.test.ts, paperwork.test.ts and cliResultsCheck.test.ts. No other
claim changes. The schedule is still seven waves, widest five, and the same
seven crossings as v1 each sit on an edge.

Budgets after this round (measured from plan-v2-draft.json): eighteen tasks
summing to 6,950,000 declared coder tokens. The largest token budget is
430,000 of 440,000 (tasks 1, 4, 5 and 10, 98%). The largest diff budget is
1,240 of 1,400 (task-10, 89%), and `diff_lines` now counts non-test lines
only (#511).

### Plan v2 review round 1 — changes

The pre-code review of the v2 draft (`state/results/bs-check-tiers.spec-review-v2-r1.json`)
raised eight findings. Each line below gives the finding id
(`f-bs-check-tiers/integration-<id>`) in the order the review lists them.
Line numbers refer to `c13458d8`.

1. aabfcf57 — fixed by task-4 and task-8. Confirmed on main:
   - `emitTaskBlocked` (taskEvents.ts:698-715) writes only `error`,
     `severity`, `task_ref` and a string `detail` (`TaskErrorInput`,
     :53-58).
   - `logBlocked` (queue.ts:326) passes a string.
   - A red multi-task candidate goes to `bisectGroup` (queue.ts:769) and gets
     no event of its own.

   What changes:
   - Every queue tier run now writes one `queue-tier-run` record. It holds
     `task_ids`, `run_id`, `tree_sha`, `results` and `environment` side by
     side.
   - The landing event names that record through `emitWaveMergedWith`. The
     blocked event names it through a new export, `emitTaskBlockedWith`.
     `emitTaskBlocked` and `TaskErrorInput` stay as they are.
   - task-4 adds the event type to taxonomy.yml and the architecture doc, and
     claims `taxonomy.test.ts`. Two new claim-order edges (task-4 -> task-2,
     task-9 -> task-4) keep the taxonomy chain in order.
   - task-4's criteria 3, 4 and 9 and task-8's criterion 9 cover this. D2,
     D6, AC3 and AC14 say so.
2. 541a89dd — fixed by task-18. This repo pins `pnpm@9.3.0` in package.json
   `packageManager`. The reviewer reproduced pnpm 9 forwarding a literal `--`
   to the script.
   - CI's tier jobs now call `node scripts/check.mjs --tier <tier> --ci`
     directly.
   - check.mjs drops one leading `--`, so `pnpm run check -- --tier ...` also
     works locally.
   - Criterion 3 runs each job's `run:` line read from ci.yml, plus both `--`
     shapes, with a mutation check.
3. dbfb36ae — fixed by task-18. Confirmed: `.github/workflows/ci.yml:23`
   groups on `ci-${{ github.event_name == 'push' && github.sha || github.ref }}`
   and names no workflow. A second workflow with the same block would share
   that group. e2e.yml now gets the prefix `e2e-`. A new functional clause and
   criterion 5 assert that the two groups differ.
4. dd3d51bc — fixed by task-18. check.mjs `--ci` now leaves an `e2e` entry to
   e2e.yml only when its `cmd` is exactly `pnpm run test:e2e`, the command
   e2e.yml shards. Any other e2e command runs in its own tier job. Criterion 4
   now judges the union by name and command, with a fixture whose `e2e`
   command differs.
5. 75e767fb — fixed by task-18. Confirmed: `const TOOLCHAIN_STEPS`
   (scaffold.ts:316) is not exported. It now gains `export`, an additive
   change that the `keeps_exports` promise allows, and nothing else.
   Criterion 2 imports it, and the contract says so.
6. 8a0a6d8d — fixed by task-11. The post-merge rule is now a run.md block of
   its own (`**Post-merge before admission.**`), after the dispatched-runner
   bullet. It says that "right away" and "at once" mean once the batch call
   has returned. (Superseded by 'Operator answers (v2)': the block is `**Post-merge and held
   tasks.**`, and the words apply to every task `--held` does not list.) Criterion 1's offset test reads that block only. It does not
   compare against run.md:139 or :154-155, which test/queuePlaybook.test.ts:35
   and :54 pin and which stay word for word.
7. 6cc5bf43 — fixed by task-1 and task-5. Confirmed: `function
   sleptFailedChecks` (gate.ts:1495) is not exported. task-1 moves it to
   testgate.ts as an export, and gate.ts imports it (task-1 criterion 11).
   task-5 classifies through it, and its criterion 6 forbids a copy.
8. f3289bab — fixed in OQ-v2-2, in this spec and in the plan's
   `open_questions`. Option (a) now says it costs more CI minutes than today:
   one checkout and install per non-empty tier job. It also says the wall
   time can drop. No option was chosen. (Superseded by 'Operator answers (v2)': (a).)

Budgets are unchanged by this round: eighteen tasks summing to 6,950,000
declared coder tokens, the largest 430,000 of 440,000. Schedule: depth 7,
widest 5. Claims impact still shows the same seven crossings, each on an edge.
One new promised crossing appears: taskEvents.ts (task-4's promise) ->
briefCompose.ts (task-1).

### Plan v2 review round 2 — changes

Review round 2 (`state/results/bs-check-tiers.spec-review-v2-r2.json`) confirmed all
eight round-1 answers. It raised three new findings. They are listed below by
id (`f-bs-check-tiers/integration-<id>`), in the review's order. Line numbers
are on `c13458d8`.

1. e46d03ff — fixed by task-18. Confirmed: `FORGE_MARKS` in
   test/scaffold.test.ts:911-916 matches four kinds of text:
   - the brand, with or without a hyphen, which also covers the overlay's
     directory name;
   - a factory CLI invocation;
   - a factory-internal path;
   - "the factory" in prose.

   The scan (about :957-960) runs over every file under factory/scaffold/ and
   over a generated project. task-18's objective now says the README states
   that learned tiers never reach CI without naming the tool, its files or its
   directories, and that every file the task writes passes the scan,
   check.mjs's header included. Criteria 6 and 7 hold the scan unchanged over
   check.mjs, ci.yml, e2e.yml, README.md and AGENTS.md, and a new
   nonfunctional clause says the same.
2. 7e86687a — fixed by task-1. Confirmed: test/testgate.test.ts:579-580 pins
   each result's key set to `exitCode`, `lock_wait_ms`, `name`, `pass` and
   `tail`. Criterion 9 now names this pin. It becomes exactly that set plus
   `check_sha256` and `cmd_sha256`, so it still proves that no result carries
   `environment`. It may be neither deleted nor loosened.
3. 834b0991 — fixed in OQ-v2-2 option (b), in this spec and in the plan's
   `open_questions`. The option now lists every task-18 criterion an answer
   of (b) would rewrite: 1, 3, 4 and 5. No option was chosen. (Superseded by 'Operator answers (v2)':
   (a), so none of them is rewritten.)

No claim, edge or budget changed. The schedule is still depth 7, widest 5.
Claims impact still shows the same seven crossings, each on an edge, and 20
promised crossings.

### Operator answers — changes

The operator's answers are recorded at `bs-check-tiers-run-2026-10-30#40` ("1c 2a 3b 4a"). Each line names the task
the answer changed.

1. **OQ-v2-1 (c): task-7.** task-7 now exports two functions.
   `postMergeBase` returns the base and the uncertified merges.
   `heldByPostMerge` is pure: given the plan's tasks, edges, statuses and the
   uncertified merges, it returns every not-yet-admitted task that depends on
   one of those merges. It returns nothing when there is no post-merge entry.
   The trigger's dependency arm calls the same function. New criterion 9
   tests it, written failing first.
2. **OQ-v2-1 (c): task-17.** admission.ts gains the pure `assertNotHeld`
   beside `assertNotInFlight`. It raises `wave.held-by-post-merge` naming the
   task and the merges it waits on. task-17 claims
   test/admissionHeld.test.ts for its new criterion 7, written failing first.
   Budget: 365k tokens, 960 diff lines.
3. **OQ-v2-1 (c): task-14.** task-14 ships two pieces.
   - `bs checks post-merge --held` is read-only: no worktree, no lock, no
     event.
   - `bs wave check --checks <file> --project <dir>` computes the held map
     and refuses a held task through `assertNotHeld`. Without `--checks`, it
     refuses on an epic with post-merge records (`wave.checks-required`).
     (Superseded in wording by the consistency sweep, 5bad56cc: on an epic
     whose records use tiers.)

   New criterion 8 lives in test/waveCheckHeld.test.ts, written failing
   first, and covers three cases:
   - a held task is refused by `wave check`;
   - an independent task is admitted while a batch runs;
   - a held task is admitted after a proceed outcome.

   New artifact edges: task-14 -> task-7 and task-14 -> task-17. Budget: 435k
   tokens, 1,300 diff lines.
4. **OQ-v2-1 (c): task-11.** The run.md block is now
   `**Post-merge and held tasks.**`. It works in four steps:
   - start the batch in the background;
   - run `--held` and `bs wave next`;
   - admit at once every task not held;
   - admit the held ones after a proceed outcome.

   Every `bs wave check` line in the playbooks carries `--checks` and
   `--project`. Criterion 1's offset test reads that block in that order.
   Budget: 420k tokens.
5. **OQ-v2-1 (c): the edge task-17 -> task-5 is not drawn.** The question's
   option text named this edge for a design that reads integration records
   inside admission.ts. In the shape implemented, admission.ts takes the
   held map as an argument and imports nothing from task-5 or task-7. The
   read happens in cli.ts's `wave check` arm, which belongs to task-14 and is
   covered by its new edges. An edge with no crossing behind it has no
   reason. Doing the read in admission.ts would also need task-17 -> task-7,
   which would push task-17, task-16, task-12, task-14 and task-11 one wave
   later (depth 8 instead of 7).
6. **OQ-v2-2 (a): no change.** It was already the draft. task-18's objective
   now cites the answer instead of the open question.
7. **OQ-v2-3 (b): task-18.** e2e.yml now lives in
   `factory/scaffold/ui/.github/workflows/`.
   - A `detect` job, run with `node` and no install, gates the shard job
     with `needs` and a job-level `if`. That shape skips the whole matrix
     before any runner starts.
   - A summary job passes when there is no suite. When there is one, it
     requires the shards to succeed. (Superseded by the consistency sweep,
     3c48b247: the summary job is skipped when there is no suite, so a
     dormant workflow shows no passed e2e job.)
   - check.mjs leaves an `e2e` entry to the workflow only when package.json
     has `test:e2e`.
   - scaffold.ts changes only by gaining `export` on `TOOLCHAIN_STEPS`.

   Criteria 4, 5 and 6 pin the real `bs new --ui` output in both cases: with
   no suite the shards are skipped; with a fixture that adds `test:e2e`, the
   shards run `test:e2e --shard`. The forge-mark scan still passes. Budget is
   unchanged: 380k tokens, 800 diff lines. (Superseded by the consistency
   sweep, 3c48b247 and 9e2b424a: task-18 is 400000 tokens, 800 diff lines.)
8. **4a: the plan is signed off.** The draft carries no open question. v1's
   six answers and v2's three are recorded in `planner_notes`, and the status
   line now reads "pending ingest".

Budgets after the answers: eighteen tasks summing to 7,020,000 declared coder
tokens. The largest token budget is 435,000 of 440,000 (task-14); the largest
diff budget is 1,300 of 1,400 (task-14). Schedule: depth 7, widest 5,
unchanged. Claims impact: the same seven crossings as before, each on an
edge, and 20 promised crossings. (Superseded by the consistency sweep,
9e2b424a: task-18 is 400000 tokens, so the eighteen tasks sum to 7,040,000
declared coder tokens; the largest token and diff budgets are unchanged.)

### Plan v2 review round 4 — changes

Review round 4 (`state/results/bs-check-tiers.spec-review-v2-r4.json`) checked
how the operator's answers landed. Its three findings are listed below by id
(`f-bs-check-tiers/integration-<id>`), in the review's order. Line numbers
are on `c13458d8`.

1. dc4b6bce — fixed by task-14 and task-11.

   Confirmed on main: `bs wave check` (cli.ts:2675-2716) reads the log only
   under `--session`, through `readLineageEvents`. The integration-check
   records come from `bs checks post-merge` and `bs integration check`, which
   write them under the epic session's envelope.

   Fixes in task-14:
   - `--held` now takes `--session` (and honours `--state-dir`) and reads that
     session's lineage. Without `--session` it exits naming the flag.
   - `wave check --checks --project` requires `--session` and reads the same
     lineage events it already reads for in-flight tasks.
   - Criterion 8 passes `--session S --state-dir T` on every command. It
     writes the green record through the real `bs checks post-merge` into S's
     log, and also from a session that continues S. Both release the hold.

   Fixes in task-11: every `wave check`, `--held` and post-merge line carries
   `--session` (the objective and criterion 1).

   D4 and AC6 say so. A call with no `--session` reads no log, as on the
   base, which is why the playbook lines carry it.
2. 6258503a — fixed in this spec. AC11's last sentence now says what (c)
   does: "right away" and "at once" apply to every task `--held` does not
   list, and held tasks wait for a proceed outcome.
3. 6499e401 — fixed in this spec. The history sections now open with a note
   saying that "Operator answers (v2)" supersedes any passage describing an
   option the operator did not choose. Each such passage carries a
   "Superseded by" marker:
   - round 7 item 1: the e2e layering and the two open conflicts;
   - round 7 item 7: admission waiting on the batch;
   - plan v2 round 1 item 6: `**Post-merge before admission.**`;
   - round 1 item 8 and round 2 item 3: "No option was chosen".

   The plan's round-1 and round-2 planner notes carry the same marker.

No claim, edge or budget changed. Schedule: depth 7, widest 5. Claims impact
still shows the same seven crossings, each on an edge, and 20 promised
crossings.

### Plan v2 review round 5 — changes

1. a88f39ad — fixed by task-14: criterion 8 now seeds S through test/helpers/cliHarness.ts `taskStatusFixtures` (imported, not edited): its `ingest` runs the real `bs plan ingest` of the A-D plan, so `wave check` meets no `cli.plan-not-ingested` (cli.ts:1614-1629) and C and D have `todo` rows; its `append` writes a `wave-merged` with `merge_sha` for A and for B, so both fold to `completed` and read as uncertified merges.

### Plan quorum (v2) — changes

> **Superseded** by "Re-specification of task-5 and task-6 — changes" at the end of this spec: the no-declaration union, `latestTierChecks`, the outcome table and `IntegrationStatus.coverage` described in this section were replaced. Kept as the record of the rounds.

1. d6c28b83 — the quorum escalated on disagreement. DeepSeek confirmed ("the plan is internally consistent"); Codex refuted ("task 6 contradicts itself: without a checks declaration it requires only checks named by the latest record at the head, yet its criteria require a post-merge-only latest record to leave a pre-release check blocked"). Codex holds: fixed by task-6 and task-5. Without a declaration the required set is now every check any non-probe post-epic record named, at the digest of the latest record naming it, certified at the head; task-6's objective, criterion 4 (the shadowing case blocks on P and R) and a functional clause state it, and task-5's `latestTierChecks` gains `latestByName` (criterion 7) because its per-commit view keeps no order across commits. Not per tier, because records carry no tier per result. D5 and AC5 say so.

### Plan quorum (v2) — review round 7 changes

> **Superseded** by "Re-specification of task-5 and task-6 — changes" at the end of this spec: the no-declaration union, `latestTierChecks`, the outcome table and `IntegrationStatus.coverage` described in this section were replaced. Kept as the record of the rounds.

1. 4a6f0ea9 — fixed by task-6. Without a declaration, an epic with no non-probe record (never run, or probe records only) blocks with main's no-record blocker (epic.ts:725, "has no integration-root check on record"), byte-identical, rather than reading an empty union as nothing to check. Criterion 4 pins both cases, with a mutation check. D5 says so.
2. c7939001 — fixed by task-6. The summary and the objective now state one blocker shape per mode: with a declaration, per check, naming the check and its tier (criterion 1); without one, per check, naming the check and the record that named it. The sentence "each failing tier is one blocker" is gone.
3. fb7a5f11 — fixed by task-5 and task-6. `latestByName`'s "latest" is now last in the lineage event order, the way main's `latestIntegrationCheck` (integration.ts:83-96) folds, never sorted by `ts`. Criterion 7 pins it with two records naming one check under different digests, in an order that `ts` would sort the other way.
4. 0ccc00f0 — fixed by task-6. Its contract now states the per-check rule: one per-check fold (task-5's `latestTierChecks`), and fail closed on an unreadable head, a malformed record, or a required check that no non-probe record certifies at the head.
5. 80bcf3d3 — fixed by task-6. Today's last-wins rule applies only when every record is pre-epic. Pre-epic records beside post-epic probe records, with no post-epic non-probe record, block with one blocker that names the latest probe and never pass on the pre-epic record. Criterion 4's empty-case test gains this third case; D5 says so.
6. 2af63fd5 — fixed by task-5 and task-6. The probe id, and the split between pre-epic and post-epic records, now have a named source. task-5's `latestTierChecks` returns `legacy`, `nonProbeCount`, `latestProbe` and `malformed` beside `byCommit` and `latestByName` (criterion 7). epic.ts replaces its `latestIntegrationCheck(events, …)` call (about line 1750) with one `latestTierChecks` over the same events, and reads no other event. There is no keeps_exports promise on integration.ts, because task-5 adds optional fields to exported interfaces; the edge task-6 -> task-5 carries the crossing.
7. 64e02a84 — fixed by task-6. Every record shape now has one outcome with and without a declaration, in one table: task-6's objective, mirrored in D5 and AC5. The last-wins rule applies only to row 3 without a declaration. With a declaration, pre-epic-only records block per check, because they carry no `check_sha256`. task-6's new criterion 5 is a table-driven test over every cell, written first.
8. 010cdcc0 — fixed by task-6. `IntegrationStatus` gains only an optional `coverage` (`{declaration, tiers}`), so the builders of `{check, headSha, branch}` in test/epic.test.ts, test/mcp.test.ts (:659, :699) and test/specFindings.test.ts compile and pass unchanged and are not claimed. Without `coverage`, `integrationBlockers`, the judge prompt (epic.ts:1329) and `epicSummaryPayload` (:1987) behave as on main. With `coverage`, `check` is `legacy` in row 3 and null elsewhere; the judge prompt lists one line per required check; and the payload gains `integration.coverage`. New criterion 6 pins this.
9. 8717758a — fixed by task-6. An empty requirement never passes. An empty declaration counts as none, as D10 makes an empty file today's behaviour. In row 5 without a declaration, an empty `latestByName` is one blocker naming the latest non-probe record.
10. b77f5fdb — fixed by task-5 and task-6. One classification of records: a post-epic record without a valid `tiers_present` is malformed, never pre-epic, and a malformed probe is malformed. Malformed records count in no other field. A new row M covers malformed records with no certifying record, and every row adds the malformed blockers.
11. 3601e652 — fixed by task-5 and task-6. "Certified" is defined once, as the head's last non-probe result for the digest being a pass, and the `<reason>` strings have a stated precedence.
12. a3bc5e33 — fixed in AC5 and task-6's summary. Today's strings apply only in rows 1 and 2 and in row 3 without `--checks`. Row 3 with `--checks` is named as a deliberate change.
13. f24b826c — fixed by task-6. Criterion 5's table test now names a fixture for every cell, with the cases the review listed. Criterion 2's probe case now has another non-probe record beside it, so it is row 5.
14. 18712985 — fixed by task-5. The objective writes `TierChecks` and its entry types with every field, and `outcome: 'not-run'` marks a not-run result. Criterion 7 says `byCommit` and `latestByName` never hold a probe's result, while `latestProbe` names the last probe.
15. f026d695 — fixed by task-5. Its summary now describes the per-check fold that returns `TierChecks`.

### Re-specification of task-5 and task-6 — changes

Five narrow review rounds on the close rule found 2, 2, 2, 8 and 9 new gaps,
all from one root: without a declaration, the required set was re-derived
from the records, so every record shape (pre-epic, probe, malformed, empty)
needed its own row. The re-specification removes that root. With `--checks`,
the required set is the declaration and the records are only evidence, so a
record can withhold certification and never define, grant or shadow it.
Without `--checks`, the close is main's on an epic whose records use no tiers,
and is refused with one blocker on an epic whose records use tiers. The one
deviation from "keep exactly main's behaviour without a declaration" is that
refusal: `bs epic close` stays callable without `--checks`, main's last-wins
record on a tiered epic is typically a partial post-merge run or a probe, and
hard constraint 7 requires the verb, not the playbook, to say no (task-14's
wave check already refuses the same way). task-5 exports one definition of
certified (`certifyChecks`) and two small readers (`latestIntegrationCheckAt`,
`lastTieredRecordId`) in place of `latestTierChecks`. task-6 adds
`EpicVerdictInput.checks` and two optional `IntegrationStatus` fields in
place of `coverage`. Claims and edges are unchanged; two sentences in task-7
and task-14 change (the epic session applies them). D5, AC4 and AC5 above
say the same.

1. d6c28b83 — fixed by task-6. With a declaration every declared check needs its own certification at the head, so a post-merge record at the head cannot stand in for a pre-release check (criterion 1). Without one, an epic whose records use tiers is refused with one blocker asking for `--checks` instead of being read by last-wins (criterion 4); main's rule stays only for epics whose records use no tiers, where no shadowing can arise. The contradiction between objective and criterion is gone because the no-declaration union is gone.
2. 4a6f0ea9 — obsolete under the re-specification, because no union is computed from records any more. Without a declaration, a never-run epic gets main's no-record blocker and a probes-only epic is refused (a `probe_of` key uses tiers); with one, no record means one `no-result` blocker per declared check. task-6 criteria 3 and 4 pin all three.
3. c7939001 — fixed by task-6. The summary and objective name two blocker shapes only: per declared check (check, tier, reason) with `--checks`, and one refusal or main's strings without. No per-tier blocker or per-tier fold remains anywhere.
4. fb7a5f11 — fixed by task-5. "Last" is defined once in `certifyChecks`: the highest index in the events array as given, then the highest result index; never `ts`. task-5 criterion 7 pins both orders against a `ts` that sorts the other way.
5. 0ccc00f0 — fixed by task-6. The contract clauses now read: one certification rule (task-5's `certifyChecks`); with a declaration the required set is the declaration; without one, main's rule only for epics whose records use no tiers. No per-tier wording is left.
6. 80bcf3d3 — obsolete under the re-specification, because there are no pre-epic or probe rows to leave a gap between: without a declaration, records written before this epic beside later probes use tiers (the probes' `probe_of`) and are refused; with one, each declared check is `no-result`. task-6 criterion 4 pins the first case.
7. 2af63fd5 — obsolete under the re-specification, because no probe-only blocker naming the latest probe exists. The one refusal names the last record that uses tiers, from task-5's exported `lastTieredRecordId`, which task-6 reads; the "every record is pre-epic" test is gone.
8. 64e02a84 — fixed by task-6 and in AC5. With a declaration, no record shape changes the rule: a record written before this epic carries no `check_sha256`, so it certifies nothing and each declared check it alone covers is `no-result` (task-6 criterion 2), named in AC5 as a deliberate change.
9. 010cdcc0 — fixed by task-6. `IntegrationStatus` keeps `{check, headSha, branch}` and gains optional `declared` and `tieredRecordId`; `computeEpicSummary` sets them from the events it already reads; `check` is stated per path; `integrationBlockers`, the judge prompt and `epicSummaryPayload` are specified for both paths; every existing builder compiles unchanged (criteria 5 and 6).
10. 8717758a — fixed by task-6. An empty declaration blocks once with its own string, even when passing records sit at the head (criterion 3). Without a declaration no required set is derived, so an empty `latestByName` cannot arise.
11. b77f5fdb — obsolete under the re-specification, because the close no longer classifies records. With a declaration, a malformed record drops out of the evidence and can only withhold certification; without one, a malformed `tiers` or `tiers_present` counts as using tiers and is refused. D5's "missing `tiers_present`" clause is removed.
12. 3601e652 — fixed by task-5 and task-6. Certification has one definition, `certifyChecks`, read by the close, by `--tier remaining` and by task-7's base; the reason comes from the deciding result (`failed` or `not-run`) or its absence (`changed`, else `no-result`).
13. a3bc5e33 — fixed in AC5 and task-6. AC5 no longer says a pre-epic record yields today's strings with `--checks`: with `--checks` it certifies nothing (a stated, deliberate change); today's strings apply only without `--checks` on an epic whose records use no tiers.
14. f24b826c — obsolete under the re-specification, because the table and its cells are gone. task-6 criteria 1 to 4 enumerate every case of both paths with exact strings, and the probe case no longer needs a non-probe record beside it: a probe certifies nothing in every case.
15. 18712985 — fixed by task-5. `CheckCertification` names every field (`certified`, `reason`, `recordId`, `result`); a not-run result is `reason: 'not-run'`; there is no `byCommit`, `latestByName` or `latestProbe` to describe.
16. f026d695 — fixed by task-5. Its summary describes `certifyChecks`, the one certification rule; `latestTierChecks` no longer exists.
17. a5a7af62 — fixed by task-5. A record names the commit its checks ran at: for a scratch run, `head_sha` is the resolved `commit`'s full sha, `tree_sha` its tree, and `branch` the integration branch name as main computes it. queue.ts `landCandidate` fast-forwards the branch to the candidate, so task-12's records at R certify the landed head. task-5 criterion 9 pins it with a commit that is not on the branch, then fast-forwards to it.
18. 80191705 — fixed by task-6 with no new claim. `summary.integration.check` is never nulled where a record could certify: without a declaration it is main's value; with one, the last non-probe record at the head. On every passing close it is a record at the head, so run.md:432's selection by `summary.integration.check.head_sha` (pinned by test/integrationPrFactPack.test.ts:103) stays right unedited. task-6 criterion 5 pins it with a probe at an older commit as the last event.
19. 86a0b5be — obsolete under the re-specification, because there are no per-row malformed blockers. task-6 criterion 3 covers malformed records with a declaration (they withhold), and criterion 4 a malformed `tiers_present` without one (refused).
20. 7f665588 — fixed by task-5. Malformation is decided per field at record and at result level: a `probe_of` of any type, a non-string `head_sha`, a non-array `results`, a result that is not an object, a non-string `name` or `check_sha256`, and a non-`true` `pass` each remove evidence or fail the check, never certify it. No `field` is reported, because nothing blocks on malformation as such.
21. 1937e8e2 — fixed by task-6. The input field is named and typed once: `EpicVerdictInput.checks?: readonly DeclaredCheck[]`, inherited by `EpicCloseInput`. Criterion 1 drives it through `runEpicVerdict` and `closeEpic`. task-14's sentence (3) is rewritten to set exactly that field (dependents).
22. 8438cc28 — fixed by task-6. Blocker precedence is stated: empty declaration, then unreadable head (one blocker, no per-check ones), then one per uncertified check in declaration order; without a declaration, the refusal, else main's order.
23. 9f20e9f0 — fixed by task-5. `--tier remaining` selects exactly the checks for which `certifyChecks` returns `certified: false` at the target commit, the definition the close applies; a pass followed by a fail is selected again (task-5 criterion 2).
24. e1b5cd94 — obsolete under the re-specification, because there are no rows. The payload gains `integration.declared` exactly when a declaration was passed and `integration.tiered_record_id` exactly when the refusal applies; the judge prompt's lines are stated for a declaration that is certified, uncertified, empty or read at an unreadable head.
25. ebe2012b — fixed in this spec. "Plan quorum (v2) — review round 7 changes" item 6, and the whole of that section and of "Plan quorum (v2) — changes", now carry a superseded note pointing here.

### Re-specification — review round 12 changes

A focused review of the re-specified task-5 and task-6 (round 12) found no
S1, one S2, five S3 and five S4. Every one is fixed, none waived. Full
TaskSpecRecords for task-5, task-6, task-7, task-12 and task-14 carry the
fixes; task-11's two sentences are in the planner's dependents list. Claims
and edges are unchanged.

1. ead87064 — fixed by task-5, task-7 and task-12. `IntegrationCheckInput` gains `setupCmd`, accepted only for a scratch run and passed to `runChecksAt`. When `runChecksAt` reports a failed setup or deps block, `runIntegrationCheck` writes no record and throws a named setup-failed refusal carrying the setup result and the deps answer. task-7 (4) and task-12 (4) map exactly that refusal to `setup-failed`, and task-7's fixture drives it through the default runner. task-5 criterion 5 pins it.
2. bcfb66d3 — fixed by task-5. A record written without `probeOf` has no `probe_of` key at all, never `null` or `''`; an empty `probeOf` is refused. Criterion 8 asserts the key's absence on clone and scratch records, its value on a probe, and that `certifyChecks` certifies what the writer wrote, with a mutation check for `probe_of: null`.
3. 629614d7 — fixed by task-5. `latestIntegrationCheckAt` and `lastTieredRecordId` read only `integration-check` events of the epic. Criterion 10 adds a later closing spec-review event with the same `epic_id` and `head_sha`, and another epic's record, and both readers ignore them.
4. 059cacdc — fixed by task-5 and task-11. `--tier remaining` with nothing left to run (every check already certified at the commit) is refused with its own nothing-remaining code, distinct from the empty-file `integration.no-checks`, and writes no record. run.md step 12 reads that refusal as done and goes on to the verdict and close; any other refusal stops the close. task-5 criterion 2 pins the code; task-11's step 12 sentence and criterion 1 carry the playbook rule.
5. 29ed0f5d — fixed by task-6. The payload's `declared[].reason` is the `CertificationReason` code, never the text, and null when certified. Criterion 5 now asserts the uncertified, empty-declaration and unreadable-head prompt lines exactly, and the `declared` entries of an override close with uncertified checks and of one at an unreadable head.
6. 6825e4f4 — fixed by task-6. The builder list names the real `IntegrationStatus` builders: test/epic.test.ts `okIntegration` (about line 191) and its literals (about line 1653), test/specFindings.test.ts (about line 1539) and test/completedStaysCompleted.test.ts (about line 166). It drops test/mcp.test.ts and test/crossSession.test.ts, which build other types.
7. 28505f36 — fixed by task-6. Criterion 3 adds an empty declaration with an unreadable head, which gives only the empty-declaration blocker. Criterion 4 adds a tiered epic with a stale record and one with an unreadable head, which give only the tiered blocker. Each has a mutation check that reorders the rules.
8. 4d1588f3 — fixed by task-6. `certificationReasonText` returns null for a certified check, so it has no text with no reader. The judge prompt's command uses main's whitespace collapse only, because the record already holds the masked command.
9. a013bb67 — fixed by task-7. Its input and step (2) name the query as a `CertificationQuery` `{name, checkSha256}`, each digest from task-1's `checkDigest`. task-14 (3) already spells it that way.
10. 250dd5ad — fixed by task-14. `bs wave check` without `--checks` now refuses by task-5's `lastTieredRecordId`, the predicate task-6's close refusal uses, so the two cannot disagree. Criterion 8 adds a pre-release-only record and a probe, which are refused, and an all-`pre-merge` log, which behaves as on the base.
11. 88e1ffec — fixed in this spec. Review round 3 item 10, which names the removed `latestTierChecks`, now carries a superseded note.
12. 20bce6bf (review round 13) — fixed by task-7. Every check run the module makes passes the batch's `setupCmd`: the head run and the reproduce, base and bisect probes. A setup or deps failure in any of them ends the call with `setup-failed`, naming the step and the commit, with no culprit and every record id written so far, instead of an uncaught error after the red head record. A new criterion, written failing first, pins a bisect-prefix, a reproduce-probe and a base-probe setup failure through the default runner. task-12 needs no change: its only check runs, at the revert commit R, already pass `setupCmd` and map the refusal (its step 4), and its `culprits` rule already covers a `setup-failed` reached before a culprit.
13. 4de860d8 (review round 14) — fixed by task-12 and task-14. task-12's result shape gains `setup_failed: {step, commit}`, set exactly when the outcome is `setup-failed`. Step (1) carries task-7's `step` and `commit` into it, and step (4) sets `{step: 'revert', commit: R}`. task-14 prints it beside the outcome, so the operator sees which run's setup failed and at which commit. task-12 criterion 8's empty-`culprits` parenthetical now covers the head run and every probe before a culprit, and its R fixture asserts the field. task-14 criterion 1 pins the field end to end: a failing `--setup-cmd` prints `setup_failed` with `step: 'head'` and the head's sha. task-11 needs no change: it hands every other outcome to the operator with the JSON and names no field.

### Plan quorum (v2, second run) — changes

1. b21112c8 — fixed by task-2, task-4 and task-9 (the quorum escalated on one Codex critique, DeepSeek confirmed, and the epic session verified it). Each of the three adds names to taxonomy.yml and bumps `version` by exactly one from the value on its own base, in claim-order edge order task-2 -> task-4 -> task-9 from main's 12: task-2 to 13, task-4 to 14 and task-9 to 15. Each task's criterion pins its own number in taxonomy.yml, in architecture §8's yaml block and in test/taxonomy.test.ts's pinned version, and adds one history-comment clause after its predecessors'. A base holding any other value is a stop-and-report, not a choice. task-9's old "one higher than task-2 left it" (14, task-4's value) is gone, and task-4 now names §8 and the pinned test, which it claimed but did not name. A sweep of every file two or more tasks claim, and of every relative "base" or "than task-N" phrase, found no other shared value that two tasks each change (the planner's notes list what was checked).

### Plan quorum (v2, third run) — changes

1. 9e1584a7 — fixed by task-4, with the same pattern swept across the draft. task-4 now states one rule. A run without `--checks` writes the base's events plus exactly one additive field, `merge_sha`, on every `wave-merged`, and no `pre_landing`, `pre_landing_run_id` or `queue-tier-run`. `pre_landing` records which pre-landing path `--checks` chose, so it is written only when `--checks` is given; `merge_sha` is written on every path, because re-merge is decided by its ancestry for every merge (D1). Criteria 1, 6 and 7 agree, and criterion 6 asserts it field by field for a sequential landing, a `--batch` landing, an adopt and a red pre-landing test. The sweep fixed task-14 criterion 3 ("unchanged except the added fields" now lists task-5's fields) and task-6's no-declaration readers (now saying why main's prompt and payload stay byte for byte beside task-5's new record fields). Every other "unchanged", "as on the base" or "byte for byte" clause already names its exceptions or touches nothing another task adds (the planner's notes list each).
2. 87c40cb7 (review round 17) — fixed by task-14. Criterion 3 now keeps the two shapes apart. The `integration-check` event payload gains task-5's snake_case keys. The printed `IntegrationCheckRecord` (`printJson`, camelCase) gains task-5's camelCase record fields. On both sides, each result gains `cmd_sha256` and `check_sha256`, which stay snake_case as `CheckResult` fields. A scan of task-5, task-7, task-8, task-12 and task-14 found no other sentence that lists printout keys against payload keys.

### Plan v2 consistency sweep — changes

Each of the last four plan-quorum runs found one pair of statements that cannot both hold. Review round 19
then swept the whole plan and found ten more (`state/results/bs-check-tiers.spec-review-v2-r19.json`). The
fourth quorum's finding is in `state/briefs/bct/finding-quorum4-task18.json`. All eleven were checked
against the draft and main before any fix, and none was wrong. Each line below names the finding id
(`f-bs-check-tiers/integration-<id>`). Text these fixes replace is marked superseded where it stood. Changed
tasks: task-3, task-4, task-7, task-8, task-10, task-11, task-12, task-14, task-18. Edges, task ids and every
nonfunctional clause are unchanged. task-10 and task-11 gain one claim each (a24cf08b). Depth 7, widest 5,
and the same seven crossings, each on an edge.

1. 915805b9 — task-18 criterion 6. "Names a tier" now means "assigns a tier to a check": no scaffold layer holds a `checks.json`, and the gate script's only default is `pre-merge` for an absent `tier`, keyed on nothing. The three tier strings may appear only in the gate script, ci.yml, the base README.md and AGENTS.md, as criterion 1 and objective (4) require. A scan over every scaffold layer pins that.
2. 54e32479 — task-18. The gate script counts twice, in a stated order. First, the gate's own refusal counts the file: a `checks.json` with no pre-merge entry is refused for `--tier pre-merge`, with or without `--list`. Then the run selection and `--list` count after `--ci` leaves the `e2e` entry to e2e.yml. A tier job is skipped by the listing job's `--tier <tier> --ci --list`. So a tier whose only entry is the `e2e` entry left to e2e.yml runs no tier job, and e2e.yml runs that entry.
3. adee4fd6 — task-7 and task-12. task-7's `revert-has-dependents` carries the same `culprit` (task, merge sha, failing checks, red head record id) as `culprit-found`, plus the dependents. task-12's `culprits` holds that culprit on every outcome reached after task-7 named one. Step (1) returns `revert-has-dependents` with it and builds nothing, so task-14 promotes on it (D7).
4. 08764ccf — task-7 criterion 4, and D4's arm 4. `--final` is an arm and never returns `batch-not-ready`. At a head already certified for every post-merge check it still returns `no-new-merges` and runs nothing, because step (2) comes first, as D4's base rule says.
5. fd7db283 — task-11 and task-14. `bs checks post-merge` takes no `--specs-dir` (review round 4 item 7), and task-14 now says so. run.md's block starts the verb without that flag, and task-11's criterion 1 requires its absence, so the doc-command test can pass. Review round 2 item 2 is marked superseded.
6. 3661495f — task-8, D6, AC8 and Goal 3. A fifth class, `unconfirmed`, is now shown: a failure that ran and is none of not-run, env, flaky or real. Two examples are a red never followed by a pass, and one cured only by editing the checks file. It counts as a run with its minutes and never as a catch. task-8 exports the five strings as one list, and criterion 1's five fixtures assert them.
7. a24cf08b — task-3, task-10 and task-11. The scope-doc test task-3 writes pins the marker and the planned status lines. task-10 claims that test and replaces the marker assertion with its absence, in the commit that removes the marker. task-11 claims it and replaces the planned-status assertion with `Status: shipped.`. Both edits are replacements of equal strength, changed first and failing first, and edges order both after task-3.
8. 9a17ba19 — task-4 criterion 4 and task-8 criterion 9. The landing and blocked events carry `pre_landing_run_id`, equal to the `queue-tier-run`'s `run_id`. No `wave-merged` or blocked event carries a key named `run_id`, and the ledger links by `pre_landing_run_id`.
9. 5bad56cc — D4, D5, AC6 and task-11. `bs wave check` without `--checks` is refused on an epic whose records use tiers: task-5's `lastTieredRecordId`, the predicate the close refusal uses (250dd5ad). So post-merge, pre-release-only and probe records all count. task-14 already said this. The spec rows and the playbook text now say it too, and 'Operator answers (v2)' carries a note.
10. 3c48b247 — hard constraint 4 binds, and its text is unchanged. D10 now states how each empty selection that does not refuse still never reads as a pass.
    - `no-checks-in-tier`, `no-new-merges` and `batch-not-ready` exit 0 and say no batch is due. They run nothing and write no record, so they certify nothing and release no held task. The playbook calls only `green` passed (task-7, task-14, task-11).
    - The scaffold's gate script refuses an empty run with exit 1.
    - The scaffolded CI skips an empty tier's job as a whole job, which GitHub shows as skipped. Only a listing job that succeeded and listed that tier empty can skip it, so a failed listing job runs every tier job (fail closed).
    - The e2e summary job is skipped, not passed, while there is no suite. 'Operator answers — changes' item 7 is marked superseded.
    - OQ-v2-2 (a) and OQ-v2-3 (b) both still hold, so no operator question is raised.
11. e5848d67 — task-18 and AC15. e2e.yml's `on:` block is exactly ci.yml's: pull requests, and pushes to `main` and `setup`. Every event that runs the tier jobs therefore runs the `e2e` entry they leave to e2e.yml. Criterion 5 deep-equals the two scaffolded `on:` blocks, with a mutation that drops `push`.

Review round 20 (`state/results/bs-check-tiers.spec-review-v2-r20.json`) checked the sweep and found three S3 and three S4. Each was verified against the draft and fixed. This round changes task-7, task-8, task-9, task-10, task-11, task-12 and task-14. Claims, edges and budgets are unchanged (sum 7,040,000).

12. 21654818 — task-10 and task-11. Each task's "Weaken nothing" clause now names its one exception: the assertion it replaces in task-3's scope-doc test. task-10 replaces the marker assertion with the marker's absence, and task-11 replaces the planned-status assertion with `Status: shipped.`. Each replacement is of equal strength. No other assertion in that file may be removed, loosened or reordered.
13. c9adc1ac — task-8, task-9, D6 and D7. An `unconfirmed` failure is never a catch: no real or unique catch, and no importance. It protects the check as a real catch does, by D6's rule that an unverifiable failure (like an unreadable diff) protects a check and never exposes it:
    - D7 eligibility now needs zero real catches and zero unconfirmed failures in the window;
    - `itemBlocker` blocks under its own reason, an unconfirmed failure in the window, whatever its severity, rather than as an S1 or S2 catch;
    - the sensitive-path guard's catch arm counts it, however old.
    task-8 reports unconfirmed failures per identity with their D6 severity.
14. 9c5f3805 — task-7, task-12 and task-14. `revert-has-dependents` carries `dependents` end to end. task-7 names the field. task-12's result gains `dependents?`, set exactly on that outcome. task-14 prints it beside `culprits`, and a CLI test pins both on that fixture.
15. b297da1e — task-8 criterion 1. `FAILURE_CLASSES` is compared as a list, in decision order (not-run, env, flaky, real, unconfirmed). Each fixture's class string is asserted on its own.
16. 2010bf19 — task-11 and D4. A proceed outcome is one of the five outcomes the verb exits 0 on: `green`, `reverted`, `no-checks-in-tier`, `no-new-merges` and `batch-not-ready`. After one of them, the playbook re-reads `--held` and `bs wave next` and admits what `--held` no longer lists. The offset test's admitting line names the five.
17. 9e2b424a — this spec. 'Operator answers — changes' item 7 and 'Budgets after the answers' are marked superseded: task-18 is 400000 tokens, and the eighteen tasks sum to 7,040,000. The planner's notes give the matching planner_notes text.

Review round 21 (`state/results/bs-check-tiers.spec-review-v2-r21.json`) confirmed all six round-20 fixes and found three problems inside them. Each was verified and fixed in task-8 and task-11. Claims, edges and budgets are unchanged.

18. cb11d7ec — task-8 and D6. A name-only failure, meaning a pre-epic record with no digest, is classed like any other. One classed `unconfirmed` protects exactly as a name-only real catch does. It counts, for every identity with that check name, in the unconfirmed failures in the window (so `itemBlocker` blocks the check) and in the sensitive-path guard's catch arm. It adds no run or minute. The identity criterion pins it beside the name-only real catch.
19. cd1e92f1 — task-11. No post-merge outcome releases a held task by itself. The playbook's re-read of `--held` recomputes the hold from records and admits what they no longer hold. After `no-new-merges`, that is whatever an earlier call's record already certified. This matches task-14 and line 10 above.
20. fc2ac27c — task-11 criterion 1. The block writes its four steps as one numbered list, and the offset test anchors each step by its list marker. It no longer anchors by the `--held` and `bs wave next` strings, which steps 2 and 4 both carry. (Superseded by line 21, 160116d6: the steps carry bold lettered labels, not a numbered list.)
21. 160116d6 — task-11. Review round 22 (`state/results/bs-check-tiers.spec-review-v2-r22.json`) found that line 20's numbered list breaks test/waveTier.test.ts. That test scans run.md with `/^(\d+)\. /gm` and allows no step number from 2 to 10. The block's four steps are now bullet items with the bold labels `**(a)**` to `**(d)**`, which no line-shape scraper matches. Each label occurs exactly once in run.md. The offset test anchors on the labels, in order, and no line of the block may start with a number. Criterion 5 now names waveTier and integrationPrFactPack among the tests that pass unchanged. The other scrapers of run.md, wave.md and queue-and-gate.md were checked: handbackPreflight's step and branch markers, playbookSlice, cliOptimize, playbookOptimize's step bounds and TaskStop paragraph, and playbookCitations' citation forms. None matches the labels. task-11 adds no line that starts with a number, and its block names no `TaskStop`.

### Plan quorum (v2, after #514) — changes

1. 0cb51329 — task-9, D7 and AC9, with the same pattern swept across the draft. The plan quorum's Codex judge raised it after #514, DeepSeek confirmed it, and the epic session verified it. One rule for a refused `bs checks apply`: it appends none of the batch's events (no `check-tier-decided`, no `check-tier-batch-answered`) and writes none of its decisions. The only changes it may leave are the reconcile's repair of what the log and the overlay already owed, and the `.blacksmith/` directory the lock creates when it is absent. On a consistent overlay a refusal therefore changes nothing. task-9's refusal criterion now crashes and then refuses: the overlay holds only the earlier logged decisions' tiers, and the log gains no event, or only the owed promotion event when the crash was a promotion's. task-9's promotion decides every no-promotion answer before the lock, so those answers take no lock and change nothing. task-15's lock is called by a caller that may write, and may refuse after taking it. task-10's `bs checks apply` refusal criterion holds on a consistent overlay. task-10's `bs checks proposals` already reconciles only when something is owed, and writes only what was owed. The sweep also fixed three sites where a 'nothing changed' clause sat next to an earlier side effect. task-14's reopen now refuses before it attaches a worktree, moves a ref or commits. task-12's refusals after the records at R write nothing more. task-12's amended-away fixture names the revert worktree, not task-7's scratch worktrees. The planner's notes list every site checked.
2. 77be7897 — task-9's contract. The validate-all-then-write clause now states the refusal rule: none of the batch's events or decisions, and only the reconcile's repair and the lock's empty `.blacksmith/` directory may remain.
3. b12b69b2 — D7, AC9, task-9, task-10 and task-11. A refused apply's refusal lists in `items` every item whose guardrail or shape now fails, and `items` is empty when the cause is the call's own. `bs checks apply` prints `items`. run.md step 12 then reports each listed item to the operator and runs apply once more with the same decisions minus those items. A refusal with no `items`, or a second refusal, goes to the operator with the decisions.json path, and the batch is not asked again. Every reply therefore ends in exactly one accepted apply or in the operator's hands. This keeps the operator's v1 asks: one question, one batch, and only moves bs can apply. A guardrail that a log change trips is one the reply could never override. task-9 and task-10 pin `items`, and task-11's test pins the three step-12 sentences.
4. 6376bd4d — D7 Apply, AC9 and D8. The refusal rule's two allowances are now named in all three places, matching task-9: the reconcile's repair and the lock's empty `.blacksmith/` directory. D8's reconcile runs at the start of every apply, of every promotion that will write, and of every `bs checks proposals` call that finds something owed.
5. 59c68d05 — task-14 and task-11. Reopen builds the revert commit in a scratch worktree detached at the integration head before it touches the task. A conflict aborts the revert, removes that worktree and refuses with `worktree.reopen-revert-conflict`, naming the sha and the paths, with nothing left behind. Otherwise the task branch only fast-forwards to the new commit. wave.md step 9 hands the refusal to the operator once. The way out is a plan amendment that supersedes the task with one cut from the integration head. A conflicting-revert fixture, written first, pins it.
6. 852a2111 — task-9, task-10, task-11, D7 and AC9. Line 3's "the batch is not asked again" now has a durable source; this supersedes its unrecorded hand-off. After a refusal goes to the operator, the playbook runs `bs checks apply <decisions.json> --hand-off <refusal-code>`. That call goes through task-9's new `recordBatchHandOff` and appends one `check-tier-batch-answered` that decides nothing and carries `handed_off: {code, decisions_path}`. The fold behind `answered_in_epic` reads it like any other, so re-entering step 12 does not ask again, and `bs checks proposals` reports `handed_off` until an accepted apply follows. No new event type is added, so task-9's taxonomy step from 14 to 15 is unchanged. task-9 and task-10 pin the hand-off, and task-11's test re-enters the gate through the CLI using run.md's own hand-off line.
7. 8a4bca7f — task-14 and task-11. Reopen's three earlier refusals now have codes: `worktree.reopen-dirty`, `worktree.reopen-not-ancestor` and `worktree.reopen-revert-not-on-integration`. They join `worktree.reopen-revert-conflict` as new `worktree.*` codes. None of main's `worktree.*` codes fits these cases, and the near matches belong to other verbs. Criterion 6 asserts each code. wave.md step 9 names all four after task-14 raises them, which is the order the error-code scan needs.
8. 71580e69 — task-14 and task-12. Reopen's scratch worktree and the revert builder's both sit under the `.wt/<project>/` root and are named `scratch-<pid>-<uuid>`, task-5's scheme. So no two collide, and task-5's dead-pid sweep removes one that a killed process left. Each task pins the name through an `opts.onScratch` seam.
9. 1c08e1c9 — task-9, task-10 and task-11. The hand-off fixtures no longer need a lock that a live pid holds: task-15's `waitMs` has no default, and no task lets the CLI set one. (Superseded in part by line 13: `waitMs` now defaults to `OVERLAY_LOCK_WAIT_MS`; 2cfe20df.) They start from a decisions value that is not an array (`{}`), which task-9 refuses with `items: []` without waiting on any lock. The hand-off then uses the code that refusal printed.
10. 9ab7c010 — task-11. Step 12's three `bs checks apply` lines are bullet items with the bold labels `**Apply.**`, `**Re-run.**` and `**Hand-off.**`. Each label occurs exactly once in run.md. The close-order and refusal-sentence tests anchor on these labels and on the first matching line after the `**Hand-off.**` item, never on a string that another step-12 line carries. This is the same cure as 160116d6 used for the post-merge block.
11. 65a5c329 — task-14 and task-12. The seam is declared with its exact type. task-14 exports `reopenTaskWorktree(projectDir, epicId, taskId, revertSha, opts?: {onScratch?: (scratchPath: string) => void})`, and task-12's `runPostMerge` opts gain the same `onScratch`; the CLI passes neither. The scratch assertion covers only the cases that reach the revert build. For reopen's three early refusals, `onScratch` is never called and no `scratch-*` entry exists.
12. 6d98d320 — task-11. The re-entry test builds its own fixture in test/checkTiersPlaybook.test.ts, using main's shared test/helpers/cliHarness.ts, which no task claims. It no longer borrows test/checksCli.test.ts's fixture. Claims are unchanged.
13. Raised by the planner, no finding id — task-15, task-9 and task-10. task-15's `withOverlayLock` had no default `waitMs`, and its production callers set none. It now defaults to the exported `OVERLAY_LOCK_WAIT_MS = 30000`. A holder keeps the lock for one reconcile, one atomic write and a few appends, so 30 s outlasts any live holder on a loaded machine, and only a hung one makes a waiter give up; a dead-pid lock is still broken at once. When the wait expires, the waiter throws `checks.overlay-busy` naming the holder's pid and writes nothing: `fn` never runs, and the overlay, the log and both lock files are as they were. task-9's apply and promotion and task-10's proposals pass no `waitMs` and rely on the default without restating it. A criterion, written first, pins the constant, the expiry under fake timers and the no-write outcome.

Review round 27 (`state/results/bs-check-tiers.spec-review-v2-r27.json`) raised eight findings against the refusal, hand-off and reopen surface. The fixes below reuse main's shapes, refuse earlier and drop a seam instead of adding new ones.

14. 5ecf58c3 — task-14. `reopenTaskWorktree` returns main's `TaskWorktree` (`{worktreeDir, branch, epic, taskId}`), and `--reopen` prints that object exactly as `bs worktree create` does. The extra `commit` field is gone.
15. 4d400167 — task-11. `promotion-skipped` and `declared-tier-wins` are annotations beside an outcome, never outcomes. The outcome's own rule applies, and each annotation is reported to the operator once.
16. 4164a46b — task-11. A `bs checks proposals` call that exits 1 is reported to the operator once, and step 12 goes on to `--final` without asking: nothing was asked and nothing moved.
17. d8298da8 — task-9 and task-10. The callers' use of the default wait is pinned at the callers. A live child holds the lock for 1 s, and apply, a writing promotion and proposals, each called with no `waitMs`, wait and then succeed.
18. c1cd0860 — task-9. The injected-`withOverlayLock` assertions are gone, so no undeclared seam remains. A lock held by a live pid under fake timers shows that a no-promotion answer and the hand-off never lock: a call that took the lock would reject with `checks.overlay-busy`.
19. 55ecfc3c — task-9, task-10, task-11 and D7. A reply that is not an array, and a non-operator actor, are refused before the lock. "Before it takes the lock" is therefore a real property of the `{}` fixtures, not an empty one.
20. 36e2f6e5 — task-11. One definition covers every labelled item in run.md: it runs from its label to the first blank line or column-0 line, and tests read it with line breaks joined. The hand-off command is the item's first `bs checks apply ... --hand-off` code span.
21. 2cfe20df — this spec. Line 9's no-default premise is marked superseded by line 13.
22. Raised by the planner, no finding id — task-9 criterion 4. Its crash-then-refuse cases now build the crash state directly, with no injected throw: either decided events whose tiers the overlay lacks, or an overlay holding a stored `pending_event`. So no undeclared crash seam remains in the sentences this sweep wrote.
23. Raised by the planner, no finding id — task-9, task-10, task-12, task-7 and task-5. Every crash or lock-wait criterion now builds its state with no injected throw and no new seam.
    - task-9's crash-order criterion asserts convergence from the two crash states: events without the overlay write, and an overlay `pending_event` without its event.
    - task-10's proposals repair case starts from the first of those states.
    - task-12's crash after landing is a bs revert commit placed on the branch with task-7's builder, with no `wave-reverted`.
    - task-7's lock-timeout and env-gap fixtures come from its declared injectable runner.
    - task-5's lock-wait fixture uses main's `BS_HEAVY_LOCK_DIR` and `DEFAULT_MAX_WAIT_MS` under fake timers.
    The other "inject" wording names a declared mechanism: main's `RunOptions.heavyLock`, task-2's `isAncestor`, task-5's `environmentSources`, task-8's tree-diff reader and task-15's `beforeRename`.

Review round 28 (`state/results/bs-check-tiers.spec-review-v2-r28.json`) raised six findings in the same surface. The fixes reuse mechanisms a task already declares and add no seam.

24. cb1c0515 — task-12. `runPostMerge`'s input is task-7's `findPostMergeCulprit` input, passed through unchanged, and every check run it makes goes through task-7's injectable runner, R's two runs in step (4) included. The lock-wait and moved-ref cases at R come from that runner: it tells R's runs apart by the `Bs-Revert-Of` trailer on their commit and passes every other call to the default runner, so the lock is held for R's runs only. The setup failure at R is a real `setupCmd` that fails only at a commit carrying that trailer. No 1 ms wait and no `heavyLock` option remains in task-12.
25. bd5b4ed3 — task-9, D8 and AC9. Only a call that takes the overlay lock reconciles. A call refused before it takes the lock (not a git repository, a non-operator actor, a reply that is not an array, or a lock still busy when the wait ends) repairs nothing, and a crash converges on the next call that takes the lock, whatever that call's batch holds. D8's "at the start of every apply" and AC9's "converges on the next call" read that way. task-9's crash-then-refuse criterion pins that a refusal made before the lock leaves the crash state as it found it.
26. e4d115dc — task-9, task-14 and task-11. `promoteAfterCatch` returns one `{check, result, reason}` per failing check, from the first rule that applies: `promotion-skipped` with `red-record-unreadable`; `declared-tier-wins`; `not-promoted` with `not-demoted`, `not-run` or `env-failure`; else `promoted`, or `promotion-skipped` with the overlay code when the lock stays busy or the write is refused. `checks.overlay-not-a-repo` is no longer a promotion answer: outside a git repository no check has an overlay tier, so the lock is never reached. `bs checks post-merge` prints these answers as `promotions`, one `{task, check, result, reason}` per failing check of each culprit, present exactly when `culprits` is non-empty. run.md reports the `promotion-skipped` and `declared-tier-wins` entries once each; line 15's annotations are these entries.
27. 3307095e — task-7 and task-9. A failed result is env-classified when `sleptDuringCheck` holds for its record's `environment` entry at the same index, the rule task-8 applies; the record-level `errorClass` decides nothing. Step (6) returns `env-failure` only when every failed result slept, and a fixture in which one of two failed results slept fails a module that reads `errorClass`. task-9's promotion reads the red record by the same rule.
28. 97b65272 — task-15, task-9 and task-10. `check-tiers.lock` holds the holder's pid in decimal and a newline, a lock whose pid is alive (this process's included) is never broken, and the wait polls every `OVERLAY_LOCK_POLL_MS = 100` ms. Every held-lock fixture takes the lock through `withOverlayLock` itself in the test process, never by writing the file; only task-15's dead-pid case writes it, in that format. This replaces line 17's live child whose hand-written file the test deleted.
29. a94b362c — task-9. The no-promotion criterion is two fixtures. With the lock held on an overlay that owes a repair, all five no-promotion answers resolve. In a repo with no `.blacksmith/` and no lock held, the three answers reachable without an overlay resolve and no `.blacksmith/` is created.

Review round 29 (`state/results/bs-check-tiers.spec-review-v2-r29.json`) found four of round 28's six closed and raised two findings against the fixes.

30. 7f54e10d — task-10. `runCli` runs the CLI through `spawnSync`, which blocks the test's event loop, so a lock held in the test process could never be released while `bs checks proposals` waited. Line 28's rule still holds: the lock is taken only through `withOverlayLock`. For this one CLI case the holder is a `node` child, started with main's async `startProcess` (test/helpers/process.ts). It imports `withOverlayLock` from the built module, prints one line once it holds the lock and releases it 1 s later. The test awaits that line at `waitForLines`' default timeout, then runs `runCli`. The library-level wait cases in task-9 call async functions, so their holder stays in the test process.
31. 560c24da — task-9. A lock still busy when the wait ends gives `promoteAfterCatch`'s answer `promotion-skipped` with `checks.overlay-busy`, never a rejection, as rule (e) states. Criterion 9's held-lock fixture now says that an answer that waited would come back that way, and it asserts the busy answer for a check rule (e) would promote: no event, no reconcile, both files' bytes unchanged. A mutation that lets the error escape as a throw fails it. Line 18's "would reject with `checks.overlay-busy`" holds for `withOverlayLock` itself, not for the promotion.

### Plan v3 — UI vocabulary claims

1. 8c8c6cb3 — fixed by task-2, task-4 and task-9 (found by the task-2 wave-runner, bs-check-tiers-w1-t2-2026-10-31#8). Each task that adds a name to taxonomy.yml now also claims ui/test/timelineDisplay.test.ts, whose 'builds the exact title and meta for every event type in the vocabulary sweep' holds the `gate_event` and `graph_event` names equal to the keys of its `expected` map, and adds only its own rows there: task-2 `'wave-reverted': ['Wave reverted', '']` (graph_event), task-4 `'queue-tier-run': ['Queue tier run', '']` and task-9 the three `check-tier-*` rows (gate_event), each the humanised title and empty meta that the timelineDisplay module's defaults give a type it has no case for. The test is extended, not loosened; no ui/src file changes and every task stays `ui_affecting: false`; the existing claim-order edges task-2 -> task-4 -> task-9 order the shared file, so no edge is added. The file's kind, title and em-dash sweeps and ui/test/taxonomy.test.ts, kanban.test.ts and roleLabels.test.ts pass unchanged. Each task's new last criterion requires the ui block of `bash scripts/check.sh` green on its branch.
2. 03c9387a — fixed by task-4 (raised by spec review v3 round 1, verified by the epic session on main). The root test 'never falls back to System for a gate_event taxonomy value' in factory/orchestrator/test/db/queries.test.ts, part of the gate's own unit check, needs `eventKind()` in factory/orchestrator/src/db/queries.ts to map every gate_event name off `System`. task-4 now also claims queries.ts and adds `case 'queue-tier-run':` to the `Gate` group beside `integration-check`. The test is not edited, and a mutation must show it fails without the case. The Activity feed takes its row kind from the server, so ui/src stays untouched and task-4 stays `ui_affecting: false`.
3. 6a689610 — fixed by task-9, in the same way: it claims queries.ts and adds the three `check-tier-*` cases to the `Gate` group on top of task-4's case, following the existing claim-order edge task-4 -> task-9. No other live task claims queries.ts. A sweep of every root test that iterates a taxonomy dimension found no other test that the five names break.
4. Raised by the planner, no finding id — new task-19 (`bs-check-tiers/task-19-readable-gate-names`, ui_affecting). Once task-4 and task-9 map their names to Gate, the Activity feed's meta line would print the raw event name for those rows, because the timeline display module's GATE_CHECK_NAME map has no entry for them. task-19 adds 'Pre-merge checks', 'Check tier decision', 'Check tier promotion' and 'Check tier proposals'. It depends on task-4 and task-9 by artifact edges and claims that module and its test. The five vocabulary-sweep rows stay as the three tasks left them, and a tester screenshot goes to the uiux visual pass. wave-reverted needs nothing: it stays System, with an empty meta and a humanised title.
5. 7ba59914 — task-19, criterion 5. The visual evidence is now exactly what the screenshot stage checks: the four `REQUIRED_COMBOS` shots of the Activity feed (desktop and mobile, light and dark), named with the suffix `SCREENSHOT_RE` reads and declared one artifact per PNG, plus `touch-targets.json` beside them. The event log behind the shots is built outside the repo.
6. b2c3e941 — task-19's contract. The nonfunctional clauses copied from task-4 are rewritten so each one is true of task-19 alone: its base (task-2, task-4 and task-9 merged), the diff budget over its one non-test file, its ui and design-lint checks, a mutation per map entry, no edit outside its two claims, and its own `keeps_exports` promise on the timeline display module (four private map entries, no export change).
7. a395b035 — task-4, criterion 12. It cited criterion 8, the heavy re-entry test. It now cites criterion 9 for the eventTypes sweeps passing, and criteria 2, 3 and 4 for the `queue-tier-run` write they scan for. The plan numbers criteria from 1. The same off-by-one in task-9's criterion 15 (criterion 11 for the vocabulary criterion, which is 12) is fixed by the same sweep.
8. 7f6e8b84 — task-19, criterion 5. The tester's write scope refuses every path outside the repo root, so the event log behind the shots can no longer sit in a temporary directory. It is written under `state/artifacts/<task-id>/` instead. That path is inside the tester's `state/artifacts/**` glob in the guardrails policy, and the repo's ignore file excludes `state/`, so the log is never committed. task-19's nonfunctional clause 7 now says the same thing. It used to read "stay out of the repo"; it now says the log and shots are never committed and live only under `state/artifacts/<task-id>/`.

### Plan v4 — follow-up fixes

1. d3d30c6d — fixed by new task-20 (`bs-check-tiers/task-20-revert-and-scratch-fixes`), by removal. `foldTasks` never moves a task that a `wave-merged` names to `waived`, `failed` or `escalated`, so those two reasons fired only under a mocked fold. task-20 drops `waived` and `held-by-operator` from `RECORD_ONLY_REASONS` and `waveRevertBlocker`, and deletes the mocked cases from test/waveRevertedEvent.test.ts and from task-16's test/postMergeResume.test.ts; D4's list above now names six reasons. That retires the waived and escalated fixtures task-16's criterion 2 names; task-16's record is not edited. task-20 runs after task-16 and before task-12 (artifact edges), so task-12 is written against the six.
2. 9000f648 — fixed by task-20. No existing invariant makes the cross-session duplicate impossible or harmless: wave sessions continue the epic session and run beside it, the lineage read from one wave session leaves out its sibling wave sessions, and a duplicate bounce written after a re-merge reopens the re-merged task in the fold. `recordWaveReverted` now runs its duplicate-`revert_sha` check over the session tree from its root, and its append, under one lock (the blocker keeps the caller's lineage; see f09c633d below), taken with the session-log lock events.ts already has (`withLogLock`) on a lock file beside the root session's log; events.ts only gains the export keyword on `withLogLock` and `logPath`. The per-session re-check inside `appendWithin` is removed, and the loser of a race is refused with `revert.already-recorded`.
3. 0f865e45 — fixed by task-20. `sweepDeadScratch` removes a worktree only when it is detached and its name is `scratch-<pid>-<uuid>`, the name `runChecksAt` gives its own; a branch worktree, or any other `scratch-<n>-` name under `.wt/<project>/`, is left alone. The sweep's existing fixtures take a uuid suffix.

task-20 claims revert.ts, events.ts, integration.ts, postMergeResume.ts and the three test files above, promises `keeps_exports` on events.ts, integration.ts and postMergeResume.ts, and is capped at 180k tokens and 150 non-test diff lines. Its edges: task-20 after task-16, task-12 after task-20, and task-11 after task-20 for its CHANGELOG paragraph. The wave schedule is depth 5, widest 3.

Plan v4 review round 1 — changes:

4. f09c633d — task-20, criterion 2. Only the duplicate-`revert_sha` check reads the root's tree under the root lock; `waveRevertBlocker` keeps reading the caller's lineage, as task-16's resume and task-12's preflight do, so a wave-session caller with a fresh sha is never refused by the root read (new case c). task-16's resume did not catch the refusal, so task-20 now claims postMergeResume.ts (it runs after task-16 merges, and already owns that file's test): the resume reads `revert.already-recorded` as recorded and moves on, pinned by two concurrent resumes from sibling sessions. That costs less than a task-12 criterion, which would supersede task-12's record and widen its claims to a file it does not own. task-12's own write after landing R reads the same refusal as recorded too: the race it loses is a resume that recorded R first, and this line is the contract task-12 reads.
5. fb2186c5 — task-20, criterion 3. Case (a), the branch worktree, is now named `scratch-<dead pid>-<uuid>`, so only the detached test protects it; case (b), detached with a name that is not a uuid, still protects the uuid test.
6. 8d620d73 — task-20's "weaken nothing" clause now lists exactly three removals or narrowings: criterion 1's deleted cases and list rewrite, criterion 2's two pre-lock duplicate checks replaced by the locked one, and criterion 3's narrowed sweep.
7. 9c2a1ec5 — task-20, criterion 1. The deletion list now includes the stale comment above each projector mock, and `vi` in each file's vitest import once nothing uses it.

### Plan v5 — closing-review fixes

The closing spec review of plan v4 (`bs-check-tiers-run-2026-10-30#649`) raised ten findings, each checked against the code at the integration head 2c89aa5a. Six are fixed in place in this spec's text, so that it states what the merged code does. Seven sit in docs that only merged tasks claimed, and go to one new task, task-21 (`bs-check-tiers/task-21-closing-review-doc-fixes`). Three findings are in both lists.

1. 0b723971 — spec, AC2: the brief-compose sentence now names the briefs that list checks (coder and tester, which refuse without `--worktree`) and says what `--checks` without `--worktree` does. task-10's criterion 8 is read as scoped to the planner role. There, `bs brief compose --role planner --checks <file>` without `--worktree` prints the not-applied line on stderr and exits 0 (test/checksCli.test.ts pins it). A planner brief has no gate-checks section, so the clause's "lists `e2e`" has nothing to list. Coder and tester refuse with `brief.worktree-required` (briefCompose.ts). task-10's merged record is not edited. The Decision of 2026-11-02 (two task-10 questions) points here.
2. d1a46ec1 — spec, D4 steps 4 and 5: step 4 scopes "predates the batch" to its own case, and step 5 names the revert-only red. That red has no culprit and gives `red-at-base`; nothing is promoted, and `red_after_revert` names the reverts (postMergeBisect.ts, postMerge.ts). The Decision of 2026-10-31 (task-7 finding 32dd16cb) points to D4. The scope doc's steps 4 and 5 are task-21's criterion 6.
3. 9c2b1d5e — spec, D4 revert step 1: a second `revert-not-applicable` path, reason `no-pre-merge-checks`, checked after the blocker; the culprit is still returned (postMerge.ts). The Decision of 2026-11-02 (task-12 finding 5818f717) points to D4. The scope doc's revert bullet is task-21's criterion 7.
4. 71a5b931 — spec, D6 unique catch: it now carries the three refinements of the Decision of 2026-10-31 (task-8 finding 242087f0), including the one over-count checkLedger.ts admits. That Decision line now says "task-8's criterion 3" where it said "AC3", and points to D6.
5. 873a98f6 — spec, AC6 and D4's trigger paragraph. Checked in cli.ts: the hold and the `wave.checks-required` refusal run only under `--session`. But a `wave check` without `--session` cannot write `wave-admitted`. For an admissible wave without `--dry`, the envelope `emitWaveAdmitted` is called with (`eventContextFromFlags`) throws `cli.missing-flag` for `--session` before anything is written; a refused wave prints its verdict and writes nothing. With `--dry` nothing is written. `--checks` or `--project` without `--session` is `cli.missing-flag` too. On the integration build, the session-less form exited 1 with `cli.missing-flag`, and the `--dry` form printed `valid: true` with its state dir left empty. So the refusals bind every admission, and the fix is text: AC6 says so, and a session-less run is a probe. No code changes.
6. 5e675a89 — task-21's criterion 1, docs/guide/operator-guide/wave.md section 2. On the integration build, the guide's session-less form, for an admissible wave, stops at `cli.missing-flag` instead of printing `{"valid":true}`.
7. d01683bf — task-21's criterion 2, the two index rows.
8. f82435f9 — spec, D8: "Where" names the mechanism that shipped, and "Where there is no overlay" lists the null layouts and the one wrong class (tierOverlay.ts `overlayPath`, test/tierOverlay.test.ts). The task-15 Progress line points to D8. queue-and-gate.md section 5 is task-21's criterion 5.
9. 453b7376 — task-21's criterion 3, the three passages. Section 7a's heading changes, so its anchor does too, and task-21 also claims its contents-list line in docs/guide/operator-guide.md.
10. af01945d — task-21's criterion 4, queue-and-gate.md section 4.

task-21 claims nine docs and no test. No existing doc test has to change. checkTiersScopeDoc.test.ts pins 'A red that predates the batch promotes nothing', which task-21 keeps word for word. checkTiersPlaybook.test.ts finds section 7a by `^## 7a\.` and section 5 by `^## 5\.`, and both keep what it asserts. task-21 is capped at 140k tokens and 140 non-test diff lines. It has no edge, because every plan-v4 task has merged. In the draft it is in the first round of `bs wave schedule`, beside nothing still to run.

Plan v5 review round 1 — changes:

11. dcb34110 — task-21, criterion 3. Its check was line-based, and limitations.md wraps 'the only' and 'check that sees' across two source lines, so the claim could survive it. The check now reads each file with newlines folded (`grep -z` over `[[:space:]]+`), and the criterion names the bullet's bold first sentence. On the base the check lists all four files (the three passages and the contents list); a copy of limitations.md with that sentence reworded passes it.
12. deaf22c9 — D8 and task-21, criterion 5. Only an absorbed submodule, whose git dir is under the superproject's `.git/modules/`, has no overlay (test/tierOverlay.test.ts pins it); a submodule whose `.git` is its own directory keeps its overlay at its own root. The exception is named as the class it is: every linked worktree of a `--separate-git-dir` layout whose git dir is named `.git`.
13. a11671d4 — AC6 and task-21, criterion 1. The invariant stated is that nothing is admitted without `--session`. A session-less check prints its verdict for a wave refused for claims, coupling or budget, stops at `cli.missing-flag` for an admissible one (cli.ts reaches `eventContextFromFlags` only for a valid, uncoupled, unblocked, non-dry wave), and writes nothing with `--dry`. Lines 5 and 6 above now scope the `cli.missing-flag` stop to an admissible wave.

### Plan v6 — second closing-review fixes

The second closing spec review (`bs-check-tiers-run-2026-10-30#687`) confirmed the thirteen plan-v5 findings closed and raised three, each checked against the code at the integration head 1948abdf. One is fixed in place in this spec's text. Two sit in a playbook and a doc that only merged tasks claimed, and go to one new task, task-22 (`bs-check-tiers/task-22-effective-tier-playbook-wording`), with the sibling sentences found by a sweep of `.claude/`, `docs/` and `README.md`.

1. e8ba2692 — spec, the task-15 Progress line: "submodule" becomes "absorbed submodule", as D8 and test/tierOverlay.test.ts have it since deaf22c9. Nothing else in that merged record changes.
2. 1c55ad6b — task-22's criterion 1. run.md's `**Post-merge and held tasks.**` block and wave.md step 10 decided from the declared checks file, while `bs checks post-merge`, `bs wave check --checks` and `bs queue run --checks` read the effective tiers (`readChecksFile` with the project dir, cli.ts). On the overlay-only path an epic session that followed run.md started no batch, and `wave.held-by-post-merge` held dependents that nothing it ran would certify. task-22 makes both say "effective" in D2's sense. checkTiersPlaybook.test.ts's step-10 pin keeps matching, so no test changes.
3. 7a01ece7 — task-22's criterion 2. task-22 makes queue-and-gate.md section 5's overlay bullet list each no-overlay layout as D8 does, with its linked worktrees, and except the known wrong `--separate-git-dir` class from the layouts that refuse writes.

The sweep found 1c55ad6b's defect in sibling passages: they decide from the file's labels, or say an absent tier is `pre-merge`, with no overlay beside it. They are task-22's criteria 3 to 6: wave.md steps 7 and 8, queue-and-gate.md section 5's `"tier"` bullet, the scope doc's Defaults, and closing-an-epic.md's per-tier close. Every other hit is listed as checked in state/briefs/bct/v6/notes.txt. CHANGELOG.md's Unreleased Check tiers entry said the same "a file that labels nothing behaves as before", and decided the queue from the file's later-tier entries. It was outside the sweep's roots. The epic session put it into task-22 as criterion 7, because a user reads that entry first: the unlabelled file behaves as before only while no approved overlay move applies, and the queue sentence says "effective tiers (declared plus overlay)" as D2 does. task-22 claims six files and no test. It is capped at 110k tokens and 80 non-test diff lines, and has no edge, because every plan-v5 task has merged.

### Plan v7 — third closing-review fix

1. 09b69938 — the third closing spec review (`bs-check-tiers-run-2026-10-30#708`) confirmed plan v6's three findings closed and raised this one S4, which goes to task-23 (`bs-check-tiers/task-23-step8-compose-worktree`). wave.md step 8's `bs brief compose` command had no `--worktree`, though task-22's sentence there names the overlay of the brief's `--worktree`, and compose refuses a coder, tester or judge-turn brief (spec-reviewer and auditor excepted) without an absolute one (`brief.worktree-required`, as AC2 says). The plan's review (#712) added two: 7bbb7b01 (S4), because compose also refuses every judge turn without an absolute `--artifact` (`brief.artifact-required`), which the command and dispatch.md left out the same way; and 6096b0e2 (S3), because the criterion's one-file vitest run must start from the repo root, where package.json and vitest.config.ts are. task-23 adds `--worktree <absolute worktree path> --artifact <absolute path>` right after `--work-root <work-root>`, which keeps handbackPreflight.test.ts's prefix pin. It names both flags in step 8's refusal clause (the artifact for a grader brief) and in dispatch.md's 'Compose requires' sentence (the artifact for every judge turn). It leaves step 8's flag list alone, because `bs dispatch lint` never reads a worktree and checks an artifact only as a judge brief's `Declared artifact:` line (dispatchLint.ts `checkArtifact`), not as a compose flag, and changes the one regex pinned on that sentence by the same words. task-23 has no edge and is capped at 80k tokens and 20 non-test lines.
2. 74046214 — the fourth closing spec review (`bs-check-tiers-run-2026-10-30#729`) confirmed 09b69938, 7bbb7b01 and 6096b0e2 closed and found this S4: line 1 and task-23 criterion 1 (b) said `bs dispatch lint` never checks a worktree or an artifact. It never reads a worktree, but it does exit 1 on a judge brief whose `Declared artifact:` line is missing, relative or mismatched (dispatchLint.ts `checkArtifact`, `ARTIFACT_FAIL`), as dispatch.md already says. Line 1 is corrected in place. task-23 is merged and its record is immutable, so criterion 1 (b) is read as "never a worktree; an artifact only as a judge's declared-artifact line". The step 8 sentence task-23 wrote is true under that reading: compose refuses the brief, and lint exits 1 on a brief that lacks the preflight lines or, for a grader, its declared-artifact line.

