# `/bs run <epic>` — the epic tier

[`dispatch.md`](dispatch.md) binds every agent this playbook dispatches;
none of it is restated here.

The loop playbook (architecture §3, §5, §11): one wave at a time, and every
task in the wave at once.

**Two tiers, two logs.** This file is the epic tier. It admits a wave (step
1), hands it to [`wave.md`](wave.md) — the wave playbook, steps 2-10 — and
picks the loop back up at step 11 once the wave has landed. That is D13's
fix: each tier owns the log for what it dispatches, so an epic session stops
carrying every wave's turns in a window it needs to reach the end of the
epic. "Hand the wave over" below says how, and says the one thing that makes
it safe.

Ask the epic's effort tier once, at the top of the run, and keep the answer
for the whole epic — `smith effort show --plan
factory/specs/active/<epic>/plan-vN.json`. Step 13 here, and steps 3, 6 and 7
of the wave playbook, each name the `profile` field that scales them; nothing
else in either file moves. Read `effective`, not `requested`: a plan whose
live tasks fire a security trigger is floored, and running it at the tier the
file asked for would be running it below the floor.

1. Ask the graph how wide this wave can be, then ask the gate whether it may
   be that wide. Two commands, two different questions — do not skip to the
   second with a set you picked by eye.

   ```bash
   smith wave next factory/specs/active/<epic>/plan-vN.json \
     --session <session-id> --repo <project-dir>
   ```

   `wave` is the widest set the plan admits right now: dependencies landed,
   claims pairwise disjoint, no shared hotspot, producers ordered ahead of
   the consumers that import them. Every task it left out is in `deferred`
   with a reason (`dependency-pending`, `claim-overlap`, `serialize-hotspot`,
   `symbol-coupled`) and the ids that held it back, so a short wave is always
   a wave with an explanation. It reads and writes nothing — ask it again
   whenever you want a fresh answer. `--session` is what lets it see live
   task status and the follow-ups `findings raise` minted into the log but
   into no plan file; without it you are scheduling from the plan as written
   hours ago. Exit 1 means work remains and none of it can start — a stall
   to report, not an empty answer. An empty `wave` with `remaining: 0` is the
   epic finished.

   Then put that proposal through the gate that actually admits it:

   `smith wave check factory/specs/active/<epic>/plan-vN.json <task-id>...`
   — claims must be pairwise disjoint and share no `worktree.yml`
   `serialize_always_globs` hotspot. A violation means cut a dependency
   edge and run the pair serially instead of forcing the wave.
   - The same verdict carries `symbolImpact`. `valid: true` with
     `symbolImpact.status: "coupled"` means the claims really are disjoint
     and that is not enough: the two tasks sit on either end of an import
     edge the plan declared no dependency for. A crossing is not
     overridable. The pair runs in the same wave only when the producer's
     spec lists the exporting file in `keeps_exports` — then the crossing
     sits in `symbolImpact.promised`, not `crossings`, and the promise is
     verified against the diff at wave.md step 10. Otherwise split the wave
     and run the producer first (operator-guide/wave.md §2).
   - `wave check` is also where the wave is priced and where
     `max_in_flight_tasks` is enforced (`budgets.yml`, `over-fan-out`).
     `wave next` deliberately asks neither question: a proposer that also
     priced the wave would have to choose which task to drop, and that is an
     operator's call. So a proposed wave can still be refused here. That is
     the gate working, not the proposal being wrong — drop tasks from the
     tail of `wave` and re-check.
   - With `--session`, `wave check` admits only live tasks of an ingested
     plan. A plan version whose tasks the log never saw is refused
     `cli.plan-not-ingested`: run `smith plan ingest` on it, then re-check.
     An id with no task row is refused `plan.unknown-task`, and a task
     that is `completed`, `superseded` or `waived` is refused
     `cli.task-not-live`, naming each task and its status. Drop those ids.
     A `failed` or `escalated` task stays admissible: an operator still
     holds it, and the escalation ladder re-admits it. A follow-up
     `findings raise` minted stays admissible while it is live, and a wave
     of follow-ups alone still needs the plan it names ingested first.
   - Never narrow a wave because a narrow one feels safer. A wave of one
     passes every check in this file — one task is disjoint with nothing,
     shares a hotspot with nothing, crosses no import edge — so `valid: true`
     on a singleton is not evidence the wave was right, only that nothing
     refused it. That is the failure this step exists to prevent: a factory
     whose whole claim is parallel execution, running its plan one task at a
     time and passing every gate while it does.

## Steps 2-10 — hand the wave over

The admitted wave now goes to [`wave.md`](wave.md), the wave playbook:
worktrees, pre-code, coder, tester, grader, the gate pipeline, bounces, and
the merge queue. Three shapes, in order of how much of this window the wave
would cost:

- **Inline**, in this session, when the wave is small enough for this
  window. Read `wave.md` and work it here.
- **In a session of its own**, when it is not, but you still want to drive
  it yourself: `smith session start <wave-id> --continues <session-id>#<n>`,
  where `<n>` is the index of the event that admitted this wave.
- **Dispatched**, as the **`wave-runner`** agent, when the wave would eat
  the window this epic needs to reach its own end. It is the only role
  `factory/policies/delegation.yml` grants `Agent`, and it earns that by
  opening its own log first — so hand it the event id of *your dispatch*,
  not the admission, because that is the edge the audit walks.

Whichever shape, hand over the project directory, the epic id, the live plan
path, the admitted task ids, the effort `profile` resolved above, and the
session id and event id the wave writes from. Take back each task's terminal
state, the merge-queue outcome, the findings raised, any escalation, and the
wave session's last event id if it opened one — chain the next command off
that.

Splitting the tier does not split the log. Every read in this playbook folds
the lineage, so a dispatch a wave session recorded is one this session can
still audit; that is what `--continues` buys, and it is why the split is safe
to make (D13, D-266). What it does not buy is a shortcut. A wave session
opened without `--continues` writes into a log nothing here reads, and the
verbs below then report a wave that appears never to have run rather than
failing — which is the same silence, arriving as a green. When you dispatched
the wave rather than ran it, `smith delegation check <session-id>` is what
turns that silence into a red: a `wave-runner` that dispatched before opening
its log, or against the wrong event, is `unverifiable` and exits 1.

**Then check that it did.** Once the wave's tasks reach a terminal state,
`smith wave audit --session <id> --epic <epic>` reads the log back and
reports the width the wave actually ran at, not the width it was admitted
at. Ask it with *this* session: it folds the lineage, so it sees the
dispatches a wave session made under the admission this one wrote. Exit `1`
is a wave whose tasks never once overlapped — the wave playbook's three
rules were not followed, and the log will say so long after this session has
forgotten. Exit `2` means the wave was admitted and no dispatch was recorded
under it, which is the wrong `--state-dir`, or a wave session opened without
`--continues`, rather than a stalled run. Ask before reporting the wave
done; a green gate on serialized work is exactly the outcome the two
playbooks are written to prevent.

11. Repeat until every task in the live plan version is `completed`/`waived`,
    or `superseded` by a successor that is itself terminal-OK (recursively —
    a successor chain counts too). Dispatch the **`planner`** again for
    the epic verdict against acceptance criteria — gaps found → a NEW
    `plan-v(n+1)` with inferred tasks (never a live-graph mutation,
    architecture §12), auto-scheduled at confidence ≥0.8 else parked for an
    operator tick. **Every new version is ingested before the loop resumes
    on it**, whichever step cut it:

    ```bash
    smith plan ingest factory/specs/active/<epic>/plan-v<n+1>.json \
      --session <session-id> --plan-version <n+1> --causal-parent <event-id>
    ```

    Cutting a version writes `plan-version-created` and moves the findings
    it cites; it does not write the tasks it added. Until they are ingested
    (`/bs plan` step 7) the new task is on no board and carries no claims,
    budget or edges in the DB, and the first gate event to name its id
    creates it as a bare row (D-46, D-254). It is idempotent: the tasks the
    version carried forward are skipped, and the output's `added` should
    equal what the amendment's `diff` added.
12. Run the full check suite **at the project root, on the assembled
    branch**. Every gate up to here ran inside a task worktree, so every
    green you have so far is a green about a worktree — the envkit epic
    shipped six green lint gates on a branch whose `pnpm lint` exited 1
    (D-42). Check out `smith/<epic>/integration` in the project first (this
    command refuses to move your working tree, and refuses a dirty one):

    ```bash
    smith integration check --epic <epic> --project <project-dir> \
      --checks <checks.json> \
      --session <session-id> --plan-version <n> --causal-parent <event-id>
    ```

    Exit 1 means the assembled branch is broken. Raise a finding, fix it as
    a task, and run this again — it pins its result to the head sha, so any
    merge after it lands makes the record stale and the verdict below will
    say so.

    `--plan-version <n>` is the live version, here and on every record steps
    13-16 write. The envelope leaves the flag optional, and an omitted one
    stamps the record `plan_version: 1` — so on an epic that amended, the
    check, the review and the close all claim to have verified a plan that
    no longer exists. One dogfooded product epic closed at v3 with its
    integration check and its closing spec review both stamped v1; the goal
    check, passed the flag, said v3. Read the version off `smith plan ingest`'s receipt and
    pass it every time.
13. Dispatch the **`spec-reviewer`** again — this time against the code.
    The pre-code review at `/bs plan` step 3 read the spec against nothing;
    this one reads it against the assembled branch, which is the only reading
    that can see a criterion the finished code proves wrong. The envkit epic
    deadlocked on exactly that: a correct S2 whose fix criterion 3 mandated
    and criterion 1 forbade (D-33). It writes to a close-specific path so it
    cannot clobber the pre-code artifact; hand that file — each item naming the
    `criterion_ref` it is against — to:

    ```bash
    smith epic spec-review --epic <epic> --project <project-dir> \
      --plan factory/specs/active/<epic>/plan-vN.json \
      --reviewed-by spec-reviewer \
      --evidence state/results/<epic>.spec-review-close-vN.json \
      --session <session-id> --plan-version <n> --causal-parent <event-id>
    ```

    `--evidence` is required unless you pass `--no-findings` instead, and
    the two are exclusive: a reviewer that found nothing writes `[]` to that
    path, and `--no-findings` is the operator attesting a review that ran
    outside the factory — recorded as `attested_by: operator`, never read as
    a file. A missing flag is refused (`cli.missing-flag`), because an empty
    review read from an absent file is how a capped reviewer closed clean.

    Its `dispatch_decision` — and step 14's, and the planner's when it
    renders a verdict — goes against the reserved `<epic>/integration` ref,
    never a `<epic>/spec-review-rN` you coin for the occasion
    ([`dispatch.md`](dispatch.md), "Dispatch a role with no claims against
    the reserved ref").

    `profile.closingSpecReview` decides whether this step runs at all:
    `always` (`huge`, `medium`), or `when-plan-amended` (`small`) — a closing
    review reads the spec against the code that now exists, which earns its
    call when the spec moved. An epic that ran its whole plan without a
    `plan amend` did not move. When the tier skips it, say so to the operator;
    a skipped review and a clean one are not the same fact either.

    When it does run, run it even when the review is clean — "ran and found
    nothing" and "never ran" are different facts, and the verdict below
    distinguishes them. It
    exits 0 even when it raises findings: what it found blocks the plan, not
    this command. A spec finding is unwaivable at S1/S2 and no task's diff can
    contain the fix, so the answer is `smith plan amend --plan … --findings …
    --rationale … --sites …` (§6a of the operator guide). `--sites` is every
    place that shape occurs, not only the file the finding was reported
    against — answer it before writing the changes, because it is the question
    that decides how much the amendment fixes (D-123). It cuts plan v(n+1):
    ingest it (step 11's `smith plan ingest`), go back to step 11 with the new
    version, and re-run this review against the branch that results. Never
    record a spec defect as a coder failure; that is
    the deadlock this step exists to end.
14. Check the plan against the **goal it was cut from**. Every gate up to
    here reads text the planner produced, so all of them go green on a plan
    that decomposes the wrong problem. This one reads the `- goal:` line of
    the roadmap milestone that owns the epic — the one reference the planner
    did not write. Get the clause list first (read-only, no event):

    ```bash
    smith epic goal --epic <epic>
    ```

    Hand those clauses and the live plan to a **`spec-reviewer`** session —
    a fresh one, never the planner's, and never the same dispatch as step 13:
    `smith dispatch check` refuses to let one dispatch answer for both.
    Dispatch it *after* step 13's record is written, not alongside it — a
    dispatch that predates the previous record has already answered for that
    one, so two sessions fired up front leave this record unaccounted for and
    `smith dispatch check` reports that record `unverifiable`. Take back one
    verdict per clause, in the goal's order, and record it:

    ```bash
    smith epic goal-check --epic <epic> \
      --plan factory/specs/active/<epic>/plan-vN.json \
      --coverage state/results/<epic>.goal-coverage-vN.json \
      --checked-by spec-reviewer \
      --session <session-id> --plan-version <n> --causal-parent <event-id>
    ```

    `covered` must name live plan task ids; `out-of-scope` must give a reason,
    and that reason is quoted back to the epic judge. `uncovered` mints an
    S2-major spec finding against the plan file — no task diff can contain
    that fix, so the answer is `smith plan amend`, which cuts v(n+1) and sends
    you back to step 11 — through `smith plan ingest`, as in step 13. The
    command exits 0 even when it raises findings.

    **It refuses (`cli.no-epic-goal`) when the owning milestone states no
    goal, and the epic then cannot close.** That is deliberate — there is no
    `not-required` escape hatch, because "no goal is stated" is the absence of
    the only text this gate can grade against. Fix the roadmap, do not work
    around it: give the milestone a `- goal:` line, or add the epic to the
    `- epics:` list of one that has it. Tell the operator you edited the
    roadmap; it is a scope surface (`/bs plan` step 8).
15. Before opening the PR, run the epic-final verdict — the last
    `quorum_triggers` gate, and the one that decides whether this epic is
    integrable at all:

    ```bash
    smith epic verdict --epic <epic> --project <project-dir> \
      --session <session-id> --plan-version <n> --causal-parent <event-id>
    ```

    Mechanical oracles first: non-terminal tasks, open blocking findings, a
    missing/failed/stale integration-root check, a closing spec review that's
    stale or missing when the tier required one, or a missing/stale
    spec-vs-goal check return `hold` (exit 1) without spending a judge call.
    A tier that waived the review (step 13: `when-plan-amended` on a plan
    still at v1) is not a hold on that ground — the verdict records the skip
    as a fact instead of staying silent about it, same as step 13 asks. A
    review that IS on record is still walked through every staleness check
    regardless of tier. `--project` is required — the verdict reads the
    integration branch head to decide whether the records from steps 12, 13
    and 14 still cover it. On `hold`, do not open the PR — report the
    `blockers` to the operator and go back to step 11.

    Once the oracles pass, the judge call is real money when an external
    provider is `active` in `crosscheck.yml`: codex spends the operator's
    ChatGPT quota, DeepSeek spends prepaid credit, and step 16 runs the
    verdict again before it writes, so a clean close is two spends, not one
    (one dogfooded epic wrote two `quorum-decision`s against its
    integration ref, one from the verdict and one from the close).
    Nothing in the `quorum-decision` payload names the purse, so say which
    one it is to the operator before the first call, not after the second.
16. Record the close. The verdict above is a read-only probe and writes
    nothing; `epic close` is what makes it a fact in the log (D-43):

    ```bash
    smith epic close --epic <epic> --project <project-dir> \
      --session <session-id> --plan-version <n> --causal-parent <event-id>
    ```

    It re-runs the verdict, then emits `epic-closed` on `go` and refuses
    (exit 1, no event) on `hold`. **Never pass `--override-rationale`
    yourself** — closing over a hold is the operator's call; ask for it and
    quote the blockers. If the epic was cut by `/bs audit`
    ([`audit.md`](audit.md) step 10), follow the close with
    `smith audit resolve <project-dir> --epic <epic> --session <session-id> --causal-parent <event-id> [--specs-dir <dir>]`
    so every finding this plan still claims is marked `fixed` in the
    project's audit store — the rest come back `deferred`, left exactly as
    they were, because the plan scoped them out on purpose. The store, not
    the epic, is where a finding's life ends. `resolve` reads the epic's
    newest plan from the work root's specs dir by default; when this
    project's plans live elsewhere, pass `--specs-dir` naming the same specs
    dir the epic was run from, or it refuses rather than guess.
17. Open **one integration PR per epic** with a scribe-written body. The head is
    `smith/<epic>/integration`. The base is the target repo's `main` unless
    the epic was cut from another epic's integration branch, in which case
    the PR stacks on that branch and the operator merges the parent's PR
    first — a child epic cut from `smith/<parent>/integration` opens its PR
    against that branch, behind the parent's PR; once the parent has merged
    and its branch is deleted, GitHub retargets the child to `main`. The
    operator reviews on GitHub; this session never merges to `main`
    (`docs/standards/guardrails.md`).

    **Build the fact pack first.** The scribe has no `Bash` and a small turn
    cap, so it cannot run `git` or `smith`, and a scribe left to grep raw logs
    caps and fills the gaps by invention — a wrong event id, a merged task
    called dead, "no waivers" over two grants. Compute every fact in your own
    session, from the epic session with `--lineage` so the waves' records
    count. Every fact comes from the log or from git, never from the SQLite
    projection: `stats kanban` and `stats timeline` read a projection that
    can lag the log, and `db rebuild` clears it before it re-reads, so do
    not refresh it for this.

    ```bash
    # one pass over the log (pass an --n that covers the whole lineage)
    smith event tail <session-id> --lineage --n 100000
    # the fingerprint map: finding_id, task_id and fingerprint of the epic's findings
    smith findings list --session <session-id> --epic <epic>
    # the goal the summary states
    smith epic goal --epic <epic> [--roadmap-path <file>]
    # the branch itself
    git log --oneline <base>..smith/<epic>/integration
    git diff --shortstat <base>...smith/<epic>/integration
    ```

    From the `event tail` pass keep, each with its `event_id`:
    - `waiver-granted` and `waiver-denied` records whose
      `payload.fingerprint` matches one of the epic's findings, mapped to
      that finding's id and task. Match on the stored `fingerprint` that
      `findings list` prints, and drop a decision that matches none: an
      ancestor session can carry an earlier epic's decisions. Grants come
      from here, not from
      `findings list --status`, because a grant only moves a raised or
      confirmed finding to `waived`; an amended or fix-verified one keeps
      its status.
    - `wave-merged` records: `payload.task_ids` and the event id.
    - `epic-closed` from step 16: its event id, `machine_verdict`, and
      `payload.summary.tasks` — each task's `task_status`, read from the log
      at close. A follow-up cleared by waiving all its findings still reads
      `todo` there; cross-check it against the grants and never publish it
      as an open task.
    - `audit-resolved`, for an epic cut by `/bs audit`: every record whose
      `payload.epic` is this epic — one epic can resolve more than once, and
      the lineage carries a parent epic's resolve too. List each event id.
      `fixed` and `deferred` are fingerprint arrays: fixed is the union of
      every kept record's `fixed`; deferred is the last record's `deferred`
      minus that union. Write the two counts into the pack yourself.
    - `integration-check` records whose `payload.epic_id` is this epic and
      whose `head_sha` equals the `epic-closed` record's
      `summary.integration.check.head_sha`: each check's `name` and `pass`.

    `epic goal` reads this repo's roadmap by default; when the epic's
    roadmap lives elsewhere, pass `--roadmap-path` naming it, or the goal
    you hand over is the wrong one. For a UI epic, take the screenshots
    from each task's tester result, `state/results/<task-id>.tester*.json`,
    field `artifacts` (the files sit under `state/artifacts/<task-id>/`);
    [`docs/standards/stack.md`](../../../docs/standards/stack.md) wants
    them on this PR. The pack carries a screenshot only as an image you
    have uploaded or attached — never a local path, which no reviewer can
    open; one you cannot attach stays out.

    Write only these filtered facts into one pack file — never raw command
    output, which puts the scribe back to grepping logs. Dispatch the scribe with that file as its **only source**, and the
    PR-body scratch file as its write root, under one rule: **omit, never
    infer**. A fact the pack does not hold stays out of the body; a count,
    a status, or an event id is copied from the pack, never worked out. If
    the pack is wrong, rebuild it and dispatch again; do not let the scribe
    reach past it into `state/events/`.

    The PR body has this shape and nothing else: **Summary** (the epic id
    and its goal, one paragraph); **Tasks** (one line per task: id,
    `task_status`, and its `wave-merged` event id when it has one);
    **Waivers** (granted and denied, each with its finding id and event id,
    or the word "none" only when both lists in the pack are empty);
    **Verification** (the verdict outcome, the `epic-closed` event id, the
    `integration-check` results, the `audit-resolved` event ids and the
    fixed and deferred counts when there are any, the shortstat, and the
    commit count from the log);
    **Screenshots** (only when the pack carries them); **Timeline** (the
    dashboard link, when you put one in the pack). The scribe's 300-word
    cap binds the prose — Summary and the sentences around the lists; the
    Tasks, Waivers and check lists are artifacts and are never cut to fit
    it, since a dropped line reads as a task or waiver that was not there.

    Before the first push, read the authorship the branch is about to make
    public — `git log --format=%ae <base>..HEAD | sort -u` — and stop on any
    address that is not a noreply one; a coder's worktree commit carries
    whatever `user.email` its session inherited.

    Then write the PR down. No verb records it for you: nothing in `src/`
    opens a PR — `gh` runs in your session, never in the factory — so a
    timeline that ends at `epic-closed` never shows what the close was for.
    Append it by hand, under the reserved ref and the live plan version:

    ```bash
    smith event append '{"session_id":"<session-id>","actor":"orchestrator","event_type":"integration-pr-opened","task_id":"<epic>/integration","plan_version":<n>,"causal_parent":"<event-id>","payload":{"step":17,"pr_url":"<url>","pr_number":<n>,"repo":"<owner>/<repo>","base_ref":"<base>","head_ref":"smith/<epic>/integration","head_sha":"<sha>","base_sha":"<sha>","commits":<n>,"changed_files":<n>,"additions":<n>,"deletions":<n>}}'
    ```

    The receipt says whether the timeline reads the type; it does, and it
    titles the row `<owner>/<repo>#<n> (<head> → <base>)` — the one line
    that shows a stacked PR's base before anyone merges in the wrong order.
