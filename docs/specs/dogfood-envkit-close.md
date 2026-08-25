# Dogfood close-out — `envkit-config-loader`

The first epic driven end to end through the factory on a real project. This
is the closing report: what shipped, what is verified, what is carried
forward, and what the run cost the factory in credibility.

Companion documents: `docs/specs/dogfood-envkit-findings.md` (D-14…D-48, the
evidence) and `docs/specs/phase-9-punch-list.md` (P9-8…P9-30, the work).

This line read "D-0…D-47" until Phase 9's close-out checked it. The findings
file has started at D-14 since its first commit (42811af); nine ids below it —
D-1, D-3, D-4, D-6, D-7, D-9, D-10, D-11, D-12 — are cited across the punch
list, the operator guide and the test suite, and no document in the repo
defines them. See that close-out's "What this phase does
not prove" for the gap; the citations are left in place rather than renumbered,
because renaming an id nobody can look up does not make it findable.

## What shipped

`envkit`, a zero-dependency `.env` configuration loader, in
`workspaces/envkit` on `smith/envkit-config-loader/integration` at `8962df9`.
Five plan tasks plus toolchain, all merged through the serial queue:

| task | branch head | what it added |
|---|---|---|
| `task-0-toolchain` | `2c4f9be` | scaffold, biome, tsc, vitest |
| `task-1a-parse-core` | `87c4a4b` | `src/parse.ts` — unquoted lines, comments, `export` prefix |
| `task-1b-parse-quotes` | `38c125f` | quoting layer: single/double, escapes, multiline |
| `task-2-coerce` | `7de9ee9` | `src/coerce.ts` — number, boolean, string[] |
| `task-3-validate` | `f862c68` | `src/validate.ts` — required, defaults, unknown keys |
| `task-4-api` | `70a5594` | `src/index.ts` — `loadConfig` public API |

## Verified state of the integration branch

Run in-session at the integration root, not reported by an agent:

| check | exit | note |
|---|---|---|
| `typecheck` | 0 | |
| `test` | 0 | 4 files, 159 tests |
| `build` | 0 | |
| `lint` | **1** | not a code defect — see D-42 |

The lint failure is the factory's worktree layout, not the merged code:
`biome check .` from the integration root discovers the six task worktrees
nested beneath it, each carrying its own `biome.json`, and refuses on nested
root configs. Move `wt/` aside and the identical command reports `Checked 10
files in 55ms`, exit 0. `wt/` is untracked, so a fresh clone and CI are
unaffected.

## How it closed

By hand, because the factory could not close it.

`smith epic verdict --epic envkit-config-loader` returns `hold` /
`mechanical-blockers`, reporting `nonTerminalTaskCount: 1` and
`openFindings: []` for an epic in which five tasks merged green. Four of the
five are absent from its view entirely: the plan declares qualified task ids
(`envkit-config-loader/task-4-api`), every execution was recorded under a bare
one (`task-4-api`), and the verdict folds only the qualified side. This is
D-28 — predicted before the run, and confirmed by it.

The close was made by hand rather than by fixing D-28 mid-run, because the fix
is a schema-boundary decision plus a migration for the existing log. That is
Phase 9 work, and patching it at the end of the run it was meant to measure
would have destroyed the measurement.

Recording the close required hand-writing an `epic-closed` event — the same
hand-assembly P9-1 objects to for lessons. The operator appended it on
2026-08-07 as **`dogfood-envkit-1#69`**; the record is committed at
`docs/specs/dogfood-envkit-close-event.json`.

**And that append taught us the fix is bigger than the verb (D-44).** The event
is in the log and in `eventsRaw`, but `db/projector.ts`'s task-status switch
knows seven event types and ends in `default: break;`. `epic-closed` falls
through it. The epic is closed in the log and open in the kanban, in `stats`,
and in the UI — the surfaces a human actually reads. P9-27 therefore needs a
projector case, not just an emitter.

## Carried forward

Two real defects ship with this branch. Neither is hidden, and neither has a
home in factory state — which is the point.

**`src/parse.ts` — bare CR is not a line separator (S2-major, D-41).**
`parse.ts:119` splits on `/\r\n|\n/`, so `loadConfig('A=legit\rB=zzz')`
returns `ok: true` with zero issues, `A` holding the swallowed text, and `B`
silently falling back to its schema default. Reproduced independently, not
taken on the reviewer's word. It is unfixed because the security reviewer
raised it while gating `task-4-api`, whose claims pin it to `src/index.ts` and
`test/index.test.ts`, and `intakeAndDecide` applies no claims-scoping — so
filing it against that task would have blocked a correct diff on a defect it
was forbidden to touch, and bounced it to a coder with no legal remedy. It
survives in a markdown file because a human put it there.

> **Fixed 2026-08-07** (branch `smith/phase-9/d41-bare-cr`, envkit commit
> `8c37519`). Not hand-patched: once P9-24 landed, the finding was raised
> through `smith findings raise` against the plan, which resolved the owner
> from `src/parse.ts`, reported the task-1a/task-1b tie instead of guessing,
> opened follow-up `envkit-config-loader/followup-4b70d608`, and held the epic
> verdict on it — so the paragraph above stopped being true before the split
> was changed. `parse.ts:119` now splits on `/\r\n|\r|\n/`; six tests written
> red first, 166/166 green. Doing it this way also exposed D-48: the follow-up
> can be minted but not advanced. See D-41 and D-48 in
> `dogfood-envkit-findings.md`.

**`worktree.ts:98` — worktrees nested inside the project root (D-42).** Local
only; described above.

> **Fixed 2026-08-07** (P9-26, branch `smith/phase-9/p9-26-integration-root`).
> Worktrees now live at `workspaces/.wt/<project>/<task-id>`, a sibling of the
> project rather than a child, and `smith integration check` runs the suite at
> the integration root.

## What the run actually demonstrated

The pipeline works. Six tasks were planned, dispatched, graded, reviewed,
gated and merged without a single bad merge, and the gates caught real
problems — including a trap criterion in `task-4-api` that a coder would
plausibly have failed.

The failures were not in the stages. They were in the seams:

- **The board is hand-written** (D-46, P9-29 — the largest finding, and it
  demotes several others to symptoms). Of the seven event types the projector
  folds into task status, only two have a producer anywhere in the
  orchestrator. `task-added`, `wave-admitted`, `wave-merged`,
  `task-superseded` and `error-logged` are emitted by nothing; every one in
  this log was typed by a human. The cost is measurable: after a clean rebuild
  of all 70 events, the `tasks` table shows four of six merged tasks
  completed, two stuck at `merging`, and one phantom row still `ready`. D-28's
  "two divergent id conventions" is really the absence of any producer to have
  a convention.
- **Two structural deadlocks, independent of each other.** D-41 stops a
  finding from reaching a task; D-28 stops the tasks from reaching a verdict.
  Both were reachable by an epic doing everything right.
- **Green gates that certify nothing about the assembled result** (D-42,
  P9-26). Every check the factory runs executes inside a task worktree.
  Nothing has ever run at the integration root. Every quality claim in an epic
  verdict today is a claim about a worktree.
- **Evidence that omits its own subject** (D-40). A coverage criterion named a
  file the attached report did not show, because the reporter suppresses rows
  for fully-covered files. The gate was right and its evidence was misleading,
  which cost a full investigation to conclude that nothing was wrong.
- **Silence read as success** (D-31, P9-11). A judge returned its own planning
  prose instead of a verdict, twice in one epic, the second time despite a
  prompt that explicitly named the failure. A text-consuming factory would
  have accepted it. Recovery was six for six via transcript resume, but the
  rule that matters is the cheap one: completion is *the artifact exists and
  parses*, never *the agent said something*.
- **A crash reported as a failed assertion** (D-47, P9-30), found in this
  branch's own pre-push checks. Under Node 20 the suite showed three
  `expected 1 to be +0` failures; the real event was `better-sqlite3`'s NAPI-10
  prebuild segfaulting on a NAPI-9 runtime, exit 139, both streams empty.
  `runCli` does `e.status ?? 1`, and `execFileSync` reports a signalled child
  as `status: null`, so SIGSEGV and a clean exit 1 are the same value to every
  assertion in the file. `engines: node >=22` is declared and enforced by
  nothing. The false diagnosis it produced — including a stash-and-rerun that
  "confirmed" the failures were pre-existing, correctly, and uselessly, because
  both runs used the same broken interpreter — is recorded in full, because the
  misdiagnosis is the finding. Under Node 22 the suite is 434/434, exit 0.
- **The decisive moment is the unlogged one** (D-43, D-44). Both terminal
  outcomes of `epic verdict` emit no event in the default configuration. The
  only verdict that gets recorded is the one that spent money on external
  judges. Appending the close by hand then showed the second half: the
  projector has no case for `epic-closed`, so even a logged close does not
  reach any surface a human reads.

Every item above cites a command run in this session. None was inferred from
reading the code.
