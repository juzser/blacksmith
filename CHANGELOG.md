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
  `factory/orchestrator/test/policy.test.ts` (68), `test/sandbox.test.ts`
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

### Changed

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

### Fixed

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

### Known gaps

- **Nothing hard-stops a dispatch that is already running.** `smith wave
  check` refuses a wave *at admission* — before anything is dispatched, the
  only moment a refusal costs nothing and distorts no work in progress — but
  an admitted wave that overruns its declared cost crosses the epic cap
  anyway, and `smith budget alarm` reports that after the fact. The
  150,000-tokens-per-task cap reports rather than blocks *by design*: a
  self-policed cap becomes pressure on the work being measured.
- **The judge sandbox reads command text, not intent.** It is not a container,
  a seccomp profile, or a read-only mount, so a write smuggled through an
  interpreter (`python3 -c "open(...,'w')"`) is invisible to it and always
  will be. `smith worktree fingerprint`/`verify` stays in the pipeline behind
  it to catch after the fact what the matcher cannot see up front; neither
  half is sold as the other.
- `.vue` single-file components are neither type-checked nor fully linted.
  `vue-tsc` needs Volar, Volar needs TypeScript's classic Node compiler API,
  and TypeScript 7's native port does not expose one. UI logic lives in
  `ui/src/lib/*.ts` — checked, linted and unit-tested — to keep the hole small.

## Phase 10 — Deployment + ops — planned

Recorded as deferred, not specced: runbooks beyond
`docs/runbooks/providers.md`, the Cloudflare port of the dashboard (local-only
today), and an always-on dispatch daemon (dispatch is still skill-guided
through `/bs`).

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
