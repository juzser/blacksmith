# Operator guide — Limitations today

One part of [the operator guide](../operator-guide.md). Section numbers
are the guide's, not this file's: `§5` means the same thing here as it
does wherever else this repo cites it.

## Limitations today

- **Dispatch orchestration is skill-guided; the background process watches,
  it does not drive.** Phase 7 ships `.claude/skills/bs/SKILL.md` — the
  operator runs `/bs new|plan|run|status|ui|waivers|lessons|report` in a
  Claude Code session inside this repo, and that session follows the skill's
  playbooks: it dispatches planner/coder/tester/reviewer/etc. sessions from
  `.claude/agents/` itself and drives them through the real `smith` commands
  in sequence. Phase 10 adds `smith daemon`
  ([`../runbooks/ops.md`](../../runbooks/ops.md)): a standalone background
  process that folds the event log on an interval and reports budget alarms,
  agents that never came back, and rechecks and cadences that are due, so
  *knowing* what the factory needs no longer takes an open session. It
  **never dispatches** — that is architecture §12's rule for the scheduler it
  wraps ("it never dispatches an agent itself"), applied to a process that
  outlives your terminal. The operator (or their Claude Code session) is
  still the loop that keeps calling `/bs run <epic>` until the epic is done.
  Every deterministic mechanic the skill relies on — plan/wave validation,
  worktree lifecycle, the gate pipeline, the merge queue, findings/waivers,
  the scheduler, the lessons pipeline, the event log — is built, tested, and
  CLI-accessible; only the "always-on daemon that needs no human in the loop
  at all" framing from architecture §16's later phases is still ahead, and it
  is not a line the watcher is allowed to cross on its own.
- **Nothing runs the integration-root check for you, and it is the only
  check that sees the assembled branch.** Every automatic gate runs inside a
  task worktree (§7a). `smith integration check` is operator-invoked, and it
  needs the project already checked out on `smith/<epic>/integration` — it
  refuses to move or clean your working tree. Skipping it no longer buys you
  a green epic, though: `smith epic verdict` holds without a current passing
  record (D-42/P9-26).
- **A spec finding needs a judge dispatched to find it, and the closing spec
  review is operator-invoked.** `--scope spec`, `plan amend` and `epic
  spec-review` (§6a, §7c) give the plan-defect route a home in the log, but
  nothing decides on its own that a criterion is wrong — a spec-reviewer
  session has to be dispatched and its evidence handed to the CLI. As with the
  integration-root check, skipping the closing review no longer buys a green
  epic: `smith epic verdict` holds an epic that has none, or whose review read
  an older head (D-33/P9-9).
- **The scheduler proposes, it never dispatches.** `smith scheduler run
  [--dry]` (architecture §12) emits `recheck-proposed`/
  `maintenance-proposed`/`growth-review-due` events on a deterministic
  pass over the event log — turning a proposal into a real dispatch is
  still a `/bs plan`/`/bs run` the operator (or their session) initiates.
- **`smith scheduler admit` says who may say yes, and still says only
  that.** It re-reads the same proposals and classifies each `auto` or
  `operator` against `scheduler.yml`'s `autonomy:` block, appending no
  event and starting no agent. `smith daemon` reports the same verdict per
  finding (§11), which is reporting and not a second answer: both call
  `autonomy.ts`, so the unattended surface cannot drift from the one you type. An `auto` classification removes the
  operator's *tick*, not the gates: the work still goes through `/bs run`'s
  ordinary wave — worktrees, tests, reviewer — and **the PR is still merged
  by a person**, which is the backstop that makes widening the whitelist
  safe. Every rule in `autonomy.ts` can only deny, growth review is denied
  ahead of the whitelist, and a proposal whose claims, task id or package
  names touch a `crosscheck.yml` security keyword is held whatever the
  whitelist says — the claims are folded out of the event log, so a recheck
  that names only an opaque task id is still matched on what it touches.
- **The lessons loop's "distillation" step is a manual dispatch.**
  `smith dream [--since]` extracts decision checkpoints into raw candidate
  events tagged `needs_distillation: true`; turning one into a checkable,
  principle-level statement means dispatching a `scribe` session by hand
  today (`/bs lessons`'s playbook), not an automatic pass.
- **Cross-provider judges run two and count one, and two of the four
  triggers only fire when you run a command.** Phase 8 ships both
  transports (Codex via `codex exec`, DeepSeek via its
  OpenAI-compatible API), the quorum engine, `smith judge run`, and `smith
  stats providers`. `crosscheck.yml` ships
  `codex: enabled: auto, mode: active` and
  `deepseek: enabled: auto, mode: shadow`, so a box holding the binary and
  the key calls both judges and only codex gates; `auto` on both means a box
  with neither has no external judge and nothing to edit. A shadow provider
  forfeits its vote and nothing else, so one active external cannot satisfy
  `min_providers: 2` and a finding claude raised still falls to the native
  verdict — promoting deepseek after a calibration pass, or changing the
  quorum policy, is an operator decision, not a default
  (`docs/runbooks/providers.md`). `smith judge preflight` checks, without
  spending a call, that a provider you switched on can be reached at all.
  All four `quorum_triggers` now have a
  host, but only two are automatic: an S1/S2 finding before it blocks and a
  same-mistake finding, both from `gate.ts`'s `intakeAndDecide()`. The other
  two are operator-invoked — `smith epic verdict` (`epic.ts`) before an
  integration PR opens, and `smith plan quorum` (`planQuorum.ts`) on a
  plan — and **nothing runs them for you**; skip the command and that epic
  or plan simply was not cross-checked. And even after promotion, one
  `mode: active` provider changes no outcomes — `finder_ne_critic` excludes
  the claim's finder (the native reviewer today), leaving a below-quorum
  pool that escalates instead of deciding; you need two.
- **The independent finder stays off even after you enable a provider.**
  Switching one on in `crosscheck.yml` buys a judge in `mode: shadow` — it
  runs on quorum triggers, it is recorded, and it gates nothing. It does not
  buy `independent_finder`, which is `enabled: false` on its own account,
  because it is the one call that would send the diff rather than a claim, and
  `send_diff: false` is a second lock on the same door. Turning it on is two
  edits and a decision about which vendor sees this repository's source; until
  you make it, `smith crossfind run` refuses and no diff leaves the machine
  (§7d).
