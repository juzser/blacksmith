# `/bs report` — the scribe's progress digest

[`dispatch.md`](dispatch.md) binds every agent this playbook dispatches;
none of it is restated here.

The scribe-template digest playbook (agent-constraints.md "scribe (digest
duties, v3.2)"), plus running the scheduler first — a report that omits
pending proposals lets them sit invisible instead of surfacing them.

1. **Ask what the factory is answerable for, then run the scheduler.**
   `smith projects list` reads the roadmap's `- project:` bullets — the
   register `smith new` writes to — and prints this clone plus every
   project it built that has a checkout, ending in the `--project` line to
   pass on. Do not assemble that list from memory: the maintenance pass
   reads one lockfile per flag and reports one proposal per repo, so a repo
   left off the line is not reported as missing, it is simply never
   mentioned. (The daemon raises `unwatched-project` for a child project with
   a checkout that is left off the line — not for this clone, which is in
   the pass by default, and not for a declared project with no checkout at
   all, which `smith projects list` marks with `?` instead of leaving it
   off the printed list. The two surfaces no longer answer the same
   question.) Then run `smith scheduler run
   [--dry] --session <id> [--project <dir>...]` with those flags — a
   deterministic pass over the event log, it never dispatches an agent
   itself (`factory/policies/scheduler.yml`, architecture §12). Read its
   `proposals` and route each kind before writing the digest:
   - `recheck-proposed` → don't act on it silently; tick it into the next
     `/bs plan` sign-off as an `origin: recheck` task, same spec/sign-off
     flow as any other. Re-running the scheduler never duplicates an
     already-pending proposal for the same task (idempotent by design) —
     it re-proposes only after that recheck is resolved (a real recheck
     task created for it, or explicitly declined).
   - `maintenance-proposed` → read `projectDir` first: one pass can raise
     several of these, one per `--project`, and they are not
     interchangeable. Then check `autoSchedulable`: `true` (patch/
     minor-only version bumps, `scheduler.yml`'s
     `auto_schedule_confidence`) can go straight into the next `/bs plan`
     without a fresh conversation; `false` (a major-version bump is
     present) still needs one.
   - `growth-review-due` → this is a TRIGGER only, never a scope proposal
     itself (architecture §12). Open a fresh `/bs plan <goal>` session
     where the planner reads the living spec/analytics/recheck outcomes
     and proposes new epics — the operator's tick is required regardless
     of confidence, same as any other plan sign-off.
2. **Ask who may say yes.** `smith scheduler admit --session <id>
   [--project <dir>...]`, with the same flag line step 1 printed, re-reads
   the same proposals and classifies
   each one `auto` or `operator` against `scheduler.yml`'s `autonomy:`
   block (`src/autonomy.ts`). It enacts nothing — the split is printed so
   it can be read and argued with before anything moves.
   - `decision: auto` → dispatchable through `/bs run`'s ordinary wave
     flow without a fresh sign-off. It is still a wave: same worktrees,
     same gates, same reviewer, and the **PR is still merged by a
     person**. That merge is the backstop that makes auto-dispatch safe
     to widen, so never bypass it because the scheduler said `auto`.
   - `decision: operator` → it waits, and `code` names the rule that held
     it: `autonomy-disabled`, `growth-never-auto`, `kind-not-whitelisted`,
     `reason-not-whitelisted`, `below-confidence-floor`, or
     `security-surface`. Report the `reason` verbatim in the digest — it
     is written in the terms an operator would use to argue with it.
   - Every rule in that file can only **deny**. There is no branch that
     promotes something the whitelist did not name, so "what runs without
     me?" is answerable by reading `scheduler.yml` alone.
   - **Never widen the whitelist to clear a denial mid-run.** Editing
     `autonomy.auto_dispatch_kinds`, `auto_dispatch_recheck_reasons` or
     `confidence_floor` is an operator decision about standing policy, not
     a way past one proposal — and a `security-surface` denial is the one
     nothing in the file can lift.
3. Gather `smith stats overview [--session <id>]` and `smith stats roadmap
   [--session <id>]` (milestone progress + budget burn per milestone).
4. **Read back the disagreements.** `smith judge escalations --session
   <id>` folds the lineage for `quorum-decision` events whose latest word
   was `escalate` — a gate finding, an epic verdict or a plan critique the
   cross-provider quorum could not settle. It exits `1` on an open
   `disagreement` and `2` when the only thing open is
   `insufficient-providers`, so **exit 2 is not a failure to fix here**: it
   is one fact about `crosscheck.yml`'s gating arithmetic, already collapsed
   to `ungated.count` plus a hint, and it belongs in the digest as a single
   line. Report each `disagreement` individually — two providers read the
   same thing and said different words, and nothing else in the pipeline
   will raise it again. An entry with `held: false` goes first: the quorum
   did not settle it and the work went ahead regardless (that includes a
   `mode: shadow` disagreement, which the gate outcome never reported to
   anyone). Resolving one is an operator reading, never this session
   deciding on its own which provider was right.
5. **Read back the parallelism.** `smith wave audit --session <id>
   [--epic <id>]` folds every `wave-admitted` against the
   `dispatch_decision` intervals underneath it and says whether a wave
   admitted N wide actually *ran* N wide. `wave check` only ever certified
   that it *could*, so without this the digest reports a factory running
   many agents in parallel on the strength of a permission slip. Exit `1`
   is a wave whose tasks never once overlapped — report it with the epic
   id, because a serialized run is the failure this whole design exists to
   prevent, not a slow day. Exit `2` is a wave admitted with no dispatch
   under it at all: that is "cannot tell", not "ran narrow", and it usually
   means the wrong `--state-dir` or a run whose agents wrote elsewhere —
   check before reporting it as a stall. A `partial` verdict is **not** a
   finding; put `widest` in the digest as the one number that says how wide
   this factory has ever actually run.
6. Dispatch **`scribe`** (`.claude/agents/scribe.md`, haiku) with that
   JSON plus step 2's admissions as input: shipped / in-flight / blocked /
   budget burn / next milestone / **N rechecks pending, M maintenance
   bumps auto-schedulable** (never silently dropped), ≤300 words, linking
   into the dashboard (`smith ui serve`'s URL) — never paraphrase numbers
   the query didn't return.
7. This fires automatically on a weekly cadence and immediately on any
   milestone completion (architecture §12) — for an ad hoc `/bs report`,
   the same digest, just on demand.
8. Sending it to Slack is an **outbound send** — the permission layer
   prompts on the `curl`/webhook call; never fire it without that prompt
   resolving (`docs/standards/guardrails.md` "Deploy + outbound"). Print
   the digest to the operator regardless, whether or not the Slack send is
   approved.

**Provider calibration note (Phase 8).** While any provider in
`factory/policies/crosscheck.yml` is still `mode: shadow`, run
`smith stats providers [--session <id>] [--since <iso-date>]` alongside the
scheduler pass and fold a one-line mention into the digest when a provider
has accumulated enough runs to review (`runs`, `verdicts`, `agreementRate`,
`schemaFailureRate`, `transportFailureRate`, `failuresByCode` per provider —
`docs/runbooks/providers.md`'s calibration procedure has the promotion
threshold). Report `verdicts` alongside `agreementRate`: a `null` rate means
no run ever answered, which is a transport problem to fix, not a provider
that disagrees (D-168). When the rate is `null`, name the top entry in
`failuresByCode` in the digest line — `provider.missing-api-key` is an unset
environment variable and the whole repair, where `provider.invalid-output`
is the prompt (D-253). Promoting a provider to
`mode: active` is always an **operator edit** of `crosscheck.yml`, never
something this session does on the digest's say-so.
