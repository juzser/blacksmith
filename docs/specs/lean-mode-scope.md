# Lean mode scope — one command, a few agents, the same gates

Status: **draft for operator sign-off**, 2026-11-03.

This scope covers a new default path through Blacksmith. It does the work with a small fixed crew of agents and the factory's mechanical gates, and drops most of the ceremony around them. The full factory (`/bs plan` + `/bs run`) stays available and unchanged until the lean path has been measured against it. Nothing is deleted under this scope.

## 1. Why

On 2026-11-03 the trial kit (`trial/`) ran five small task kinds twice. One arm was plain Claude Code with the operator's global engineering rules: TDD, a fresh-context review, verification before claiming done. The other was Blacksmith 0.7.0 through `/bs plan` + `/bs run`. Each cell ran once, so every number below is a single run.

| | plain Claude Code | Blacksmith 0.7.0 |
|---|---|---|
| Hidden checks passed | 5/5 | 5/5 |
| Claude tokens (input + cache-creation + output) | 527,880 | 4,868,052 (×9.2) |
| Active time (operator waits removed) | 22 min | 194 min (×8.8) |
| Operator interventions | 0 | 28 |
| Blind A/B code review | — | Blacksmith slightly better 3, equivalent 1, plain negligibly better 1 |

The blind reviews found the production code roughly equal in all five kinds. Every Blacksmith advantage came from its tests. For example, in large-refactor its tests caught 12 of 13 seeded mutants and plain's caught 1.

Where Blacksmith's tokens went:

| Part | Share |
|---|---|
| Orchestrating session: playbooks, envelope bookkeeping, CLI writes | 40% |
| `bs-planner` (opus, xhigh; 12 dispatches) | 26% |
| `bs-wave-runner` + `bs-spec-reviewer` | 15% |
| **`bs-coder` + `bs-tester` + `bs-reviewer`** | **13%** |
| `bs-grader`, `bs-security-reviewer`, `bs-uiux` | 7% |

What the judges did in the trial:
- All 10 `grader-verdict` events read `met` in round 1.
- No code reviewer or security reviewer raised a finding.
- No task went back for a second round.
- Every `finding-raised` came from the spec-reviewer, on plans (6), or from uiux (1, a false positive caused by the screenshot width floor).

Of the 28 interventions:
- 10 were by design: sign-off and `/bs run`, 5 times each.
- 5 were merges.
- 13 came from setup or bugs: a single outside provider, no remote, close holds, a missing roadmap milestone, the screenshot width floor, and asking before spending quota.

Full record: the operator's trial notes, kept outside the repo, with `results.jsonl`, the blind-review probes and the transcripts.

The reading: the work that produced the quality (coder, tester, reviewer) is cheap. The coordination around it is what costs. The lean path keeps the first and replaces most of the second with hooks and mechanical checks.

## 2. Operator decisions this scope implements

| # | Decision (2026-11-03) |
|---|---|
| O-1 | Lean is the default; the full factory becomes opt-in. Measure before deleting anything. |
| O-2 | Keep cross-check by a different model. |
| O-3 | Keep parallel runs and multi-agent roles. |
| O-4 | Keep per-subagent model selection and budget distribution. |
| O-5 | Keep the security, convention, optimize and audit rules. |
| O-6 | The grader is an option, off by default ("4A"). |
| O-7 | The planner is an option, switched on automatically when the work splits into two or more independent parts ("5A"). |

## 3. The lean path — `/bs do <request>`

A new verb, so that the lean path and the full factory can run side by side and be measured against each other. `/bs plan` and `/bs run` are untouched.

1. **Size it.** The session reads the request and the code it touches, then decides between one part and several independent parts. Independent means disjoint path claims and no dependency, by the same `claims.ts` rules the planner uses today.
   - **One part:** the session writes 3–5 acceptance criteria into the brief itself. No planner, no sign-off.
   - **Several parts:** `bs-planner` drafts a short plan: parts, claims, criteria and order. The operator approves it once. That is the only extra touchpoint. The spec-reviewer runs one round on it, bounded to a named focus list, never an open hunt.
2. **Build each part.** Every role reads its model, effort and turn cap from its own template.
   1. A worktree is made (`bs worktree`, mechanical).
   2. `bs-coder` works test-first. It follows the new **test-strength rule**: every acceptance criterion gets a test that fails if that criterion is removed, and a refactor adds a behaviour-lock test before moving code.
   3. `bs-tester` adds depth and checks each criterion by mutation reasoning: if this criterion were removed, which test would fail?
   4. `bs-reviewer` reviews in **two stages**. First, compliance with the criteria, test strength included; this absorbs the grader's job. Second, code quality.
   5. The mechanical gate runs: the full suite, typecheck and lint where the stack has them, claims, and the diff cap.
   6. The part enters the merge queue.
   - Conditional roles keep their triggers. `bs-security-reviewer` runs only when a claim matches `sensitive-paths.yml`. `bs-uiux` runs only on a part with a UI criterion. `bs-verifier` runs only on an S1/S2 reviewer finding.
   - `bs-grader` runs only with `--grader`.
3. **Parallel.** When there are several parts with no dependency between them, the session dispatches their coders at once. Each coder runs in its own worktree, and the merge queue lands them one by one. The session dispatches directly; there is no wave-runner layer.
4. **Cross-check (§5).** Once everything is merged, a different model (Codex) reviews the combined diff once.
5. **Finish.**
   1. The full suite runs on the combined branch.
   2. The session writes the operator one summary: what changed, what was checked, the cross-check's notes, and spend by role.
   3. The summary ends with the merge command or a PR, following the existing finishing rules (no-reply email check, no force-push).
   - There is no epic verdict, no quorum, no closing spec review, no planner verdict and no roadmap requirement.

**Operator touchpoints:**
- One part: the request and the merge.
- Several parts: the request, the plan sign-off and the merge.
- Setup gaps (no remote, a single outside provider) are reported in the summary, not asked about mid-run.

## 4. Budget and model routing (O-4)

- **Model, effort and turn cap per role** stay in each template's frontmatter, as today (`.claude/agents/bs-<role>.md`). Claude Code applies them natively, so the orchestrator spends nothing on them. `maxTurns` is the hard cap.
- **Token budget per role** stays in `factory/policies/budgets.yml` (`task:` caps, tier caps). It is enforced after the fact, not projected beforehand:
  1. A `SubagentStop` hook reads the finished subagent's transcript with the reader the trial used (`transcriptTokens.ts`).
  2. It appends a usage event: role, model, tokens.
  3. It warns when the role's cap is crossed.
  4. The run's total against the tier cap is printed in the summary, and `bs budget alarm` keeps working off the same events.
- **Dropped from the lean path:** pre-dispatch admission paperwork, projected spend, and per-dispatch `dispatch_decision` writes by hand. These are the bookkeeping that made up much of the orchestrator's 40%.
- **To verify in phase 1:** that the `SubagentStop` input names the subagent's transcript in the Claude Code version we pin. If it does not, the hook falls back to the session's `subagents/` directory.

## 5. Cross-check (O-2)

Today's cross-check is a quorum vote that needs `min_providers: 2`. In the trial that produced:
- a hold on every close, because only codex was set up;
- two codex calls per close, because a hold cannot be reused;
- one refute, seen twice, that misread an "unit (pre-merge)" label.

The lean cross-check is one review, not a vote:

- **Who:** the first active external provider in `crosscheck.yml` (codex today), through the existing `providers/` transports. It is read-only (§18 rule 5) and fingerprinted around the call (§18 rule 6).
- **When:** once, on the combined diff, after the final suite passes. It is never re-run at close.
- **What it is asked:**
  1. Real defects, each with a concrete input and output.
  2. Acceptance criteria that no test would catch if removed.
  The prompt carries the criteria, the diff and the test files. It does not carry check labels.
- **Power:** advisory by default. A finding blocks only when the session reproduces it (a failing test or a probe run). The session then fixes it through the coder, or reports it as reproduced but not fixed.
- **No provider available:** the review is skipped and the summary says so. The operator is not asked.

## 6. Rules, security and audit (O-5)

- **Kept as text, read by every role:**
  - convention and security rules: `docs/standards/guardrails.md`, `stack.yml`, the agent templates;
  - approved lessons: `factory/policies/lessons.md`, spliced as today.
- **Kept mechanical:**
  - the guard and policy hooks (§18 rule 10);
  - `sensitive-paths.yml` triggers;
  - lint, typecheck and the full suite at the gate.
- **On demand, unchanged:** `/bs audit` with its four axes (security, code-quality, performance, architecture), and `/bs lessons` for candidate review. Neither runs per task.

## 7. Event log and the load-bearing rules (§18)

The dashboard and `bs stats` keep working off `state/events/*.jsonl`. What changes is who writes the events:
- Hooks write `SubagentStart`/`SubagentStop` events and the existing prompt capture.
- CLI verbs write gate, queue and merge results, as they do today.
- The session no longer threads an envelope through every command by hand.

| Rule | Effect |
|---|---|
| 1, 2, 3, 5, 6, 9, 10 | Unchanged. |
| 4 (a dispatch is written by the node that owns the log) | Still holds. The hook runs in the dispatching session, so the dispatcher writes it. |
| 7 (plans are immutable) | Applies whenever a plan exists, which is the several-parts path. |
| 8 (every write carries the envelope; ids are read, never computed) | Still holds. Hooks and CLI verbs fill the envelope from their own output. What goes away is the session doing it by hand. **This changes how rule 8 is met, so it needs the operator's sign-off.** |

## 8. Fixes the lean path needs first (phase 0)

These were found in the trial and lie on the lean path. Each is a small separate PR.

1. `bs init` adds `/.blacksmith/` to `.git/info/exclude`. Without it, the integration check refuses a fresh project's untracked state.
2. The trial harness `diffStats` exits 1 when `.blacksmith` is git-ignored, because the exclude pathspec names an ignored path.
3. The uiux screenshot tool cannot go below about 500 px wide. Its "phone width" shots were cropped, which caused a false S2.
4. `bs checks post-merge` takes the checked-out integration branch for the default branch when the repo has no remote.

Two further trial findings are on the full path only and are deferred:
- spec-review findings on a draft plan stay `raised` after the draft is fixed;
- the codex label misreading.

## 9. Measuring it (phase 2) — the acceptance bar

Re-run the five trial kinds with `/bs do`, under the same protocol: one run per cell, blind A/B review, and mutation probes on the tests. Targets:

| Measure | Target |
|---|---|
| Hidden checks | 5/5 |
| Claude tokens | ≤ 2× plain per kind (plain: 115,528 / 70,238 / 123,619 / 183,711 / 34,784) |
| Interventions | 1 per one-part kind (the merge); none about setup |
| Test strength | each kind's tests kill at least as many seeded mutants as plain's, and at least as many as Blacksmith 0.7.0's |
| Active time | ≤ 3× plain per kind (reported, not gating) |

Add two **large** kinds to `trial/tasks/`, with hidden checks:
- a feature spanning migration, API and page, about 600–1000 lines;
- a cross-cutting refactor over ten or more files.

Run each three ways: plain, `/bs do` with parallel parts, and the full `/bs run`. This is the evidence the parallel and multi-agent path needs, and the 2026-11-03 trial had none.

## 10. Phases

| Phase | Content | Gate to the next phase |
|---|---|---|
| 0 | The four fixes in §8 | merged, CI green |
| 1 | `/bs do` playbook, target ≤ 200 lines; test-strength rule in `bs-coder`/`bs-tester`; two-stage `bs-reviewer`; `--grader`; usage hook; one-shot advisory cross-check | the operator approves the PRs |
| 2 | §9 measurement, including the two large kinds | the numbers go to the operator |
| 3 | If §9 is met: `/bs do` becomes the documented default, `/bs plan` + `/bs run` move under "advanced", and unused machinery (quorum, epic verdict, goal check, roadmap requirement, tier overlay, …) is removed one PR at a time. If not met: back to the operator with the numbers. | operator decision |

## 11. Out of scope

- Deleting any module, policy or playbook. That is phase 3, by separate decision.
- Changing `/bs plan`, `/bs run`, `/bs audit`, `/bs lessons`, the dashboard or the daemon.
- The earlier cost work (read-time budget join, planner cache, lesson gating). The lean path replaces it.

## 12. Open questions for the operator

| # | Question | Recommendation |
|---|---|---|
| Q-1 | A new verb `/bs do`, or make `/bs run` itself lean behind a `--full` flag? | New verb: both stay runnable for the measurement. |
| Q-2 | Should the cross-check block only on a reproduced finding, or on any codex S1/S2? | Reproduced only. Codex refuted twice on a label in the trial. |
| Q-3 | When the planner is on, should it keep opus/xhigh? | Yes. It now runs only on multi-part work, where splitting quality matters most. |
| Q-4 | Is meeting §18 rule 8 through hooks and CLI output, not by hand, acceptable? | Yes. The rule's guarantee is unchanged. |
