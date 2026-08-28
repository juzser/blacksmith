# Changelog

Blacksmith has **no versioned releases**. It runs from a clone, not from a
registry: `package.json` is `version: 0.0.0`, there are no git tags, and the
only supported revision is `main`. So this file is not a list of releases —
it is a list of what landed, in the order it landed, keyed to the milestones
in [`factory/specs/roadmap.md`](factory/specs/roadmap.md).

Dates are the day the roadmap first recorded a milestone as `completed`,
derived from the development history that preceded this repository. They mark
when the phase was declared done, which for the earliest phases is later than
when the work started — development began 2026-08-03.

Format loosely follows [Keep a Changelog](https://keepachangelog.com);
newest first.

## Unreleased

This repository is the public release of Blacksmith. The work was done in a
private repository and published here as a single initial commit, so the phase
entries below record development that predates this repo's git history rather
than appearing in it.

### Added

- `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
  a pull-request template, and this changelog.
- A Quickstart in the README, plus a docs index covering
  `docs/standards/mcp.md` and `docs/runbooks/providers.md`.
- `INSTALL.md` — the install detail lifted out of the README as an executable
  runbook, written so a Claude Code session can work through it end to end
  when the operator says *"install Blacksmith"*. `CLAUDE.md` declares it.
- Three operator guides carved out of the README, so each one can go deeper
  than a landing page should: `docs/guide/operator-loop.md` (the six steps you
  actually perform, plus the S1–S4 severity contract),
  `docs/guide/dashboard.md` (the eleven pages, what each answers, and why the
  screenshots are committed e2e fixtures) and `docs/guide/status.md` (built vs.
  planned per phase, and the four caveats that matter before relying on it).
  `docs/README.md` indexes all three.
- The cross-provider judges documented for an operator rather than an
  implementer, in `docs/runbooks/providers.md`: the four quorum triggers and
  the fact that nothing polls for two of them, the `enabled`/`mode` dials, how
  to read `smith stats providers` before a promotion, why one active provider
  still changes no outcome, and what a judge is shown — a finding's claim,
  never the file contents and never the diff.
- **The repository health pass**, which is mostly infrastructure a contributor
  meets on their first PR:
  - `.editorconfig` and `.gitattributes`, so the file types here agree on line
    endings and whitespace before Biome has an opinion about them.
  - A secret-scanning gate that exists rather than being described:
    `.gitleaks.toml` allowlisting the one synthetic fixture credential by
    *literal* rather than by path, so the rule stays armed over the specs that
    quote it; a `gitleaks dir .` step in `scripts/check.sh`; and a
    checksum-pinned install in CI (`GITLEAKS_VERSION` + `GITLEAKS_SHA256`, both
    literal in the workflow, so a swapped release cannot pass quietly).
    Verified by canary rather than assumed: the AWS key from the vendor docs is
    stoplisted and finds nothing, a random `ghp_` token trips it.
  - Coverage thresholds on all three suites, each scoped to the code the suite
    is about — `factory/orchestrator/src`, `ui/server/src/app.ts`, and
    `ui/src/lib` minus `api.ts` — and run by `scripts/check.sh`, so the floors
    are part of the gate rather than a command someone remembers.
  - `.github/`: three issue-template files (Discussions are off, so the
    template `config.yml` does not link to them), `dependabot.yml`, and
    `CODEOWNERS`.
  - `package.json` metadata a public repo needs (description, keywords,
    homepage, repository, bugs, author, license, `engines`, `bin`) and the
    scripts that were only ever in prose: `check`, `format`, `test:watch`, the
    three coverage variants, and a `prepare` that builds the orchestrator so
    `smith` works from a fresh clone without a separate build step.
- `ui/src/lib/waivable.ts` — the "is this finding waivable" rule, extracted so
  it is unit-tested rather than inlined in a `.vue` file no type-checker reads.
  `TaskDetailPage.vue` now delegates to it; seven tests cover the S1/S2 refusal
  and the S3/S4 cases.
- **Rule D in the P9-37 event-type lint.** The scanner already followed a
  literal *at* `event_type:` (A), a literal handed *to* an `eventType`
  parameter (B), and either of those naming a module-level constant (C).
  Rule D is the mirror of B: a helper handing an event type *back*. Findings
  are credited to the `return` in the defining file, not to the call site,
  because that is where the typo would be. Its body spans are found textually
  and bounded away from nested callbacks' returns, and the suite asserts out
  loud that the rule still fires — P9-22: a rule that finds nothing is
  indistinguishable from one that never ran.
- The scheduler's three proposals — `recheck-proposed`, `maintenance-proposed`,
  `growth-review-due` — now render on the operator timeline with an icon and a
  title naming the task, the outdated packages or the cadence, instead of a
  bare `event_type`. Architecture §12 has the scheduler propose and the
  operator dispose, so the timeline row *is* the offer being made.
- `CONTRIBUTING.md` gained a **What the gate does not cover** section and a
  coverage table; `SECURITY.md` gained the same gap. The one thing the gate
  structurally cannot check is now written where a contributor will meet it.

- **The guardrails moved out of bash and into a tested policy layer.** The
  data half is
  [`factory/policies/guardrails.yml`](factory/policies/guardrails.yml) —
  protected branch names, allowed roots, which commands count as a deploy,
  and the exact wording an agent sees when a rule fires. The deciding half is
  `factory/orchestrator/src/policy.ts`, in TypeScript, with unit tests. Two
  commands host it: `smith policy check --command '<cmd>'` answers what the
  rules would say without running anything (exit 1 on a deny, and the output
  names the rule), and `smith policy hook` is the PreToolUse body itself,
  reading a hook payload on stdin. Six S1 rules apply to every agent session —
  `push-to-protected`, `force-push`, `merge-into-protected`, `deploy-command`,
  `history-rewrite-on-protected`, `unbounded-rm`. Matchers deliberately stay
  out of the YAML: a rule whose matching logic is data is a rule nobody can
  write a test against, and this is the one gate where "we changed it and
  nothing checked" is not an acceptable failure mode. Nothing in the layer is
  shell-specific, which is the larger half of the Windows blocker in
  `INSTALL.md` § Known platform gaps.
- **A judge sandbox, so "judges are read-only" is enforcement rather than a
  sentence in a prompt.** `smith sandbox open <worktree-dir> --role <role>
  --task <id> --session <id>` takes a lease over one directory before the
  orchestrator hands it to one of the six read-only judge roles (grader,
  reviewer, verifier, spec-reviewer, security-reviewer, uiux); `smith sandbox
  close` releases it once the verdict is filed and `smith sandbox status`
  lists what is open. While a lease is open, three further S1 rules apply to
  commands run inside that directory, on top of the six above:
  `judge-network` (no `curl`/`wget`/`gh`/`git fetch`/package installs — a
  judge that cannot verify something records a finding, it does not go and
  fetch what it is missing), `judge-write` (no write except the judge's own
  verdict under `state/results/` or `state/artifacts/` — if the code needs
  changing, that is a finding, not an edit) and `judge-sandbox-escape`
  (`smith sandbox` itself: a lease the leaseholder can lift is not a lease).
  This is possible rather than aspirational because judge roles hold
  `Read, Grep, Glob, Bash` and no `Edit`/`Write`, so `Bash` is a judge's only
  write path and the hook already sits on every `Bash` call. The lease file
  lives under `state/sandboxes/` in the main clone rather than in the worktree
  being judged, and matches by containment, so a `cd` two directories down
  stays inside it while an ordinary coder session in the same repo sees none
  of these rules. `researcher` is deliberately outside: fetching is its job,
  and it fetches through `WebFetch`/`WebSearch` rather than `Bash`.
- **The tester is fenced to test files, so it cannot make a red test green by
  editing the subject.** A test whose author may edit what it covers is a test
  that grades itself, which is the same failure the fresh-context reviewer
  exists to prevent one gate later. `role_write_scopes` in
  [`factory/policies/guardrails.yml`](factory/policies/guardrails.yml) declares
  a role's `write_globs`, and the new S1 `role-write-scope` refuses a write
  outside them — for the tester: test and spec files, the test directories, and
  its own results under `state/`. It also refuses outright the verbs whose
  target a text matcher cannot pin down (`cp`, `mv`, `patch`, `sed -i`,
  editors) and the git subcommands that rewrite tracked content without naming
  a path (`apply`, `cherry-pick`, `reset`, `restore`, `checkout`, `stash`).
  What the tester keeps is deliberate: the network, because a suite installs
  and downloads browsers, and `git add`/`commit`, because its output contract
  *is* a commit on the task branch.
- **The guard hook now sits on `Write`, `Edit`, `MultiEdit` and `NotebookEdit`
  as well as `Bash`.** The judge sandbox could watch `Bash` alone because a
  judge holds no `Edit`/`Write` and a shell was therefore its only write path.
  A tester holds both, so a rule watching only `Bash` is a rule it routes
  around with the tool it was handed. `smith policy check --tool Write --file
  <path>` asks the same question of a file write that `--command` asks of a
  shell line, and the same globs decide both a redirect target and a
  `tool_input.file_path`. A directory is in scope when something inside it
  would be, so `mkdir -p …/test/fixtures` is allowed rather than refused —
  a false deny teaches an agent to route around the gate rather than trust it,
  which is why the refused-verb scan also blanks quoted spans before it runs
  (`git commit -m "test: cover the restore path"` is the tester doing exactly
  what its contract asks, not a `restore`).
- **`sandbox open` refuses a role `guardrails.yml` has no rules for**, rather
  than leasing one it cannot govern. `judge_sandbox.roles` is now declared
  data instead of a list hard-coded in TypeScript, and an unrecognised role
  falls back to the judge rules — the strictest set, because that is the only
  fallback that fails closed.
- **`smith wave check` now refuses a wave that cannot fit**, where it
  previously only checked that the claims were disjoint. It prices the wave
  against what the epic has already spent and refuses admission that would
  cross `epic.cap_tokens`; refuses a wave that would put more tasks in flight
  than `epic.max_in_flight_tasks` allows; and refuses one it cannot price at
  all rather than admitting it optimistically. `--budget-policy <file>` points
  at a different policy, and `--override-rationale <text>` admits a refused
  wave with the machine's verdict recorded beside the human's reason. Every
  admission — not only an overridden one — writes a `budget` block onto the
  `wave-admitted` event, because a log that records only failures cannot
  answer "was this wave ever checked?" for the waves that passed. The same
  reasoning keeps the status `unchecked` distinct from `ok` instead of
  collapsing them: one indistinguishable yes for "checked, and it fits" and
  "never checked" is the exact shape of the guard-hook bug below. A follow-up
  task minted by `findings raise` has claims but no declared budget
  (D-48/P9-31), so it is priced at `task.coder.cap_tokens` as a charge rather
  than waived; a task the *plan* declares with no `budget.tokens` is a
  different silence and is still refused.
- Tests for all three, and a build step that stops mis-reporting what ran.
  `factory/orchestrator/test/policy.test.ts` (71), `test/sandbox.test.ts`
  (19), `test/guardHook.test.ts` (14) and 20 more in `test/waveBudget.test.ts`.
  The hook tests drive the real script the way Claude Code does — payload on
  stdin, decision on stdout — over real leases opened through the built binary
  with no stubbed lease directory, so they fail if the wiring between the
  lease file, the payload's `cwd` and the rules is wrong even where every unit
  test passes. `test/globalSetup.ts` builds `dist/` once for the whole run
  rather than in a per-file `beforeAll`: two test files now exec the built CLI
  and vitest runs files in parallel, and a throwing `beforeAll` reports as
  "2 failed, 182 skipped" — a headline that reads like two broken tests when
  in fact no CLI assertion ran at all.

- **`smith tester check` asserts that a tester graded the code, not the coder.**
  `crosscheck.yml`'s `finder_ne_critic` compares *models*, which is the wrong
  question for a tester: a tester may legitimately run on the coder's model.
  The risk is a shared *turn* — a coder that writes and runs its own tests
  grades itself, and every gate downstream still goes green over it. So the
  policy gained a second block, `role_isolation.pairs` (one entry today:
  `coder` / `tester`), and the command asserts it against the log per
  `testgate-result`: a tester dispatched at or before the gate, after a coder
  dispatch, under a different `agent_id`, having reported before the gate ran.
  Statuses and exit codes match `dispatch check` and `escalation check` —
  `violation` and `unverifiable` both exit 1, because a check that cannot
  answer must not read as a pass.

  Two things make it a separate command rather than another `asymmetric_roles`
  pair. **Absence is the finding here**: in `dispatch check` a critic that
  never ran is `not-applicable` and exits 0, while a test gate that graded
  checks with no tester behind it is precisely the failure being hunted — two
  opposite defaults cannot live in one matcher. And the evidence is a
  *dispatch*, not a model: no role template grants `Agent`, so a
  `dispatch_decision` is written by the orchestrator once per agent it invokes
  and never by an agent about itself, which makes a second dispatch the only
  proof the log can hold that a second turn happened. A missing `agent_id`
  never downgrades a check — it is an optional event field, not part of the
  dispatch payload contract, so "not recorded" is read as not recorded and
  never as "same agent". 27 tests in `test/testerAudit.test.ts`; documented as
  operator-guide §2d.

- **An independent finder, so a quorum can raise a finding and not only drop
  one.** Everything the external tier did until now was subtractive:
  `quorum.ts`'s vocabulary is `confirm | refute`, a critic is handed one claim
  the native reviewer already raised and asked whether it survives, and the
  strongest available outcome is deleting it. That makes the second vendor a
  brake and never an eye — a bug the native reviewer's context did not surface
  is a bug no amount of cross-checking reaches, because nothing outside that
  context is ever asked to look.

  `src/crossFinding.ts` asks. A finder on a different vendor reads the same
  diff in a fresh context, returns evidence against the new
  `finding-evidence.schema.json`, and the two lists are reconciled into four
  outcomes: `corroborated` (same fingerprint — severity may rise per
  `severity_resolution`), `co-located` (same file and category, different
  claim — recorded, never merged), `independent-only` (mintable as a real
  finding) and `native-only` (**no effect, by rule**). That last one is the
  design: silence is not a refutation. The finder was never asked about a
  native claim, it was asked to read a diff, so its not mentioning something
  is absence of evidence — subtracting on it would let a truncated second
  opinion delete real findings. Refutation stays in the critic tier, where a
  judge is handed the claim itself. And an `independent-only` finding is
  minted, not privileged: it enters the gate as an ordinary finding and at
  S1/S2 meets the same `quorum_triggers` critic as any other, so an unshared
  third-party opinion still has to survive a refute pass before it blocks.

  The switch that matters is `send_diff`, and it ships `false`. A critic
  judges a *claim*, so quorum can send a summary and a failure scenario and
  never the source; a finder has nothing to read but the diff. Shipping
  worktree source to a third-party API is not a decision this code has
  standing to make quietly, so `smith crossfind run` **refuses** rather than
  degrading to a diffless "find bugs" prompt that would invent findings about
  code the model never saw — and `max_diff_bytes` refuses rather than
  truncating, for the same reason. `smith crossfind request` prints the exact
  payload without sending it, so the decision is made on the bytes.

  Three verbs: `request` (print, send nothing), `reconcile` (two saved lists,
  offline, no provider and no event — it answers under
  `SMITH_CROSSCHECK_OFFLINE` because it is pure) and `run` (dispatch, then
  reconcile). `run` and `reconcile` exit 1 when the result would change a
  gate, which under `mode: shadow` is never. Each run writes one
  `cross-finding-reconciled` event — outcome counts, providers run, skipped
  and failed, and the ids it would have minted; in shadow mode that event is
  the only thing a run produces, so it also gained a timeline row, because a
  shadow verdict nobody can see is a shadow deployment nobody can evaluate.
  41 tests (29 unit, 8 CLI, 4 UI); documented as providers-runbook §5.

  One of those CLI tests exists because the suite hid the feature from itself:
  `test/setup.ts` sets `SMITH_CROSSCHECK_OFFLINE` for the whole run and the
  CLI subprocess inherits it, so the first `crossfind run` test silently
  exercised the kill switch instead of the verb. The switch now has its own
  test asserting the refusal *names* the skipped provider — the runbook has
  warned since Phase 8 that a skipped provider leaves no trace, and a finder
  that found nothing reads exactly like a finder that never ran.

- **`smith judge preflight`** — the one provider question that can be answered
  without spending a judge call. It came out of running the cross-provider
  check live against the shipped `crosscheck.yml` to confirm the tier is
  actually wired: it is — `gate.ts` raised a trigger unprompted on a blocking
  finding, codex returned a schema-valid `refute` in 7.6s, and the quorum
  correctly declined to gate it (both externals are `mode: shadow`, and the
  native reviewer was `excluded_as_finder`, so the pool was empty and the
  finding kept blocking). What the same run also showed is the gap:
  `deepseek` ships `enabled: true`, so on a machine with no
  `DEEPSEEK_API_KEY` every trigger spawned a call that could not leave the
  box, caught it, and wrote an `ok: false` row. Nothing was unsafe — the
  quorum is fail-closed — but it is one doomed call per blocking finding, and
  the only surfaces that reported it (`judge-verdict` rows, `smith stats
  providers`) are readable *after* the calls are spent.

  The command reads the policy and asks only what is knowable locally: is the
  `api_key_env` variable set, is the `command` on `PATH`, and does the
  arithmetic of the promotions add up — one `mode: active` external against
  `min_providers: 2` is flagged, because with the native finder excluded that
  operator is paying a gating provider's bill for a shadow provider's
  influence. Exit 1 with a `problems` array, 0 when there is nothing to fix.

  Three deliberate non-behaviours. It never makes a judge call — a preflight
  that proved a provider answers by asking it something would cost exactly
  what it saves, so a resolvable `command` is reported as resolvable and
  never as authenticated. It never prints a key, only the variable *name*.
  And it ignores `SMITH_CROSSCHECK_OFFLINE`, which forces every provider off
  at load time and would therefore hide the misconfiguration being looked
  for; the switch is reported as `offlineSwitch` instead. Zero active
  externals is the shipped default and is never flagged. 15 tests (14 unit,
  1 CLI); documented as providers-runbook §1.

- **A spec-vs-goal gate: `smith epic goal` and `smith epic goal-check`.** Every
  gate that existed before this one reads text the planner produced — the plan,
  the diffs the plan asked for, the gate records those diffs earned. So all of
  them go green on a plan that decomposes the *wrong problem*: criteria met,
  tests passing, spec review closed, and the epic ships something nobody asked
  for. The one reference the planner did not write is the `- goal:` line of the
  roadmap milestone that owns the epic, and nothing read it.

  `smith epic goal` prints that goal split into clauses, and writes nothing —
  the split happens here rather than in a judge's head, so two runs of the same
  check answer the same question. `smith epic goal-check` records one verdict
  per clause, in the goal's order. `covered` must name live plan tasks; a
  clause credited to a task the plan does not have is refused
  (`goal-check.unknown-task`), because a clause delivered by a task that does
  not exist is a clause nothing delivers. `uncovered` mints an S2-major
  spec-scoped finding against the plan file, which no task diff can close —
  `smith plan amend` is the only answer. `out-of-scope` is the one verdict that
  makes a clause disappear, so it demands a reason and that reason is printed
  back to the epic judge verbatim. Everything validates before anything is
  written, the way `plan amend` does: a map that raises two findings and then
  names a phantom task on the third clause writes neither finding and no event.

  **The gate fails closed, and the blast radius is the point: an epic whose
  owning milestone states no `- goal:` line no longer closes.** `smith epic
  verdict` holds it, and `smith epic goal-check` refuses to run there
  (`cli.no-epic-goal`) rather than record a check against nothing. There is
  deliberately no `not-required` escape hatch of the kind
  `MCP_SURFACE_NOT_REQUIRED` gives the MCP surface gate — an epic can honestly
  owe no manifest, while "no goal is stated" is the absence of the only text
  this gate can grade against, and treating it as a pass would make the gate
  skippable by deleting a line from `factory/specs/roadmap.md`. The fix is that
  same one-line edit in reverse: give the milestone a goal, or add the epic to
  the `- epics:` list of a milestone that has one.

  A check goes stale two ways, the pair D-125 drew for the closing spec review:
  a plan version older than the live plan, and a goal digest the roadmap no
  longer states. The second is why `epic goal` prints a digest at all —
  rewording a goal invalidates a check exactly the way cutting a new plan
  version does, and without the digest a reworded goal would silently keep a
  green check. `dispatchAudit`'s `CRITIC_WORK_EVENTS` gained
  `goal-check-recorded` at the moment the event was written rather than after
  an incident: a recorded check with no dispatch behind it is `unverifiable`,
  and one dispatch cannot cover both a spec review and a goal check — nor can
  two dispatches fired before either record, since the second one falls
  outside its record's window. 64 tests (57 unit, 7 CLI); documented as
  operator-guide §7e, `/bs run` step 14, and a third dispatch shape in the
  `spec-reviewer` agent contract.

- **A lessons audit, so the corpus can be pruned on evidence rather than on
  taste** — `smith lessons audit <session-id>`. A lessons file only grows: every
  incident adds an entry, nothing ever removes one, and the corpus drifts into a
  set of standing instructions that contradict each other while the escalation
  match quietly stops reaching half of them. `findMatchingLesson` is
  first-match-wins, so corpus *order* is load-bearing, and an entry an earlier
  one provably covers can never fire again no matter how true it is.

  The audit answers that with two independent classes of evidence, and it never
  conflates them. **Structural** death is provable from the corpus text alone:
  `coversEntirely` decides whether an earlier same-category entry's glob
  contains this one's, and if it does the entry is `unreachable` and recommended
  `retire` — no run, no log, no sampling required. **Evidential** death needs the
  event log to prove the entry was actually *loaded*: an entry is `idle` only
  when decisions in its category, on files its glob covers, were recorded by an
  intake whose payload shows the gate was holding it, and went somewhere else.
  That denominator is why `SeverityDecisionRecord` gained `findingCategory` and
  `filePath` — without them a decision cannot be placed against an entry, and
  the audit counts it in `decisionsWithoutContext` rather than guessing.

  It recommends and does not act. `keep`, `review`, `retire`, `rescope`,
  `no-evidence` — and `no-evidence` is never a reason to drop an entry, which is
  the whole point of separating it from `retire`. Contradictions are reported
  rather than resolved: two entries whose statements pass a unigram-Jaccard
  topic threshold while their polarity differs get `review`, because reconciling
  two standing instructions is a human's call. `overlapsWith` is informational
  on purpose — overlap between globs is normal, and only provable containment
  kills. Exit 1 on anything but `clean`, so it can sit in a scheduled job.
  22 unit tests plus gate and CLI coverage.

- **Path claims that see past the file, to the symbols crossing between
  files** — `factory/orchestrator/src/symbols.ts` and `impact.ts`, surfaced as
  `smith claims impact` and folded into `smith wave check`. A path claim answers
  "did two tasks write the same file", and that question has a blind spot with a
  name: task A changes `parse()`'s signature in `src/a.ts`, task B calls
  `parse()` from `src/b.ts`, the two claim lists are disjoint, every gate is
  green, and integration is where the factory finds out. The conflict was never
  in a file — it lived on the edge between two files.

  `symbols.ts` is a scanner, not a compiler front end, and that is a constraint
  rather than a preference: `typescript@7.0.2` is the native rewrite, which
  ships `"main": null` and exports only `./lib/version.cjs` plus two `unstable`
  entry points. There is no `ts.createSourceFile` to call. So the module reads
  imports, exports and re-exports directly, records each export's clause text
  (everything up to the first depth-0 `;` or `{`, whitespace-collapsed) as its
  signature, and resolves specifiers with a `/dist/` → `/src/` fallback because
  this repo's own source imports its build paths.

  Two checks, and the difference between them is the difference between a risk
  and a fact. **`waveImpact` runs before dispatch, over declarations.** All it
  can see is that two tasks in one wave sit on either end of a compile-time
  edge; that is a reason to order them, not evidence anything is wrong, so it
  reports `coupled` and the wave is refused. There is deliberately **no
  override**: `validateWave` already refuses a wave holding both ends of a
  *declared* edge, so any crossing that reaches this check is between two tasks
  the plan declared *no* edge between — precisely the dependency the planner
  missed — and the remedy is to run them in separate waves, which is cheap.
  **`exportImpact` runs after the work, over a diff.** An export removed while a
  file outside the task's claims still imports it is not a risk but a `proven`
  break; a signature that changed is the weaker `possible` claim, because this
  module reads text and not types and says so.

  Holes are reported and never fatal — an unparseable file, an unresolved
  specifier, a claim matching nothing. Failing a wave for the scanner's blind
  spots would teach operators to reach for the override, which costs more than
  the check was ever worth. `wave check` gained `--repo <dir>` to name the
  checkout the graph is read from, and prints its verdict as `symbolImpact`
  beside the claim result. 27 impact tests, 47 scanner tests, 7 CLI tests.

- **A merge queue that pays for the tests the change can actually reach** —
  `factory/orchestrator/src/testSelect.ts`, wired into the queue and surfaced as
  `smith queue run --select-test-cmd '<cmd> {files}'`. The serial queue ran the
  full cumulative suite once per task, so a wave of ten tasks paid for the whole
  suite ten times over changes that were often disjoint. Selection reuses the
  symbol graph `smith claims impact` already builds: it takes the files the task
  actually committed (`git diff --name-only <integration>...HEAD`), walks the
  dependents edge backwards to closure, and keeps whatever in that closure looks
  like a test file. The chosen files are substituted into the operator's own
  template at `{files}` — the module never invents a command, because a test
  runner's invocation is not something a fold over a graph is entitled to guess.

  Every ambiguity resolves to running everything, and each fallback carries a
  reason: an unparseable file in the graph, a changed file the graph does not
  know, a change to a config or lockfile, an empty selection, a template that
  fails to render. A `TestRunReport` — `{ mode: 'selected' | 'full', ran, known,
  reasons }` — rides in the queue's per-task result whenever selection ran, so a
  selective run is never silently indistinguishable from a full one in the log;
  without `--select-test-cmd` the key is absent and the result shape is exactly
  what it was before. Two things it
  deliberately does not do: it never narrows a typecheck, which is whole-program
  by nature and cheap next to a suite; and a template without `{files}` is
  refused before the queue starts (`test-select.no-files-placeholder`) rather
  than quietly running the full suite and reporting it as a selective run.
  Selection happens *after* the rebase, so it sees the files the task will
  actually merge. 19 selection tests, 4 queue tests, plus CLI coverage.

- **`smith daemon` — the folds, without an open session** (Phase 10):
  `factory/orchestrator/src/daemon.ts` and the runbook that operates it,
  [`docs/runbooks/ops.md`](docs/runbooks/ops.md). Until now, *knowing* what the
  factory needed meant keeping a terminal open and re-running `smith budget
  alarm`, `smith scheduler run --dry` and `/bs status` by hand. The daemon runs
  those same folds on an interval — it does not reimplement them, so it and
  those commands cannot disagree — and writes what it found to
  `state/daemon/status.json`. Four verbs: `run` in the foreground (or `--once`),
  `start` detached, `status` (exit 1 when it is not running, so it drops into a
  health check), `stop`.

  A tick reports findings, each one `info` or `attention`: an epic over or near
  its budget cap, spend the log cannot attribute, an agent live past four hours
  with no result, error or supersession, a recheck or a cadence that is due,
  a log it could not read, a SQLite projection that failed. It also refreshes
  the read-model the dashboard serves, so an unattended dashboard stops going
  stale.

  **It watches; it does not drive.** It never dispatches an agent, never enters
  the merge queue, and never writes outside `state/daemon/` and the derived
  SQLite database — architecture §12 says a scheduler run "never dispatches an
  agent itself", and a process that outlives the operator's terminal is the last
  place to relax that. Dispatch stays skill-guided through `/bs run`. Phase 10's
  other half, the Cloudflare port of the dashboard, stays deferred and unspecced
  rather than being quietly counted as done. 30 daemon tests, 6 CLI tests.
  Documented for operators in `docs/guide/operator-guide.md` §4b and §11 and in
  the ops runbook, which carries the launchd, systemd and cron recipes.

- **A dashboard that shows its own pulse, without a toast** — the freshness
  indicator moved out of Overview and into the app shell (`ui/src/App.vue`,
  `composables/usePulse.ts`, `lib/navBadges.ts`), and the shell now polls
  `/api/pulse` every 5s on every page. It carries two clocks, because they
  answer two different questions and neither implies the other: `livenessLabel`
  says whether the *screen* is current, and the new `lastEventLabel` says how
  long ago the *factory* last emitted. On the nine pages that were not Overview,
  a frozen server used to look exactly like a quiet factory — the confusion
  Overview had already fixed for itself. The sidebar gained arrival badges
  (`Timeline 3`, `Errors 1`) counted from the first poll after you last visited
  that page; the collapsed rail draws a dot and puts the number in the
  accessible name instead. Only monotonic counters get one, so a badge can never
  disagree with itself; Lessons badges its pending *level* rather than an
  arrival count. The shell's Refresh reaches every mounted poller through a
  signal in `usePoll`, so it refreshes the page you are on rather than only the
  pulse.

  **Toasts on events, triggers and dispatches were considered and rejected.**
  `useToast` currently means one thing — *your own action landed* — and a toast
  fired from a diff between polls would mean something else while looking
  identical. It would also misreport *when*: the UI polls at 5s and 15s, so the
  toast times the poll, not the event, and a wave would storm the corner of the
  screen with ten of them at once. `usePoll` pauses while the tab is hidden, so
  those toasts would be lossy for something the event log records durably —
  a badge that is still there when you come back is the honest surface. And a
  *dispatch* toast would imply the dashboard drives the factory, which is
  exactly the line the daemon above is not allowed to cross. The reasoning is
  recorded where it will be found again: `lib/navBadges.ts`'s header,
  `ui/docs/design-spec.md` §A.6, and the `ui/docs/DESIGN.md` decision log.
  24 badge tests, plus `lastEventLabel` coverage; three new contrast pairs
  (48 checked, 0 failures). The wiring is asserted where only a browser can
  see it, in the new `ui/e2e/shell.spec.ts`: that the shell polls on a page
  that has no poll of its own, that its Refresh refetches the page you are on
  rather than only the indicator beside it, and that a counter growing while
  you were elsewhere reaches the rail and clears when you read it. A fold that
  is correct and never mounted still leaves you staring at a frozen server.

- **A worker can now argue with the spec, and only an operator can change it**
  — `factory/orchestrator/src/specChange.ts`, four operator verbs (`smith plan
  propose | proposals | approve | reject`), and a request schema at
  `factory/specs/schema/spec-change-request.schema.json`.
  A plan version was immutable and a worker that found the criterion itself
  wrong had two exits: build the wrong thing, or fail against a clause it had
  already disproved. There is now a third. A worker returns a
  `spec_change_request` in its `structured_output` — the criterion, the
  assumption that criterion makes, the evidence against it, the diff it
  proposes in `PlanChanges` shape, every other site with the same shape, and
  whether it is blocking. It rides in a returned field rather than an emitted
  event because **a worker cannot emit an event — only the node that
  dispatched it can** (architecture §15), so a returned field is the only
  signal that survives the worker dying mid-flight. It is the same shape, and
  the same reason, as `research_request`.

  **Immutability is not relaxed; the approval path is added.** A proposal moves
  no plan file. `spec-change-proposed` is data, not a command (D-33): no worker,
  judge or scheduler can approve one, `smith plan approve` is an operator
  command, and approving is what calls the existing `plan amend` with no guard
  loosened. Every version is still cut by `plan amend` alone and still recorded
  as `plan-version-created`. A proposal's diff is validated at *proposal* time
  — drafted onto the next version and run through the plan's own validator — so
  a diff that could never be applied is refused while the worker is still there
  to be told, rather than landing in an operator's queue to be discovered later.
  Twelve refusals carry codes, among them `spec-change.proposal-without-sites`,
  `.proposal-without-argument`, `.rejection-without-rationale` and
  `.approval-stale`.

  Four decisions worth naming. `sites` is asked of the worker and not typed at
  approval, because the worker is the one who just read the code (D-123);
  approval prints `sitesUnclaimed`, the sites the amended plan claims no task
  for, at the moment the operator is best placed to say whether that is a
  deliberate call. A proposal defaults to `S2-major`, deliberately above the
  `S3`/`S4` band `raiseFinding` consults the waiver list for, so a standing
  waiver cannot silence one (D-196). `--rationale` is required to reject and
  optional to approve: approval can fall back to the worker's own argument
  because it agrees with it, while a rejection is the operator saying something
  the log does not already contain. And staleness is computed against the plan
  on disk rather than stamped at proposal time, so a proposal that was open
  this morning is stale this afternoon with nothing written to it — refused at
  approval, where it can still stop you, and never applied blind.

  The event order is load-bearing. An approval is `spec-change-proposed`,
  `plan-version-created`, `finding-transitioned`, `spec-change-decided` — the
  decision written *last*, after the version it authorised exists, so a crash
  between them leaves a proposal still open against a plan that already moved,
  which is the stale case above and not a silent double-apply. A rejection is
  `spec-change-proposed`, `spec-change-decided`, `finding-transitioned`, and no
  version. Taxonomy v7 adds both types to `graph_event`; `smith daemon` reports
  an unanswered proposal as a finding — `attention` when the worker called it
  blocking, `info` when it did not — and the dashboard's timeline reads them in
  the worker's own words behind a new **Plan changes** filter. 25 module tests,
  6 CLI tests, 4 daemon tests, 7 timeline tests. Documented in
  `docs/guide/operator-guide.md` §6b, with every command and every JSON body in
  that section copied from a real run against the built CLI.
- **A contract gate over `.vue` single-file components**, closing the oldest
  gap `SECURITY.md` states. Nothing here type-checked an SFC and nothing could:
  `vue-tsc` needs Volar, Volar needs TypeScript's classic Node compiler API,
  and this repo runs the native port, which exposes none. So the gate asks the
  compiler that actually renders these files what it had to leave for runtime.
  `ui/test/sfc.ts` runs `compileScript` for the binding metadata and
  `compileTemplate` with it, then reads the generated render code:
  `_ctx.<name>` is a template identifier no binding provides,
  `_resolveComponent`/`_resolveDirective` are an unregistered component or
  directive, and an import mentioned by neither the script body nor the render
  code is dead — which restores template-aware what `biome.json` has to turn
  off for `**/*.vue`. A second pass walks every call site and compares what it
  passes against what the called SFC declares, props, events and slots alike.
  Vue's real fallthrough rules are encoded rather than assumed: `aria-*`,
  `data-*` and the HTML globals are legitimate on a component, so are native
  DOM listeners, `v-bind="obj"` makes a call site unknowable and nothing is
  claimed about it, and a component with a bound slot name has no knowable
  slot set. `ui/test/vueContract.test.ts` runs it over all 57 SFCs in
  `ui/src` and carries 22 unit tests besides, because a sweep that has never
  failed is a sweep nobody has proven fires. No new dependency, and no CI
  wiring — it is a test in the ui suite `scripts/check.sh` already runs.
- **The stack is an install-time answer, not a mandate**
  (`factory/policies/stack.yml`). Blacksmith used to ship one operator's
  answers, recorded 2026-08-03 and hand-compiled into `docs/standards/stack.md`
  as prose every scaffolded project was told to obey: Vue 3 + Vite, Workers +
  Hono, SQLite/D1 + Drizzle, and a design system that lives in a private
  repository. A stranger who cloned this repo inherited all of it, including
  the part they could not obtain. Now [`INSTALL.md`](INSTALL.md) Step 5 asks
  the fifteen questions once, the answers land in one commented YAML, and
  `smith new` reads that file rather than a standard. The shipped answers are
  the ones that assume least — `frontend: none`, `backend: none`,
  `design_system: none` — so a fresh clone inherits nobody's taste, and
  `stack.md` now documents what reads each field instead of dictating it.
  - `smith stack show` prints what this clone answered. `smith stack check`
    sorts every field into **honoured** (a shipped template reads it),
    **recorded** (nothing in `factory/scaffold/` reads it, but the agents do)
    and **refused**, and exits non-zero only on `refused` — a check that goes
    red for every operator whose stack is wider than the template tree is a
    check they learn to ignore.
  - An answer the templates cannot build makes `smith new` **refuse before it
    creates anything**, rather than quietly handing over the frontend they do
    ship: answering `frontend: react` and receiving Vue reads as the factory
    ignoring the interview it just ran. Both the scaffoldability check and the
    design-system resolution run ahead of the first `mkdirSync`, so a refusal
    leaves nothing behind to clean up.
  - `design_system` names a kit and `design_system_source` names a directory:
    `smith new --ui` copies that directory into the new project's `design/`
    verbatim and imports its tokens. Vendored, never referenced — a named
    source that is not on disk is a refusal, not a warning. And
    `src/styles/main.css` is generated from the `styling` and `design_system`
    answers rather than copied from a template, because its content follows
    from them.
  - Validation is written against YAML 1.2 as it actually reads: closed
    vocabularies check membership instead of truthiness (`off`, `no` and `yes`
    are all non-empty, all truthy), and free-text fields refuse a non-string
    outright, because an unquoted version arrives as a number.
    `factory/orchestrator/test/stack.test.ts` carries 18 tests over it.
  - `stack show` and `stack check` share one dispatch arm and branch on
    `action` inside it — a shape the help-table drift guard misread, handing
    that inner branch to the last bare namespace above it and so inventing a
    `new show` while losing the real `new`. The extractor in `usage.test.ts`
    now reads pair-form arms as well as bare ones, so only a bare namespace
    can own a nested action.
- **`WAIVABLE_SEVERITIES` is now pinned to the `blocks_merge` column it was
  always a restatement of.** `severity.yml` declares which levels block a
  merge and states the rule in its own `waiver_semantics` ("Only S3/S4
  findings are ever waived"); `waivers.ts` re-typed the answer as a literal,
  so an operator flipping a level's `blocks_merge` would move the merge gate
  and leave the waiver path answering from the old shape — a finding that no
  longer blocks a merge yet cannot be waived either. A drift guard rather
  than a runtime read on purpose: threading a `SeverityPolicy` through every
  `applyBatch` call site would let the merge axis decide the waiver axis by
  fiat, and the two are equal today by coincidence, not by definition. A
  second test asserts the comparison walks every level `severity.yml`
  declares, so a level missing from `SEVERITY_ORDER` cannot be silently
  excluded from the guard that is supposed to read it.
- **`paths.ts` now has to name every file in `factory/policies/`.** Ten of the
  eleven policy files had a constant there; `severity.yml` did not, because
  `severity.ts` spelled `${REPO_ROOT}/factory/policies/severity.yml` itself —
  the only path in the repo assembled by interpolation rather than
  `path.join`, and so the one loader that could not be held to the convention
  `budgets.test.ts`, `crosscheck.test.ts` and `scheduler.test.ts` all keep
  ("the loader's default and the paths.ts constant name one file"). The
  constant moved, `severity.ts` imports it, and that convention test now
  covers it. A new `paths.test.ts` compares the directory listing against the
  constants as sorted arrays — so both a policy file no module can name and
  two constants pointing at one file go red — plus a second test pinning that
  every policy path is built with `path.join`, because the first one keys on
  `path.dirname` and a stray separator would drop a constant out of the
  comparison unnoticed.
- **Two tests for the half of `NativeFindingRecord.file_path`'s claim that
  nothing checked.** The doc comment promises both that a pre-P9-15 record
  with no path is never co-located *and* that it "can still be corroborated —
  the fingerprint is a digest of the path it was raised on". Only the first
  half was pinned, and the two fail in opposite directions: if corroboration
  ever started reading the path column instead of the fingerprint, such a
  record would come back `native-only` beside an `independent-only` mint —
  the factory raising a duplicate of a finding it already holds — with no test
  going red. The second test carries a real path inside its fingerprint and
  still refuses to co-locate, so the first cannot be passing for the
  uninteresting reason that its digest was over an empty path.
- **`docs/guide/extending.md` gained an "Add a judge provider" section** — the
  page a public operator with a provider this repo has never heard of reaches
  first, and the one extension point it did not cover. It states the shape of
  both transport declarations, the four steps from key to promotion (name the
  env var, `smith judge preflight`, start in `mode: shadow`, calibrate before
  promoting), how to roll one back, and the two transport behaviours worth
  knowing before writing a config: the extractor takes the first *validating*
  JSON rather than the first parseable one, and a provider that fails is
  dropped from the quorum rather than taking the run down, which is what
  `smith stats providers` is for.

### Changed

- **Judge providers are resolved by transport, not by name.** The architecture
  says the judge tier is "provider-agnostic by contract" — "any model that can
  honor the contract can serve" — and the registry contradicted it. Dispatch
  opened with two name-keyed branches, `codex` and `deepseek`, each forwarding
  to a one-line module that called the same generic transport the file already
  ended with, and each refusing to run if its name was paired with the other
  transport. The forwarding modules added no behaviour; the refusals were the
  real cost, turning two ordinary strings into reserved words with opinions.
  An operator reaching Codex over an OpenAI-compatible endpoint, or running
  DeepSeek's open weights as a local command, wrote a correct `crosscheck.yml`
  and was told it was misconfigured — and an operator whose own provider
  happened to be called either name inherited a vendor's transport by
  coincidence of spelling. Both are configurations someone will write, and
  neither is wrong. The name is now data all the way through: it selects a
  config entry and labels the verdict, and `transport` alone decides what
  runs. `providers/codex.ts` and `providers/deepseek.ts` are deleted, adding a
  provider is a config entry and nothing else, and the two names in the
  shipped file are worked examples rather than reservations. No transport
  behaviour changed.
- **`guardrails.md` now states the removal rule the matcher actually
  enforces.** The contract read "`rm -rf` and equivalents are blocked outside
  `workspaces/` and `state/`", and two things make that untrue. The roots are
  matched by name at the top of whichever repository the command runs in —
  the git toplevel of its working directory, never this clone — so inside a
  task worktree, where a worker spends the whole task, neither root exists and
  every recursive-force `rm` is refused, its own `node_modules` included,
  while a project carrying its own top-level `state/` has the bound applied
  there instead. And "equivalents" claimed a reach the rule has never had: it
  reads the shape of an `rm` invocation as written, so `rimraf`, an
  `fs.rmSync` script, and `git clean` pass it untouched. Both halves were
  reproduced against real git fixtures through the context `smith policy
  hook` builds, rather than read off the source. No matcher, root, or verdict
  changed — the divergence was in the sentence, and `guardrails.yml`'s comment
  above `allowed_roots` carried the same one.
- **A project driven by Blacksmith no longer has to live under
  `workspaces/`.** Nothing in the runtime ever required it: every verb that
  touches a project's git takes the directory itself — `<project-dir>` as a
  positional on the `worktree` family, `--project <dir>` everywhere else —
  `smith new --target-dir` puts a new project wherever it is told, and since
  D-42 a worktree is a sibling of the project directory rather than a child,
  so it follows a clone that sits outside this repo. The instruction surface
  did require it. Seven command lines in the `/bs` playbook wrote
  `workspaces/<project>` where the CLI takes a path, which is the path an
  agent then typed, and `worktree create` was among them. The playbook now
  asks where the project lives once, at the top of a run, and carries that
  one answer through every command below; `AGENTS.md`, the `coder` role and
  the operator guide state `workspaces/` as an instance of the rule rather
  than as the rule. `smith new` still lands there when no `--target-dir` says
  otherwise, and this repo's own `workspaces/` is unchanged.
- **Nothing prescribes a design system any more, and the dashboard stopped
  naming a private one.** This repo's own kit was called HDS, after the
  private design system it was ported from, and the name had leaked into
  places that bind *other people's* projects: the `uiux` agent was told to
  write an "HDS-grounded" spec, `taxonomy.yml`'s finding vocabulary carried a
  `visual-hds` category, `severity.yml`'s S3 row read "visual regression vs
  HDS", and `ui/docs/DESIGN.md` opened by declaring this repository an adopter
  of a design system whose registry lives somewhere nobody outside can clone.
  - `visual-hds` → `visual-design`, named for the uiux spec the render departs
    from rather than for any one kit. `suggestCanonical` derives its
    suggestions from the vocabulary itself, so the rename retargets the
    typo-suggestion for free and the bare-tail rule still resolves `design` to
    exactly one candidate; no recorded event carried the old value.
  - The `uiux` agent looks the answer up instead of assuming it. Which design
    system a project has is a fact in `factory/policies/stack.yml`, a project
    scaffolded with a named kit carries it vendored at `design/`, and
    `design_system: none` is a complete answer — spec against the components
    and tokens the project already ships, and say in the spec that you did.
  - The dashboard's kit moved to the neutral namespace its tokens already
    used: `ui/src/components/hds/` → `components/ds/`, `hds-tokens.css` and
    `hds-components.css` → `ds-*`, and the `hds-` class prefix → `ds-` across
    `ui/src`, `ui/test`, `ui/e2e` and the four design gates. Every token was
    already `--ds-*`, so nothing collided. The port's provenance is now
    recorded once, in `ui/docs/DESIGN.md`, and reads as a footnote about where
    files came from rather than as somewhere to go — nothing under `ui/`
    reaches outside this repository at build or run time.
  - Section A of `docs/specs/black-smith-interview.md`, the stack questions,
    is a pointer to `INSTALL.md` and `stack.yml` instead of a second copy of
    them, because a second copy is a copy that drifts. The dated answers
    already recorded there stay: they are history, not a declaration.
- Demo project fixtures, screenshots and compiled lessons use neutral names
  (`demo-rpg`, `demo-hub`). Provider credentials are environment-only, named
  in `.env.example` and never committed.
- **Both external judges are now `enabled: true` in `mode: shadow`**, where
  Phase 8 shipped them `enabled: false`. Their verdicts are recorded and gate
  nothing until an operator promotes one to `mode: active`. The practical
  difference: with no credentials configured, each quorum case now records a
  caught transport failure instead of making no call at all, which reads as a
  `transportFailureRate` of 1.0 in `smith stats providers`. `README.md`,
  `INSTALL.md`, `docs/guide/operator-guide.md` and `factory/specs/roadmap.md`
  had all kept describing the old default.
- The product's name is written **Blacksmith**, one word, everywhere it is
  prose — 62 occurrences that read "Black Smith", including the dashboard's
  sidebar and `<title>`, so the committed e2e screenshots regenerated.
  Identifiers deliberately keep their hyphenated slug: the
  `docs/specs/black-smith-*.md` filenames, the `black-smith.dev/schema/*`
  `$id` URIs, `ui/src/assets/brand/black-smith.png`, the `package.json` name,
  and the project slug recorded in existing event logs are paths, contracts or
  data rather than prose.
- **The README is now a landing page, not a manual.** It went from 510 lines
  to ~220 by moving whole sections into files of their own rather than
  summarising them twice: the operator loop, the dashboard tour and the phase
  table each became a guide (see **Added**), the install detail was already in
  `INSTALL.md`, the cross-provider detail was already in
  `docs/runbooks/providers.md`, and the safety rules were already in
  `docs/standards/guardrails.md`. What stayed is what a first-time reader
  needs: what it is, why it is shaped this way, how to get it running, one
  screenshot, and a link per topic. The `## First commands` section was
  dropped outright — `smith --help` is generated from the same `COMMANDS`
  table the CLI dispatches on, so a hand-copied command list could only drift
  away from it.
- **The README is now written for a person deciding whether to use this**, not
  for an agent reading it as spec. The previous pass made it short; this one
  makes it a pitch. It opens with the failure it removes — two workers editing
  the same file, one quietly renegotiating the goal, a third reporting itself
  done — then answers it with seven features, each pairing one claim with the
  committed e2e screenshot that shows it (`ui/e2e/__screenshots__/phase-6b/`),
  so every capability line has a picture a reader can check it against. A nav
  row under the badges jumps to Features / Install / Using it / How it works /
  Safety / Status / Docs. Shape borrowed from the two repos the operator
  pointed at, `eneskirca/nodeterm` and `stablyai/orca`.
- **More README content moved out rather than being rewritten**, on the same
  rule as the pass above — a second copy is a copy that drifts. The ASCII
  pipeline diagram is gone because `docs/specs/black-smith-architecture.md` §3
  already draws that loop; the three install caveats are gone because
  `INSTALL.md` already carries them; the `## Cross-provider judges` section is
  gone because `docs/runbooks/providers.md` owns it. Each is now one link.
  `/bs mcp` was restored to the command table, which had listed eight of the
  nine commands `.claude/skills/bs/SKILL.md` defines.
- **Corrected the epic token cap everywhere it is still asserted as fact.**
  `budgets.yml` has declared `epic.cap_tokens: 4000000` since the 2026-08-11
  operator decision, but seven live places still said 2,000,000 and alarmed at
  1.4M: `.claude/agents/planner.md` (a prompt, so the planner was being handed
  a cap half the real one), `.claude/skills/bs/SKILL.md`'s status report,
  `docs/standards/agent-constraints.md`, `docs/guide/operator-guide.md` §9,
  `docs/guide/status.md`, `docs/runbooks/providers.md`, and the README. The
  same sweep replaced "concurrency is uncapped" with what is now true —
  uncapped *by default*, with `epic.max_in_flight_tasks` present and `null`,
  and still not the thing that bounds spend. Worked examples of past dogfood
  runs keep their original numbers: they are records of what the tool printed
  at the time, and editing them would falsify the record rather than fix it.
- `docs/guide/status.md`'s caveat on prompt-level budgets now says which half
  of it is deliberate — the per-task cap reports rather than blocks on
  purpose, because a self-policed cap becomes pressure on the work being
  measured — and which half was simply a gap. That gap closed later in this
  same block: `smith wave check` refuses the wave at admission rather than
  reporting the overrun afterwards (see **Added**), and the caveat was
  rewritten a second time to say so.
- Cross-references that pointed into README sections which no longer exist
  now point at the file that owns the content: `SECURITY.md` → `INSTALL.md`
  § Known platform gaps, `INSTALL.md` → `smith --help` and the operator
  guides, `docs/guide/operator-guide.md` → `docs/guide/operator-loop.md`.
- **Biome now lints `.vue` files**, which it had been configured out of. Three
  rules stay off for `**/*.vue` and say why in `biome.json`: `noUnusedImports`,
  `noUnusedVariables` and `useVueMultiWordComponentNames` all misfire when the
  linter cannot see a template using an import. Twenty-seven components
  reformatted on the first honest run. A warning for anyone editing that file:
  it is parsed as strict JSON, and a `//` comment does not error — it silently
  invalidates the block it sits in, which is how the `overrides` array came to
  be disabled while the lint reported 112 errors and nobody read the config.
- The Kanban filter gained a `scheduler` chip; the kind existed in the data and
  not in the control.

- **`.claude/hooks/guard.sh` is a 119-line transport shim**, where it was 174
  lines of bash implementing all six rules directly. It reads the PreToolUse
  payload from stdin, hands it to `smith policy hook` unchanged, relays that
  command's decision, and inspects neither — a transport shim that cannot
  parse its own output correctly is the failure this rewrite exists to remove,
  and this one never parses anything. Its one remaining judgment call is what
  to do when the policy layer cannot answer at all — a fresh clone with no
  `dist/`, no `node` on `PATH`, a CLI that exits non-zero — and the answer is
  `ask` rather than `deny`. `deny` there is a trap rather than a safety
  property: the first command of `INSTALL.md`'s self-install runbook is
  `pnpm install`, and the remedy for a missing build (`pnpm run build`) is
  itself a `Bash` call the hook has just refused, so the factory would be
  unrepairable from inside. On no path does it emit an `allow` envelope, because
  Claude Code reads a hook's `allow` as "skip the permission system for this
  call" — it outranks the operator's own `permissions.deny` list. Its command
  in `.claude/settings.json` is now quoted, so a project directory containing
  a space still resolves.
- The documents that describe any of this were updated with it, not after it:
  `docs/standards/guardrails.md` gained a **The judge sandbox** section and a
  preamble naming where the rules now live and what `smith policy check`
  answers; `SECURITY.md`'s judge-integrity and guard-hook bullets name both
  halves of the enforcement and put a shim that fails *open* in scope;
  `INSTALL.md` says the Windows blocker is now the shim rather than the rules,
  and that an unbuilt clone escalates every `Bash` call rather than guessing;
  `docs/guide/operator-loop.md` and `.gitattributes` point at the policy layer
  rather than at the bash; and `docs/specs/agent-interviews.md` N-10 — the
  interview question that observed "judges are read-only" was a sentence and
  not a rule — carries its answer.
- **The novelty gate now corrects its threshold for how long the two
  statements are** (P9-35 (a)). A statement of *n* words has *n-s+1* shingles
  and swapping one interior word destroys *s* of them, so nothing shorter than
  twenty-nine words could score 0.8 against its own near-copy — the gate built
  to stop lessons accumulating in slightly different words was, at its
  shipped defaults, an exact-duplicate detector. Each pair is now judged at
  `(n-2s+1)/(n+1)` for the **shorter** of the two statements, which is the
  worst of the three one-word edits and therefore the bar that catches all of
  them. Measured over the real 25-statement corpus: one word substituted 16/25
  → **25/25**, inserted 19/25 → **25/25**, deleted 19/25 → **25/25**, with no
  genuine pair newly judged redundant (highest real similarity 0.0238 against
  a lowest corrected bar of 0.400). Two-word rewrites stay 0/25 — the
  correction is calibrated to exactly one edit and says so rather than
  implying more. It never *raises* an operator's threshold, and below
  `2*shingle_size+1` words it stands aside entirely, because there a near-copy
  and two unrelated statements sharing one three-word run score identically
  and `novelty-rejected` is a terminal status. The knob is
  `lessons.novelty_length_aware` in `factory/policies/scheduler.yml`,
  validated as a real boolean because YAML 1.2 reads `off` as a truthy string
  — an operator switching the correction off would have switched it on. The
  bar a verdict was taken at now travels with the match, so a rejected
  candidate is no longer reported as "scores 0.65, threshold 0.8" in the CLI
  error, the approval-time `novelty` block, or the dashboard's notice.

### Fixed

- **The guard hook loaded the entire orchestrator to answer a question about
  a command.** `.claude/hooks/guard.sh` fires on every `Bash`/`Write`/`Edit`/
  `MultiEdit`/`NotebookEdit` call an agent makes, which makes whatever it
  execs the most frequently run code in the repo. It execed
  `dist/cli.js policy hook`, and `cli.ts` is a router with 64 top-level
  imports — `db/projector.js`, and so `drizzle-orm`, among them. Loading that
  graph measured ~1.63s in front of ~39ms of actual policy work: a database
  layer loaded and thrown away once per guarded action, in front of every
  action every agent takes. The shim now execs `dist/policyHook.js`, an entry
  point whose import graph is the decision's alone, and the same payload
  through the same shim measures ~0.20s. `smith policy hook` still exists and
  behaves identically — both routes call `decideHookPayload` in the new
  `hookDecision.ts`, so there is no second copy of the decision to drift.
  `policyHookEntry.test.ts` pins both halves of that: parity with
  `cli.js policy hook` case by case, and a structural assertion that the
  hook's import graph cannot silently regain the database layer.

- **The recursive-force `rm` gate read two flag spellings out of the many
  that mean the same removal** (rule 6, `unbounded-rm`). It matched the flags
  as a literal run directly after `rm` — `r` and `f` inside one lowercase
  token, or the two long flags side by side — so `rm -Rf src`, `rm -r -f src`
  and `rm --recursive -f src` deleted trees outside `workspaces/` and
  `state/` with the gate's blessing. `-R` is POSIX's own recursive spelling,
  and bundling is a convenience rather than part of what makes the removal
  dangerous. Detection is now two halves: is `rm` invoked in this chain
  segment, and do its flag tokens carry both recursive and force — read
  across the invocation instead of out of a single token — which also reads
  flags written after the path, where a shell accepts them and the old anchor
  did not look. Eleven cases in `policy.test.ts` pin the spellings, three of
  them the ones that must stay allowed (`-r` without force, `-f` without
  recursion, a command whose name merely ends in `rm`) so the gate did not
  widen past what it names, and thirty-two verdicts were re-driven through
  the context `smith policy hook` builds. The doc bullet under **Changed**
  was written one commit earlier and described the trigger as it then stood;
  it now says both flags, however spelled.
- **A playbook told an agent to run a verb that has never existed** (D-259).
  Step 14 of `.claude/skills/bs/SKILL.md`'s run playbook — the spec-vs-goal
  check that closes an epic — named `smith dispatch audit`. The verb is
  `smith dispatch check`; typing what the playbook said produced
  `Unknown command: dispatch audit` and exit 1, in the step a session reaches
  last. The wrong name came from the CLI's own file layout: the module behind
  the verb is `dispatchAudit.ts`. `usage.ts` and `cli.ts`'s dispatcher are
  pinned to each other from both directions and both were green, because both
  are about code — nothing read the prose as a command line, so the one
  surface an agent is handed was the only one where a verb's name was checked
  against nothing. `factory/orchestrator/test/docCommands.test.ts` now reads
  it as argv: every `smith …` invocation — and every `node …/cli.js …` one,
  which is how the pre-install guide has to write them — in every backtick
  span and fenced block of every instruction file, resolved against the same
  `COMMANDS` table `--help` prints, flags included. 423 of them across 43
  files. A pipe between two words names a command family rather than a
  pipeline, escaped or not; prose brackets and trailing punctuation are
  dropped; an inline span that wraps across a line break is still one span,
  which is how a tenth of these invocations are written; fenced lines stay
  line-anchored so a command cannot swallow the next line's flags. Runtime
  state and the records of the past are excluded by shape rather than by
  name — `docs/specs/dogfood-*`, `docs/specs/evidence/`, `*punch-list.md`,
  `CHANGELOG.md`, this entry among them — so tomorrow's record drops out on
  its own while tomorrow's governing spec is in by default. The parser is
  pinned against fixtures rather than the repo, the exclusion rule is
  asserted directly rather than sampled, and a floor assertion fails if the
  scanner ever stops reading. This is the converse of D-191, and the half
  that bites harder: a verb named in no document reaches no agent, but a
  verb the document invents reaches one and then fails in its hands.
- **D-159 again, at the door P9-36 opened: the dashboard ran the lesson
  novelty gate on library defaults, not on the operator's policy file.**
  `cli.ts` closed every CLI path into that gate against
  `factory/policies/scheduler.yml` — the file `architecture` §9.3 and
  `LessonsSchedulerPolicy` both call the single source of truth. Then P9-36
  gave the UI three lesson routes onto the same `transitionLesson()`, and that
  path never got the fix: Approve and Edit scored duplicates against
  `lessons.ts`'s own constants, so lowering the threshold in the policy file
  moved the CLI and left the dashboard where it was. Latent only because the
  shipped numbers happen to equal the defaults, which is precisely the state
  D-159 named a knob wired to nothing. `createApp()` now reads the policy once
  at startup and spreads it last into every transition, so a malformed file is
  a loud failure when the server boots rather than a 500 the first operator to
  click Approve discovers, and no request body can take the gate's shape.
  Tests may inject a policy; production omits it and reads the file.
- **A drift guard that could not detect drift.** `ui/test/waivable.test.ts`
  ran two tests titled "matches factory/orchestrator/src/waivers.ts …" that
  compared the UI's copy against a literal spelled out three lines above them
  — pinning the copy to itself. Editing `WAIVABLE_SEVERITIES` in the
  orchestrator left both green, which is the one thing the copy exists to make
  loud. The guards now re-derive the lists from `waivers.ts`'s source text
  (the UI bundle still cannot import the orchestrator, and `WAIVABLE_STATUSES`
  is not exported there — reading the file is what is left), and a third test
  pins the parse itself, so a regex that quietly stops matching cannot turn
  both guards into `[] === []`. The docblock in `ui/src/lib/waivable.ts` that
  claimed the protection was real is now a description of what happens.
- **Eight cards asked to be small and eight `<div>`s got an attribute**
  (D-258). `<Card size="sm">` at eight call sites in `AnalyticsPage.vue`,
  `OverviewPage.vue` and `TaskDetailPage.vue`, where `Card.vue` declares
  `title`, `description` and `padded` and nothing else — so Vue's fallthrough
  put the literal string on the root element, `<div class="hds-card"
  size="sm">`, where no stylesheet selects on it and no `.hds-card--sm` rule
  exists to be selected. The cards had rendered at full size since the file
  was written. The attributes are deleted rather than a compact variant
  invented: the cards already look the way they look, so the diff is provably
  visual-neutral, and shipping a design decision no design pass made would be
  the worse fix (D-229's precedent). The unmet intent is recorded as a finding
  instead. Found by the gate above, on its first run; e2e had photographed the
  wrong card 135 green tests at a time, because `shoot()` writes a screenshot
  and does not compare one.
- **Three scheduler event types were invisible to all three directions of the
  P9-37 lint at once** — undeclared, apparently unemitted, and unseen on the
  timeline — with every test green. `scheduler.ts` writes
  `event_type: eventTypeFor(proposal)`, and a call expression at that position
  was deliberately ignored by every rule the scanner had. Adding Rule D made
  the first direction fail with exactly those three types; declaring them then
  made the third fire ("written and never shown"); fixing that produced the
  timeline rows above. The lint written to catch this class of bug had the
  bug's own shape as its blind spot.
- Four exported error classes that nothing ever threw — `ProjectorError`,
  `GateError`, `QuorumError`, `TestGateError` — are gone, each replaced by a
  comment saying why its module does not throw. None of the four files contains
  a single `throw`: a gate failing is a verdict, a failed command is a
  `CheckResult` carrying the exit code and the output, a provider blowing up is
  a recorded transport failure, and a record the projector cannot fold is
  logged and skipped. The classes advertised an error mode that did not exist,
  and the one-error-class-per-module convention would have kept regrowing them.
- `docs/standards/guardrails.md` § CI described a gitleaks gate on every PR
  that did not exist. It exists now (see **Added**), so the line is a
  description again rather than an intention.

- **The guard hook had been allowing everything on macOS since Phase 2, in
  silence.** Its `extract_field` used a `\|` alternation inside a *basic*
  regular expression — a GNU-sed extension that BSD/macOS `sed` (the only
  `sed` on a stock Mac) does not implement. The substitution never matched,
  `tool_name` came out as `''`, and every rule below it fell through to allow,
  on every macOS run, with no error of any kind. Eight phases of "enforced by
  a local guard hook" were, on the machine this repo was developed on,
  enforced by `.claude/settings.json`'s deny list alone. No test noticed
  because no test existed. The rules were ported rather than repaired in
  place, and `test/guardHook.test.ts` now ends with the one assertion that
  would have caught it: on no path may the shim emit an `allow` envelope.
- **A chained command could walk past the git rules.** The bash took the
  *first* segment matching a git subcommand and stopped, so
  `git push origin feat/x; git push origin master` was read as a push to
  `feat/x` and allowed. `gitSegmentsFor` returns every matching segment, and
  `checkUnboundedRm` likewise checks each segment rather than the first `rm` —
  a chain is one tool call and every command in it runs.
- Path comparisons normalise Windows separators before testing a path against
  the allowed roots, closing a gap the bash version had in the same place.
- **`git merge-base` is not `git merge`.** A regex word boundary treats a
  hyphen as a boundary, so the merge rule fired on every hyphenated plumbing
  command whose name begins with a subcommand it watches — `git merge-base`
  above all, which is read-only, cannot merge anything, and is exactly what a
  script reaches for to ask how far a branch has diverged. The bash version
  had the same hole and never fired at all; this one refused a legitimate
  command the first time it was used. A subcommand now has to be a bare word
  with no hyphen on either side, which costs no coverage on `push`, `merge`
  or `rebase` and removes a class of false deny that teaches operators to
  route around the gate rather than trust it.

### Known gaps

- **Nothing hard-stops a dispatch that is already running.** `smith wave
  check` refuses a wave *at admission* — before anything is dispatched, the
  only moment a refusal costs nothing and distorts no work in progress — but
  an admitted wave that overruns its declared cost crosses the epic cap
  anyway, and `smith budget alarm` reports that after the fact. The
  150,000-tokens-per-task cap reports rather than blocks *by design*: a
  self-policed cap becomes pressure on the work being measured.
- **The role sandbox reads command text, not intent.** It is not a container,
  a seccomp profile, or a read-only mount, so a write smuggled through an
  interpreter (`python3 -c "open(...,'w')"`) is invisible to it and always
  will be. The `Write`/`Edit` half is exact — the path is an argument, not
  prose — but the `Bash` half stays a matcher, so a tester's write scope is
  enforced precisely on the tools it normally uses and approximately on the
  shell. `smith worktree fingerprint`/`verify` stays in the pipeline behind
  it to catch after the fact what the matcher cannot see up front; neither
  half is sold as the other.
- **`smith tester check` cannot tell whether the dispatched tester wrote the
  tests.** It answers "was a tester dispatched separately, and did it report,
  before this task's tests were graded?" — nothing in the log distinguishes a
  test file the tester authored from one it merely ran. `role-write-scope`
  fences where a leased tester may write, and the two are complementary rather
  than substitutes. It is also **CLI-only and not wired into `gate run`**,
  following the `dispatch check` / `escalation check` precedent: these audits
  read the log after the fact, and the operator runs them per round. Nothing
  blocks a merge on a `violation` — the check reports, and acting on it is a
  step in the loop, not an automatic stop.
- `.vue` single-file components are still not *type*-checked. `vue-tsc` needs
  Volar, Volar needs TypeScript's classic Node compiler API, and TypeScript
  7's native port does not expose one. The contract gate above knows a prop
  exists; it does not know a `string` was passed where a `number` was
  declared. UI logic stays in `ui/src/lib/*.ts` — checked, linted and
  unit-tested — to keep what remains small.

## Phase 10 — Deployment + ops — in progress

Three items were recorded here as deferred and not specced. Two have since
landed and are described under *Unreleased*: the ops runbook
(`docs/runbooks/ops.md`) and the background process, which shipped as the
`smith daemon` watcher rather than the always-on *dispatch* daemon this entry
first named — dispatch is still skill-guided through `/bs`. The Cloudflare
port of the dashboard stays deferred and unspecced; the dashboard is
local-only today.

## Phase 9 — Hardening — 2026-08-10

- Escalation ladders counted from the event log (`smith escalation check`),
  budget alarms (`smith budget alarm`), and a same-mistake KPI
  (`smith kpi same-mistake`) — three policies that had been prose nothing
  parsed.
- The MCP surface standard: `docs/standards/mcp.md`, `smith mcp init|check`,
  hard-gated at epic close.
- Lesson approve/reject verbs and dispatch-time lesson injection, closing the
  third ungated door into the factory's memory.
- Prompt-injection fencing for ingested text (`smith prompt wrap`), a judge
  worktree-immutability guard (`smith worktree fingerprint|verify`), and
  cross-session event edges.
- Producers for the five task-status events that had none, checks that run at
  the integration root rather than only inside task worktrees, and an epic
  close that is both a logged fact and a folded projection.
- The taxonomy stopped being hand-copied into four files that had all drifted.

P9-1..P9-37, with their close-out and the deliberate leftovers, are in
`docs/specs/phase-9-punch-list.md`.

## Phase 8 — Cross-provider judges — 2026-08-05

Provider adapters (Codex CLI, DeepSeek API), quorum policy, disagreement
analytics, and shadow-mode calibration. All four `crosscheck.yml` quorum
triggers have a host: blocking-finding and same-mistake fire automatically
from the gate; `smith epic verdict` and `smith plan quorum` are
operator-invoked. Both providers shipped `enabled: false` in this phase;
they are `enabled: true` in `mode: shadow` today — see **Unreleased**, and
`docs/runbooks/providers.md` for the promotion procedure.

## Phase 7 — Self-extension — 2026-08-05

Inferred tasks with a confidence policy, the scheduler, rechecks, the lessons
compilation loop, and the `/bs` operator skill.

## Phase 6 — UI (HDS) — 2026-08-05

The local dashboard: overview, timeline, and kanban first; lessons, errors,
and analytics second. Built on an in-repo design system with token, emoji,
hardcode, and contrast gates, and a Playwright screenshot suite.

## Phase 5 — State + analytics — 2026-08-04

SQLite projections rebuilt from the append-only event log, the timeline, and
the live agent registry.

## Phase 4 — Gates — 2026-08-04

Test gate, the reviewer/verifier chain, the severity policy, and the waiver
flow.

## Phase 3 — Loop runner + worktree engine — 2026-08-04

Dispatch from task specs, path-claim validation, worktree lifecycle, the
serial merge queue, and the event log everything else is projected from.

## Phase 2 — Skeleton + contracts — 2026-08-04

Repo layout, the spec/result/finding/lesson JSON Schemas, `taxonomy.yml`, and
the agent templates.

## Phase 1 — Interview + standards — 2026-08-04

The operator interview, `docs/standards/stack.md`, the per-agent constraint
blocks, and the pinned scaffold.

## Dogfooding

Running Blacksmith on Blacksmith produced most of what the gates and
policies now enforce. Those defect logs are kept in `docs/specs/`
(`dogfood-4-findings.md`, `dogfood-envkit-findings.md`,
`phase-9-punch-list.md`) and are referenced by id (D-###, P9-##) from commit
messages throughout this history.
