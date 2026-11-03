# Lean mode scope — one command, a few agents, the same gates

Status: **decisions recorded (O-1..O-16), text awaiting operator sign-off**, 2026-11-03.

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
| O-8 | A new verb, `/bs do`. `/bs plan` + `/bs run` stay runnable next to it (Q-1 A). |
| O-9 | The cross-check blocks only on a finding the session reproduces (Q-2 A). |
| O-10 | When the planner is on, it keeps opus/xhigh (Q-3 A). |
| O-11 | §18 rule 8 is met by hooks and CLI output, not by hand (Q-4 A). |
| O-12 | The other verbs (`audit`, `new`, `mcp`, `use`, `status`, `ui`, `waivers`, `lessons`, `report`) and the `SKILL.md` router lose their redundant flow too (§6a). |
| O-13 | `/bs status` stays a separate quick view, about 25 lines. A new CLI verb renders the digest (Q-5 A). |
| O-14 | The dashboard goes entirely: the `/bs ui` verb, `bs ui serve`, the `ui/` package, its e2e CI jobs and its docs (Q-6, §6b). |
| O-15 | `/bs waivers` is retired on the lean path. Open S3/S4 findings become one yes/no line in the `/bs do` summary (Q-7 A). |
| O-16 | **North star:** Blacksmith is a repo of harness and skills that raise quality and enable parallel work with subagents. Anything that serves neither is a removal candidate (§10 phase 3). |

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
- **On demand, trimmed per §6a:** `/bs audit` with its four axes (security, code-quality, performance, architecture), and `/bs lessons` for candidate review. Neither runs per task.

## 6a. The other verbs (O-12)

The same principle applies to every verb:
- keep text rules, mechanical checks and the one operator stop that sets scope;
- cut steps that exist only to thread the envelope by hand, steps that duplicate a check the CLI already makes, and stops that could be a line in a summary.

None of these verbs ran in the trial, so the costs and values below are **unmeasured**. The line counts are targets for the playbook.

| Verb | Today | Lean version | Lines | What is lost |
|---|---|---|---|---|
| `SKILL.md` (router, loaded by every `/bs` turn) | ~56 of its lines exist only for hand-written events: the envelope, the prompt-capture parse, the event-id rules, the compaction rule. `audit`, `lessons` and `report` also load the 578-line `dispatch.md`. | Keep the role, the CLI spelling, the project-dir rule, "Talking to the operator" and the verb table (with `do`). The rest moves to `plan.md`/`run.md`. Split `dispatch.md` into an ~80-line core; the rest moves to `run.md`/`wave.md`. | 203 → ~90 | Nothing on the lean path. |
| `audit` | ~22 + N hand-written envelopes. A separate `worktree fingerprint`, although `audit open` already fingerprints (`audit.ts:794`). A judge dispatch/report pair per axis. One `decide` per finding. A `.gitignore` question. A roadmap block. A hand-off to `/bs plan` + `/bs run`. | `open` prints 4 briefs → the 4 axis judges in one message → `record` per axis, which re-verifies the tree and refuses a stale file → `consolidate` → **one batch stop** (where the operator sets scope) → `decide --batch` → `cut` writes a `/bs do` request → `close`. | 275 → ~100 | `judge outstanding` for audits; the audit milestone on the dashboard; `resolve` keyed by plan claims. Because a one-part `/bs do` has no plan, `resolve` must key on the merged diff's paths. Risk (unmeasured): a multi-part cut puts the plan sign-off right after the audit stop, which is two stops back to back. |
| `new` | Scaffold + gates + commit + a bootstrap roadmap milestone; a toolchain verdict; the push commands. | The same, without the bootstrap milestone and the inline history. | 35 → ~22 | The milestone `bs projects list` reads. That reader moves to the event log. |
| `mcp` | `mcp init` + milestone. Approval rule (already checked in code, `mcp.ts` MCP-T4) and MCP-S3 rule. `mcp check` runs only at `epic close`. | `mcp check` runs in the gate whenever `mcp.manifest.json` exists, because `/bs do` has no epic close and the check would otherwise be silently dropped. Keep "never sign an approval yourself" and MCP-S3; MCP-S3 has no code check. | 29 → ~12 | Nothing; the check moves earlier. |
| `use` | The hook writes the binding; the session relays it; the small-change bypass question. | Already lean. The hook text and playbook point at `/bs do` instead of "/bs plan and /bs run" (`sessionBinding.ts`). Keep the small-change bypass: a one-line change through `/bs do` still costs 3 dispatches. | 54 → ~35 | Nothing. |
| `status` | `daemon status` + `stats overview`, each rendered as prose by the session. It also restates `budgets.yml` caps, which the router forbids. | A new CLI verb prints the readable digest itself (its name is settled in phase 1b); the playbook relays it. | 61 → ~25 | The waiver and milestone lines, whose sources the lean path no longer produces. |
| `ui` | `ui serve`, a build on `ui.not-built`, the URL. | **Removed with the dashboard (O-14, §6b).** | 35 → 0 | The dashboard; see §6b. |
| `waivers` | `pending` → one batch → `apply` → `approve-task` → about 10 commands to route a denial. It exists because S3/S4 findings block the epic verdict, and the lean path has no verdict. | On the lean path, open S3/S4 findings are one line in the `/bs do` summary. A yes runs `waivers apply`, which is kept so a waived finding is suppressed in later reviews. A no becomes a follow-up `/bs do`. The verb stays for the full path, trimmed. | 93 → ~25 (full path) | On the lean path, the record of a denied finding carried forward. |
| `lessons` | `candidates`, each presented singly, approve/edit/reject plus a novelty read, `db apply`, `dream` + scribe, `compile` + commit, `lessons audit`. | Run `dream` first. Present one batch. `compile` reads the db, so `db apply` folds into it. The scribe becomes optional, which also skips loading `dispatch.md`. Add reviewer bounces as a `dream` source, since the lean path makes fewer sign-offs, waivers and escalations. | 85 → ~40 | With the scribe off, a fresh-context drafter. |
| `report` | `projects list`, scheduler `run`/`admit`, two stats reads, `judge escalations`, `wave audit`, provider stats, scribe prose, Slack, export. | A CLI render instead of scribe prose; this also enforces "never paraphrase numbers". Drop `judge escalations`, which reads quorum events only; drop `wave audit`, which exits 2 with no waves; drop provider agreement rates, which mean nothing for an advisory cross-check. Point "auto → /bs run" at `/bs do`. Keep: a person merges every PR, and the auto-dispatch whitelist is never widened mid-run. | 139 → ~40 | The scribe's prose summary. |

Cross-verb changes:

1. **Envelope defaults (O-11).**
   - `eventContextFromFlags` (`cli.ts`) requires `--session` and `--causal-parent` today. Change it so the session defaults to `CLAUDE_CODE_SESSION_ID` and the parent to the session's last event.
   - Keep the explicit flags for parallel writes, where "last event" could name a sibling's event (§18 rule 8's original hazard). Hooks always pass the parent they observed.
2. **Hooks write dispatch events for every verb,** not only `/bs do`.
3. **Every "/bs plan → /bs run" hand-off becomes `/bs do`.** This covers `audit`, `use` and `report`, and the session-binding hook text.
4. **Every lean run gets an id,** so `bs stats`, the dashboard and `status` can group by run as they group by epic today.
5. **Verb changes (O-13..O-15):**
   - `status` stays separate;
   - `/bs ui` is removed with the dashboard;
   - `/bs waivers` is retired on the lean path.

## 6b. Removing the dashboard (O-14)

The dashboard serves neither quality nor parallel work (O-16), so it is removed in one change:

- the `ui/` package (518 tracked files, about 13 MB): app, server and tests;
- the `bs ui serve` verb and `.claude/skills/bs/ui.md`;
- `ui/dist` and `ui/server/dist` from `package.json` `files`;
- the dashboard docs: `docs/guide/dashboard.md`, and the dashboard parts of `README.md`, `INSTALL.md`, `docs/guide/status.md`, `docs/guide/operator-loop.md`, `docs/runbooks/ops.md`, `SECURITY.md` and `docs/claims-matrix.md`;
- the e2e CI jobs (`e2e-shard`, `e2e (Playwright, Chromium)`), which test only the dashboard.

**Ordering constraint:**
- The `main` ruleset (26017656) requires the check named `e2e (Playwright, Chromium)`. A PR that deletes that job would wait forever for a check that never reports.
- So **the operator removes that required check from the ruleset first**; ruleset changes are the operator's. The removal PR merges after that.
- `gate (scripts/check.sh)` stays required.

Kept, because `bs stats`, the `/bs status` digest and the gate read them:
- the event log;
- the projection tables (`db/projector.ts`, `db/queries.ts`).

Queries that only the dashboard read are phase-3 candidates (O-16). They are not removed in this change.

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
| 1a | Envelope defaults and dispatch-event hook (§6a 1–2); `/bs do` playbook, target ≤ 200 lines; test-strength rule in `bs-coder`/`bs-tester`; two-stage `bs-reviewer`; `--grader`; usage hook; one-shot advisory cross-check; `mcp check` in the gate | the operator approves the PRs |
| 1b | Trims in §6a: `SKILL.md` and `dispatch.md` split, `audit`, `new`, `use`, `status`, `waivers`, `lessons`, `report`; hand-offs to `/bs do` | the operator approves the PRs |
| 1c | Dashboard removal (§6b) | the operator first drops `e2e (Playwright, Chromium)` from ruleset 26017656 |
| 2 | §9 measurement, including the two large kinds | the numbers go to the operator |
| 3 | If §9 is met: `/bs do` becomes the documented default, `/bs plan` + `/bs run` move under "advanced", and machinery that fails the O-16 test is removed one PR at a time. If not met: back to the operator with the numbers. | operator decision, per candidate |

Phase-3 candidates under O-16, listed but not decided. Each will go to the operator with what reads it and what its removal loses:
- the quorum vote, epic verdict, goal check, roadmap requirement and tier overlay;
- the daemon and scheduler;
- the Slack digest in `report`;
- the `bs new` scaffolder and `mcp` layer;
- the project registry;
- the lessons `dream` miner;
- projection queries only the dashboard read.

## 11. Out of scope

- Deleting any module, policy or playbook. That is phase 3, by separate decision.
- Changing `/bs plan`, `/bs run` or the daemon. The other verbs are in scope (§6a), and so is the dashboard's removal (§6b).
- The earlier cost work (read-time budget join, planner cache, lesson gating). The lean path replaces it.

## 12. Questions

All resolved on 2026-11-03:
- Q-1..Q-4 were answered A, recorded as O-8..O-11.
- Q-5 was answered A (O-13).
- On Q-6 the operator went further than the question and removed the dashboard entirely, stating the north star (O-14, O-16).
- Q-7 was answered A (O-15).
