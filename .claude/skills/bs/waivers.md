# `/bs waivers` — answer the pending waiver batch

1. `bs waivers pending <epic> --session <session-id>` — every S3/S4
   finding for the epic with no waiver decision yet (a decided fingerprint
   never resurfaces).
2. Present the whole batch to the operator as **one** question ("ignore
   these?") — never ask per-finding (architecture §11, `severity.yml`).
3. Write the answers to `decisions.json`
   (`Array<{fingerprint, decision: "granted"|"denied", operatorNote}>`) and
   run `bs waivers apply decisions.json --session ... --plan-version ...
   --causal-parent ... --actor operator`. S1/S2 findings are rejected by
   the command itself if attempted — they go through the escalation ladder
   instead, never a waiver.
   Task waivers are a separate step. A task whose plan row says `waived`
   carries no gate run, and the epic close holds it as a blocker ("waived
   without operator approval") until the operator's approval is recorded.
   Ask the operator, then run `bs waivers approve-task <task-id> --note
   "<why>" --session ... --causal-parent ... --actor operator`. Only the
   operator actor is accepted; an approval written under any other actor is
   refused, and one appended by hand under another actor is not honoured.
4. A denial discharges nothing — the finding stays open with no further
   move of its own, and an open finding blocks the epic verdict. The
   command's output carries `findingIdsToCarry`: every finding id this batch
   denied. Carry the whole list forward until each id is closed — by the
   route its **scope** allows (`bs findings list --session <id>` shows
   the scope), by a later grant, or by `refuted`. The two scopes do not share
   a route:

   - **`spec` finding** (owned by `<epic>/integration`) — cut a
     `bs plan amend`, and its `--findings` must name every spec id from
     the list, or the finding stays open forever with no path back (issue
     #221). The amendment moves it to `amend-pending`; epic close moves it to
     `amended`. See `docs/guide/operator-guide/findings.md` §6a.
   - **`diff` finding** — `plan amend` refuses it
     (`plan.amendment-not-spec-scoped`): the code is wrong, not the plan. If
     the owning task is still open, bounce the finding to it like any gate
     finding. If the owner has already merged, fix it in a **follow-up
     task**:
     1. Write a draft, `Array<{filePath, finding}>` (the `gate run`
        findings shape). `filePath` is the denied record's `file_path`;
        `finding` is the **whole** record `bs findings list` prints,
        minus the three fields raise derives and overwrites —
        `fingerprint`, `file_path` and `finding_status`. Keep the rest:
        the schema requires `failure_scenario` and `found_by` too, and a
        draft without them fails with `findings.invalid-record`. Leave
        `task_id`, `finding_id` and `epic_id` as they are; routing rewrites
        them. Do not touch `finding_category` or `summary`: the follow-up
        id is derived from the fingerprint they make.
     2. Raise it against the plan with no `--task`:
        `bs findings raise --plan <plan.json> --findings <draft.json>
        --session <id> --plan-version <n> --causal-parent <event-id>
        --actor operator`. Routing sees the owner is closed and mints
        `<epic>/followup-<fp8>` — read `taskId` from the printed row
        (`attribution: follow-up`). A denied fingerprint is not suppressed
        on a re-raise; a granted one is.
     3. Check its claims before dispatching. A follow-up **inherits the
        owner's whole claim set** — and when ownership of the file was
        ambiguous, the **union** of every candidate's claims — so it can
        overlap tasks still in flight. `bs wave next <plan.json>
        --session <id> --causal-parent <event-id>` shows it: it folds in
        live status and logged follow-ups, and defers an overlapping task
        with `claim-overlap`. `wave check` validates only the ids it is
        given and cannot see the conflict.
     4. Dispatch it like any task, with these gaps filled by hand. It
        carries no acceptance criteria and no budget: **write the ACs into
        the dispatch brief** (the finding's fix, plus the test that proves
        it). `wave check` prices it at the coder cap, and `gate run` reports
        its budget as not-declared. It is not in the plan, so
        `lessons for-dispatch`, `findings for-dispatch` and `coverage check`
        refuse it with `cli.task-not-in-plan`: splice
        `bs lessons for-dispatch <role> --case-type bugfix` without
        `--plan`/`--task` — at the cost of every claim-path lesson, since
        claims are then `[]` and those lessons drop silently — and replace the findings block with
        `bs findings list --session <id> --task <epic>/followup-<fp8>`.
        At its gate, run `gate run` **without** `--plan`. With it, a judge
        finding on the merged owner's file routes to yet another follow-up
        (listed under `reattributedFindings`) instead of blocking this one,
        and that stray follow-up then blocks the epic until it completes or
        its findings are waived. Without it the finding blocks here, at the
        cost of coverage checking the total rather than the follow-up's
        claims.
     5. Close **both** findings by hand once the follow-up merges — nothing
        links the re-raised finding to the denied one, and neither moves on
        its own. Walk each with `bs findings transition <finding-id>
        <status> --session <id> --plan-version <n> --causal-parent
        <event-id> --actor operator` through `confirmed`, `fix-pending`, `fix-landed`,
        `fix-verified` (start at the first edge its status allows).
