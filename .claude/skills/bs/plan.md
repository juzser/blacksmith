# `/bs plan <goal>` — draft or re-plan an epic

[`dispatch.md`](dispatch.md) binds every agent this playbook dispatches;
none of it is restated here.

The planner-session playbook (architecture §3, §12):

**Pick the effort tier before step 1.** It is chosen per *epic*, not per
project — the same repo runs a `small` internal-tool epic and a `huge`
one — and it scales steps 3–4 below plus most of `/bs run`. Ask, do not
recall:

```bash
smith effort show --effort <small|medium|huge>   # no plan file exists yet
smith effort show --plan factory/specs/active/<epic>/plan-vN.json
```

`profile` is what this epic buys, and every step below that a tier touches
says which field decides it. `invariants` is what no tier may touch: the
gate pipeline, the integration check, claim disjointness and worktree
isolation, the security-reviewer's own triggers, the operator's sign-off,
the epic verdict, the event log and the escalation ladder run identically at
every tier. A `small` epic is faster because it deliberates less, never
because it verifies less — a tier that skipped tests would not be cheap,
just unverified.

Omit `--effort` and the epic takes `effort.yml`'s `default_tier`. Read
`effective`, not `requested`: an epic whose live tasks fire `crosscheck.yml`'s
`plan_quorum` security triggers is floored at `security_floor` no matter what
was asked for, and `floorApplied: true` says so. An internal tool that
touches auth is not a small epic. Without `--plan` the floor is *not
evaluated* — `securityFloorEvaluated: false`, and an empty `securityTriggers`
there means "not looked at", not "looked at and clean".

1. **Static analysis for claims first.** Before any decomposition, get the
   target repo's import/dependency graph so claims are computed, not
   guessed (architecture §5) — dispatch `researcher`
   (`.claude/agents/researcher.md`) for an unfamiliar repo, or do it
   directly with Grep/Read for a small one.
2. Dispatch a **`planner`** session (`.claude/agents/planner.md`, opus/
   fable) with the goal + the claims analysis. It drafts the epic spec and
   task specs (`factory/specs/schema/task-spec.schema.json` shape).
3. Dispatch a **`spec-reviewer`** session (`.claude/agents/spec-reviewer.md`)
   — a *different model* than the planner's, per its own frontmatter — to
   hunt spec gaps/ambiguities/missing-nonfunctional clauses
   (`docs/standards/agent-constraints.md` "planner"; `severity.yml`: most
   spec gaps land S2, blocking sign-off).
4. Planner fixes flagged issues; repeat 2–3 until the spec-reviewer has
   nothing S1/S2 left — or exactly once when `profile.specReviewRounds` is
   `single-pass` (`small`), where the planner fixes what came back and
   anything still S1/S2 goes to the operator with the spec at step 5 instead
   of round-tripping. Then run the plan quorum before sign-off — it
   evaluates `factory/policies/crosscheck.yml`'s `plan_quorum.triggers`
   (budget ≥50% of the epic cap, `case: infra`, security-sensitive, low
   confidence) for you:

   ```bash
   smith plan quorum --epic <epic> --plan-version <n> \
     --session <session-id> --causal-parent <event-id> \
     --confidence <your own 0–1 confidence in this plan>
   ```

   **Nothing runs this for you — you run it here** when
   `profile.planQuorum` is `always` (`huge`). At `when-triggered` (`medium`,
   `small`) run it only when you can already name the trigger from the plan
   you just wrote — budget ≥50% of the epic cap, `case: infra`, a
   security-sensitive clause, or your own confidence below 0.8. The command
   is local and free either way; what the tier is buying back is the step,
   not the tokens, because the two cross-provider judges are trigger-gated
   inside `runPlanQuorum` at every tier. Exit 0 = nothing needs
   the operator. Exit 1 (`critiqued`/`escalated`) is critique-only: never
   rewrite the plan silently, surface the critique to the operator at step
   5. If the output is `endorsed` with a non-empty `triggers` array, a
   trigger fired but no external provider is `enabled` in `crosscheck.yml`
   — say that plainly to the operator rather than signing off as if a
   cross-provider quorum happened.
5. **Present the epic spec + acceptance criteria to the operator.** Nothing
   executes before they sign off (architecture §1; agent-constraints.md
   "planner: autonomy — spec sign-off per epic").
6. On approval, write task specs to
   `factory/specs/active/<epic>/plan-v1.json` and validate:
   `smith plan validate factory/specs/active/<epic>/plan-v1.json` must
   report `{"valid":true}` before anything else touches this plan. Write the
   tier onto the plan file as a top-level `"effort": "<tier>"` — that is
   where `/bs run` reads it, and `smith plan amend` carries it into
   v(n+1) so a re-plan is not a fresh choice. Omit the field to take the
   policy default; a value that is not `small`/`medium`/`huge` fails
   validation rather than degrading to it.

   Then read the plan's parallelism ceiling before anyone is dispatched
   against it:

   ```bash
   smith wave schedule factory/specs/active/<epic>/plan-v1.json \
     --session <session-id> --repo <project-dir>
   ```

   `valid: true` says the plan is well-formed; this says whether it can ever
   run wide. It replays the wave loop to exhaustion and reports `depth` (how
   many sequential rounds) and `widest` (the most tasks any round starts —
   the ceiling beyond which more agents buy nothing). Exit 1 means the plan
   **stalls** and cannot be finished as written: fix it here, not by watching
   `/bs run` hang. Exit 2 means it runs but loses width to `constraints` —
   tasks whose dependencies were satisfied and were held back only by how you
   drew the claims. That is a plan-time cost and this is the last step that
   can pay it cheaply; a `widest: 1` plan serializes the whole epic while
   every gate downstream reports a healthy wave of one. Deferrals for
   `dependency-pending` never appear there, because a chain of real
   dependencies is the shape of the work and not a defect. Exit 2 is
   information, not a stop — decide whether to re-slice, and say which you
   chose when you present the plan.
7. Log the sign-off itself as a decision checkpoint (this is exactly what
   `smith dream`'s "plan sign-off" extraction looks for, `lessons.ts`):
   `smith event append '{"session_id":"...","actor":"operator",
   "event_type":"plan-version-created","plan_version":1,
   "causal_parent":"...","payload":{"epic_id":"<epic>","version":1,
   "note":"<operator's own words>"}}'`.
8. If this epic opens a new roadmap milestone, add it to
   `factory/specs/roadmap.md` (planner-maintained, architecture §12) — a
   roadmap change is itself a scope change and needs the same operator nod.
   Give it a `- goal:` line and list the epic under `- epics:`. That line is
   load-bearing, not documentation: it is the only text the spec-vs-goal gate
   can grade the plan against (`/bs run` step 14), and a milestone without one
   holds every epic it owns.
