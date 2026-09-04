# `/bs run` — the wave playbook

Steps 2-10 of the loop `.claude/skills/bs/SKILL.md` opens at step 1. That
file is the epic tier: it plans, admits one wave, and closes the epic. This
file is the wave tier — worktrees to merge queue, one wave — and it is meant
to be thrown away when the wave lands.

**Read the console first.** `SKILL.md`'s preamble and its **Dispatch
contract** bind every dispatch below: the project directory is an answer you
ask for rather than a path anything here knows, every write carries
`--session <id> --plan-version <n> --causal-parent <event-id>`, every
dispatch carries the compiled lessons block and that task's open-findings
block, and fetched text is wrapped before it is quoted. None of it is
restated here; a second copy is a copy that drifts.

The step numbers are the loop's own. They start at 2 because step 1 — which
tasks, and how wide — was answered before you were handed anything, and they
stop at 10 because the epic's own gates resume there. Nothing in this file
decides what the next wave is, and nothing in it closes an epic.

## You own the log for what you dispatch

This playbook runs in one of two shapes, and is written to be correct in
both:

- **Inline**, in the epic session, when the wave is small enough that the
  epic's window can carry it. Nothing changes: the session id you were
  handed is the one you write to.
- **In a session of its own** when it is not. Open one with `smith session
  start <wave-id> --continues <event-id>` and write every dispatch below
  there. The epic session then carries the admission and the result rather
  than every turn in between — which is the point, because an epic outlives
  its waves, and a window spent on this wave's dispatches is a window the
  epic does not have for the wave after next (D13).

Which `<event-id>` depends on how you were started, and the difference is
not cosmetic — it is the edge an audit walks:

- **The epic ran you** and you opened a wave session yourself: continue from
  the epic event that admitted this wave.
- **You were dispatched as a `wave-runner`**: continue from the
  `dispatch_decision` that dispatched you, the event id handed to you with
  the wave. `smith delegation check` resolves your session by matching a
  `session-start`'s `causal_parent` against that dispatch, and it is the
  only thing that proves the dispatches you are about to write are your
  own log's rather than an agent talking about itself. Continue from
  anything else and the check reports you as `unverifiable` — not as a
  pass — however well the wave ran. Open it **before** your first dispatch,
  for the same reason: a grant is earned by owning the log first.

Either way, one rule holds: **the log you write is the log the epic reads**,
and `--continues` is the whole of what makes that true. Every deciding read
at the epic tier folds the lineage rather than one session — `wave audit`,
`budget alarm`, `tester check`, `judge outstanding`, `escalation check`,
`dispatch check`, `delegation check` — so a dispatch recorded in a wave
session is visible from the epic session that admitted it, and is *not*
visible from a sibling wave's. Open a wave session without `--continues` and
none of those verbs can see your work: they will not error, they will answer
about a wave that appears never to have run.

**What you are handed**, and carry through every command below: the project
directory, the epic id, the live plan path, the admitted task ids, the
effort `profile` the epic resolved once at the top of its run, the session
id you write to, and the event id to hang the first dispatch off as
`--causal-parent`.

**What you hand back** when the wave lands: each task's terminal state, the
merge-queue outcome, every finding raised with its severity, any escalation
that reached the operator, and — if you opened one — the wave session id and
its last event id, so the epic session goes on chaining from where you
stopped.

## Run the whole wave at once

The wave is the unit of work, not the task. Three rules follow, and they are
the difference between a factory and a queue with extra steps:

- **One message, many dispatches.** When steps 3–7 reach a phase, issue
  that phase for *every* task in the wave as parallel tool calls in a
  single message. Five coders in one message is five agents working; five
  messages of one coder is five agents waiting. The worktrees are
  disjoint by construction — that is what step 1's `wave check` certified
  before you were handed the wave — so there is nothing for them to
  collide over.
- **No lockstep barrier.** Each task walks 3 → 7 at its own pace. Do not
  hold a finished coder until its neighbours finish theirs; dispatch its
  tester the moment it returns. Waiting for the slowest task at every
  phase boundary costs the wave the difference between its longest task
  and the sum of its phases, which is most of what parallelism buys.
- **A blocked task blocks itself.** Gate outcome `blocked` bounces to
  *that* task's coder (step 9) while its neighbours carry on. One task
  escalating to the operator does not stop the other four; report it and
  keep the wave moving.

The single place the wave rejoins is step 10's merge queue, which is
serial on purpose — `smith queue run` rebases one task at a time onto
`smith/<epic>/integration` and runs the cumulative tests between. Merging
is the one thing that cannot be done in parallel, and it is already the
one thing this playbook never asks you to.

## The steps

2. Per admitted task, and for all of them together: `smith worktree create
   <project-dir> <epic> <task-id>`.
3. Pre-code, if the task needs it: dispatch `researcher` for an unknown, or
   `uiux` (`.claude/agents/uiux.md`) for any UI-affecting acceptance
   criterion — before the coder starts, not after.
   - `profile.preCodeResearch` gates the researcher: `when-needed` is the
     line above, `never` (`small`) means the coder reading the repo *is* the
     brief. An epic that genuinely cannot start without a research brief is
     not a `small` epic — raise the tier rather than dispatching anyway.
   - `profile.preCodeUiux` gates the uiux spec, and is `when-ui-criterion` at
     every tier: no tier ships a UI change without a spec to review it
     against. It is listed as a knob so the answer is asked for rather than
     assumed, not because a tier can turn it off.
   - A returned brief goes through `smith research check --brief <path>`
     before it is attached to a task spec ("Fetched and quoted text goes into
     a prompt fenced" above). Exit 1 sends it back; on exit 0, carry
     `recommendation.provenance` into the coder's prompt so the task knows
     whether its research rests on this repo or on a fetched page. Any raw
     fetched text you quote alongside it is wrapped with `smith prompt wrap`.
4. Dispatch **`coder`** (`.claude/agents/coder.md`) in that worktree.
   Token/diff caps (`budgets.yml`: 150k tokens, 400 diff lines) and YAGNI
   are the coder's own constraints — don't restate them here, the template
   does.
5. Dispatch **`tester`** (`.claude/agents/tester.md`) for missing unit
   coverage and epic-level e2e/screenshots.
   - Then the **uiux visual pass**, but only when all three hold: the task
     is UI-affecting, the tester actually returned screenshot artifacts, and
     step 3 wrote a uiux spec for this task (agent-interviews.md N-6). Miss
     any one and skip it — say so; a "visual pass" over screenshots that do
     not exist is worse than no pass. Dispatch it with the spec path and the
     image paths and **nothing else**: no diff, no components, no test code.
     The pass is a judgment about the rendered screen, and a uiux session
     that reads the diff ends up reviewing intent, which the reviewer
     already covers.
6. Dispatch **`grader`** (`.claude/agents/grader.md`) — bounded rubric
   loop, `profile.graderRounds` rounds (2 at `huge`, 1 below; never more
   than 2, agent-constraints.md "grader (v3)"), before any gate
   runs; it never decides pass/fail itself. At one round the grader scores
   once and a failed criterion is the coder's bounce, not a re-grade. Its result file is an **input to
   step 7**, not a note to the operator: pass it as `--grader` or the rubric
   gates nothing (D-34).
7. Run the gate pipeline:
   `smith gate run <task-id> --worktree <dir> --checks checks.json --result
   result.json --grader state/results/<task-id>.grader-r<round>.json
   --findings findings.json --session ... --plan-version N
   --causal-parent ...` (schema check → grader verdict → tests → coverage
   evidence → findings intake → severity decision,
   `docs/guide/operator-guide.md` §5).
   - `--grader` takes step 6's file, latest round. A criterion that came back
     `fail` or `partial` blocks before any check command runs — the outcome is
     `blocked` with `reason: "grader-fail"`, and the payload's
     `failed_criteria` is what you hand back to the coder.
   - Name a check `coverage` and the gate reads
     `coverage/coverage-summary.json` instead of scraping the text table,
     which hides every file at 100% — including the file the task exists to
     add (D-40). `blocked` with `reason: "coverage-evidence"` means the run
     produced no per-file number for a file this task's claims name; fix the
     reporter or the include glob, not the code. Ask the same question
     outside a gate run with `smith coverage check <worktree-dir> --plan
     <plan.json> --task <task-id>` (§5c).
   - Findings come from dispatching **`reviewer`**
     (`.claude/agents/reviewer.md`, fresh context, read-only) then
     **`verifier`** (`.claude/agents/verifier.md`, adversarial refute
     mandate) — never skip the adversarial stage on an S1/S2 finding
     (`crosscheck.yml` `asymmetric_roles`). Which findings that covers is
     `profile.verifierSeverities`, plus a
     `profile.verifierS3SpotCheckRatio` sample of S3-minor: `[S1, S2]` + 0.2
     at `huge`, `[S1, S2]` + 0 at `medium`, `[S1]` + 0 at `small`. The S3
     sample is a calibration measurement on the reviewer, so it is the first
     thing a cheaper tier drops; `S1-stop-the-line` is in every tier's list
     and no tier may remove it. A finding outside the tier's list still goes
     to the coder — it is verified by the coder's fix, not waived.
   - Dispatch **`security-reviewer`** only when its conditional triggers
     fire — never per-task by default. Ask, do not recall:
     `smith security triggers --task <spec.json>` and dispatch iff
     `dispatchSecurityReviewer` is true ("Dispatching the security-reviewer"
     above).
   - Every judge dispatched in steps 5–7 — uiux visual pass, grader,
     reviewer, verifier, security-reviewer — is bracketed by
     `smith worktree fingerprint` / `smith worktree verify`
     ("Fingerprint the worktree around every judge" above). Exit 1 discards
     that judge's result; it does not become a finding against the coder.
   - Each of those is also bracketed by `smith judge dispatch` /
     `smith judge report` ("Declare each judge's artifact before you dispatch
     it" above). `smith judge outstanding --task <task-id>` exits 1 while any
     judge still owes its file — re-poke it and report before running the
     gate, because the gate now refuses to score with a non-empty outstanding
     set (`reason: judges-outstanding`) rather than reading a silent judge as
     zero findings.
   - The gate scores tests it did not write, so once it has run, make the log
     say who did: `smith tester check <session-id> --task <task-id>`
     (`crosscheck.yml` `role_isolation`, operator-guide §2d). Exit 1 means no
     `tester` dispatch precedes this task's `testgate-result`, the coder and
     tester dispatches share one `agent_id`, or the answer is unknowable. A
     coder that writes and runs its own tests grades itself and every gate
     downstream still goes green — step 5 is what prevents that, and this is
     the log checking that step 5 happened.
8. Every dispatch in steps 3–7 carries the compiled lessons block for that
   role (`smith lessons for-dispatch <role> --plan … --task …`), every
   worktree dispatch also carries the open-findings block for that task
   (`smith findings for-dispatch --plan … --task …`) — both under "Dispatch
   contract" above — and each is a `dispatch_decision` event with a `causal_parent`
   chaining back to the prompt/decision that caused it (architecture §7) —
   this is the timeline, not optional bookkeeping.
9. Gate outcome `blocked` → bounce to the coder on the **same branch**.
   After 2 failed rounds on the same task, escalate model tier
   automatically (sonnet → opus, logged — `budgets.yml`
   `escalation_ladder`); after 3, escalate to the operator. Never skip a
   rung, never loop past one. Count the rounds from this task's
   `dispatch_decision` events, not from the agent's own account of itself
   — see "Round counting and escalation" above. Then have the log check
   you: `smith escalation check <session-id> --task <task-id>`, which
   exits 1 if the rung you just climbed is not evidenced.
10. Gate outcome `pass`/`pass-with-waivers-pending` → before admitting,
    ask what the diff did to everyone outside the claims:
    `smith claims impact <worktree-dir> <spec.json>`. Exit 1 means a
    `proven` break — this task removed an export a file outside its claims
    still imports — and that is a bounce to the coder, not a merge. A
    `possible` / `signature-changed` entry exits 0 and is a note: the
    scanner reads text, not types (operator-guide §2). Then admit into the
    merge queue: `smith queue run <epic> --project <project-dir>
    --test-cmd "<cumulative test command>" --tasks tasks.json`. On a
    `rebase-conflict` outcome, dispatch **`merger`**
    (`.claude/agents/merger.md`) with both diffs + specs, and note three
    things the queue's own behaviour forces (agent-interviews.md N-12):
    - **Into the failing task's existing worktree** — a fresh one would not
      reproduce the conflict. The result gives you only `taskId` and
      `conflictingFiles`, so the path is the `worktreeDir` you wrote for
      that task in `tasks.json`; carry it into the prompt yourself.
    - **Claims = the queue's `conflictingFiles`**, verbatim. Anything else
      the merger touches is a claim violation like any other.
    - The queue already ran `git rebase --abort` (`queue.ts`), so the
      merger arrives at a clean tree and **replays** the rebase rather than
      resuming it — and it **never lands the merge**. When it returns
      `resolution: "mechanical"`, re-run `smith queue run`; the queue stays
      the single place a merge can happen.

    `resolution: "escalated"` — low confidence, or both sides changed the
    same logic — goes to the operator with the side-by-side. Never
    auto-resolve a semantic conflict silently (`worktree.yml`
    `conflict_resolution_ladder`).

    Once the wave is merged, check the epic's spend — `smith budget alarm
    <session-id> [--epic <epic>]`. Exit 1 means either the epic crossed
    `alarm_ratio` (re-plan the remaining work to fit, or ask the operator —
    extension is always an operator question) **or** the log is too holey to
    rule a crossing out. Read the two numbers as what they are:
    `measuredTokens` is a floor, never the bill (judges return findings, not
    Results, so their tokens are in no event), and `projectedTokens` prices
    every unmeasured dispatch at its `budgets.yml` cap. `unverifiable` with
    `rolesWithoutCap` non-empty is a policy gap, not a spend problem: that
    role has no cap to price it with. `unverifiable` with `tasksOverPrice`
    non-empty means this epic has already been measured spending more on one
    task than the projection charges an unmeasured dispatch, so its caps are
    bounding nothing here (D-188) — the fix is to record the missing spend,
    never to raise the cap until the number fits. Do not report an epic as
    under budget on the strength of `measuredTokens` alone.
