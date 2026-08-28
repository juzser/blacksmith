# Extending Blacksmith

Contributor guide: how to add an agent template, change the taxonomy, add a
policy, and what invariants `scripts/check.sh` enforces so a docs/code
mismatch fails CI instead of drifting silently.

## Add an agent template

Templates live at `.claude/agents/<role>.md` — Claude Code subagent
format (YAML frontmatter + body-as-system-prompt). There are 12 today:
`planner`, `spec-reviewer`, `researcher`, `coder`, `tester`, `grader`,
`reviewer`, `verifier`, `security-reviewer`, `merger`, `scribe`, `uiux`.

To add one:

1. **Write the file** `.claude/agents/<role>.md` with required
   frontmatter fields `name`, `description`, `model`, `tools` (plus
   `maxTurns`, conventionally). `description` should say what the role does
   *and* when to dispatch it — it's the routing signal, not just a label.
2. **Add `<role>` to the taxonomy's `agent` dimension**
   (`factory/policies/taxonomy.yml`) — `scripts/check.sh` diffs the set of
   template filenames against `taxonomy.yml`'s `agent` list and fails on
   any mismatch in either direction (missing template for a taxonomy value,
   or a template with no taxonomy value).
3. **Mirror architecture.md §8** — the taxonomy file's own header says it
   plainly: "if they diverge, that is a bug — fix both in the same PR." Add
   the role to the `agent:` line in §8 of
   `docs/specs/black-smith-architecture.md` and to §4's model-tiering table
   if it belongs to an existing tier (or add a new tier row).
4. **`check.sh`'s contract**, which every template must satisfy:
   - starts with `---`, has a well-formed frontmatter block;
   - `name`, `description`, `model`, `tools` all present and non-empty;
   - the set of `.claude/agents/*.md` basenames equals `taxonomy.yml`'s
     `agent` dimension exactly (Section "Agent templates: frontmatter" in
     `scripts/check.sh`).

Run `bash scripts/check.sh` before opening a PR — it catches all of the
above mechanically; don't rely on review to catch a taxonomy/template
mismatch.

## Change the taxonomy

`factory/policies/taxonomy.yml` is a closed, versioned, multi-dimension
controlled vocabulary (architecture §8). The event logger rejects unknown
tags at write time, which is the point — analytics stay aggregatable across
months of runs only if the vocabulary never silently drifts.

- **Changing the taxonomy is a PR that bumps `version`** — never a runtime
  write, never a value added ad hoc by an agent.
- **§8 mirror.** `taxonomy.yml`'s header states it mirrors
  `docs/specs/black-smith-architecture.md` §8 value-for-value; update both
  files in the same PR. `scripts/check.sh`'s x-taxonomy check partially
  guards this (every `x-taxonomy` annotation in `factory/specs/schema/*.json`
  must name a real dimension in `taxonomy.yml`), but it does not diff §8's
  prose against the YAML — that half is a manual review discipline, so call
  it out explicitly in the PR description.
- **Deprecate-only rule.** A value is never deleted or renamed in place —
  mark it deprecated in the YAML with a `superseded_by` pointer so old
  events stay queryable. Renames are supersessions, recorded, not silent
  edits (`taxonomy.yml` rules section, `renames_are_supersessions: true`).
- **One value per dimension.** A record needing two values is two records
  or a wrongly-cut dimension — fix the taxonomy by PR, don't overload a tag
  with a compound value.
- **Required-dimensions table.** `taxonomy.yml`'s `rules.required_dimensions`
  declares which dimensions each record type (`task`, `dispatch`, `error`,
  `finding`, `lesson`, `edge`) must carry. If you add a dimension that a
  record type now requires, update this table too — `taxonomy.ts`'s
  `validateRequiredDimensions` reads it directly.

## Add a policy

Policies live at `factory/policies/*.yml` (`budgets.yml`, `severity.yml`,
`worktree.yml`, `crosscheck.yml`; `lessons.md` is generated, not
hand-authored). To add a new one:

1. Write the YAML with a header comment stating which architecture section
   it implements — every existing policy does this, and it's how a reader
   traces "why does this number exist" back to the spec.
2. `scripts/check.sh`'s YAML section (`-- YAML: factory/policies/*.yml --`)
   parses every file under `factory/policies/*.yml` automatically — no
   registration step needed beyond dropping the file in place.
3. If the policy introduces new taxonomy-valued fields, those need
   `x-taxonomy` annotations wherever they appear in a JSON Schema (not the
   YAML itself — the YAML's values are read and validated in code, e.g.
   `severity.ts` reading `severity.yml`).
4. Reference the new policy from `AGENTS.md`'s "Policies" row and from
   `docs/README.md`'s policy table so it's discoverable.

## Docs-mirror invariants

Two invariants `scripts/check.sh` enforces mechanically, and one it does
not (own it in review):

| Invariant | Enforced by |
|---|---|
| `taxonomy.yml`'s `agent` dimension == `.claude/agents/*.md` basenames | `scripts/check.sh` "Agent templates: frontmatter" section |
| Every `x-taxonomy` value in `factory/specs/schema/*.json` names a real `taxonomy.yml` dimension | `scripts/check.sh` "x-taxonomy dimensions referenced in schemas exist in taxonomy.yml" section |
| `taxonomy.yml` mirrors architecture.md §8 prose value-for-value | **Not mechanically checked** — a manual review item on every taxonomy PR |

## Event log vs. projections: source of truth vs. derived

`state/events/*.jsonl` (append-only NDJSON) is the **durable execution
substrate** (architecture §7) — every record is `{ts, session_id, actor,
event_type, task_id?, agent_id?, plan_version, causal_parent, payload}`, and
the invariant is: any component can crash and be reconstructed from the log
alone. `events.ts` enforces this at write time — every `causal_parent` must
reference a real prior event in the same session log (except `session-start`,
which may be `null`, or may name an event in **another** session so one epic
can span several operator sessions — P9-7), and every event
validates against `event.schema.json` + its taxonomy dimensions before it's
appended.

`state/smith.db` (SQLite, shipped in Phase 5) is a **projection**: rebuilt
from the event log for fast UI/CLI queries (`sessions`, `tasks`, `edges`,
`errors`, `lessons`, `reviews`, `waivers`, `artifacts`, `milestones`). It is
derived state, never the source of truth — if the DB and the log ever
disagree, the log wins and the DB gets rebuilt (`smith db rebuild`). Never
write application logic that trusts the DB over the log; the DB exists purely
so a dashboard query doesn't have to fold the entire NDJSON history on every
page load.

## Test conventions

- **TDD is mandatory.** A failing test exists before the implementation
  that makes it pass — this repo's own `coder` template constraint
  (`agent-constraints.md`: "TDD: strict for logic... gate-enforced") is the
  standard for `factory/orchestrator/` itself too. `vitest.config.ts`'s
  `include` only picks up `factory/orchestrator/test/**/*.test.ts`, so a
  new module without a paired test file is invisible to the coverage gate
  entirely — don't rely on that; write the test file first regardless.
- **Coverage floors.** `vitest.config.ts` sets an 80% threshold on lines,
  statements, functions, and branches over `factory/orchestrator/src/**/*.ts`
  (excluding `cli.ts` and `types/**` — the CLI router is thin argv-wiring,
  covered by `test/cli.test.ts`'s integration-style tests instead of unit
  coverage). This mirrors `agent-constraints.md`'s "80% floor on claimed
  logic paths" for target-repo code the coder produces.
- **Tests that spawn the CLI are slow, and that is not a bug to patch
  locally.** `cli.test.ts` and `guardHook.test.ts` drive the built binary
  through `spawnSync`, and one `node dist/cli.js` boot costs ~1.4s of module
  loading before the command runs. A test with a dozen spawns spends ~17s on
  node startup with nothing wrong. `vitest.config.ts` sets `testTimeout` and
  `hookTimeout` globally to absorb this — deliberately loose, because the
  budget is a hang-detector and not an assertion about speed. **Do not add a
  per-test timeout argument** (`}, 20_000)`); the suite carried twenty-six of
  those, each a local patch for one global misconfiguration, and they were
  removed when the global budget was set. If a test genuinely needs longer than
  the global, the spawn count is the thing to question.
- **Mutation-probe habit.** A green test suite proves nothing about a test
  that never actually exercises the failure path — after writing a test,
  break the implementation on purpose once (invert a condition, return the
  wrong value) and confirm the test goes red before you trust it goes
  green for the right reason. This isn't automated in the repo today (no
  mutation-testing tool is wired into `scripts/check.sh`); treat it as a
  manual discipline until one is.
- **Fixture hygiene.** Tests that touch the filesystem or git use
  `mkdtemp`/`tmpdir()` and clean up in `afterEach` (see `test/plan.test.ts`,
  `test/worktree.test.ts`) — never operate on the real `state/` or
  `workspaces/` trees from a unit test; those are gitignored runtime
  directories, not fixtures.
