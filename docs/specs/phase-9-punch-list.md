# Phase 9 punch list

Work that Phase 8's close-out and the two exercises after it identified but
deliberately did **not** build. Each item names its evidence and what "done"
looks like, so Phase 9 planning starts from a spec rather than from memory.

Roadmap entry: `factory/specs/roadmap.md` § Phase 9 — Hardening.
Closing report: § "Phase 9 close-out" at the end of this file — what was
closed, what was deliberately left, and what the phase does not prove.

Three sources, and they found different things.

**P9-1…P9-7 come from the subagent interviews** (`docs/specs/agent-interviews.md`)
and share a shape: the *rule* already exists in a template or a policy file, and
**no code enforces it**. A rule an agent can break without anything noticing is
a rule that holds exactly as long as the model happens to cooperate.

**P9-8…P9-30 come from running a real epic end to end** through the factory
(`docs/specs/dogfood-envkit-findings.md`). Those are mostly a second shape: not
an unenforced rule but a stage that runs, returns success, and is wrong —
because two stages disagree about what "the work" is, or because a producer for
an event the system already reads was never written. Nothing in that half was
inferred; every item cites a command run in the session.

**P9-31…P9-37 come from fixing the list**, which is a third shape and the one
worth watching for. P9-31 is the pure case: two items that each landed correct
and green, and broke against each other the first time anything used both. The
six after it are its variants — a rule the goal line asserted that nothing
parsed (P9-32), a policy knob with no reader (P9-33), a KPI with no instrument
and a gate with no entry point (P9-34/P9-35), a door the CLI closed and the UI
left open (P9-36), and a vocabulary copied by hand into four files that had all
drifted apart (P9-37). This source only exists because the phase was written
down; a phase driven from memory produces the same defects and no entries for
them. It cites commands too.

## P9-1 — `smith lessons approve|reject <lesson-id>`

**Evidence:** agent-interviews.md N-9. The operator approval gate is real
policy (architecture §9.4, the memory-poisoning boundary) but has no verb: the
`/bs lessons` playbook tells the operator to hand-write a
`lesson-status-changed` event with `to_status: approved`, envelope flags and
all. A hand-built event is a typo away from an unparseable transition, and the
one path where a *wrong* lesson enters every future prompt is the worst place
to leave hand-assembly.

**Done looks like:** `smith lessons approve <lesson-id>` and
`smith lessons reject <lesson-id>` emit the transition themselves, refuse a
transition the `lesson_status` taxonomy does not allow, and take `--actor
operator` — with `reject` mapping to `invalidated`, the status the UI's reject
route already uses (`ui/server/src/app.ts`). `--note` folds in the
`lesson-edited` payload so "edit then approve" is one call.

**Status: fixed, 2026-08-07, branch `smith/phase-9/p9-1-lessons-approve`** —
`transitionLesson()` in `lessons.ts` mirrors `findings.ts`'s `transition()`:
fold the log for the one lesson, refuse what `LEGAL_LESSON_TRANSITIONS` does
not allow, then append. `smith lessons approve|reject <lesson-id>` are the same
verb with the destination fixed (`approved` / `invalidated`). **6** unit tests
and **1** CLI test cover it; the dream→compile end-to-end no longer
hand-assembles an approval envelope, which is the change this item was
actually about.

Two decisions worth recording. **`invalidated`, `novelty-rejected` and
`superseded` are terminal.** The taxonomy says which statuses exist and
`appendEvent` already refuses one outside it; what neither can say is which
follows which, and the one that matters here is that a lesson the operator
threw out cannot quietly come back — reviving it means raising it again with
its own provenance, not rewriting the decision. `novelty-rejected` is terminal
too, even though `dream()` writes it automatically: the recourse for a wrongly
auto-rejected near-duplicate is to approve the lesson it duplicated, which says
the same thing.

**The edit rides on its own flags, not on `--note`.** This item's wording put
the `lesson-edited` payload behind `--note`; a flag named `--note` silently
replacing a lesson's *statement* is a data-loss footgun, so `--statement`,
`--lesson-type` and `--lesson-scope` carry the edit (the shape ui/server's edit
route already writes, and the way an operator fixes a scope `dream()` guessed
mechanically), while `--note` records the rationale as `operator_note` on the
status change — the field waivers already use. Taxonomy tags on the edit are
validated *before* either event is written, as `lessons.invalid-lesson-tag`
(the code `ui/server`'s `errorStatus` already maps to 400 and nothing raised
until now), so a bad `--lesson-scope` can never leave a half-applied
transition.

Not done here, and deliberately (**closed later by P9-36**):
**`ui/server`'s approve/reject/edit routes still call `appendEvent`
directly**, so the state machine guards the CLI only.
Wiring them up changes UI behaviour no item has asked for — a double-approve
would become a 409 — and the fixture the UI tests run against
(`test/db/fixtures.ts`) approves `lesson-1` before any request is made, so it
would have to change too. The exposure is small: the Lessons page only offers
approve/reject on lessons the pending query returns, so reaching an illegal
transition means hand-crafting an API call. Worth its own item, not a silent
rider on this one.

## P9-2 — Dispatch-time lesson injection

**Evidence:** agent-interviews.md N-9. Every template carries a
`<!-- LESSONS:<scope> -->` marker; `lessonsForScope()` is implemented and
tested (`lessons.ts`, `lessons.test.ts`) and has **zero** production callers.
So the loop punishes a repeated mistake (`gate run --lessons` →
`severity.ts`'s same-mistake escalation) but never *prevents* one, because no
lesson text reaches an agent before it works. That is the half the factory's
premise rests on.

**Done looks like:** at dispatch, the compiled `factory/policies/lessons.md`
is read, filtered to the role's scope, and spliced into the prompt — approved
lessons only, never a candidate. The decision is recorded: splice at dispatch,
flat topology, one host; the markers become documentation of where the text
lands rather than a render directive.

**Status: fixed, 2026-08-07, branch `smith/phase-9/p9-2-dispatch-lessons`** —
`lessonsForDispatch(role, claimPaths)` in `lessons.ts` reads
`factory/policies/lessons.md` (and nothing else, so "approved only" is true by
construction, not by a check), filters it through the existing
`lessonsForScope()`, and returns the block already rendered. `smith lessons
for-dispatch <role> [--plan … --task …]` is the verb, and the `/bs` skill's
dispatch contract now splices its `text` into every prompt it composes.
**15** unit tests, **3** severity tests and **2** CLI tests cover it.

Three decisions worth recording. **The role→scope mapping is read from the
templates' own `<!-- LESSONS:<scope> -->` markers**, not from a table in code:
a table drifts the first time someone edits a template, and the drift is
invisible — the block just comes back missing a scope. A test walks every
shipped `.claude/agents/*.md` and fails if one carries no valid marker.

**Flat topology, one host, spliced once.** The markers sit at different depths
in different templates, and rendering per-marker would mean the orchestrator
editing a role template at dispatch time — a second writer to a file the
operator owns. So the marker documents *where the text belongs*, the splice
happens once in the composed prompt, and the templates stay static. The block
is delimited (`<!-- BEGIN/END COMPILED LESSONS -->`), every statement is
flattened to one line with `<!--`/`-->` escaped, and the header says the
contents are data rather than instructions — the same injection boundary the
compile side already enforces. It renders even with zero matches, because
"matched nothing" and "never ran" must not look alike.

**The parser had to stop dropping category-less lessons**, and that was a real
hole, not a refactor. `finding_category` is optional per
`lesson.schema.json`, `smith dream` never sets one, and every `agent-role` /
`case-type` lesson lacks one — yet `parseLessons` required it, so those
entries compiled into `lessons.md` and then parsed back out to nothing. The
CLI end-to-end caught it: a dreamed → approved → compiled lesson came back
from `for-dispatch` as an empty list. `parseLessons` now keeps them with
`category: ''`, and `findMatchingLesson` skips an empty category explicitly,
so same-mistake escalation matches exactly what it matched before — an empty
category is never a wildcard.

## P9-3 — Split `postRunCheck` into collector + classifier

**Evidence:** agent-interviews.md N-11 discussion. `postRunCheck`
(`factory/orchestrator/src/claims.ts`, `smith claims check`) both collects the
changed-file set and classifies it against a task's claims. Only agents that
work inside a worktree have claims, so the two agents that write outside one —
planner (`factory/specs/active/<epic-id>/**`) and scribe (`state/lessons/**`)
— have no host at all: their write roots exist as a sentence in a template and
nothing else.

The coupling is concrete, not stylistic: `postRunCheck` derives the epic's
integration branch from the branch *name* and throws
`claims.cannot-derive-integration-branch` on anything that is not
`smith/<epic>/<task-id>`, then collects with `git diff --name-only
<integration>...HEAD`. Neither half survives outside a task worktree — the
planner and scribe write on an ordinary branch, and their output is uncommitted
when you want to look at it.

**Done looks like:** two collectors behind one classifier — the existing
committed-diff collector, plus a working-tree one (`git status --porcelain` at
a given root) — so a *write-root* check can reuse the matching logic without
inventing claims for a role that has none, and without the branch-name
convention. Then `smith claims check --roots <glob>...` covers planner and
scribe. Until this lands, the `/bs` dispatch contract carries the interim
rule: the operator session eyeballs `git status --porcelain` after either role
returns.

**Status: fixed, 2026-08-07, branch `smith/phase-9/p9-3-write-roots`**

`claims.ts` now exposes `classifyChanges(files, patterns, code?)` — the whole
matching half, and it knows nothing about git — plus two collectors:
`collectCommittedChanges` (the old branch-name derivation and
`git diff <integration>...HEAD`, unchanged) and `collectWorkingTreeChanges`
(`git status --porcelain=v1 -z --untracked-files=all`, no branch convention).
`postRunCheck` and the new `writeRootCheck` are three-line compositions.
`smith claims check <root-dir> --roots '<glob>' [--roots '<glob>'…] [--since
<ref>]` is the write-root mode; without `--roots` the spec-file form is
byte-identical to before.

Decisions worth recording:

**A rename reports both paths.** `git status -z` emits `R  <new>\0<old>\0`, and
the collector consumes that second field instead of skipping it. Moving a file
*out* of a write root is the interesting half of a rename, and reporting only
the destination hides it. `-z` for the same class of reason: the default
porcelain format quotes and backslash-escapes paths with spaces, and a quoted
path silently fails to match a glob it should have matched.
`--untracked-files=all` because a role's first write is usually a new file, and
`normal` mode collapses a whole new directory into one entry.

**`--since` exists because the planner holds `Bash`.** The default window is
the working tree, which is where the planner and scribe leave their output —
the operator commits, not them. But a planner that ran `git commit` itself
leaves a clean tree, and a working-tree-only check would call that a pass. The
base ref is operator-supplied (`git rev-parse HEAD` before the dispatch) rather
than derived, because deriving it would reintroduce the branch-name coupling
this item exists to remove. An unresolvable ref raises
`claims.cannot-resolve-since-ref` rather than reporting an empty diff.

**Repeated flags accumulate; commas do not split.** `parseArgs` gained
`repeated: Record<string, string[]>` alongside `flags`, which keeps last-wins
for the ~40 existing single-valued readers. Comma-splitting was the other
option and is wrong: `src/{a,b}/**` is one glob containing a comma, and
splitting it corrupts the pattern.

**An empty pattern list matches nothing.** `classifyChanges(files, [])` puts
every change out of bounds rather than passing everything through — a role with
no declared write root is one that should not be writing. The two violation
codes (`contract.claim-violation`, `contract.write-root-violation`) stay
distinct because the recourse differs: one bounces a task diff, the other is a
config change nobody reviewed.

## P9-4 — Mechanical host for `factory/policies/sensitive-paths.yml`

**Evidence:** agent-interviews.md N-7. The file exists and records the
security-reviewer's three dispatch triggers, but nothing reads it —
today's only consumer is a human-or-model reading of the `/bs` dispatch
contract. A trigger that fires only when the orchestrator remembers to check
is not a trigger.

**Dogfood evidence (D-25, S2):** the globs themselves are wrong, independently
of having no host. Every non-trivial pattern in the file is directory-only:
`**/parse*/**` requires `parse` to be a *directory* with something under it, so
it never matches `src/parse.ts`; `*parser*`, `*auth*`, `*login*` and
`*session*` match a path segment with no slash on either side, so a file named
`parse.ts` or `auth.ts` is missed; `**/*.lock` misses `pnpm-lock.yaml`, the
lockfile every JS project actually has. Measured against the six tasks of a
real epic: one fired, and it was the wrong one — `package.json` matched
`**/package.json` under supply-chain, while the three tasks that parse
untrusted `.env` text (`src/parse.ts`, `src/validate.ts`) fired nothing. A
security-reviewer ran on all of them only because the operator dispatched by
judgement.

**Done looks like:** a verb (`smith security triggers --task <spec>`, or a
flag on `wave check`) that matches a task's `claims[]` against the file's
globs and returns the fired triggers. Match semantics are **overlap**, not
containment — a task claiming `src/**` must fire against `src/auth/**` — and
that is the part worth a test, since the naive `startsWith` reading gets it
backwards. The glob rewrite (`**/*parse*`, `**/*.lock`, `**/*lock*.{yaml,json}`
alongside the directory forms) ships with the host, and its test fixture is the
envkit claim set, where the current file scores one for six.

**Status: fixed, 2026-08-07, branch `smith/phase-9/p9-4-security-triggers`**

`smith security triggers --task <spec.json>` reads the policy and returns
`{ taskId, dispatchSecurityReviewer, triggers[] }`, each trigger naming the
claim and the glob that fired it. `factory/orchestrator/src/security.ts` holds
the parse/load pair and the matcher; the yml's globs were rewritten alongside
it. Measured on the envkit fixture the file now scores four for six — the two
parse tasks, the validate task and the toolchain task (for `pnpm-lock.yaml`,
not only `package.json`) — and does not fire on `src/coerce.ts` or
`src/index.ts`. Both `/bs`'s dispatch contract and the `/bs run` step now run
the verb instead of describing the file.

Decisions worth recording:

- **The overlap matcher is security-local, and `globsOverlap` was left alone.**
  `claims.ts`'s `couldJointlyMatch` only ever synthesizes a *tail*, so
  `globsOverlap('src/**', '**/auth/**')` is false — it probes
  `src/__smith_probe__` and `__smith_probe__`, neither of which satisfies both
  sides. Policy globs are nearly all `**/<literal>/**`, so that gap is the
  common case here, not an edge one. `security.ts` adds
  `sharesSynthesizedPath`, which substitutes the claim's static base for the
  glob's `**` (`src/**` + `**/auth/**` → `src/auth/__smith_probe__`) and
  requires the candidate to satisfy both patterns. It stays local because
  `globsOverlap` drives wave serialization, where a wider answer costs
  concurrency on every epic; here a wider answer costs one extra review.
- **Exclusions are containment, on purpose.** If they were overlap,
  `**/*.test.ts` would silence `src/**` and every broadly scoped task could
  dodge the review by claiming a tree that happens to hold a test file. The
  asymmetry with the glob list is deliberate and is stated in both the code and
  the yml.
- **`dot: true` everywhere.** picomatch hides dotfiles from `*` and `**` by
  default, so `**/*.env*` would never have matched a bare `.env` and
  `**/.github/workflows/**` would have been invisible to a `**` claim. Two
  fixture rows exist only to keep that from regressing.
- **One trigger per claim.** The glob is evidence that a claim is sensitive,
  not an enumeration of every glob it could match, so results stay short and
  deterministic.
- **Exit 0 whether or not a trigger fires.** Unlike `claims check` and
  `wave check`, firing is a dispatch instruction rather than a violation; the
  answer is `dispatchSecurityReviewer`, not `$?`.
- **`other_triggers.epic_cases` → `cases`, matched against the task spec's own
  `case`.** Nothing in `task-spec.schema.json`, `epic.ts` or `db/schema.ts`
  carries an epic-level case or tag, so the honest source is the task. The
  parser still reads the old spelling, and `--epic-tag`/`--recheck` stay
  operator-asserted until the schema has somewhere to put them.
- **`**/package.json` is kept whole**, so every dependency bump fires. It is a
  supply-chain event and the host reads claims, not diffs; narrowing it needs a
  consumer that can tell a bump from a script rename.

**Follow-up: D-176, 2026-08-19.** The matcher covered the directory axis
only. A claim narrowed by *extension* — `ui/src/**/*.tsx`, `server/**/*.py` —
fired nothing in the entire policy: the synthesized filename was always the
probe and never the claim's own tail, and `synthesizeLiteralSegment` collapses
the yml's nine-language brace sets to `ts`. Both sides propose a filename now.
See `docs/specs/dogfood-4-findings.md` § D-176.

## P9-5 — Judge worktree-immutability guard

**Evidence:** agent-interviews.md N-10. Six roles (reviewer, verifier, grader,
spec-reviewer, security-reviewer, uiux) are described as read-only but hold
`Bash`, which writes files as easily as it runs a test suite. The templates
now say so explicitly and spell out the prohibition, but the guarantee is a
sentence in a prompt.

**Done looks like:** the dispatcher records the worktree's `git status`
fingerprint before a judge runs and compares after, failing the judge's result
when the tree moved. Cheap, mechanical, and it turns "the judge did not edit
the code it was judging" from a hope into a check.

**Status: fixed, 2026-08-08, branch `smith/phase-9/p9-5-judge-immutability`**

`smith worktree fingerprint <dir>` prints `{ head, branch, entries }`;
`smith worktree verify <dir> --before <fingerprint.json>` prints
`{ unchanged, drift[], violation }` and exits 1 when the tree moved.
`factory/orchestrator/src/immutability.ts` holds both, `drift[]` names each
path with a kind (`head-moved`, `branch-switched`, `dirtied`, `reverted`,
`modified`), and the violation is `contract.judge-mutation`. `/bs` now brackets
every judge dispatch in steps 5–7 with the pair, and the six judge templates
say the prohibition is checked rather than trusted.

Decisions worth recording:

- **Content hashes, not just the status list.** The item says "`git status`
  fingerprint", and a status-only fingerprint is blind to the case that matters
  most: the coder leaves `src/parse.ts` dirty, the judge edits it again, and the
  porcelain line reads `" M src/parse.ts"` both times. Each entry carries a
  truncated sha256 of the working-tree bytes. The test that proves it asserts
  the two status strings are equal *first*, so the reason the hash exists is in
  the test rather than only in a comment.
- **HEAD and branch are part of the fingerprint.** A judge that commits its edit
  leaves a clean `git status`; a judge that switches branches changes what the
  next reader sees without touching a file. Neither is visible in the entry map.
- **Gitignored paths are excluded on purpose.** Judges run the suite — that is
  what `Bash` is for — and the suite writes `node_modules/`, `dist/`, coverage.
  A guard that fired on those would be switched off within a day. The obvious
  evasion is closed by a test: widening `.gitignore` mid-run is itself drift,
  and ignore rules never apply to already-tracked files.
- **Exit 1 is the verdict, not an instruction.** `security triggers` exits 0
  either way because firing is a dispatch decision; here the judge's result is
  simply not trustworthy once it moved what it judged, so the dispatcher
  discards it and re-runs on a clean worktree. It is not a finding against the
  coder.
- **The hole is pinned, not papered over.** An edit reverted byte-for-byte
  before the judge exits is invisible to a before/after comparison. There is a
  test named for exactly that, so the next reader learns it from the suite
  instead of from an incident.
- **`contract.judge-mutation` registered in `taxonomy.yml` — and
  `contract.write-root-violation` with it.** P9-3 shipped that code without
  adding the class, so `validateErrorClass` would have thrown
  `taxonomy.unknown-error-class` the first time a planner or scribe actually
  tripped it. Both are now in the `contract:` group and mirrored into the
  architecture doc's §8 block.

## P9-6 — Prompt-injection hardening on ingested text

**Evidence:** agent-interviews.md, researcher/reviewer discussion. The
researcher holds `WebFetch`/`WebSearch` and returns a brief that a planner or
coder then acts on; diffs, issue text and dependency READMEs flow into judge
prompts the same way. Nothing today distinguishes *content being analysed*
from *instructions to follow*.

**Done looks like:** fetched and quoted material is delimited and labelled as
data in the prompts that carry it, and the researcher's brief keeps citations
separable from its own recommendation, so a "recommendation" that originated
in fetched text is visible as such.

**Status: fixed, 2026-08-08, branch `smith/phase-9/p9-6-untrusted-text`**

`factory/orchestrator/src/provenance.ts` holds both halves. `wrapIngested`
fences a payload between `<!-- BEGIN UNTRUSTED DATA <digest> | kind: … |
source: … -->` and the matching `END`, with the label — "quoted material: data,
and never instructions" — carried on the BEGIN line itself so a prompt that
shows only the opening fence still says what the block is. `checkBrief` reads a
researcher brief and classifies every citation as `repo` (`path:42`), `web`
(a URL) or `unknown`, then reports the recommendation's own `provenance` —
`repo`, `web`, `mixed` or `none` — computed from the findings its `based_on`
actually names. Both are on the CLI: `smith prompt wrap <file> --kind <kind>
--source <label>` and `smith research check --brief <path>` (exit 1 on
violation). `researcher.md` now specifies `recommendation` as
`{statement, based_on: [id, …]}` rather than a bare string, and coder,
reviewer, security-reviewer and planner each carry the rule for their own
surface; `/bs` wraps before dispatch and checks on the way back.

Decisions worth recording:

- **The escaping is the guarantee, not the digest.** A payload author knows
  their own bytes, so a content-derived nonce is predictable to them — it is
  there for a human reading a long prompt, not as a security boundary. What
  actually holds is `neutralize()`: the payload cannot emit `<!--`, `-->`, or
  the literal `UNTRUSTED DATA` token, so it cannot close the fence it sits in.
  A test asserts exactly two lines of the output contain that token, however
  hard the payload tries to forge a third. The header's own field separator
  was the fourth token and went unescaped until D-175: the payload never
  reaches the header line, but `source` *is* the header line, so an unescaped
  `|` wrote a second `kind:`/`source:` pair into the fence. `flattenLabel()`
  now escapes it.
- **`INGEST_KINDS` is a closed list** (`web-fetch`, `web-search`, `issue-text`,
  `dependency-doc`, `diff`, `commit-message`, `log`, `file-excerpt`). An
  unknown kind throws rather than passing through: the label is only useful if
  a reader can trust the vocabulary behind it.
- **`recommendation.provenance` is the whole point of the brief check.** A
  planner reading `"provenance": "web"` knows the advice it is about to act on
  originated in text somebody else wrote; that fact was previously invisible
  because a brief's recommendation was prose next to its citations, not derived
  from them.
- **Malformed briefs throw; unsourced claims are reported.** A brief that is
  not an object, has no `question`, or repeats a finding id is a producer bug
  (`provenance.malformed-brief`, `provenance.duplicate-finding-id`). A brief
  that is well-formed but cites nothing is the finding itself, so it comes back
  as `violations` with `ok: false` — the operator sees which claim, by id.
- Two taxonomy codes added under `contract`: `uncited-claim` and
  `unsourced-recommendation`, mirrored into the architecture doc's §8 block.

## P9-7 — Cross-session event edges

**Evidence:** agent-interviews.md M-6, and the `/bs` dispatch contract's own
note. There is no concurrency cap on a wave — fan-out is bounded by the claim
graph — so the real limit on epic size is the orchestrator's context window.
The stated fix is splitting an epic across sessions, and it is blocked:
`events.ts` validates `causal_parent` within a single session only, so a
second session cannot chain onto the first one's timeline.

**Done looks like:** an event edge that can cross a session boundary without
breaking the causal-parent validation or the timeline projection — which is
what makes "one epic, several operator sessions" expressible at all.

**Status: fixed, 2026-08-08, branch `smith/phase-9/p9-7-cross-session`**

The edge exists on both sides now. On the write side, `events.ts` gained
`parseEventId` (an event id is `<session-id>#<index>`, split on the *last*
`#`) and `validateCausalParent`: a parent naming the appending session is
checked against that session's log as before, and a parent naming another
session is checked against *that* log — read outside its append queue, which
is safe because logs are append-only, so a concurrent append there can add
events but never remove the one we are about to point at. On the read side,
`db/queries.ts`'s `causalChain` now hops by event id alone instead of
constraining every lookup to one `session_id`, so the timeline projection
walks through a split rather than stopping dead at a session root and
reporting a two-event history for a chain that ran back through three
sessions. `sessionLineage(sessionId)` is the new read primitive, surfaced as
`smith event lineage <session-id>` (the chain, root first) and `smith event
tail <session-id> --lineage` (the epic's tail, not the newest session's).
23 tests: 19 in `test/crossSession.test.ts`, 4 CLI-level in `test/cli.test.ts`.

Decisions worth recording:

- **The cross-session edge is allowed only on `session-start`.** One entry
  edge per session makes the log a tree of sessions rather than a general
  graph: "where did this session come from" is answered by a single event,
  and the lineage walk terminates. A mid-session event pointing at another
  session is `events.cross-session-parent-not-root`, not a convenience.
- **Event ids are globally unique, so the projection hop needs the id
  alone.** But `session_id` still gates the *first* lookup in `causalChain`
  — asking for a chain that does not start in the named session stays an
  empty answer instead of silently redirecting to some other session's event.
- **`parseEventId` splits on the last `#`, and rejects a non-integer index
  outright.** `Number.parseInt` would accept `"3abc"`; an event id is exact
  or it is a typo, and a typo that parses is a pointer into the wrong place.
- **`sessionLineage` answers `[sessionId]`, never `[]`.** A session with no
  cross-session parent has a lineage of one — itself. An empty list would
  make "no parent" indistinguishable from "no such session", and the latter
  has its own code (`events.unknown-session`).
- **Four codes, each naming a distinct operator mistake:**
  `events.malformed-event-id` (that string is not an event id),
  `events.cross-session-parent-not-root` (crossed from the wrong event),
  `events.unknown-causal-session` (named a session with no log — the message
  prints the path it looked for, because this is nearly always a typo), and
  `events.session-lineage-cycle` (a lineage that revisits a session, which
  the append path cannot produce and so means a log was hand-edited).

## From the `envkit-config-loader` dogfood

P9-8 onward come from pointing the factory at a real greenfield project and
running one epic end to end: `smith new` → a six-task plan → four waves. Three
waves merged, wave 3 half-merged, wave 4 never started. The full log —
40 findings, D0 through D-39, with the commands and their output — is
`docs/specs/dogfood-envkit-findings.md`; each item below cites the D-numbers it
distils and the log holds the repro.

Ordered by the severity assigned during the run, S1 first. Three of these
(P9-8, P9-9, P9-11) are cases where the factory shipped or would have shipped a
green verdict over work that was not there, not correct, or not reviewed —
which is the one failure class that makes every other check decorative.

What held, so the list is not read as a verdict on the whole: claim-overlap
detection failed closed and forced a genuine two-wave split; both legal waves
passed `wave check` clean; asymmetric review found real defects the coder had
missed, including a totality violation in `validateConfig`; and the plan's
immutability held under pressure — the run deadlocked rather than quietly
amending the spec, which is the correct failure and the reason P9-9 exists.

## P9-8 — The gate must certify the commit the queue will merge

**Evidence:** D-30 (S1). `task-3-validate` reported done with 260 lines staged
and never committed; the branch head was still the integration commit it was cut
from. `gate.ts` runs every check with `cwd: input.worktreeDir` (`gate.ts:390`)
and touches git nowhere in the file; `queue.ts` rebases and merges
`task.branch` (`queue.ts:77`, `:99`). So schema, lint, typecheck, test and
coverage all go green against the working tree while the merge is a no-op that
still returns `{outcome:'merged'}` and marks the task complete. Nothing errors
— the work simply is not in the commit, and five green checks say it is. The
coder did not breach its contract either: `coder.md`'s "Output contract" names
two mandatory parts, the result file and the JSON line, and mentions committing
only inside the `research_request` escape hatch.

**Done looks like:** `gate run` refuses to score a task whose worktree
`git status --porcelain` is non-empty, and refuses one whose branch head equals
the integration base it was cut from — a task that merges nothing is a bug, not
a pass. Both are a few lines and neither needs a judge. `coder.md` gains the
commit as a mandatory third part of done in the same change, so the gate is not
failing agents for something nobody asked them to do. The complete form —
check out the branch head and run the checks there — closes the gap entirely at
the cost of one checkout per gate.

**Status: fixed, 2026-08-08, branch `smith/phase-9/p9-8-gate-certifies-commit`**

`factory/orchestrator/src/commit.ts` holds `certifyCommit(worktreeDir,
{baseRef?})`, which returns a certificate — `{certified, reason, head, branch,
dirty[], baseRef, baseSha, commitsAhead}` — rather than throwing. `runGate`
calls it after the schema check and before the testgate, emits
`commit-check-result`, and blocks with `reason: 'not-committed'`; every gate
outcome now carries the certificate it was issued under. `queue.step` calls it
again before the rebase and returns `nothing-to-merge` with a
`contract.uncommitted-work` error rather than merging an empty branch. The CLI
takes `--base <ref>`. `coder.md` and `tester.md` gained the commit as a
mandatory first part of their output contract.

Decisions worth recording:

- **A certificate, not an exception.** `certifyCommit` returns a verdict the
  way `verifyImmutability` does, so "this task has nothing to merge" is a gate
  *outcome* with a printable reason, not a stack trace the caller has to
  classify. Five reasons, ordered by what the reader can act on:
  `not-a-git-worktree`, `uncommitted-work`, `unborn-branch`, `unknown-base`,
  `branch-not-advanced`.
- **Dirt is checked before the base.** A worktree that is both dirty and
  unadvanced reports `uncommitted-work`, because the uncommitted work is *why*
  the branch is empty and "commit it" is the whole fix. Reporting
  `branch-not-advanced` there would be true and useless.
- **Both halves, in both places.** The item only asked the gate to refuse, but
  D-30's actual damage was `{outcome:'merged'}` on a no-op merge — the gate's
  refusal is fast feedback, the queue's refusal is the guarantee. The queue
  refuses *before* the rebase, so the agent's uncommitted work is still sitting
  where it left it; a test asserts the staged file is untouched afterwards.
- **`commitsAhead: null` is not `0`.** `--base` is optional, like `--plan` in
  P9-24: an ad-hoc gate run against a repo with no integration branch is not
  forced to invent one. Without a base the certificate says `null` — "nobody
  asked" — so a reader can never mistake it for "the branch is empty".
- **Fail-closed cost two fixtures, and that is the point.** Three test blocks
  that gated a bare temp dir now build a real repo with a commit. A gate that
  cannot find a repo cannot certify anything, and a checker that passes when it
  cannot check is the bug this item is about.
- **Not the complete form.** The gate still runs the checks against the working
  tree, not against a checkout of the branch head. With the worktree certified
  clean and ahead of its base those are the same bytes; a `git stash`-shaped
  divergence between them is out of reach of this change, and the checkout
  variant remains available if that ever bites.
- **The taxonomy moved to `version: 3`** — `gate_event.commit-check-result` and
  `error.contract.uncommitted-work`, mirrored value-for-value into architecture
  §8 in the same commit, per the rule at the top of `taxonomy.yml`.

**Follow-up: D-178, 2026-08-19.** "A checker that passes when it cannot check
is the bug this item is about" — and this one could be made unable to check
from outside itself. `dirtyPaths` read `git status --porcelain` without
`--untracked-files=all`, so a `status.showUntrackedFiles = no` set in the
repo, the user's `~/.gitconfig`, or the system file hid untracked work
entirely and `certifyCommit` returned `certified: true` on a worktree holding
uncommitted new files. `runIntegrationCheck` had the same read and recorded a
`pass: true` integration check on a dirty branch. Both now pass the flag
explicitly, where the config cannot reach it. See
`docs/specs/dogfood-4-findings.md` § D-178.

## P9-9 — A `spec`-scoped finding, and a plan-amendment path

**Status: fixed, 2026-08-08, branch `smith/phase-9/p9-9-spec-findings`**

A finding now carries `finding_scope` (taxonomy dimension, `diff` by default)
and, when it is `spec`, a `spec_ref` of `{plan_version, criterion_ref}`. The
gate diverts a spec finding before attribution: it is reported in
`GateOutcome.specFindings`, it never blocks the diff, and it mints no follow-up
task, because no task's diff can hold the fix.
`factory/orchestrator/src/spec.ts` holds the other end — `amendPlan` cuts the
next plan version, writes a `plan-version-created` event naming which finding
forced it and which criterion moved, and transitions each cited finding to
`amended`; `recordSpecReview` records the closing spec-reviewer dispatch pinned
to the integration head. `specReviewBlockers` is now part of the epic verdict,
so an epic whose plan nobody re-read once the code existed is held. Three CLI
verbs drive it: `smith findings raise --scope spec --plan <plan>`,
`smith plan amend --plan <plan> --findings <ids> --rationale <why>`, and
`smith epic spec-review --epic <id> --project <dir> --plan <plan>`.

Decisions worth recording:

- **Scope belongs to the dispatch, not to each item.** `mintFindings` takes an
  optional `spec: {planVersion}` context, and its *presence* is what makes every
  finding in the batch spec-scoped — one review reads one thing. A
  `criterion_ref` on a diff dispatch is dropped rather than promoted, so a judge
  cannot elect its own scope by putting an extra field in its evidence. Same
  reason the CLI flag is `--scope` on the dispatch and not a field per finding.
- **Evidence, not identity (interview N-2), applied to the plan version.** A
  spec reviewer legitimately knows which criterion it read; it cannot know the
  plan version it was dispatched on. So `criterion_ref` comes from the judge and
  `plan_version` comes from the plan file the dispatcher passes — which is why
  `--plan` is mandatory for both spec verbs. A spec finding stamped with a typed
  version points at a criterion that never moved.
- **A spec finding never enters attribution — in the CLI too, not only the
  gate.** `routeFindings` would rewrite its `task_id` to whoever claims the file
  it happens to cite, and a plan defect attributed to a task is precisely the
  deadlock this item exists to end. `findings raise --scope spec` bypasses the
  routing entirely and stamps `<epic>/integration`, the same owner
  `recordSpecReview` uses, so the two routes into the log are indistinguishable
  downstream. It also refuses `--scope spec --findings <prebuilt.json>`: a
  pre-built draft was minted under a different dispatch.
- **`amendPlan` validates everything before it acts.** Cited findings must
  exist, must be spec-scoped, and must be legally transitionable to `amended`,
  and all of that is checked before `nextVersion` writes anything. The other
  ordering leaves a plan file on disk that no event explains — and nothing in
  this codebase deletes a plan file.
- **An amendment must cite a finding and must say why.** Without the first, "the
  plan changed" has no recorded cause and immutability is decorative: a new
  version any time anyone wants one is a mutable plan with extra files. Without
  the second, the diff records what moved and nothing records the argument,
  which is the half a future reader actually needs.
- **A pure carry-forward warns loudly instead of failing.** Rewording a
  criterion without moving a task is legal, but it is also the exact shape of a
  forgotten `--changes`, so `plan amend` emits a `warning` key and a stderr
  line rather than silently cutting an identical version.
- **The spec review is recorded even when it is clean.** "Ran and found
  nothing" and "never ran" are different facts and the epic gate distinguishes
  them; a review that only logged when it found something would make a silent
  skip indistinguishable from a pass — the same shape of hole D-42 was.
- **No `SPEC_REVIEW_NOT_REQUIRED` escape hatch.** `mcp.ts` has one because an
  epic can legitimately owe no MCP surface. Every epic has a plan, and every
  plan can be wrong in a way only the finished code reveals, so this blocker has
  no opt-out — and it fails closed on an unreadable head, like the integration
  blocker it mirrors.
- **`epic spec-review` exits 0 even when it raises findings, and refuses when
  it cannot read the integration head.** The review ran; a spec finding blocks
  the plan, not this command, and `plan amend` is what answers it. But a review
  pinned to a head nobody could read is a review nothing can be shown to cover.
- **`spec.ts` never imports `epic.ts`.** The arrow points one way — `epic.ts`
  folds facts from here — so the module that decides readiness stays downstream
  of the facts it folds.

**Evidence:** D-33, D-39 (S1). This is what stopped the epic.
`task-1b-parse-quotes` passes all five checks (115 tests, 98.54% statements)
and is blocked by one S2 from the security-reviewer: an unbalanced quote
swallows the following line, so `SECRET_TOKEN=abc123` rides inside the previous
key's value and never becomes a key. The finding is correct — and so is the
code. Acceptance criterion 3 mandates multi-line double-quoted values, which is
what makes the swallow possible; criterion 1 forbids the only other remedy
("`ParseIssueCode` gains no new member"). S1/S2 are categorically unwaivable
(`severity.yml:73`, enforced at `findings.ts:432`), and `quorumEscalations` came
back `[]` because no external provider is enabled. The diff cannot be fixed,
the finding cannot be waived, the queue never admits the task. The factory has
exactly one verdict for "this is wrong" and it points at the builder; here the
defect is in the plan, which is immutable by construction.

**Done looks like:** a finding scope of `spec` — carrying
`{plan_version, task_id, criterion_ref}` — routed to the planner and the
operator instead of to the task gate, blocking the plan rather than the diff. A
spec finding becomes the mechanical trigger for a `plan-version-created`
amendment, which is the one legitimate way to change an immutable plan, and the
amendment records which criterion moved and why. Paired with it: a second
spec-reviewer dispatch at epic close, run against composite behaviour, when the
code the spec describes finally exists — the wave-3 finding is precisely the
kind a spec review cannot see before the parser is written. Until this lands,
every spec defect is recorded as a builder defect and deadlocks here.

## P9-10 — One task-id form, and an `epic_id` carried rather than parsed

**Evidence:** D-14, D-28, D-22a (S1). The plan writes
`envkit-config-loader/task-0-toolchain`; every mechanical consumer — branch
names, worktree dirs, `state/results/*.json`, gate, queue, findings — uses the
bare `task-0-toolchain`. Both `plan validate` and `wave check` accept the
qualified form, so nothing complains. The projector then holds two rows for one
task: `envkit-config-loader/task-0-toolchain|ready` and
`task-0-toolchain|completed`. The two epic filters fail in **opposite**
directions. `runEpicVerdict` (`epic.ts:257`) selects tasks by
`startsWith(epicId + '/')`, so it sees only the abandoned `ready` rows and holds
the epic on a phantom blocker. `listFindings`'s epic filter (`findings.ts:355`)
does `f.task_id.split('/')[0] === epic`, which for a bare id returns the whole
id and matches nothing — so `waivers pending --epic` returns `[]` while an open
S3 exists. Today the over-block masks the under-block. The obvious repair —
qualify the ids everywhere — fixes the task filter and leaves the finding filter
broken, converting a deadlock into a `go` verdict with an unwaived open finding
underneath it.

**Done looks like:** epic membership is a field, not string surgery. `epic_id`
is carried on findings and on the projected task row (the `tasks` table already
has the column) and both filters read it. The projector normalises the id at
its boundary — or rejects an event whose task id is absent from the plan — so
one task can never hold two rows. If derivation stays for back-compat it needs
one shared helper plus a guard that refuses an id whose shape does not match; a
`split('/')[0]` that silently returns the whole string when there is no `/` is
the entire bug.

**Status: fixed, 2026-08-08, branch `smith/phase-9/p9-10-task-id-form`**

`factory/orchestrator/src/taskId.ts` is now the one place that knows what a task
id is shaped like, and its answer for an unqualified id is `null`, not a
plausible lie. Four call sites did `taskId.split('/')[0]` — `attribution.ts:65`,
`findings.ts:378`, `db/projector.ts:888`, `epic.ts:351` — and all four are
converted. `epic_id` is now carried: `mintFindings` stamps it, `raiseFinding`
backfills it for any producer that did not, `reattributeFinding` moves it with
the `task_id`, and `finding.schema.json` declares it optional. The projector
folds it onto every task row and normalises the id at its boundary, so one task
holds one row.

Decisions worth recording:

- **`null`, not the whole string.** `epicOfTaskId("task-0")` returns `null`.
  That single change is what makes the rest possible: every consumer now has to
  say what it does with "no epic", and the two that cannot proceed without one
  say so out loud. `requireEpicOfTaskId` throws `task-id.unqualified` naming the
  id, and `attribution.ts` uses it — because every epic that module derives
  becomes durable, either as a finding's `epic_id` or as the `<epic>/followup-`
  prefix of a task that gets dispatched. `epicOf("task-1")` used to mint
  `task-1/followup-ab12` under an epic that does not exist.
- **The guard found a real caller that legitimately holds an epic.**
  `smith findings raise --plan` with no `--task` puts the EPIC id in
  `defaultTaskId` on purpose — cli.ts's own comment says "the epic is a
  fallback, never a real owner" — so asking that field for an epic is the wrong
  question, and four `cli.test.ts` tests went red saying so. The fix is an
  explicit `RouteOptions.epicId` that the plan-bearing caller passes, not a
  lenient derivation for everyone. A field that means two things is what this
  whole item is about; making the parser tolerant would have re-created it one
  layer up.
- **The projector normalises, and refuses to guess when it cannot.**
  `buildTaskIdAliases` runs one pass over the events before any row exists,
  collecting every (bare id → epic) assertion — from a qualified id directly,
  from `wave-admitted`'s `epic_id` beside its bare `task_ids`. A bare id that
  exactly one epic claims is folded into the qualified row. A bare id two epics
  claim gets **no** alias and stays its own row: merging it into either would
  silently mark the wrong task complete, and a visible third row is a better
  bug report than a confident wrong answer. The alternative in "done looks
  like" — reject an event whose task id is absent from the plan — was not taken,
  because the projector reads logs from sessions whose plan file may be gone,
  and a projector that refuses to project old history is worse than one that
  normalises it.
- **A qualified id outranks a disagreeing payload.** In `task-added` and
  `wave-admitted` the row's epic is `epicOfTaskId(id) ?? payload.epic_id`. The
  id is what branch names, worktree dirs and finding ids are keyed on; a payload
  that disagrees with it is a producer bug, not a second opinion.
- **`epic_id` is not orchestrator-owned on the intake path.** It was
  deliberately left out of `ORCHESTRATOR_OWNED_FINDING_FIELDS`: `FindingEvidence`
  has no such field and `mintFindings` builds the draft from scratch, so a judge
  cannot set it anyway, and adding it would have forced an edit to
  `spec-reviewer.md` that PR #39 already touches.
- **One test was asserting the bug.** `cli.test.ts`'s `db rebuild + apply +
  stats` asserted `stats kanban --epic epic-9` returns `[]` for a task whose only
  event is a `dispatch_decision` on `epic-9/task-1` — the same task the very next
  assertion finds by id, and that `stats overview` counts as a live agent. That
  expectation is exactly D-22a's under-block, so it was changed rather than
  preserved.

**Follow-up: D-177, 2026-08-19.** Branch names and worktree dirs were keyed on
the id, but not on the *same* id: `taskBranchName` stripped a matching `<epic>/`
prefix and `taskWorktreeDir` did not, so one task addressed one branch and two
directories depending on how the id was spelled. `listStale` reports the id it
reads off the branch — always the bare form — and `worktree rm`, the verb the
operator guide pairs it with, then computed a path that does not exist. Both
now share one strip. See `docs/specs/dogfood-4-findings.md` § D-177.

**Acceptance, measured.** Red first: with the implementation absent, 7 tests
failed across the four target files and `taskId.test.ts` failed at import. After:
`taskId.test.ts` (new, 15 tests) plus the additions to `findings.test.ts`,
`epic.test.ts` and `db/fold-extra.test.ts` — 97 passed across the four files.
The fold test that matters is the two-form one: `task-added envkit/task-0` +
`wave-admitted {epic_id: envkit, task_ids: [task-0]}` + `wave-merged
{task_ids: [task-0]}` now folds to exactly **one** row —
`envkit/task-0 | envkit | completed | smith/envkit/task-0` — where the dogfood
log produced two. Its sibling holds the ambiguity open: two epics both claiming
bare `task-0` leaves three rows, not a guess. `epic.test.ts` covers the
opposite direction — an epic whose task carried its epic in the payload used to
read "no tasks in the event log" and now counts one. Full suite under Node
22.23.1: 757 tests, 44 files, lint and typecheck clean.

One honest remainder: `epic_id` is carried on new findings and backfilled at
`raiseFinding`, but records already written to `state/events/` do not have it —
`listFindings` and the projector fall back to the task id's prefix for those, so
a *pre-existing* finding with a bare task id still matches no epic. That is the
D-22a under-block surviving in old data only; it cannot be fixed without
rewriting the append-only log, which is not a thing this factory does.

## P9-11 — A dispatched judge must report back

**Evidence:** D-31, D-20 (S1). Wave 3 dispatched 8 agents and **five stopped
mid-procedure** — each ending its turn on an announcement of its next step
("Now let's run the prototype-pollution probes"), each signalling `completed` to
the layer above, none having written its result file. All five finished
correctly on one resume, in 1–13 tool calls, so the work was cheap and the
silence was the whole defect. Nothing records that a dispatched judge reported
back, so nothing can notice that one didn't. The event pair exists on paper and
neither half fires here: `dispatch_decision` has exactly one emitter in
`factory/orchestrator/src` — `quorum.ts:280`, the external-provider judge path
— so a judge dispatched the normal way, as a subagent out of the operator
session, is never recorded as dispatched at all; and its declared terminal
counterpart `task-result-recorded` (`agents-registry.ts:28`) has readers in four
files and **no producer anywhere**, so even a recorded dispatch could not be
closed. And `cli.ts:323` reads
`const findings = flags.evidence ? mintFindings(...) : []`, which collapses
three different outcomes — judge ran and found nothing, judge died before
writing, judge was never dispatched — into the same value at the gate. Had the
five not been resumed by hand, `task-3-validate` merges green with zero
findings, and the security review that was one probe short of the
`validateConfig(null, …)` TypeError never lands.

Wave 4 raised the severity of this item twice over. First, it recurred in a
dispatch whose prompt **explicitly named this failure mode** — "a previous
judge in this epic returned nothing at all and that is now a tracked defect" —
so prompt-level mitigation demonstrably does not close it. Second, the wave-4
reviewer did not return nothing. After 36k tokens and 17 tool calls it returned
*"Node 22.23.1 available which supports type stripping. Let's write probe
scripts…"* — fluent, on-topic, technically accurate prose that is a fragment of
its own planning. A consumer treating a judge's final text as its verdict would
have accepted that sentence as a review. An empty return is detectable; a
plausible fragment is not, which is why the completion signal has to be the
artifact rather than the message. Resumed from transcript, the same agent
produced a complete review (`[]`, seven attack classes probed and cleared) for
39k more tokens — again, the work had been done and only the reporting was lost.

**Done looks like:** a `judge-reported` event carrying `task_id`, `agent_role`,
`round` and the artifact path, emitted per judge; `gate run` refusing to score a
task whose dispatch set and report set differ; `--evidence` existence-checked
per dispatched judge, so a missing file is an error rather than `[]`, with an
explicit `--no-findings <role>` for the genuinely clean case. Cheapest useful
addition on top: a dispatcher that re-pokes an agent whose turn ended without
its declared artifact on disk — recovery was six for six here. Completion is
"the artifact exists and parses", never "the agent said something".

**Status: fixed, 2026-08-08, branch `smith/phase-9/p9-11-judge-reports`**

`factory/orchestrator/src/judges.ts` holds both halves of a judge turn and the
gap between them. `smith judge dispatch --task <id> --role <r> --round <n>
--artifact <p>` writes a `dispatch_decision` carrying `declared_artifact` and
`round`; `smith judge report --task <id> --role <r>` reads that file, refuses it
if it is missing, is prose, or is not a findings array, and writes a
`judge-reported` carrying `agent_role`, `round`, `artifact_path` and
`finding_count`; `smith judge outstanding --task <id>` prints the difference and
**exits 1 while it is non-empty**. `gate run` refuses to score a task with a
non-empty difference — `outcome: blocked`, `reason: judges-outstanding`, and the
outstanding turns with the file each one owes in the payload — before it pays
for the test run.

Decisions worth recording:

- **`declared_artifact` is what makes a dispatch a judge dispatch.** No
  hardcoded list of judge roles anywhere. A dispatch that names a file it will
  write owes that file; a coder's dispatch names none and owes nothing. This
  keeps `agents-registry.ts`'s existing fold working unchanged, keeps the
  taxonomy the only place role names live, and means the gate check is a
  **no-op** for every task that never used `judge dispatch` — which is what
  makes shipping it non-breaking.
- **The finish line is declared before the run, not after.** The dispatch
  records the path. A judge cannot pick its own finish line once it sees how the
  turn went, and the wave-4 failure — 36k tokens of fluent, accurate prose that
  was a fragment of the reviewer's own planning — fails at
  `judges.artifact-unparseable` rather than being read as a verdict.
- **Three failure codes, because there are three different things to do.**
  `judges.artifact-missing` (re-poke the agent), `judges.artifact-unparseable`
  (it narrated instead of reporting), `judges.artifact-not-a-list` (it wrote
  some other shape). A single "bad artifact" error would have made the
  re-pokeable case indistinguishable from the two that need a human.
- **Two passes over the log, not one.** A round-1 report that lands *after* a
  round-2 dispatch must not close round 2. Pass one settles which round each
  role is on, pass two closes only a report naming that round. A single pass
  that resets `reported` on each dispatch gets the same answer for a
  well-ordered log and the wrong one for a slow judge.
- **Earlier rounds are superseded, not kept outstanding** — the rule
  `agents-registry.ts` already applies to a re-dispatched task. Without it every
  re-poke would leave a permanent phantom in the outstanding list and the gate
  would deadlock on a judge that has since reported.
- **`--no-findings` is recorded as an attestation, not as a review.** The item
  asks for it and it is worth being honest about what it is: an attestation *is*
  "the agent said something", relayed by the operator, which is the exact class
  of evidence this item exists to stop trusting. So it is never dressed up as an
  artifact — `artifact_path: null`, `finding_count: 0`, `attested_by: operator`,
  visibly different in the log from a judge that wrote `[]`. A judge that
  genuinely found nothing should write `[]` and report normally; the flag is for
  the case where the judge ran outside the factory.
- **A bare `--no-findings` on the gate is a usage error.** `parseArgs` renders a
  valueless flag as the string `'true'`, and attesting a role called `true`
  would close nothing while looking like it closed something.
  `cli.no-findings-needs-role`, with a test.
- **`gate run --evidence --found-by <role>` closes that role's turn.** Handing
  the gate a judge's evidence *is* that judge reporting, so the common path is
  one command rather than two, and forgetting the second can no longer block a
  task whose judge did everything right. A `--found-by` role with no dispatch
  behind it has no turn to close and takes the pre-P9-11 path untouched.
- **The "re-poke" ask is served by exit 1, not by a dispatcher.** This
  orchestrator cannot spawn subagents; the thing it can do is make the
  outstanding set machine-readable and give a shell loop a status to branch on.
  `smith judge outstanding` is that, and `/bs` step 7 now runs it.

**Acceptance, measured.** `pnpm vitest run factory/orchestrator/test/judges.test.ts`
→ 16 passed. `pnpm vitest run factory/orchestrator/test/gate.test.ts` → 32
passed (6 new, covering the refusal, its ordering against the schema check and
the testgate, and task scoping). `pnpm vitest run factory/orchestrator/test/cli.test.ts`
→ 9 new tests for the four verbs, each written red first against the built
binary.

One honest remainder: the check compares sets, so it cannot tell a judge that
reviewed carefully from one that wrote `[]` without looking. It closes the
silence, not the diligence — grading a judge's output is P9-14's problem.

## P9-12 — Producers for the events the factory already reads

**Evidence:** D-22, D-27, D-23. `db/projector.ts` folds the tasks table from
seven event types, two of which have **no emitter anywhere** in
`factory/orchestrator/src`: `wave-merged` and `task-added`. `queue.ts` imports
no event machinery at all and `queue run` takes no `--session`, so the one
component that knows a task merged is mute; the projector's only path to
`completed` is `wave-merged`, so every task terminates at `merging` forever
unless a human hand-appends the event — which is what happened four times in
this run. `task-result-recorded` has readers in `agents-registry.ts`,
`scheduler.ts`, `db/projector.ts` and `db/queries.ts` and no producer either, so
the registry's `live` entries never close. Measured after a fully green wave:
`stats kanban --epic envkit-config-loader` returned `[]` and `stats overview`
reported zero epics in flight. Two shape defects ride along: `wave-merged`
carries a record-level `task_id` that no consumer reads (the projector reads
only `payload.task_ids`) yet is the field a hand-appender dutifully fills; and
the live-agent registry keys open dispatches on `task_id` alone, while `/bs run`
deliberately runs coder, grader, reviewer and security-reviewer against one task
— three finished agents were recorded `superseded` and a fourth stayed `live`
forever.

**Done looks like:** `queue run` takes an event context and emits `wave-merged`
on merge, plus an error event on rebase-conflict or tests-failed; plan admission
emits one `task-added` per task carrying `epic_id`, `branch`, `claims` and
`budget_tokens`; a schema-valid worker or judge return emits
`task-result-recorded`. The registry keys on `(task_id, agent_role, round)` and
supersedes only on a same-role redispatch. Wave-scoped events drop the singular
`task_id`, and the projector's test fixture uses a two-task wave — a
single-task fixture cannot catch this.

**Status: fixed, 2026-08-08, branch `smith/phase-9/p9-12-event-producers`** —
`queue run`'s half landed with P9-29 (`taskEvents.ts` emits `wave-merged` per
merged task and `error-logged` on a failed rebase or red suite); this item
closes the other three.

`task-result-recorded` now has a producer: `runGate` emits it the moment the
schema check passes, with the validated Result as the payload verbatim. The
gate is the right emitter because it is the one component that has already
proved the Result is schema-valid — emitting from the dispatcher would put
unvalidated payloads into the rows `analytics()` and `tokensSpentByEpic()` sum.
It fires *before* the test gate runs and whatever the gate then rules: the
worker's tokens were spent and its agent stopped whether or not the tests it
left behind pass, so deferring the event to a clean outcome would leave the
live-agent count wrong for exactly the tasks that go wrong.

The registry keys on `(task_id, agent_role)`, not `task_id` alone, and closes
an entry on `task-result-recorded`, `judge-reported` (P9-11's half) or
`error-logged`. `round` rides along on the record and in a new `agents.round`
column (migration `0007`) but is deliberately **not** part of the key: a round-2
dispatch arriving while round 1 is still open means round 1 was given up on, and
keying on the round would leave it live forever — the same bug one level down.
A terminal event that names no role closes every entry open under that task,
because after a task-level failure nobody is still running.

Decisions worth recording:

- **Dedupe is a content hash, not an event id.** `smith gate run` over an
  unchanged `result.json` is an operator re-reading their own gate, and
  double-counting it inflates the very budget numbers P9-17/P9-18 exist to make
  honest. The hash is sha256 over a key-sorted serialization scoped to
  `(session, task)`, re-derived from each stored payload rather than carried on
  it — a hash field wedged in beside the Result would be a Result that no longer
  validates. A genuinely re-run worker differs in `token_usage` at minimum, so
  it hashes differently and counts again.
- **The branch convention is defined once.** `taskBranchName()` moved out of
  `worktree.ts`'s privates and is now exported, because three places have to
  agree on it: the module that cuts the branch, `task-added` (which declares it
  so the board can link before any worktree exists), and the projector's
  fallback for events logged before the payload field existed. It strips a
  duplicated epic prefix on the way, which also kills a latent
  `smith/epic-7/epic-7/task-142`.
- **Wave-scoped events keep the singular `task_id`** — a deviation from "done
  looks like". `waveTaskIds()` prefers `payload.task_ids` and falls back to the
  record-level id. Dropping the field would leave the four hand-appended dogfood
  events silently folding to nothing; reading it makes those keystrokes mean
  what they look like they mean, and costs the producers nothing since they emit
  both.
- **The projector's shared fixture stays a one-task wave** — the other
  deviation. `projector.test.ts` pins TASK_2 at `reviewing`/`live` on purpose to
  cover the waiver path, so widening its wave would destroy that coverage.
  Dedicated multi-task `foldTasks` tests went into `fold-extra.test.ts` instead,
  which is where the shape defect is actually observable.
- **Judges close on `judge-reported`, not a synthesized Result.**
  `result.schema.json` requires `token_usage`; minting a zeroed one to reuse
  `task-result-recorded` would inject invented numbers into the rows budget
  accounting sums. The registry learned a second terminal event rather than the
  event learning to lie.

**Acceptance, measured.** Every claim above is covered by a test watched failing
first: 6 new registry tests (concurrent coder + reviewer both stay live; a
Result closes only the role it names; a judge closes on `judge-reported` and not
on the coder's Result; `round` defaults to 1; same-role redispatch supersedes
whatever round it claims; a role-scoped error closes one entry and a task-scoped
one closes all), 6 new `foldTasks` tests (multi-id waves, per-task merges,
record-level fallback, declared-branch preference), 1 new `taskEvents` test for
the epic-prefix rule, and 6 new gate tests for the producer (records verbatim
once; records even when the gate blocks; records nothing for a schema-invalid
Result; a re-run does not double-count; a genuinely re-run worker does; key
order is not content). Under Node 22.23.1: **752 tests pass across 43 files**,
lint and typecheck clean.

One honest remainder: the gate emits for a *worker's* Result only. A judge's
return closes its registry entry through `judge-reported`, which P9-11 defines
but no dispatcher emits yet — so a judge dispatched as a subagent is still
neither recorded as dispatched nor as reported. That is P9-11's dispatcher half,
not this one's.

## P9-13 — Multi-judge evidence at one gate run

**Evidence:** D-32. `gate run` pairs one `--evidence <file>` with one
`--found-by <role>`, and a task normally has several judges.
`task-3-validate` returned findings from both the reviewer (a test gap) and the
security-reviewer (a totality violation); passing both through one gate run
means concatenating them under a single attribution, which makes at least one
attribution false. Attribution is not cosmetic — it feeds the same-mistake
quorum trigger and any "which role catches what" analysis, and
`--found-by-provider` exists precisely because the system wants to know. The
library is already correct: calling `mintFindings` twice from outside the
orchestrator produced two correctly attributed records that `gate run
--findings` accepted. But that path requires importing `dist/findings.js`, is
documented nowhere, and moves minting outside the process that emits the gate
events.

**Done looks like:** `--evidence` is repeatable and positionally paired with the
`--found-by`/`--found-by-provider` that follows it — or takes one file whose
records each carry their own `found_by`. A CLI-surface fix, not a model one.

**Status: fixed, 2026-08-08, branch `smith/phase-9/p9-13-multi-judge-evidence`**

`--evidence` now repeats, and each occurrence is minted under the
`--found-by`/`--found-by-provider` written after it. `--evidence rev.json
--found-by reviewer --evidence sec.json --found-by security-reviewer
--found-by-provider codex` files two judges' findings under two judges' names in
one gate run, which is what a task with two judges has always needed.

The parser could not answer the question as it stood. `flags` keeps the last
occurrence and `repeated` keeps every occurrence, but both are keyed by flag
name, so neither retains the order *between* flags — and "which `--found-by`
followed *this* `--evidence`" is a question about exactly that. `parseArgs` now
also returns `ordered: FlagOccurrence[]`, every occurrence of every flag in the
order the command line wrote them. Added beside `flags`/`repeated` rather than
replacing them: some forty single-valued readers are correct as they are, and
rewriting them to serve one command is a large diff bought with nothing.

Decisions worth recording. Positional pairing, not parallel arrays: `--evidence
a --evidence b --found-by x --found-by y` reads fine until the day the two lists
are different lengths, and then it silently swaps two judges' names — the exact
failure the item exists to remove, reintroduced by a convention. A `--found-by`
seen *before* any `--evidence` is the default for sources that name no judge of
their own; that is precisely the pre-P9-13 line (`--found-by reviewer --evidence
file.json`) that the `/bs` skill, the operator guide and every existing caller
write, and flags were order-independent when they wrote it, so a strict
"role must follow evidence" rule would turn all of them into errors overnight.
An evidence file with neither its own role nor a leading default is refused by
name (`cli.missing-flag`, message quoting the file), before any event is
written — falling back to the nearest judge would be the misattribution again,
and silent. Both call sites go through one `mintFromEvidence` helper: `gate run`
and `findings raise` face the same judges, and fixing one would leave the bug
wherever the operator happened to be standing.

The punch list offered an alternative — one file whose records each carry their
own `found_by` — and it was not taken. `found_by` is on
`ORCHESTRATOR_OWNED_FINDING_FIELDS`, so evidence carrying it is rejected as
`findings.evidence-carries-identity`; that guard is what stops a judge from
attributing its own findings to another judge, and relaxing it to save a flag is
a bad trade.

**Acceptance, measured.** Four tests added to
`factory/orchestrator/test/cli.test.ts` (`gate run multi-judge evidence
(D-32/P9-13)`), which exercises the built `dist/cli.js`, not the source. Red
against the pre-change orchestrator: 3 failed | 1 passed | 58 skipped — the two
judges collapsed to one record (`expected [ [ …(3) ] ] to deeply equal [ [ …(3)
], [ …(3) ] ]`), the orphan evidence exited 0 instead of 1, and `findings raise`
filed both findings under `security-reviewer`. The fourth test — the legacy
single-judge line with `--found-by` written first — was green before the change
and stayed green, which is its whole job. After: 4 passed | 58 skipped. Full
suite `pnpm test` 43 files / 737 tests passed, `pnpm typecheck` clean, `pnpm
lint` clean over 133 files, Node v22.23.1. `.claude/skills/bs/SKILL.md` records
the repeatable flag where the operator reads it.

One honest remainder: nothing checks that the set of evidence files handed to a
gate matches the set of judges the task actually dispatched. An operator who
forgets the security-reviewer's file gets a clean gate run over half the
evidence, and the log cannot tell that from a security-reviewer who found
nothing.

## P9-14 — The grader's verdict needs a consumer

**Evidence:** D-34 (S2). No code path in the orchestrator opens a grader verdict
file — grepping `grader` across `factory/orchestrator/src` returns nothing. The
grader runs before the gates so its rubric result can inform them, and that
result reaches them only if a human reads the file and retypes the conclusion.
The cost showed up inside a single wave: two graders, same role, same template,
wrote two different shapes — `{task_id, round, verdict, criteria, notes}` with
the verdict at `.verdict`, and the standard result envelope with the verdict at
`.structured_output.overall` — and nothing objected, because nothing reads them.
A schema is load-bearing only if something loads it.

**Done looks like:** a `grader-verdict.schema.json` in
`factory/specs/schema/`, `gate run --grader <file>` validating against it, and
`verdict: fail` or any `not-met` criterion treated as a gate input rather than
as prose. Until then the operator guide says plainly that the grader is
advisory with a human in its output path — the dispatch reason currently
written into the event log says it runs "before the gates", which reads as
feeding them.

**Status: fixed, 2026-08-08, branch `smith/phase-9/p9-14-grader-verdict`**

`smith gate run --grader <file>` now reads the grader's result file, validates
the verdict inside it against a new `grader-verdict.schema.json`, and blocks the
task when the rubric was not met — before a single check command runs.

The stage sits between the result schema check and the test gate, and the order
is the point. The grader has already run by then; if its rubric says the
criteria were not met, the diff bounces whatever the suite says, so running the
suite first spends a full test run to learn nothing. Blocking early also matches
how the rest of the pipeline already behaves: the first hard stop wins and the
stages after it never execute.

Three ways to not pass, deliberately kept apart, because they send the diff to
different people. `grader-invalid` — the file is not shaped like a verdict, so
nothing has judged this diff and the grading pass has to be re-run. That is
where D-34's second shape lands: a file with the verdict at `.verdict` fails
with an error naming `.structured_output` and quoting the output contract,
rather than being silently ignored the way it was when nothing read the file at
all. `grader-fail` — the rubric was read and the criteria were not met, which
goes back to the coder with the named gaps (or, at round 2, to the planner).
And `run_status: "dead"`, the grader's own word for "this task spec has no
checkable acceptance criteria", reported as verdict `not-graded`: it blocks,
because a task nobody could grade has not passed its criteria, it has escaped
them.

Decisions worth recording. A criterion marked `fail` or `partial` blocks even
under an `overall: "pass"` — the grader can contradict itself, and the
per-criterion line is the one carrying evidence, so it wins. `partial` is in the
schema's `status` enum although the grader's Output contract listed only
`pass`/`fail`: the same file's Mission says "score each acceptance criterion
pass/fail/partial" and its context-window rule *requires* writing `partial` at
60% of the window, so the contract was the half that was wrong. Writing the
schema is what forced that contradiction into the open; `.claude/agents/
grader.md` is corrected in this PR. `round` is capped at `maximum: 2`, which
turns "two rounds is a hard stop, not a suggestion" from prose into something
that fails a gate. `evidence` is required and non-empty per criterion, so
"looks correct" with the evidence field simply omitted no longer validates.
The flag is optional: a gate run with no `--grader` is the pre-P9-14 pipeline
exactly, because an ad-hoc gate run has no rubric result and inventing one
would be worse than skipping the stage — the same shape as `--plan` in P9-24.

One drift closed on the way past: `docs/specs/black-smith-architecture.md` §8's
`gate_event` list was missing `integration-check`, which
`factory/policies/taxonomy.yml` has had since D-42/P9-26. The taxonomy header
says value-for-value divergence between the two "is a bug — fix both in the same
PR", so both lists now carry `integration-check` and the new `grader-verdict`.

**Acceptance, measured.** Nine tests in `gate.test.ts`
(`describe('grader verdict (D-34/P9-14)')`) and two in `cli.test.ts`
(`describe('gate run --grader (D-34/P9-14)')`), written first. Red against the
pre-change orchestrator — source stashed, the new schema file moved aside —
`10 failed | 1 passed | 84 skipped`; the one pass is the backward-compat guard
that asserts a gate run *without* a verdict behaves exactly as before, which is
supposed to be green on both sides. After the change: `9 passed` in `gate.test.ts`,
`2 passed` in `cli.test.ts`. Full suite `pnpm test` 43 files / 744 tests passed,
`pnpm typecheck` clean, `pnpm lint` clean over 133 files, Node v22.23.1.

One honest remainder: nothing checks that the file handed to `--grader` is the
grading pass for *this* task, or its latest round. The grader is told never to
set `task_id` (the dispatcher owns it), so the verdict file carries no task id
to cross-check against, and the round number inside it is self-reported. A
stale round-1 file from an earlier bounce would pass the gate on a task whose
round-2 verdict was `fail`. Closing that needs the dispatcher to record which
grader artifact it wrote for which task and round, which is P9-22's territory
(`artifacts need a home the gate can check`), not this one's.

## P9-15 — Open findings must reach the task that reopens their file

**Evidence:** D-26 (S2). Wave 2's reviewer raised a real S3 on `src/parse.ts`;
`severity.yml` defers S3s to the operator at epic end. Wave 3's
`task-1b-parse-quotes` claims the same file and rewrites the quoting rule
wholesale. The task was dispatched without the finding injected, deliberately,
and the decision recorded in the `wave-admitted` event so the run would produce
evidence either way. The coder rewrote the exact region — moved the statement 77
lines, renamed the variable `line` → `rawLine`, and computed `trimmed`, the
correct operand and the entire content of the finding, five lines above it —
and preserved the bug. Verified against the committed rewrite:
`parseEnv('  export FOO=bar')` still yields `{"export FOO":"bar"}`. Nothing
reads open findings at dispatch time; both consumers (`epic.ts`,
`db/queries.ts`) are epic-final. This is not P9-2: lessons are cross-epic and
approved, this is an open finding inside the current epic against a file the
current plan is about to reopen, and the join needs no inference at all.

**Done looks like:** at dispatch, open findings' `file_path` is intersected
against the dispatching task's `claims[]` and the matches are attached as
*context, not scope* — "an open S3 exists in a file you are about to edit; fix
it if it falls naturally inside your diff, otherwise leave it and say so" —
because silently widening scope breaks both plan immutability and the diff cap.
And when a task merges over an open finding's file, the finding is re-verified
before it can be waived: its evidence is provably stale, and a waiver batch
describing rewritten code is a decision made on deleted evidence.

**Status: fixed, 2026-08-08, branch
`smith/phase-9/p9-15-open-findings-reach-task`** — the join the item calls "no
inference at all" could not be computed at all before this, because the anchoring
path survived only inside `computeFingerprint`'s digest, a one-way hash.
`file_path` is now a field on the `Finding` record and on the `finding-raised`
payload, required by `finding.schema.json`, and normalized the same way the
fingerprint normalizes it, so a finding raised as `./src\foo.ts` and a claim
written as `src/**` still meet.

`findingContext.ts` is the dispatch half, deliberately shaped like
`lessons for-dispatch`: `findingsForDispatch({sessionId, taskId, claims})`
returns the matching findings and a rendered block, and
`smith findings for-dispatch --session ... --plan plan.json --task <id>` prints
it for the caller composing the prompt. Three rules decide what is in the block —
open means `raised` or `confirmed`; the file must match one of *this* task's
claims; and the dispatching task's own findings are excluded. The block says
`CONTEXT, NOT SCOPE` and "never widens your claims" in its own text, and it
always renders: "injection ran and nothing matched" has to look different in a
transcript from "injection never ran".

The waiver half is `staleFindings` (`findings.ts`) over the merge history:
`emitWaveMerged` now records `files_changed` from `git diff --name-only HEAD^1
HEAD`, and a granted waiver whose finding is anchored to a file some *other*
task has merged over is refused with `waivers.stale-evidence`, naming the file,
the task that merged it, and the remedy. `smith findings reverify <id>` is that
remedy: a new `finding-reverified` event that re-dates the evidence.

Decisions worth recording:

- **`reverify` is its own verb, not a `transition`.** Re-verification does not
  move `finding_status`, and the two statuses it could be confused with mean
  something else entirely: `confirmed` cannot be re-entered, and `refuted` says
  the finding was wrong. "I re-read it and it still reproduces" needs an event of
  its own. `finding-reverified` was added to `taxonomy.yml` and mirrored into the
  architecture doc's §8 in this same PR, as that file's header requires — which
  also closed a pre-existing drift, since §8 was missing `integration-check`.
- **`--plan` is required on `findings for-dispatch`, unlike `lessons
  for-dispatch`.** Without a plan the claims list is empty, every finding fails
  the join, and the command would answer "nothing is open in your files" without
  ever having looked. An empty answer that was never computed is worse than an
  error.
- **Denials are allowed through a stale-evidence batch.** A denial closes nothing
  and grants nothing, so blocking it would only strand the batch. The merge
  history is read once per batch, and only when at least one decision is a grant.
- **The dispatching task's own findings are excluded on purpose.** They reach it
  as *scope*, through its own fix round. Re-attaching them here as "context, not
  scope" would tell the coder its own required work is optional.
- **Reviewer free text is escaped before it enters a prompt.** A finding summary
  is untrusted text going straight into a dispatch block; the HTML-comment
  delimiters are neutralised and multi-line summaries are folded onto one line,
  the same memory-poisoning guard `lessons.ts` applies on its side.
- **`--state-dir` now actually threads through the findings and waivers verbs.**
  `findings list`, `findings transition`, `waivers pending` and `waivers apply`
  parsed the flag and dropped it, so they answered about the real `state/events/`
  log instead of the session the operator named — an answer about a different
  session, which is worse than an error.

**Acceptance, measured.** Red first across the four unit files this touches
(`findings`, `findingContext`, `waivers`, `queue`): **16 failed / 53 passed
(69)** against the pre-change source, **83 passed (83)** after. Full suite under
Node v22.23.1: **767 tests across 44 files**, `pnpm typecheck` and `pnpm lint`
clean. The three CLI e2e tests in `cli.test.ts` — the claims join, `reverify`
leaving `finding_status` at `raised`, and a `reverify` of a finding the log never
raised — were written *after* the CLI wiring rather than before it; the model
underneath them is what was driven red-first.

One honest remainder: the projector's `findings` table has no `file_path`
column, so the SQL view of a finding still cannot answer "which file". Adding one
means a real drizzle migration (`db/projector.ts` runs `migrate()` against
`migrationsFolder`), which is its own change; the event log and the CLI are
complete without it, and every consumer this item names reads the log.

## P9-16 — The worktree is not isolated from the factory

**Evidence:** D-15, D-24, D-16, D-17, D-38. Four separate escapes, all hit in
the first two waves.

(a) **Path doubling (S2).** `worktree create` with a *relative* `projectDir` —
the exact form `/bs run` step 2 documents — builds `path.join(projectDir, 'wt',
taskId)` and hands that relative string to `git` running with
`cwd: projectDir`, so git resolves it a second time. The directory created is
`workspaces/envkit/workspaces/envkit/wt/<task>`; the path *returned* is the
un-doubled one. Exit 0, no warning. `removeTaskWorktree` and `listStale`
recompute the same wrong path, so create and remove agree with each other and
only a third party ever sees the discrepancy — which is why this survived to a
live run.

(b) **stderr leak.** `detectDefaultBranch` (`worktree.ts:32`) prints
`fatal: ref refs/remotes/origin/HEAD is not a symbolic ref` to the operator's
terminal for every project without a remote — which is the state `smith new`
leaves every project in.

(c) **Root-walk escape.** `pnpm install` inside a worktree walks up past the
worktree's `.git` pointer file, finds black-smith's own `pnpm-workspace.yaml`,
and fails with `ERR_PNPM_INVALID_WORKSPACE_CONFIGURATION`. The coder worked
around it with `--ignore-workspace` and said so in its result.

(d) **Borrowed toolchain (latent).** Wave 3's worktrees had a `node_modules`
containing `.vite` and `.vite-temp` and nothing else — all five green checks
resolved their binaries by walking up into black-smith's `node_modules`. Every
version happened to match exactly (typescript 7.0.2, biome 2.5.6, vitest
4.1.10), so the green was true, by luck. A version-skewed green is
indistinguishable from a real one, in exactly the case the gate exists to catch.

**Done looks like:** `path.resolve(projectDir)` once at the top of each worktree
entry point, with a regression test that creates from a relative dir with a
different cwd and asserts `fs.existsSync(returnedPath)` — the current tests
presumably all pass absolute paths. `stdio: ['ignore','pipe','ignore']` on the
remote probe. A boundary marker in the scaffold (`pnpm-workspace.yaml` with
`packages: ['.']`) so an upward root-walk stops at the project. And a gate
precondition that the worktree has its own dependencies — cheapest form, assert
`node_modules/.bin` exists before any check runs.

**Status: fixed, 2026-08-08, branch `smith/phase-9/p9-16-worktree-isolation`**

(a) was already closed, by P9-26. `taskWorktreeDir` resolves `projectDir` once
at the top, and the regression this item asks for exists as
`'resolves a relative projectDir instead of doubling it'` in `worktree.test.ts`
— it chdirs elsewhere, creates from a relative dir, and asserts the returned
path exists. Recorded here rather than re-claimed: the item is closed, the work
was someone else's.

(b) is now one module. `src/git.ts` is the only place the factory shells out to
git; `worktree.ts`, `claims.ts`, `immutability.ts`, `integration.ts`,
`queue.ts` and `scaffold.ts` each dropped their own two-line helper for it, and
`runPnpmOutdated` got the same `stdio` treatment. `GitCommandError` carries
git's stderr into the JSON envelope on stdout, credential-redacted.

(c) `factory/scaffold/base/pnpm-workspace.yaml.tmpl` with `packages: ['.']`, so
a project scaffolded into `workspaces/<name>` stops pnpm's upward walk at
itself.

(d) `checkWorktreeDeps` in `gate.ts` runs before anything else *executes* in the
worktree, emits `deps-check-result` on every path, and blocks with the new
`deps-missing` reason. The dashboard renders it as the gate stage it is.

Decisions worth recording:

- **Silence must not delete the diagnosis.** The item asks for
  `stdio: ['ignore','pipe','ignore']` — stderr to `/dev/null`. That is the D-47
  mistake one layer down: throw away the channel and the next real failure
  arrives as an exit code with no words attached. stderr is captured instead,
  and folded into the thrown error, so the operator sees nothing while git
  succeeds and sees git's own sentence the moment it doesn't. Two tests hold
  the pair together: `stderr` is `''` on a successful `worktree create`, and
  `''` *with git's message in the stdout envelope* on a failing `worktree rm`.
- **stdin is `'ignore'`, not `'pipe'`.** A git that decides to prompt — for a
  credential, for an editor — would otherwise block forever on input no
  unattended agent is going to type.
- **`execFileSync` returns stdout alone, so a successful child's stderr was
  being discarded.** The test helper hardcoded `stderr: ''` on the happy path,
  which means an assertion that a command is quiet passed without ever looking.
  That is why (b) survived two waves: `runProcess` (on `spawnSync`) now carries
  it, and a test proves a child that exits 0 after writing to stderr reports
  what it wrote.
- **Credential redaction is in the error path, not the log path.** git's stderr
  travels into `GitCommandError.message`, which reaches PR bodies and the event
  log; `https://user:token@host/…` becomes `https://user:***@host/…`, and the
  token-only form too.
- **Six test files moved onto a shared `git` fixture.** They were the loudest
  producers of the noise — 14 lines of `You appear to have cloned an empty
  repository` and `Preparing worktree` per full run. A log that always shouts
  cannot report anything, which is the second reason (b) stayed invisible.
- **The scaffold marker is a `.tmpl`.** Same reason as `biome.json.tmpl`: an
  untemplated `pnpm-workspace.yaml` sitting in `factory/scaffold/base/` would
  itself terminate a root-walk inside black-smith's tree.
- **The (c) test measures pnpm's answer, not the file's existence.** It
  scaffolds under a stand-in parent workspace and asserts `pnpm root -w` from
  the new project resolves to the project's own `node_modules`. A marker that
  existed but failed to stop the walk would pass a file-exists check and leave
  the bug in place.
- **(d) asks for `node_modules/.bin`, not `node_modules`.** Wave 3's worktree
  *had* a `node_modules` — containing `.vite` and `.vite-temp`, written by a
  vite run, and nothing else. That directory is precisely what made the
  borrowed toolchain look installed. A test creates exactly it.
- **A malformed `package.json` is not blocked here.** It is a real problem and
  not *this* problem; blocking on it would file a JSON syntax error under "you
  forgot to install". The schema and test gates downstream get to say it.
- **`deps-check-result` is emitted even when there is nothing to install** —
  P9-23 in miniature. A check that decided "nothing to check here" is a check
  that happened, and a log that omits it cannot be distinguished from one where
  the check never ran.

**Acceptance, measured.** 18 new tests. Red first, each watched: the six (d)
cases ran `3 failed | 3 passed | 41 skipped` under `-t "P9-16d"` (the three
passes are the pass-through cases, correctly green before the fix because they
assert preserved behaviour); the (c) case failed on
`missing pnpm-workspace.yaml: expected false to be true`; the UI case on
`expected 'history' to be 'shield-alert'`. The (b) escape was measured rather
than assumed — `grep -c "You appear to have cloned an empty repository"` over a
full run answered **14** before and **0** after, `Preparing worktree` likewise
**0**. (c) was measured the same way: `pnpm root -w` from a probe directory
inside `workspaces/` answered black-smith's own `node_modules` before the
marker existed. Green after: orchestrator **44 files / 750 tests**, UI
**6 files / 35 tests**, `pnpm typecheck` and `pnpm lint` clean over 135 files,
Node 22.23.1.

One honest remainder: (d) proves the worktree owns *a* toolchain, not the
*right* one. `node_modules/.bin` present with a stale or hand-installed set of
versions still passes, and the version-skew case in the evidence — five checks
that were green by luck because every version happened to match — would be
caught only by comparing the installed versions against the lockfile. That is a
larger check and it is not in this change.

## P9-17 — `token_usage` belongs to the dispatcher

**Evidence:** D-18, D-35 (S2). `result.schema.json` requires `token_usage` and
`coder.md` restates the shape, but an agent cannot read its own token meter, so
the field has exactly two honest values: a zero or a guess. Wave 2 wrote
`{0,0,0}`. Wave 3 wrote `{"input": 55000, "output": 12000}` and
`{"input": 60000, "output": 12000}`. Real per-agent totals from the harness in
the same session: 19,264 / 151,315 / 458,028 / 509,796 — not one is round, and
every agent-authored figure is round to the nearest 1000 or 5000. Both forms
pass the schema, because a schema validates shape and never provenance; wave
3's gate caught the *key names* and would have waved the fabricated numbers
through unchanged had the coders spelled them correctly, which is exactly what
wave 2 did. The dispatcher/agent split is already settled for `agent`,
`provider` and `model_tier` (interview N-1), where an agent writing an
orchestrator-owned field is a contract breach
(`ORCHESTRATOR_OWNED_FINDING_FIELDS`, `findings.ts:163`). `token_usage` is the
one field left on the agent's half that the agent has no instrument to measure
— and it is the only per-task cost signal in the envelope, so P9-18 depends on
it.

**Done looks like:** `token_usage` moves to the dispatcher's half, populated
from the harness's reported usage; the result-side equivalent of
`ORCHESTRATOR_OWNED_FINDING_FIELDS` makes an agent-written value a breach rather
than an input; and the field comes out of `coder.md`'s output contract in the
same change, or agents will keep filling it.

**Status: fixed, 2026-08-08, branch `smith/phase-9/p9-17-token-usage-ownership`**

`src/results.ts` is the result-side twin of `findings.ts`'s minting check.
`ORCHESTRATOR_OWNED_RESULT_FIELDS` is five long — the four from interview N-1
plus `token_usage` — and `stampResultEnvelope` throws
`results.agent-wrote-owned-field`, naming every offender at once, rather than
merging a document whose provenance is unknown. `total_tokens` is computed from
the two counts the dispatcher passes, so the envelope has two numbers to get
right instead of three.

`gate run` grew the second half of a shape it already had: with `--agent`
(plus `--provider`, `--model-tier`, `--input-tokens`, `--output-tokens`),
`--result` is the worker's half and the orchestrator stamps the rest — exactly
as `--evidence` mints findings. Without `--agent`, `--result` is still read as
a complete document, which is what replays and fixtures hand over.

The field came out of all six worker templates in the same change, as the item
asked. Each now names three keys, not four, and each "Never set" sentence lists
five fields, not four, with a paragraph saying why `token_usage` joined them.

Decisions worth recording:

- **No `agent-result.schema.json`.** The judge side has no evidence schema
  either; the ownership check lives in code where it can name the offending
  field, and `result.schema.json` — already `additionalProperties: false` —
  validates the merged document. A second schema would be a second thing to
  drift.
- **A throw, not a gate event.** A result whose provenance is unknown should
  not reach the gate at all, so this is `mintFindings`' failure mode, not a new
  blocked reason. It also keeps the event vocabulary and the dashboard out of
  this change.
- **Zeros are rejected as firmly as fabrications.** `{0,0,0}` is the wave-2
  shape and reads as "empty, so harmless". It is a measurement the agent could
  not take, landing in the only per-task cost signal the epic has, and P9-18
  will read it.
- **`total_tokens` is derived, not accepted.** A third number that can
  contradict the other two is a third thing to fabricate.
- **The dispatcher's own numbers are checked too.** `results.invalid-token-count`
  and `cli.non-numeric-flag` catch a NaN at the flag, so `--input-tokens abc`
  is named where it happened instead of surfacing as a schema complaint about
  `/token_usage`.
- **Zero from the dispatcher is legal.** A run really can spend nothing; the
  objection was never to the value, only to who wrote it.
- **Interview N-1 was amended, not rewritten.** The accepted answer stands as
  recorded with a dated amendment beneath it. Its own reasoning — "self-reported
  provenance is not evidence" — is the argument that moved this fifth field; it
  simply stopped one field short.

**Acceptance, measured.** 17 new tests, red first and watched: `results.test.ts`
failed to import a module that did not exist yet, and the two new `gate run`
cases failed `expected 1 to be +0` while the third — the pre-minted replay path
— passed from the start, which is what makes it a regression guard rather than a
new feature. Green after: orchestrator **44 files / 750 tests** (was 43 / 733 on
this branch's base, measured by stashing the change), UI **6 files / 34 tests**,
`pnpm typecheck` and `pnpm lint` clean over 135 files, Node 22.23.1.

One honest remainder: nothing yet *supplies* the two counts. The gate will now
refuse an agent-written figure and stamp whatever the caller passes, but the
caller today is a human operator or the `/bs` skill reading the harness's usage
line by eye. A dispatcher that reads usage off the SDK response and fills these
flags itself is the other half of D-18, and it is not in this change.

## P9-18 — Budgets: correct the header, measure, then enforce

**Status: fixed, 2026-08-08, branch `smith/phase-9/p9-18-budgets`** — the three
steps in order, and the third one answers "limit or signal" differently per
field.

`factory/orchestrator/src/diffstat.ts` is the measurement:
`measureDiff(worktreeDir, {baseRef?})` runs `git diff --numstat -z` against the
integration branch the task-branch name implies (or an explicit base), and
returns `{baseRef, diffLines, excludedLines, files}`. `budgets.ts` gains
`TASK_BUDGET_FIELD_READERS` — one entry per declarable field, naming the thing
that reads it or `null` — and `checkTaskBudget`, which compares a declaration
against what was measured. `validatePlan` rejects any field whose reader is
`null`, and `runGate` runs the check and emits a `budget-check-result` event on
every run. `smith gate run` picks the budget up from the `--plan` it already
takes for finding ownership; `--base` is there for callers that know their
exact base.

Per field, as of this change: `tokens` is a **signal**, compared against the
result's `token_usage.total_tokens`. `diff_lines` is a **signal**, compared
against the measured diff. `max_turns` is **neither** — it now fails plan
validation.

Decisions worth recording:

- **`max_turns` has no host, and the honest fix is to refuse it, not to build
  one.** The Agent tool exposes no turns parameter (agent-interviews.md M-4,
  answered (c) on 2026-08-05), so a turn limit can only ever be a sentence in a
  dispatch prompt. Leaving the field in the plan file makes it *look* enforced,
  which is the exact defect this item is about. The validation error names where
  the number belongs rather than just rejecting it. It stays schema-*valid* so
  plans cut before today still load — a plan is immutable, and breaking the
  loader for historical files would be a worse cure than the disease.
- **Overruns record and report; they do not block.** Blocking a green, reviewed
  task on its budget moves D-29's "trade finishing for compliance" pressure off
  the agent and onto the gate, which does not remove it. It would also need a
  `finding_category` the taxonomy does not have, and inventing a vocabulary
  value is a change to `taxonomy.yml` with its own PR (P9-20's neighborhood).
- **The check runs before the testgate, not after.** The runs that most need an
  economy record are the expensive ones that then failed. A check gated behind
  green tests would never produce one for them.
- **Measurement throws rather than returning zero.** A zero that means "no diff"
  and a zero that means "I could not look" are the same number to a cap, and
  only one of them should pass. Every failure path is a typed `DiffstatError`
  with a code — including a directory git has never heard of
  (`diffstat.not-a-git-worktree`), which would otherwise surface as a raw shell
  string and read like a bug in the gate.
- **Unmeasurable degrades the check, it does not cancel it.** When the diff
  cannot be measured the token half is still checked and reported, and
  `diffLines` is simply absent — not zero.
- **Lockfiles and generated output are excluded but still reported.**
  `excludedLines` is on the record, so the omission is auditable rather than
  invisible. Exclusion is by basename at any depth (twelve lockfile names) and
  by path segment (`dist`, `build`, `coverage`, `node_modules`, `.next`,
  `__generated__`); `src/lock.ts` is not a lockfile.
- **`-z`, and a real parser for it.** The default numstat format quotes and
  backslash-escapes any path with a space or a non-ASCII byte, so the path you
  compare is not the path git changed. `-z` fixes that and introduces a second
  problem: a rename is three NUL fields, not one, and read naively it counts as
  a nameless file plus two phantom ones. `parseNumstat` has a test per record
  shape.
- **The event is always emitted, including when there is nothing to check.** One
  of three honest statuses — `checked`, `not-declared`, `unmeasurable`. A check
  that ran and found nothing is a different fact from a check that never ran,
  and only one of them is visible if the no-op stays silent (a second down
  payment on P9-23, after P9-16's `deps-check-result`).
- **No new gate flag.** A budget the gate can check is by definition one the plan
  already stated, and the gate already reads the plan. A task the plan does not
  name — a follow-up minted by `findings raise`, D-48/P9-31 — reports
  `not-declared` rather than refusing to gate; ambiguity still throws.

**Acceptance, measured.** Red first, in this session, then green: `diffstat.test`
went from module-not-found to **15 passed**; `budgets.test` from **11 failed | 3
passed** to **14 passed**; `plan.test` from **2 failed | 17 passed** to **19
passed**; the six new `gate.test` budget cases from **6 failed | 41 passed** to
green; and the two new `cli.test` cases were re-run with the `--plan`→budget
wiring removed to confirm they fail without it (`expected { status:
'not-declared' } to match { tokensUsed: 150, overruns: [{tokens, 100, 150}] }`)
before being restored. Full suite under Node 22.23.1: **770 passed (44 files)**,
up from 761. `pnpm typecheck` and `pnpm lint` clean.

One honest remainder: `factory/specs/active/envkit-config-loader/plan-v1.json`
declares `max_turns` in all six task budgets and now fails `smith plan validate`.
Nothing in the suite or CI validates that historical plan, so nothing goes red —
but the dogfood epic's plan is, as of today, an invalid plan by the factory's own
rule. It is left as-is deliberately: plans are immutable, and rewriting a shipped
plan to satisfy a rule written after it would be the more dishonest of the two
options. Also unaddressed here, on purpose: the plan-quorum budget trigger still
sums *declared* task budgets rather than projected epic cost including judges,
review rounds and planning — the ~1.6M-vs-545k gap in the evidence below. The
measurement this item adds is what a real projection would need, but building it
is a change to the trigger, not to the budget record.

**Evidence:** D-12, D-29, D-9. `budgets.yml:3` says the caps are "enforced
mechanically by the loop runner". Repo-wide, `diff_lines`/`diffLines` and
`max_turns`/`maxTurns` have **zero** consumers in `factory/orchestrator/src`;
`epic.alarm_ratio`, the per-task coder caps, the researcher and judge caps and
`concurrency.max_parallel_workers` have no runtime host either. Only
`epic.cap_tokens` does — read once by the plan-quorum budget trigger, and only
as the sum of *declared* task budgets. `budgets.ts`'s own module header says
exactly this, so two files in the same policy directory make opposite claims and
an operator reads the wrong one first.

The consequence is not bookkeeping. `task-3-validate` ran 40 tool uses against
`max_turns: 30`, and spent its tail shaving lines to land exactly on
`diff_lines: 260` — stopping mid-procedure to do it, its final message being
"One more line to trim." A cap the agent polices itself becomes a pressure on
the work, and the orchestrator gets neither the budget nor the deliverable.
Separately, the plan-quorum budget trigger measures the smaller half of the
bill: this plan's task budgets summed to 545,000 against a 2M cap, so the
trigger stayed quiet, while the projected epic cost including judges, review
rounds and planning was ~1,635,000 — past the 1.4M alarm ratio.

**Done looks like:** first the header states what is enforced today and what is
prompt-level — one line, no code, removes a false guarantee. Then measure: the
merge queue captures `git diff --numstat` per task and the dispatcher records
real token spend (P9-17), so every cap becomes at least auditable, which is also
what the budget trigger needs in order to compare declared against actual. Then
decide per field whether it is a limit or a signal: `max_turns` is a limit and
belongs in the dispatch harness, `diff_lines` works better as a gate-time
comparison against the measured diff than as a self-imposed live cap. A field
in the plan with zero readers should fail plan validation rather than sit there
looking enforced.

## P9-19 — The scaffold must be able to run its own gates

**Evidence:** D-3, D-3a, D-3b, D-4. `smith new` produces a project that
declares an 80% coverage floor and ships no lockfile, no `node_modules`, and no
`@vitest/coverage-v8`. The first task of any epic in a fresh project is
therefore a serial toolchain task before any feature work can be dispatched —
`task-0-toolchain` exists for no other reason, claims the hottest files in the
repo, and makes wave 1 one task wide for reasons unrelated to the epic. The
same gap fails again elsewhere: `ci.yml` runs `pnpm install --frozen-lockfile`
against no committed lockfile, so the first PR out of any epic red-CIs on step
one unless that epic happens to create the lockfile. CI runs lint, typecheck,
test and build but never `test:coverage`, so the 80% floor this epic spent a
whole serial task making per-file is enforced only by the factory's own gate and
never by CI. And `ci.yml`'s `push: branches: [main]` trigger cannot fire at
all: `smith new` leaves the project on a single branch named `setup`, with no
`main` or `master` anywhere — which is also outside the case `guardrails.md` was
written for, since it reasons about `main`/`master` being untouchable.

**Done looks like:** the scaffold ships a lockfile and the coverage provider, or
`smith new` runs the install itself and proves the toolchain works before an
epic is ever planned against it — that cost belongs to scaffolding, not to the
first epic's budget. `ci.yml` runs coverage, and its trigger names the branch
the scaffold actually creates.

**Status: fixed, 2026-08-08, branch `smith/phase-9/p9-19-scaffold-gates`**

Both halves of the "or", because neither alone closes it. The scaffold now
ships `pnpm-workspace.yaml`, `@vitest/coverage-v8`, a `test:coverage` script and
a coverage `exclude` list; and `smith new` installs the toolchain and runs the
project's own gates — `pnpm install`, `lint`, `typecheck`, `test:coverage`,
`build`, in exactly `ci.yml`'s order — before it makes the first commit. The
result envelope carries a `toolchain` report (`verified` / `failed` / `skipped`,
per-step exit codes, the exact re-run line, and a 4 KB output tail on the step
that went red), and the command exits 1 on a red one. `task-0-toolchain` no
longer has a reason to exist.

Decisions worth recording:

- **The install was not slow, it was impossible.** Reproducing D-3 turned up a
  bigger fact than the item states: `pnpm install` could not run *at all* in
  `smith new`'s default target. pnpm walks up for a workspace root, finds
  black-smith's own `pnpm-workspace.yaml` — which declares no `packages` — and
  dies with `ERR_PNPM_INVALID_WORKSPACE_CONFIGURATION` before resolving a single
  dependency. The boundary marker P9-16(c) prescribed for worktrees was missing
  from the scaffold for the same reason, and it is the same one-file fix:
  `packages: ['.']`, which stays correct once the project moves to its own
  remote and has nothing above it to find.
- **The 80% floor was unmeetable on `--ui` before anyone wrote a line.** Also
  not in the item, also found by running it: `src/main.ts` is the three-line
  Vite mount entrypoint, v8 counts every file matching `include` whether it was
  loaded or not, and a freshly scaffolded UI project measured **50% lines** and
  failed its own floor on its first run. `exclude: ['src/main.ts',
  'src/**/*.d.ts']` fixes it, and a test asserts the stronger property — every
  `src/**/*.ts` the floor counts is either exercised by a test or named in
  `exclude`, so the next module added to the scaffold cannot quietly go
  uncounted.
- **The scaffold's install carries no `--frozen-lockfile`, and runs before
  `git init`.** This run is what *creates* the lockfile that CI's frozen install
  then checks against — the reason the first PR out of any epic red-CI'd on step
  one. Ordering it before the commit is what puts `pnpm-lock.yaml` in the
  scaffold's first commit; a test writes a lockfile from an injected runner and
  then asserts `git ls-files` contains it, so the ordering cannot silently
  regress.
- **Fail fast, and keep the tree.** The run stops at the first red step, the way
  `ci.yml`'s step list does: the operator needs to know which gate went red
  first, and running four more commands against a tree that failed `install`
  produces noise, not evidence. Nothing is deleted on failure — the half-built
  tree is what the operator fixes.
- **`--skip-toolchain` reports `skipped`, never a green.** An offline operator
  gets an escape hatch, and the report says plainly that no gate was proven. A
  scaffold that quietly reported nothing is the original D-3 gap with extra
  steps.
- **CI triggers on `[main, setup]`, and the scaffold still creates `setup`.**
  Naming only `main` meant the workflow could not fire on a fresh project at
  all, because a fresh project has no `main` yet. Renaming the scaffold's branch
  to `main` would have been the other way to close it and was rejected: it puts
  every scaffolded project's first push on the branch `guardrails.md` calls
  untouchable. Naming both branches covers the scaffold's whole life instead of
  only the half after the first merge.
- **CI runs `test:coverage` in place of `test`, not in addition.** Two steps
  would pay for the suite twice; leaving coverage out is how a declared floor
  ends up enforced by nothing but the factory's own gate.
- **The suite still never installs from the network.** The toolchain logic is
  covered through an injected `RunCommand` seam; the three CLI tests that spawn
  a real `smith new` pass `--skip-toolchain`, and `mcp.test.ts`'s scaffolding
  helper sets `skipToolchain` directly. The real install is acceptance
  evidence, recorded below, not a cost the suite pays on every run.

**Acceptance, measured.** Eight new tests in `scaffold.test.ts` red against the
pre-change source (`Tests 8 failed | 6 passed (14)`), green after
(`14 passed (14)`); the new CLI test watched red at `expected +0 to be 1` with
the exit-code line reverted, green with it restored. End-to-end, for real, with
network installs: a base project scaffolded to a scratch dir, a `--ui` project,
and one into the default `workspaces/<name>` target — the exact directory where
install used to be impossible — all three reported
`toolchain.status: "verified"` with all five steps `ok`, and the `--ui` project
that measured 50% now passes coverage at 100% (1/1 statements, 1/1 functions).
That the floor still bites was proven by adding an untested export to the
scaffolded `src/index.ts`: exit 1, `index.ts 25% stmts / 33.33% lines`, four
threshold errors. Full suites green in-session: orchestrator **43 files / 742
tests**, UI **6 files / 34 tests**, `pnpm typecheck` and `pnpm lint` clean, Node
22.23.1 / pnpm 9.3.0.

One honest remainder: the scaffold's gates are run, not the *judges'* — nothing
here checks that a worktree cut from a scaffolded project has its own
`node_modules`, which is the other half of P9-16(d). And `pnpm install` without
`--frozen-lockfile` means the scaffold resolves at scaffold time, so two
projects created a month apart can hold different transitive versions; pinning
that is a lockfile-in-the-template decision this item deliberately did not make.

**Integration addendum (`smith/phase-9/integration`).** This item extended
`scaffold.ts`'s import to `{ execFileSync, spawnSync }` for the toolchain
runner. P9-16, on a branch cut in parallel, deleted the `git()` helper that was
`execFileSync`'s only caller and deleted the import along with it. Git resolved
the pair the only way it can — a modified line beats a deleted one — and
produced an import of a symbol nothing calls. Neither branch's CI could fail on
it, and it is invisible to `tsc`. `pnpm lint` on the assembly caught it:
`scaffold.ts:8:10 lint/correctness/noUnusedImports`. Dropped `execFileSync`;
`spawnSync` at line 242 is the one remaining caller. Worth recording because
the failure mode is generic — one branch removes a use, another adds one to the
same line, and the merge is clean and wrong.

**Follow-up: D-179, 2026-08-19.** The same pair did it twice. P9-16 added
`factory/scaffold/base/pnpm-workspace.yaml.tmpl`; this item, on the branch cut
in parallel, added `factory/scaffold/base/pnpm-workspace.yaml` — the same file
under the name the `.tmpl` convention strips it to. Two paths, not one line, so
the merge was clean and there was no unused symbol for `pnpm lint` to find. The
result shipped for eleven days: `copyTemplateDir` wrote both to one destination
in `readdirSync` order, which is unsorted, so which of the two rationales
reached a scaffolded project depended on the filesystem, and `filesWritten`
reported eleven files for ten. Every assertion covering this file set is an
`existsSync`, and a collision satisfies presence twice over. `copyTemplateDir`
now refuses a directory whose entries strip to the same destination, and the
duplicate is deleted. The addendum's closing sentence holds and wants widening:
the merge is clean and wrong whenever two branches say the same thing in two
places, and only the single-line case leaves evidence a linter can read.

## P9-20 — Validate the vocabularies the taxonomy declares

**Evidence:** D-6, D-37, D-7. Three instances of the same asymmetry: a
controlled vocabulary is declared, and nothing checks membership at the point of
writing.

`taxonomy.yml:166` declares `edge_type` and `edge_provenance` as required
dimensions on a plan edge; `validatePlan` (`plan.ts:144-154`) checks only that
each edge's `task` and `dependsOn` name real tasks. A plan carrying
`"edge_type": "NOT-A-REAL-EDGE-TYPE"` validates clean, exit 0, reproduced twice.

`finding_category` cost a full gate round in wave 3: a reviewer tagged
`test-gap`, a plausible synonym for the real `test-coverage`, because nothing
ever showed it the list. Its own brief enumerates severity inline
("`S1-stop-the-line`, `S2-major`, … bare `S2` is rejected") and gives category
only a *path to a file*; across the five judge briefs, one contains a single
category literal (`reviewer.md:49`) and one contains two (`spec-reviewer.md:68`),
each for a specific rule rather than as the vocabulary. The validation timing
repeats the split: `mintFindings` validates severity at mint, canonicalises a
bare `S2`, and enumerates the legal values on failure, while `finding_category`
is copied through untouched and first checked at gate intake — after five checks
have already run — with an error naming no legal value.

Third: `result.schema.json` defers `structured_output`'s shape to the task
spec's `output_schema_ref`, and `factory/specs/schema/` contains no per-task
schemas at all. Every `output_schema_ref` points at nothing and every
`structured_output` passes.

**Done looks like:** `validatePlan` looks up every declared dimension value in
the taxonomy, the way task specs already do through `validateRecord`;
`mintFindings` validates `finding_category` beside severity, with the same
`Valid: …` enumeration and the same synonym canonicalisation; and the nine
category literals are inlined into every judge brief exactly as severity already
is.

**Status: fixed, 2026-08-08, branch `smith/phase-9/p9-20-taxonomy-vocab`**

All three instances now check membership at the point of writing.

`validatePlan` runs `validateRequiredDimensions(taxonomy, 'edge', edge)` over
every edge, accumulating each rejection at `/edges/<index>` instead of throwing,
so a plan with three bad edges names all three in one pass — the same shape the
task-spec loop above it already has. `validateTag` carries the legal vocabulary
in its error details and drops it from the sentence, so `describeAllowed`
appends it: a plan author reading a validation report has no other way to see
the list, and "unknown value" without the list is the exact defect being fixed.

`mintFindings` validates `finding_category` immediately after severity, with the
same `Valid: …` enumeration. The canonicalisation the severity check had —
`S2` → `S2-major` — was generalised into one `suggestCanonical` helper that both
now share: bare head, bare tail, or exactly one shared hyphen token, each rule
firing only when it picks out a single candidate. It is derived from the
vocabulary rather than a synonym table, so it cannot drift from `taxonomy.yml`.
It suggests and never corrects — the evidence is rejected either way.

The nine literals are inlined in `reviewer.md`, `security-reviewer.md` and
`spec-reviewer.md`, the only three briefs that write a category.

Decisions worth recording:

- **Edges go through `validateRequiredDimensions`, not a new schema.**
  `taxonomy.yml`'s `rules.required_dimensions.edge` is already the register of
  what an edge must carry. A `plan-edge.schema.json` would be a second register
  that can drift from the first. This also gives `validateRequiredDimensions`
  its first production call site — it has been exported and unit-tested since
  Phase 2 and called from nothing, which is a quiet instance of the same
  declared-but-unchecked pattern this item is about.
- **Inlining a vocabulary into a brief is paid for with a drift test.** The
  architecture's "enums are never inlined" rule is about schemas, and the reason
  is drift. `taxonomy.test.ts` now reads the three briefs from `AGENTS_DIR` and
  asserts their `finding_category` bullets are set-equal to `taxonomy.yml`'s —
  adding a tenth category and not updating the briefs is now a red test, not a
  wasted gate round six months later.
- **D-7 is fixed as "the ref must resolve", not "the ref must be per-task."**
  `validatePlan` reduces each `output_schema_ref` to the name `compileSchemas`
  keys on — path, bare filename, `$id` URL and bare name all land on the same
  key — and reports one when the factory has no such schema, naming what it does
  have. Rejecting `result.schema.json` outright would be the stricter correct
  fix, but it fails the live envkit plan and forces per-task schemas to be
  authored, which is a planner-contract change well past this item.

**Acceptance, measured.** Against the built CLI: the D-6 repro
(`edge_type: "NOT-A-REAL-EDGE-TYPE"` grafted onto the envkit plan) now exits 1
with `{"path":"/edges/0", … "Valid: artifact, claim-order, spec-clause,
regression-test, research-brief."}` where it used to print `{"valid":true}` and
exit 0; the D-7 repro (`output_schema_ref` pointing at a schema that does not
exist) exits 1 naming the seven schemas that do. Against `dist/findings.js`,
`test-gap` throws `findings.non-canonical-finding-category` and names
`test-coverage`, `coverage` and `hds` do the same, `zzzz` is rejected with the
full list and no guess. Every committed plan file still validates
(`plan-v1.json` → `{"valid":true}`). `pnpm test` 747 passed / 43 files,
`pnpm test:ui` 34 passed, `pnpm typecheck` and `pnpm lint` clean.

One honest remainder: the ref now has to resolve, but every plan in the repo
still points it at `result.schema.json`, the envelope — which constrains
`structured_output` not at all. The check that was missing is now present and
passing vacuously. Writing real per-task output schemas is planner work, not
orchestrator work, and it is not in this branch.

## P9-21 — CLI legibility

**Evidence:** D0, D-21, D-36. `smith` and `smith --help` both answer
`{"error":{"message":"Unknown command: "}}`, so every command's argument shape
has to be read out of `cli.ts` or `SKILL.md` — which cost real time in this
session and is the cheapest item on this list. `event tail` with a typo'd
session id, and `event tail` with the positional omitted entirely, both return
`[]` and exit 0: `cli.ts:298` reads `positional[0] as string`, and the
`as string` is a lie when nothing was passed. An empty result and a malformed
query produce the same output, and the malformed one answers confidently. And a
gate blocked on schema returns
`{"outcome":"blocked","reason":"schema-invalid","testResult":null,"blockingFindings":[]}`
— the nine actual validation errors exist only in the preceding
`schema-check-result` event, which the operator has to know to go looking for.
For `tests-failed` the CLI does return `testResult` inline, so the asymmetry is
an omission rather than a position.

**Done looks like:** a `usage` branch listing `<ns> <action>` pairs with their
positional and flag shape, exit 0 for `--help` and exit 1 with the same text for
an unknown command; a positional equivalent of `requireFlag` that fails
`cli.missing-positional` rather than answering `[]`, and — cheaply, since the
events dir is listable — distinguishes an unknown session from an empty one; and
the `schema-check-result` errors returned inline on `reason: 'schema-invalid'`,
exactly as `testResult` already is.

**Status: fixed, 2026-08-08, branch `smith/phase-9/p9-21-cli-legibility`**

`src/usage.ts` is now the single register of what `smith` can be asked to do:
one `CommandDoc` per dispatch key, holding the positionals separately from the
flags, because `requirePositionals` counts the `<placeholders>` in the first
field and must not count the second. `--help`, `-h` and `help` in the namespace
slot all resolve through the same lookup, so `smith gate run --help` and
`smith help gate run` print byte-identical text. An unknown command prints that
same text on stderr and the structured error on stdout — the split that lets
`| jq` keep working while a human still reads the usage.

Decisions worth recording:

- The table is not allowed to lag the dispatcher, in either direction. `cli.ts`
  calls `isDocumented(namespace, action)` before dispatch and refuses what
  `usage.ts` does not describe, which makes "documented ⊇ reachable" structural
  rather than aspirational — a command added without a doc line cannot run at
  all. The other direction is a test: `test/usage.test.ts` reads the command set
  back out of `cli.ts` by regex and asserts set-equality with `COMMANDS`. That
  extractor can fail open, so it is itself guarded — four shape assertions plus
  a floor on how many commands it must keep finding, so a refactor that blinds
  it fails loudly instead of comparing two empty sets.
- `requirePositionals` takes the `CommandDoc`, not a hand-written usage string.
  The old signature invited a usage line that described a shape the parser no
  longer enforced. Two `required: n` overrides disappeared as a side effect —
  `worktree verify` and `claims check --roots` only needed them because flags
  used to live in the counted string. `wave check` keeps its override, and now
  it is the only one, which is the honest reading of "this command really does
  take an optional second positional".
- `schemaErrors` on `GateOutcome` is required, not optional, for the same
  reason `testResult` is: an absent field and an empty array must not both mean
  "no errors". `reason: 'tests-failed'` and `reason: 'findings'` carry `[]`.
- The unreachable unknown-command tail at the end of `main()` stayed. It cannot
  fire while `isDocumented` and the branches agree, but a function returning
  `Promise<number>` has to return on every path, and an unreachable `throw`
  would be a worse answer than the honest one.

**Acceptance, measured.** `smith --help` exits 0 and lists all 48 documented
forms; bare `smith` prints that identical text on stderr with
`{"error":{"message":"No command given."}}` on stdout and exits 1 (`diff` of the
two streams: identical). `smith plan --help` narrows to the four `plan`
commands. `smith gate run --help` prints the one block, and `smith help gate
run` prints the same bytes. `smith teleport` and `smith plan teleport` exit 1
with the all-commands and the `plan` listing respectively. `smith plan validate`
now exits 1 with `cli.missing-positional` and
`Usage: smith plan validate <plan.json>`. `smith stats bogus` is refused before
the DB is opened, where it used to fall through. A gate blocked on schema
returns the nine validation errors inline, and `test/gate.test.ts` asserts they
are the same objects the `schema-check-result` event recorded, not a re-derived
summary. Suite: 44 files / 763 tests green (usage.test.ts is new — 20 of them),
UI suite 6/34 green, `pnpm lint`, `pnpm typecheck`, `pnpm build` all exit 0.

One honest remainder: bullet two of the contract above — the positional
equivalent of `requireFlag`, distinguishing an unknown session from an empty one
— was already delivered by **P9-28**, not by this branch. The cli test written
for it here passed against the unmodified binary before a line of P9-21 was
written, which is how it was caught. `smith event tail sess-nope` exits 1 with
`events.unknown-session`; a session whose log exists but is empty still returns
`[]` and exits 0. The evidence paragraph above is stale on this point:
`cli.ts:298` no longer reads `positional[0] as string`. One P9-28 assertion was
rewritten rather than deleted — it asserted the error message must not contain
`--session`, which is now false on purpose because the usage line names the
flags; it now asserts the missing *positional* is what gets reported, which was
the behaviour it existed to protect.

## P9-22 — Artifacts need a home the gate can check

**Evidence:** D-19. The wave-1 coder recorded three artifacts at
`/tmp/probe-fail-output.txt`, `/tmp/probe-pass-output.txt` and
`/tmp/final-test.txt`. The evidence in them was real, and `/tmp` is outside both
the worktree and the session scratchpad: not claim-checked, not captured with
the branch, not carried into the PR, and swept periodically by the OS.
`result.schema.json` types `artifacts` as `[{type, path, description?}]` with no
constraint on `path`, no template says where artifacts belong, and the gate
reads the result file rather than the artifacts — so nothing notices when a
declared path has already evaporated.

**Done looks like:** `state/artifacts/<task-id>/` as the declared home, beside
`state/results/<task-id>.json`, stated in the templates, with the gate verifying
that each declared `artifacts[].path` exists at schema-check time. An artifact
that cannot be opened when the verdict is written is not evidence.

**Status: fixed, 2026-08-08, branch `smith/phase-9/p9-22-artifact-home`**

`state/artifacts/<task-id>/` is now the one home. `src/artifacts.ts` computes it
(`artifactHome`) and checks a result's declarations against it
(`checkArtifacts`); the gate runs that check between the schema check and the
tests and blocks with a new `reason: 'artifacts-missing'`, listing every bad
path in a required `artifactIssues` field. The six worker templates, the result
schema's `path` description and the operator guide's §5 all say where artifacts
go, and `gate run --artifacts-dir` moves the root for tests and replays.

Decisions worth recording:

- **One home, not two.** Allowing the worktree as a second legal home was the
  tempting design — a coder's test output is already there. The durability
  probe killed it: the `/tmp` and scratchpad files from the dogfood run are
  *still on disk today*, while `workspaces/envkit/wt/task-4-api` is **gone**,
  because the worktree was removed after the merge. The path that looks most
  like a project path is the one that survives least.
- **Existence alone was never the property.** A `/tmp` file that exists today
  passes an existence check and dangles next reboot. So containment is checked
  first and reported as `outside-home`; `missing` is reserved for the right
  place with nothing in it. When a path is both wrong and absent, the
  actionable half is the wrong place, so that is what is reported.
- **`artifactIssues` is required, `[]` when clean** — same rule P9-21 applied to
  `schemaErrors`. An absent field and an empty one must not both have to mean
  "nothing wrong here".
- **Directories pass.** An html coverage report and a Playwright trace are real
  artifacts and neither is a file. The gate checks that a path resolves inside
  the home and exists; whether the bytes support the claim is a reviewer's job,
  not a `stat` call's.
- **`artifact-check-result` is emitted even when the task declared nothing** —
  `{ok: true, checked: 0}`. A check that only speaks up when it has something to
  say is indistinguishable, later, from a check that never ran. That is P9-23's
  whole complaint, paid down here in advance.
- **A blank or missing `task_id` is refused, not tolerated.** This was not
  designed in; it was found by running the check over the real results, where 16
  of 21 files carry no `task_id` at all. An empty id resolves to the artifacts
  *root*, which contains every task's home — so every path would have passed
  containment. An id with `..` in it is refused for the same reason.

**Acceptance, measured.** `pnpm test` 44 files / 750 tests green; `pnpm test:ui`
6 / 34; `pnpm lint`, `pnpm typecheck`, `pnpm build` all exit 0. `artifacts.test`
is new — 12 tests — and `gate.test` gained 5. Run over the real dogfood results
in `state/results/`, the check reports **17 of 17 declared artifacts bad across
7 files**: three `/tmp` paths (task-0) and seven scratchpad paths (task-1a,
task-2) as `outside-home` — all ten still on disk, which is exactly why
existence was the wrong test — plus `src/parse.ts`, `test/parse.test.ts`,
`src/validate.ts`, `test/validate.test.ts` (source files declared as evidence),
a result file naming *itself* as its own artifact, and task-4's two worktree
paths, now `missing` because the worktree is gone. Driven end to end through the
built binary: a result declaring `/tmp/final-test.txt` plus an absent
`coverage.txt` exits 1 with `reason: "artifacts-missing"` and both issues named,
`artifact-check-result` in the log ahead of the `gate-outcome`, and no
`testgate-result` at all; the same result with a real `coverage.txt` and a
`shots/` **directory** in the home exits 0 with `{"ok":true,"checked":2}`
logged.

One honest remainder: the researcher and uiux templates told those roles to save
their brief under the epic's spec directory, which is durable but is not the
artifact home. Rather than move the brief — planners and coders read it where it
is — the templates now say to keep a copy in the home and declare that path. A
copy is a wart, and the alternative (a second legal home for repo-relative
committed paths) is indistinguishable at check time from the worktree paths that
did not survive.

## P9-23 — Record that a check happened, including when it was a no-op

**Evidence:** D-10, D-1b. `smith plan quorum` ran on this epic, fired six
security triggers, returned `{"outcome":"endorsed"}` and exit 0 — and wrote
**zero events**. `planQuorum.ts:425-429` returns early when no external provider
is enabled, before the step-5 emit that exists to "emit exactly once, for any
case that actually ran a quorum". Both providers ship `enabled: false` in
`crosscheck.yml`, so the zero-provider path is the only path the shipped
configuration can take: the command is a no-op that returns exit 0 and writes
nothing, and an operator reading the log later cannot distinguish "endorsed by
default because nothing was enabled" from "nobody ever ran it". The event log is
the declared source of truth.

The same gap covers the asymmetric-review rule. The roles are dispatchable by
name now (D-1, PR #19), so a template's `model:` is honoured — but nothing
asserts that the spec-reviewer's model differs from the planner's. In this run
it held only because the operator passed `model: sonnet` by hand on every
spec-review dispatch against an opus planner.

**Done looks like:** the quorum-decision event is emitted on the zero-provider
path too, carrying the fired triggers and an explicit
`endorsed_by: "default-no-provider"`; and the dispatched model is recorded per
role in the event log, so a check can assert planner-model ≠ spec-reviewer-model
after the fact. Telling "checked and endorsed" apart from "nothing checked it"
is the entire job of an audit trail.

**Status: fixed, 2026-08-08, branch `smith/phase-9/p9-23-record-noop-checks`** —
two halves, because the item is two instances of one disease: a check that did
not record itself is indistinguishable, afterwards, from a check that never ran.

**Half A — the no-op quorum now writes its event.** `runPlanQuorum` returned
early on two paths (zero triggers at step 1, zero enabled providers at step 2)
before ever reaching the step-5 emit. Both now emit, so there are three exits
and all three write exactly one `quorum-decision`. The payload gained a required
`endorsed_by`, typed `'no-triggers' | 'default-no-provider' | 'quorum'`, which
is the field that makes the record readable a month later: `outcome: "endorsed"`
alone never said *why*. The all-failed and shadow-only fallbacks report
`default-no-provider` too — they endorsed by default just as much as an unconfigured
run did, and giving that its own name would have implied a distinction the
decision does not have. `outcome` is `gating?.outcome ?? 'not-run'`, so a
no-op reads as `not-run` rather than borrowing a verdict nobody rendered.

**Half B — the dispatched model is on the record.** The asymmetry rule could
not have been checked even by an operator willing to read the whole log:
`dispatch_decision` carried `model_tier`, and opus and fable are both
`frontier`. So `model` (the concrete id) is now a required dispatch dimension,
`crosscheck.yml`'s `asymmetric_roles` names the pairs it means
(`planner`/`spec-reviewer`, `reviewer`/`verifier`) instead of only asserting
that pairs exist, and `smith dispatch check <session-id> [--task <id>]` asserts
the rule against the log. Note `black-smith-architecture.md` §7 has specified
`model` in the `dispatch_decision` payload since Phase 1 — this half is the
implementation catching up to the spec, not a new requirement.

Decisions worth recording:

- **`model` is required, not optional.** An optional field is dropped exactly
  where it matters most, and its absence would then read as compliance — the
  precise failure the field exists to prevent. `smith event append` refuses a
  dispatch without it.
- **…and presence-checked, not a closed dimension.** Model ids turn over
  monthly. An enum would either reject next month's model or, far likelier, get
  the field quietly dropped rather than the taxonomy bumped. `model` joins
  `task_ref` and `provenance_event_ids` in `PRESENCE_ONLY_FIELDS`. Its value is
  only ever compared against another value, never looked up.
- **A CLI-transport provider records `<command>:default`.** It genuinely does
  not know its model, and inventing an id would be worse than admitting that:
  the audit would then compare two fictions and report `ok`.
- **The audit is fail-closed.** `unverifiable` — a dispatch with no model, or a
  critic with no finder dispatch before it — exits 1 exactly like `violation`.
  "I cannot tell" that exits 0 is indistinguishable from "it held", which is
  this item's whole subject. A policy declaring no pairs is itself
  `unverifiable`, not a pass.
- **`not-applicable` is reported, not omitted.** A pair whose critic never ran
  gets a row saying so. An audit that silently drops what it had nothing to say
  about produces a short clean report that looks identical whether the verifier
  ran correctly or never ran at all.
- **Each critic is compared against the latest finder at or before its own
  timestamp**, not the newest in the session. Otherwise a re-plan an hour later
  on a different model retroactively launders an earlier same-model review into
  a pass.
- **Pre-P9-23 events are kept with `model: null`, not filtered.** The log is
  append-only. Dropping them would turn "this dispatch cannot be checked" into
  "no such dispatch happened".

**Acceptance, measured.** Suite **44 files / 754 tests**, up from 43/733 on
`main` — one new file (`dispatchAudit.test.ts`, 11 tests) plus 10 new tests
across `planQuorum`, `crosscheck`, `events`, `quorum` and `cli`. All red first:
the four `cli.test.ts` cases failed on `Unknown command`, and the `events.test`
pair on a payload the taxonomy still accepted. `pnpm test` exit 0, `pnpm
test:ui` 6 files / 34 tests, `pnpm lint` clean over 135 files, `pnpm typecheck`
and `pnpm build` clean, Node 22.23.1. Driven end-to-end against the built
binary: a planner-on-opus / spec-reviewer-on-codex session reports `ok: true`
exit 0; the same session with the spec-reviewer moved onto `claude-opus-5`
reports `status: "violation"` naming both event ids, exit 1; a dispatch with
`model` omitted is refused at write time with
`events.invalid-payload-dimensions`; and `smith plan quorum` against the real
`envkit-config-loader` plan — the run that started this item by writing zero
events — now writes `quorum-decision` with `endorsed_by:
"default-no-provider"` and all six fired triggers.

Making `model` required broke **51 tests across 9 files** that had been
appending dispatch payloads without one. Every one was repaired by adding the
field, not by loosening the rule; the two negative fixtures that assert a
*rejected* dispatch kept their gaps deliberately.

**Integration addendum (`smith/phase-9/integration`).** P9-11 landed
`src/judges.ts` in parallel with this item, on a branch cut before it, so
neither branch's CI ever saw the other: `recordJudgeDispatch()` writes a
`dispatch_decision`, and it wrote one without a `model`. Assembled together,
every `smith judge dispatch` died at `events.invalid-payload-dimensions` — 18
tests across `judges`, `gate` and `cli`. Repaired the same way as the other 51:
`JudgeDispatchInput.model` and `smith judge dispatch --model <id>` are
**required**, with no default beside `--provider`/`--model-tier`'s. The pairing
argues for it rather than against it — `reviewer` and `verifier` are one of
`crosscheck.yml`'s two `finder_ne_critic` pairs, and this verb is how both
halves reach the log, so a defaulted id would have handed `dispatch check` two
placeholders to compare and let it report `ok` on an asymmetry nobody arranged.
`judges.no-model` catches it a step earlier than the taxonomy does, only so the
message names the judge instead of the record type.

Three honest remainders. There is **no `smith dispatch record` verb** — the
existing `smith event append` path the `/bs` skill documents already enforces
`model` through required-field validation, so a wrapper would add a second way
to do one thing; SKILL.md and the operator guide were updated instead. The
`dispatches` **drizzle table has no `model` column**: `eventsRaw` keeps the full
payload, so the model stays queryable, and a migration can wait for a reader
that needs it. And **`model` is not on the Result contract** —
`result.schema.json` sets `additionalProperties: false`, and a worker's
self-report is a different record from the orchestrator's dispatch decision;
conflating them is how you get a model id attested by the agent whose
independence you are trying to check.

## P9-24 — A finding needs an owner, and the owner is not "whoever is being gated"

**Evidence:** D-41, with D-33 and D-39 as the same wound from other angles. The
wave-4 security reviewer found a real S2 in `src/parse.ts:119` — bare CR is not
a line separator, so `loadConfig('A=legit\rB=zzz', …)` returns `ok: true` with
zero errors, one key holding the swallowed text and the other silently taking
its schema default. Reproduced independently. It is the task-1b bug class,
still open, reachable through the API task-4 had just shipped.

The finding is anchored to a file task-4-api is **forbidden** to touch: C14 pins
its claims to `["src/index.ts","test/index.test.ts"]` and the claims checker
enforces that. `parse.ts` belongs to task-1b, merged two waves earlier. And
`intakeAndDecide` applies no claims-scoping at all — it blocks whichever
`taskId` was handed to `gate run`. Filing the evidence against task-4 would
have blocked a correct diff on a defect it cannot legally fix, and the round-2
loop can only bounce it back to a coder with no legal remedy: an unbreakable
deadlock, not a slow one.

There is also no correct place to put it. Findings are minted only inside
`gate run <taskId>`; there is no `smith findings raise`. task-1b is merged, so
the only way to attach it is to re-gate a closed task. A real S2 discovered in
wave 4 has **no home anywhere in the factory's own state** — it survives
because a human wrote it into a markdown file.

**Done looks like:** finding ownership resolved from `file_path` against the
plan's claims map rather than from the gate invocation; when the owning task is
already merged, the finding opens a follow-up task against the epic and blocks
the **epic verdict** instead of an unrelated diff; and `smith findings raise`,
so a finding can exist without a gate run. A factory that conflates the task
being gated with the task that owns the defect will either block the innocent
or lose the finding — here it was positioned to do both.

**Status: fixed, 2026-08-07, branch `smith/phase-9/p9-24-finding-ownership`** —
ownership is now a property of the file. `claims.ts` gained a pure
`resolveFindingOwner(filePath, claims)`, which ranks matching claim patterns by
specificity and returns `ambiguous` on a genuine tie rather than picking one,
plus `decideFindingAttribution`, which turns an owner into one of three answers:
`gated` (the owner *is* the task at the gate), `reassigned` (an open task owns
it), or `follow-up` (the owner already merged, two tasks tie, or nobody claims
the file). The decision is written nowhere by these functions, which is what
lets a caller compute the whole routing and then discard it.

`attribution.ts` is the one implementation both hosts call — `routeFindings`
decides, `recordReattribution` writes. Ordering is the load-bearing part: the
finding is re-minted under its new owner *before* `raiseFinding`, so the raised
event's `task_id` and `finding_id` agree; the follow-up task and the
`finding-reattributed` event are written only *after* the finding survives the
waiver check and the cross-check quorum, so a waived or refuted finding mints no
task for a bug nobody is going to fix. The follow-up's id is derived from the
fingerprint (`<epic>/followup-<fp8>`), so a re-run recognises it as already
written instead of minting a second task; it carries `task_status: "todo"`,
which is not in `TERMINAL_OK_TASK_STATUSES`, so `summarizeEpic` already blocks
the epic verdict on it. That half needed no new mechanism, only a task the
existing one could see.

`smith findings raise --evidence <file> --found-by <role> [--task <id>]
[--plan <plan.json>]` is the gate-free path, and `smith gate run` takes the same
`--plan`. With neither `--task` nor `--plan` it refuses (`cli.missing-flag`)
rather than inventing an owner; with `--plan` alone the epic id is the fallback,
which is safe because `decideFindingAttribution` returns `gated` only when the
owner *equals* that id, and an epic id never equals a task id. `gate run` also
now honours `--state-dir`, which it silently ignored before.

Measured: 548 tests pass across 40 files, `pnpm typecheck` and `pnpm lint`
clean. The regression tests are 7 unit tests in `gate.test.ts` and 5 CLI e2e
tests in `cli.test.ts`; the gate e2e was checked red first — dropping either
half of the `gate run` wiring turns the S2 about `src/bar/*.ts` back into a
block on `epic-1/task-1`. See P9-29 in this file for the `task-added` producer
this leans on.

**Amended 2026-08-07 by first real use.** Routing D-41 through this path did
what the entry promises — ownership resolved from the file, the tie between
task-1a and task-1b reported rather than guessed, the finding raised with no
gate run, the epic verdict held on the follow-up. It also showed that the task
it mints cannot be executed: its claims are too narrow to hold its own
regression test, and `queue run` refuses an id the plan does not contain. See
D-48 and P9-31. The routing is right; the task it produces is not yet a task
the rest of the factory can process. *(P9-31 fixed 2026-08-07: it is now.)*

## P9-25 — Coverage evidence must measure the file the criterion names

**Evidence:** D-40. Task-4-api's C12 names `src/index.ts` explicitly. The gate
ran `pnpm test:coverage`, exited 0, and printed a table containing `coerce.ts`
and `parse.ts` and nothing else — not `src/index.ts`, the file the task exists
to add, and not `src/validate.ts`. Read literally, the gate's own transcript
says the criterion is unverifiable and the per-file threshold is passing
vacuously over unmeasured files.

It is not: the v8 text reporter suppresses rows for files at 100% on every
metric, both files are at 100%, and the "All files" denominator rising from 179
to 199 statements proves they were instrumented. With `thresholds.perFile:
true`, exit 0 is itself proof that every included file cleared 80%. So the gate
is correct and its evidence is misleading — the expensive combination, because
it is invisible until someone checks. Here it cost a full investigation,
including a coverage re-run on the pre-task-4 integration branch to rule out a
regression, to conclude that nothing was wrong.

**Done looks like:** the coverage check emits `json-summary` and the gate
attaches `coverage-summary.json` to its outcome, rather than scraping a
human-oriented table that hides exactly its passing rows. Any check whose
criterion names a file must produce a per-file number for that file. Evidence
that omits the subject of the criterion is not evidence.

**Status: fixed, 2026-08-08, branch `smith/phase-9/p9-25-coverage-evidence`** —
the gate no longer reads coverage with its eyes.

`testgate.ts` keeps the last 50 lines of a check's combined output as `tail`,
and for the coverage check that tail *is* the human-oriented table: the one that
suppresses a row for any file at 100% on every metric. So the evidence the gate
carried forward was systematically missing exactly the files doing best, and
D-40 spent an investigation — including a coverage re-run on the pre-task-4
integration branch to rule out a regression — establishing that a green gate was
green.

The new `coverage.ts` reads `coverage/coverage-summary.json` instead, and the
gate attaches it to the outcome as `coverageEvidence` and emits it as a
`coverage-evidence` event. `json-summary` went into both `vitest.config.ts`
files: the scaffold's, so every project the factory creates ships it, and this
repo's own, which had the identical gap it was about to ship.

Decisions worth writing down:

- **Attach the machine-readable summary; do not parse the table.** The table is
  a rendering with a lossy rule the reader has to know. The summary lists every
  instrumented file, and a real one-test-file run of this repo has 43 keys —
  all 42 instrumented src files plus `total` — where the table printed a
  fraction of that.
- **The subjects are the gated task's own literal claims.** Not the plan's:
  blocking task-1 for a file task-2 owns is D-41 in a new costume. Not its
  globs either — `src/**` names a region, and a region has no single number a
  per-file criterion could cite. `--plan` therefore demands `--task`.
- **Three statuses, because two would lie.** `measured`; `unmeasured` — no row,
  yet siblings in the same directory have one, so the coverage config reaches
  here and skipped the file the criterion names; `not-instrumented` — no row
  and no instrumented sibling, so the file is outside the include glob, which
  is a fact about the config rather than a hole in the evidence. The
  sibling-directory test is the whole discriminator: it needs no vitest-config
  parsing and no file-type heuristics.
- **Fail closed, both ways.** An `unmeasured` subject blocks with the new
  reason `coverage-evidence`, and so does a coverage check that wrote no
  summary at all. `thresholds.perFile: true` proves every *included* file
  cleared the bar and says nothing whatsoever about a file that was never
  included; and a configured coverage check producing no machine-readable
  artifact is the D-40 condition itself, whose fix is one line in
  `vitest.config.ts`. Blocking is what gets that line written.
- **A malformed summary throws rather than reading as empty.** An empty summary
  is a claim — "nothing was instrumented" — and the wrong one. A file entry
  missing a metric is refused rather than defaulted: zero invents a number and
  100 invents a pass.
- **No coverage check, no behaviour change.** The stage is keyed on a check
  named `coverage` (overridable via `GateInput.coverage.checkName`), so every
  existing caller is untouched: no evidence field, no event, no block.

**Acceptance, measured.** RED first, in all three places. `pnpm exec vitest run
coverage.test` → exit 1, `Cannot find module '../src/coverage.js'`; after the
module, 16 passed. `pnpm exec vitest run gate.test -t "coverage evidence"` →
exit 1, `6 failed | 1 passed | 41 skipped` (the passing one asserts the
no-coverage-check case, correct in both states); after the pipeline stage, 7
passed. `pnpm exec vitest run cli.test -t "coverage check"` → exit 1, `5 failed
| 58 skipped`; after the verb, 5 passed.

Full sweeps on Node v22.23.1: `pnpm test` 44 files / **761 tests**, exit 0 (up
from 43 / 733 on `main`); `pnpm test:ui` 6 files / 34 tests, exit 0; `pnpm lint`
135 files, exit 0; `pnpm typecheck` exit 0; `pnpm build` exit 0.

The reporter change is verified by a real run, not by reading the config:
`pnpm exec vitest run coverage.test --coverage` now writes a 13,844-byte
`coverage/coverage-summary.json` where it previously wrote none. Three verbatim
CLI outputs against this repo, with `coverage.ts` at 94.28% lines:

```
$ smith coverage check . --plan <plan> --task phase-9/p9-25
{"summary_path":"coverage/coverage-summary.json","present":true,"complete":true,"files_measured":43,
 "subjects":[{"path":"factory/orchestrator/src/coverage.ts","status":"measured","lines_pct":94.28,"statements_pct":93.42,"functions_pct":100,"branches_pct":87.23},
             {"path":"factory/orchestrator/test/coverage.test.ts","status":"not-instrumented","lines_pct":null,...}],
 "detail":"43 files measured; 1 of 2 named files have a per-file number."}   exit 0

$ smith coverage check . --plan <plan naming src/nowhere.ts> --task phase-9/p9-25
 "detail":"no per-file number for factory/orchestrator/src/nowhere.ts — the criterion names a file the coverage run did not measure."   exit 1

$ smith coverage check /tmp
 "detail":"no coverage/coverage-summary.json after the coverage check — add \"json-summary\" to coverage.reporter in vitest.config.ts, because the text table hides every file at 100%."   exit 1
```

Three honest remainders.

**Freshness is assumed, not checked.** The gate reads whatever summary is on
disk after the coverage check exits; it does not compare the file's mtime
against the run's start. A stale `coverage-summary.json` left by an earlier run
would be read as this run's evidence. In a fresh task worktree there is nothing
stale to read, which is why this is a remainder and not a defect today — but a
re-run in a reused worktree is exactly where it would bite.

**A non-code claim inside an instrumented directory blocks, wrongly.** Measured:
a claim on `factory/orchestrator/src/schemas.json` comes back `unmeasured` and
exits 1, because `src/` has instrumented siblings and the discriminator is
directory-level. The include glob is `src/**/*.ts`, so that file could never
have a row. Sharpening this means reading the include globs out of the vitest
config — the thing the directory test exists to avoid — so it is deliberately
left, and the workaround is to not claim non-source files.

**Only the vitest/v8 `json-summary` shape is understood, and only the task
gate collects it.** Jest writes the same istanbul-shaped document so it should
read unchanged, but that is inference, not a run. And `smith integration
check` (P9-26) still performs no coverage collection at the assembled-branch
root, so this is per-task evidence only.

**Integration addendum (`smith/phase-9/integration`).** This item was the last
of the eighteen onto the assembled branch, and it collided with four earlier
ones that its own CI could not have seen. Two `tsc` caught, one only the suite
caught, and one nothing caught — it merged clean and would have shipped.

*Required fields on a blocked return (P9-21/P9-22).* Those items made
`schemaErrors: ValidationIssue[]` and `artifactIssues: ArtifactIssue[]`
required on every `blocked` outcome — absent is not the same claim as empty.
The `coverage-evidence` return here predates both and set neither. Repaired by
setting both explicitly to `[]`, which is the true statement: the coverage
stage runs after the schema and artifact stages have already passed.

*The usage-table drift guard (P9-21).* `smith coverage check` was written
against the old CLI, with its usage string as a literal and its arity as a
`required: 1`. P9-21 made `COMMANDS` in `usage.ts` the single source and had
the dispatcher refuse any command the table does not list, so the assembled
tree failed with `TS2345: Argument of type 'string' is not assignable to
parameter of type 'CommandDoc'` at `cli.ts(1182,7)`. The verb now has a
`COMMANDS` entry and takes its arity from `requirePositionals(positional,
usageFor('coverage check'))`; `gate run`'s one-line summary gained the coverage
stage in the same edit. The guard did exactly what it was built for — a verb
that skipped the table could not compile.

*The commit certificate meets the coverage artifact (P9-8).* Five gate tests
went red on assembly with `reason: "not-committed"` where they asserted
`"coverage-evidence"`. Not a coverage bug: `runGate` certifies the commit
before the expensive stages, `writeSummary()` in the fixture writes
`coverage/coverage-summary.json` into the worktree, and an untracked file is
uncommitted work. The two cases in the same block that write no summary passed
throughout, which is what identified it. Fixed by committing a `.gitignore`
holding `coverage/` in the fixture's base commit — the same line this repo and
the scaffold both carry — rather than by narrowing the certificate. A real
project ignores its reporter output; the fixture now does too.

*Two sections numbered `5a` (P9-8).* Both items added a `## 5a.` to
`operator-guide.md`, in different places, and git merged both without a
conflict. The guide would have shipped with two identically-numbered sections
and a `see §5a` in the outcome table that resolved to whichever the reader
found first. P9-8's commit check keeps `## 5a.`; this item's coverage section
moved after `## 5b.` and became `## 5c.`, with the table row and the `/bs`
skill's step 7 re-pointed. Textual merges do not check document structure, and
no test reads a heading number.

Assembled totals on the integration branch: `pnpm test` 57 files / **1153
tests**, exit 0 — the per-branch figures recorded above (including the 761
here) were each true when measured and none of them describe the assembly.

## P9-26 — Nothing ever runs at the integration root

Every check the factory performs runs with `cwd` set to a task worktree
(`gate.ts:390`). No check has ever executed at the root of the assembled
branch. That gap is not theoretical: at the end of the dogfood, with all five
tasks merged and all six gates green, `pnpm lint` on the integration branch
exited 1 (D-42).

The cause is that `worktree.ts:98` places each worktree *inside* the project
(`path.join(projectDir, 'wt', taskId)`), so the root contains seven copies of
the project's `biome.json` and biome refuses to run on nested root configs.
From inside `wt/task-4-api/` the siblings are not descendants, so every task
gate correctly saw a clean tree. The failing condition exists only at a root
no gate stands in. Move `wt/` aside and the same command reports `Checked 10
files`, exit 0 — the merged code was never the problem.

Two fixes, and both are worth doing because they fail differently. Relocating
worktrees to a sibling path (`workspaces/.wt/<project>/<task-id>`) kills this
class outright — no root-walking tool can reach them. But the reason the bug
survived to the end of a five-task epic is the second gap: **per-task gates
cannot certify an assembled branch**, and the factory currently issues its
quality verdicts as though they can. Every claim in an epic verdict today is a
claim about a worktree.

**Done looks like:** worktrees live outside the project root, *and* the epic
cannot reach a `ship` verdict until the full check suite has run once at the
integration root with its output recorded as an event. The run that would have
caught this took eleven seconds; it happened because a human typed it.

**Status: fixed, 2026-08-07, branch `smith/phase-9/p9-26-integration-root`** —
both halves landed. `worktree.ts` now places worktrees at
`workspaces/.wt/<project>/<task-id>`, a sibling of the project; the six envkit
worktrees that predated the change were migrated with `git worktree move`, and
`pnpm lint` at the envkit integration root went from exit 1 to exit 0
(`Checked 10 files`), with all 159 envkit tests still passing. The second half
is `src/integration.ts` + `smith integration check`, which runs the check suite
at the project root against `smith/<epic>/integration` and records an
`integration-check` event pinned to the head sha it covers. `summarizeEpic`
takes a fourth, *required* `IntegrationStatus` argument and `EpicVerdictInput` a
required `integrationHeadSha`, so no caller can silently opt out; the verdict
blocks when the check is missing, stale (recorded sha ≠ current head), or
failing. Verified end-to-end against the real dogfood log: `epic verdict` on
`state/events/` still reports *"has no integration-root check on record"*,
while the same command against a log carrying a fresh check at `8962df9` drops
that blocker. `runIntegrationCheck` refuses rather than mutating the operator's
clone — empty check list, missing branch, wrong branch, dirty tree — because a
vacuous pass is worse than no answer. Repo suite green: 38 files / 476 tests,
lint and typecheck clean.

## P9-27 — An epic's close must be a fact in the log, not terminal output

`runEpicVerdict` returns on a mechanical blocker before reaching its only
`appendEvent` (`epic.ts:263`), and deliberately: *"a deterministic blocker is
final. Zero judge calls, zero events (read-only projection)."* The `go` path is
equally silent when no external providers are enabled (`epic.ts:274`).

In the default zero-cost configuration that means **both terminal outcomes
emit nothing**, and the only verdict ever written to the log is the one that
spent money on external judges. The property is exactly inverted: an epic's
close is the moment most worth making durable.

Confirmed by the dogfood (D-43). The epic was held; nothing in the event log,
the projector or the UI records that the verdict ran, what it said, or why.
Closing it by hand then required hand-assembling an `epic-closed` event — the
same hand-assembly P9-1 objects to for lessons, and for the same reason.

**Done looks like:** the cheap probe stays free, and the close becomes a verb.
Either `epic verdict --record` or a separate `smith epic close` emits an
`epic-closed` event carrying the verdict, the summary it was computed from, and
the blockers if any. A prepared instance of that payload, written by hand for
this run, is in `docs/specs/dogfood-envkit-close-event.json` — it doubles as
the fixture for the verb's first test, and it was appended for real as
`dogfood-envkit-1#69`.

**And a projector case, which the append proved is a separate change (D-44).**
`db/projector.ts:543` writes every event to `eventsRaw` regardless of type, so
`#69` is persisted and queryable — but the task-status switch at
`projector.ts:314` knows seven event types and ends in `default: break;`.
`epic-closed` falls through. The epic is closed in the log and open in every
surface a human looks at. Emitting the fact is half the fix; folding it is the
other half.

Two details for the implementer, both from D-44/D-45:
- Normalise the epic-level `task_id`. `#69` carries
  `envkit-config-loader/epic`; the codebase's convention is
  `` `${epicId}/${RESERVED_TASK_ID}` `` where `RESERVED_TASK_ID` is
  `'integration'` (`worktree.ts:10`, used at `epic.ts:177,221,284,326`). Inert
  now only because nothing folds the event — add a `touch()` and the
  unreserved suffix escapes the `isReservedRef` guard at `projector.ts:307`
  and mints a phantom task row. Keep `#69` as a fixture that carries the wrong
  id on purpose.
- `epic close` must not repeat `event tail`'s failure mode: a missing or
  unknown session id there returns `[]` and exit `0` (D-45).

**Status: fixed, 2026-08-07, branch `smith/phase-9/p9-27-epic-close`** — a
separate verb, so `epic verdict` stays free and read-only.
`smith epic close --epic <id> --project <dir>` runs the verdict and then records
it: `go` emits `epic-closed` with `closed_by: "verdict"`; `hold` refuses with
`epic.close-refused` and exit 1, naming the blockers, and writes nothing;
`hold --override-rationale "<why>"` emits with `closed_by: "operator-override"`,
keeping `machine_verdict`, `machine_reason` and the blockers it closed over. A
blank rationale is refused. Both riders landed: new events carry
`` `${epicId}/${RESERVED_TASK_ID}` ``, and a session with no log throws
`epic.unknown-session` instead of starting one with a close in it.

The projector half is a separate `foldEpics()` into a new `epics` table
(migration `0006`), keyed on `payload.epic_id` — it never touches `task_id`, so
it cannot route through `touch()` and cannot mint the phantom task row D-44
warns about. `#69` keeps its wrong id as a fixture; a test pins
`foldTasks([#69]) === []`. Two call sites of `epicsInFlight` (`overview()` and
`projectSummary()`) computed "in flight" from non-terminal task statuses alone,
which would have kept an override-closed epic in flight forever; both now use
one `inFlightEpics()` helper, `overview()` gained `closedEpics[]`, and the
Kanban/Flow pickers build from `selectableEpics()` so a closed epic's board
stays reachable.

Acceptance, measured on the branch: orchestrator **40 files / 527 tests**
(+16 — 6 `closeEpic`, 5 `foldEpics`, 2 queries, 3 CLI), UI **34** (+4),
server **17**, all passing; `pnpm typecheck` and `typecheck:ui` exit 0; `pnpm
lint` clean over 126 files. Evidence is D-43/D-44 in
`docs/specs/dogfood-envkit-findings.md`.

## P9-28 — A missing required positional must fail, not return empty

`cli.ts` validates flags with `requireFlag` and validates positionals not at
all — `positional[0] as string` is a cast, not a check. `smith event tail` with
no session id prints `[]` and exits `0`; so does an unknown session id. *You
forgot the argument*, *no such session*, and *the session is empty* are one
observable state, and it is the success one.

Same family as P9-11 and D-31: silence read as success. Worse here because the
verb is the one an operator reaches for precisely when they are unsure what the
log contains — the failure mode answers "your log is empty."

**Done looks like:** a `requirePositional` twin to `requireFlag`, applied
everywhere a positional is cast rather than checked; and a session id that has
no log file is an error, not an empty array. A sweep of `cli.ts` for
`positional[` shows how many verbs share the gap.

**Status: fixed, 2026-08-07, branch `smith/phase-9/p9-28-require-positional`** —
the sweep found **15** verbs casting a positional and, in `queue run`, three
flags doing the same thing (`flags.project as string`, in the one verb that
shells out to git). `requirePositionals(positional, usage, required?)` now
takes the usage line as its source of argument names — it reads them out of the
`<placeholders>`, so the error can name the argument that is missing *and*
print the line that would have worked, with no second list to drift. It throws
`cli.missing-positional`; `queue run`'s three flags moved to the existing
`requireFlag`.

Three decisions worth recording. **Positionals are checked before flags**,
because argument order is reading order: `smith findings transition F-1` now
says `<status>` is missing rather than `--session`, which is what an operator
would have typed next. **Surplus positionals stay accepted** — `wave check` is
variadic and `smith new` spends its first token on the project name, so an
arity check would reject valid lines; rejecting *unexpected* arguments is a
different question and is not done here. **`wave check` passes `required: 1`**
so only its plan path is checked here and its own, better `cli.empty-wave`
message stays reachable for the variadic tail. An empty-string argument counts
as missing, since `smith gate run ""` is an unset shell variable and the empty
id travels exactly as far as `undefined` did.

The session half is `requireSession(sessionId, opts)` in `events.ts`, and it is
deliberately *not* a change to `readEvents`. `readEvents` must keep answering
`[]` for a log that does not exist, because `appendEvent` reads the log to
derive the next line index and check `causal_parent` — a session's first event
depends on absent meaning empty. So the check is opt-in and reader-side, wired
into the seven log-backed verbs: `event tail`, `findings list`, `waivers
pending`, `scheduler run`, `dream`, `db apply`, and `db rebuild --session` (not
`--session`-less `db rebuild`, where finding no sessions is a real answer). It
says nothing about an existing-but-empty log; that one really is an empty
session. `smith new`'s missing project name was already checked, but under
`cli.missing-flag`; it now reports `cli.missing-positional` like everything
else.

**Acceptance, measured.** Nine new CLI tests, red against the pre-change source
(`git stash push -- factory/orchestrator/src`, since `cli.test.ts` runs the
built binary): the two `event tail` cases failed on `expected +0 to be 1` —
exit **0**, the success answer, for both a forgotten argument and a typo'd
session — and the other seven on a missing or wrong error code. Green after:
orchestrator **40 files / 570 tests** (+9), `pnpm typecheck` and `pnpm lint`
clean over 127 files, Node 22.23.1. One existing P9-27 test changed with the
behaviour: it proved `epic close --session no-such-session` started no log by
tailing it and expecting `[]`, and its own comment cited this bug (D-45) as the
reason that was weak evidence; it now asserts the refusal.

## P9-29 — Give the orphaned task-status events a producer *(supersedes the framing of P9-9)*

**This is the highest-value item on the list, and it demotes several others to
symptoms.** Evidence: D-46.

The projector's task-status fold (`db/projector.ts:314`) consumes seven event
types. An exhaustive sweep of all 16 `appendEvent` call sites in
`factory/orchestrator/src` shows that **only two of the seven have a producer**
— `dispatch_decision` (`quorum.ts`) and `gate-outcome` (`gate.ts`).
`task-added`, `wave-admitted`, `wave-merged`, `task-superseded` and
`error-logged` are emitted by nothing. `errors.ts` and `plan.ts` call
`appendEvent` zero times. The only other producer is `cli.ts:292` — the
`event append` verb, which is a human at a keyboard.

So the kanban, `stats` and the UI are driven by events only an operator can
write, and the dogfood shows exactly what that costs. After the close, with all
70 events applied by a clean rebuild, the `tasks` table reports four of six
merged tasks completed, two stuck at `merging`, and one phantom row still
`ready` — three separate defects, each traceable to a human hand-writing a
wave payload: a qualified id admitted then merged under a bare one, a task
dropped from its wave's merge payload, and a wave merged with no event at all.

**It reframes P9-9 (D-28).** "Two divergent task-id conventions" reads like two
components disagreeing. There are no two components. There is no producer, so
there is no convention — the id is whatever got typed. A schema-boundary
constraint is still worth having, but on its own it just makes the hand-typed
id well-formed; it does not stop a human being the sole source of truth for
whether a task merged.

**Done looks like:** each orphaned type gets the component that already does
the work it describes — `queue.ts` emits `wave-merged` (it performs the merge
today and appends nothing), `wave check` emits `wave-admitted`, plan ingestion
emits `task-added`, `errors.ts` emits `error-logged`. Ids are minted from the
plan, never retyped. The acceptance test is this run's log: replay the envkit
epic through the new producers and the `tasks` table must show six completed
rows and no phantom. Until it lands, the kanban is narrative, not state, and
the punch list should say so.

**Status: fixed, 2026-08-07, branch `smith/phase-9/p9-29-task-status-producers`**
— all five orphaned types now have a producer.
`factory/orchestrator/src/taskEvents.ts` holds the emitters and owns exactly two
things: minting the task id from the plan, and shaping the payload the projector
reads. Every decision stays with the component that makes it and calls in at the
moment it makes it — a new `plan ingest` verb emits `task-added` (and
`task-superseded` for any task the plan itself marks superseded), `wave check`
emits `wave-admitted` only when the wave is actually admissible and not
`--dry`, and `queue.ts`'s `step()` emits `wave-merged` after the
`git merge --no-ff` returns. `emitTasksAdded` reads the log back before writing,
so re-ingesting a plan is a no-op rather than a doubled history.

One deliberate deviation from "done looks like": `error-logged` is produced from
`queue.ts`, not `errors.ts`. `events.ts` imports `SmithError` from `errors.ts`,
so the reverse import is a cycle — and more to the point, constructing an error
is not the same event as deciding a task is blocked by it. `queue.ts` is where
that decision happens, and it logs *after* the git work: an event written ahead
of the merge would be a prediction, and a falsified prediction is the phantom
row all over again.

The plan's `--tasks` file was the last id-minting hole, since it is hand-written
like the wave payloads were. `queue run --session` now requires `--plan` and
resolves every id through `resolveTaskId` before any git runs; a task id the
plan does not contain refuses the whole run rather than merging some tasks and
mislabelling them.

**Acceptance, measured.** The envkit epic replayed end-to-end through the
producers with no `event append` by hand except the session root, driving the
same bare ids the dogfood operator typed. 17 events (1 root + 6 `task-added` +
4 `wave-admitted` + 6 `wave-merged`), then a clean `db rebuild`:

| | rows | completed | stuck `merging` | phantom |
|---|---|---|---|---|
| dogfood log (hand-typed) | 7 | 4 | 2 | 1 |
| replay (producers) | **6** | **6** | 0 | **0** |

Every row carries the plan's spelling (`envkit-config-loader/task-0-toolchain`,
…) and the branch the worktree actually got. Under Node 22.23.1: 457 tests pass,
build, lint and typecheck clean.

## P9-30 — The wrong Node version must fail loudly, and a crashed child must never report as exit 1

Evidence: D-47.

`package.json` declares `"engines": { "node": ">=22" }` and nothing enforces
it — no `.nvmrc`, no `.node-version`, no `engine-strict`. `better-sqlite3`
13.0.2's `darwin-arm64` prebuild is NAPI 10; under Node 20.14.0 (NAPI 9) it
loads and then dies with SIGSEGV, exit 139, both streams empty. The suite
reports three `expected 1 to be +0` assertion failures and no mention of a
signal, because `runCli` (`cli.test.ts:14-22`) does `e.status ?? 1` and
`execFileSync` sets `status: null` / `signal: 'SIGSEGV'` on a signalled child.
A segfault and a clean exit 1 are the same value to every assertion in the
file. That misreporting cost a full false diagnosis in this session,
including a stash-and-rerun that "confirmed" the failures were pre-existing —
sound method, useless conclusion, because both runs shared the broken
interpreter.

**Done looks like:** three independent layers, cheapest first.

1. `runCli` and every other `execFileSync` wrapper in the test tree propagate
   `signal`, and a signalled child fails with a message naming the signal.
   This alone converts D-47 from a day into five minutes.
2. `.nvmrc` pinning 22 and `.npmrc` with `engine-strict=true`, so the wrong
   runtime fails at `pnpm install` rather than at an arbitrary later call.
3. A startup assertion in `cli.ts` comparing `process.versions.napi` against
   the minimum the native dependencies need, exiting with a named error. The
   engines field is a string check; this is the actual invariant.

The acceptance test is a run of the suite under Node 20 that fails with a
sentence a human can act on, instead of three assertion diffs about `0`.

**Status: fixed, 2026-08-07, branch `smith/phase-9/p9-30-runtime-guard`** —
shipped in **four** layers, not three. Layers 1–3 are as specified:
`factory/orchestrator/test/helpers/process.ts` is now the one child-process
runner for the test tree and `assertNotSignalled` turns a signalled child into
a sentence naming the signal; `.nvmrc` (22) and `.npmrc`
(`engine-strict=true`) make the wrong runtime fail at `pnpm install` with
`ERR_PNPM_UNSUPPORTED_ENGINE`; `factory/orchestrator/src/runtime.ts` holds the
NAPI check and `cli.ts`'s `main()` refuses up front with prose on stderr and a
structured `unsupported-runtime` error on stdout.

The fourth layer was not in the plan and was found by running the acceptance
test rather than reasoning about it. The `cli.ts` assertion alone still let the
suite fail *unevenly* under Node 20 — files that open SQLite killed their vitest
worker, files that did not passed clean — which is the exact shape that made
D-47 expensive. So the guard also sits at `openDb` (`db/projector.ts`),
immediately before the `new Database()` that segfaults, and in a vitest
`setupFiles` entry (`test/setup.ts`) so every test file fails identically.
Partial support is the trap; refusing up front is the fix.

Also fixed beyond the spec: `testgate.ts` annotates a signalled check, and
decodes a shell-reported `128+N` exit into the signal it stands for — the same
crash reaches the orchestrator in two shapes depending on whether the shell
execs the command in place, and both now read the same way.

Acceptance verified under Node 20.14.0: `smith stats overview` exits **1**
(was 139) printing `smith: unsupported runtime` and the reason; `pnpm build`
refuses at the toolchain layer; the suite reports one
`UnsupportedRuntimeError: Node v20.14.0 (N-API 9) is too old…` per file with no
partial green. Under Node 22.23.1: 451 tests pass, lint and typecheck clean.

## P9-31 — A minted follow-up task must also be executable

Evidence: D-48. Found by using P9-24 and P9-29 together for the first time,
which is the only way either could have surfaced it: each feature's own tests
pass, and the defect lives in the sentence neither of them states.

P9-24 mints a follow-up task that is not in any plan. P9-29's whole point is
that task ids come from the plan and are never retyped. So the task exists,
blocks the epic verdict on `task_status: "todo"` exactly as designed, and
cannot be moved off `todo` by anything — `queue run --session` requires
`--plan` and refuses the id with `plan.unknown-task` before any git runs, and
`emitTaskSuperseded` resolves through the plan too (`taskEvents.ts:271`). The
only remaining exit is `smith event append` by hand, which is the disease P9-29
was built to cure. Applied together, the two fixes reconstruct the hand-written
board one task at a time.

The second half is narrower and cheaper. `recordReattribution`
(`attribution.ts:162-171`) sets `claims: [routed.input.filePath]`, so the D-41
follow-up claims `["src/parse.ts"]` and nothing else. Writing the regression
test for a parser bug is then a violation by the factory's own checker —
`smith claims check` returns `contract.claim-violation` on
`test/parse.test.ts` and `test/index.test.ts`, exit 1. A task created to fix a
bug cannot legally prove it fixed it.

**Done looks like:** the follow-up inherits the claims of whoever resolved its
ownership — the union of the candidates' claims when the owner is `ambiguous`,
the owner's claims when `resolved`, the named file alone only when nobody
claims it. That shape is already written down one line away, in the same claims
map that answered the ownership question: every task in the envkit plan pairs
its source file with its test file. And `resolveTaskId` gains a second source,
so a task the log has added is as real as a task the plan declares; the queue
should accept an id it can find in either, and still refuse one it can find in
neither. The acceptance test is D-41's own follow-up — the one that exposed
this — running from mint to merged with no `event append` by hand.

**Status: fixed, 2026-08-07, branch `smith/phase-9/p9-31-executable-followup`** —
the log is now the second register a task id may be found in.
`readAddedTasks` (`taskEvents.ts`) reads a session's `task-added` events back as
ids *with* their claims, and `resolveTaskId` takes that register as a third
argument: a task either source knows is real, one neither knows is still
`plan.unknown-task`, and the message now names both places it looked. The
register is read inside `emitWaveAdmitted` and `emitTaskSuperseded` rather than
passed in, so no caller can forget it and quietly lose the ability to admit a
follow-up; `wave check` and `queue run` read it directly too, the first because
it also needs the claims, the second because refusing the id there is what left
D-41's follow-up unmergeable. Claims are carried alongside the ids on purpose —
a wave that admits a task with an empty claim set has admitted a task allowed to
touch nothing, and that fails at the first edit rather than at admission, where
the mistake actually is. Where plan and log both know an id, the plan wins: a
re-cut plan is the newer statement of that task's claims.

The claims half is `followUpClaims` in `attribution.ts`, computed where the
ownership map and the resolved owner are both already in scope: the owner's full
claim set when one task owns the file, the union of the candidates' sets when
several do, the named file alone only when nobody claims it. Candidate records
carry only the single matching claim, so the full set is looked up by id in the
ownership map; the result is sorted and de-duplicated, because a task spec that
differs run to run is not a spec.

**Acceptance, measured.** The punch list's own acceptance test now exists as
`a minted follow-up is executable (D-48/P9-31)` in `cli.test.ts`: `findings
raise` mints the follow-up, `wave check` admits it by its bare id, `worktree
create` cuts its branch, and `queue run --plan --session` merges it — one `event
append`, for the session root, and none after. Two sibling tests hold the edges:
a rival wave is refused as overlapping *because* the follow-up's claims came
from the log, and an id neither register knows is still refused. Verified red
first — with `src/` stashed, the mint-to-merged test fails at `wave check`
(`expected 1 to be +0`) and the claims test never reaches a verdict; the
plan/taskEvents/gate tests failed 9 of 57 before the fix and pass 57 of 57
after. Full suite under Node 22.23.1: 561 tests, 40 files, lint and typecheck
clean.

Against the real envkit plan, the D-41 finding on `src/parse.ts` is ambiguous
between `task-1a-parse-core` and `task-1b-parse-quotes`, and its follow-up is
now minted with `["src/parse.ts", "test/parse.test.ts"]` — the regression test
the old single-file claim made illegal. One honest remainder: the dogfood fix
also touched `test/index.test.ts`, which is `task-4-api`'s file and stays out of
claim. That is the claims map working, not a gap in this fix; a follow-up that
needs another task's file needs a plan cut, not a wider inheritance rule.

## P9-32 — The escalation ladder must be counted, not remembered

**Evidence:** `factory/policies/budgets.yml` `escalation_ladder`, and
`src/budgets.ts`'s own header admitting it: the ladder was prose, and "nothing
here parses them". This is the P9-1…P9-7 shape arriving from the goal line
instead of from the interviews — a rule written down in Phase 1, honoured by
habit, checkable by nobody. Two failed rounds are supposed to escalate the model
tier and three to reach the operator, "never skipped and never looped past their
bound". Nothing counted a failed round, so a task could fail four times on the
same tier with the operator never told and leave a log indistinguishable from
one that climbed correctly.

**Done looks like:** the rungs carry a machine-readable half beside the prose,
and a verb asserts them against the log — `dispatch check`'s contract exactly,
because it is the same kind of claim: fail-closed, `unverifiable` exiting 1
alongside `violation`, `not-applicable` stated rather than dropped.

**Status: fixed, 2026-08-10, branch `smith/phase-9/escalation-ladder`.**
`escalation_ladder.rungs` gained `failed_rounds` and a closed `enforce` keyword
(`model-tier`, `operator`) next to the existing `trigger`/`action`, mirroring
what P9-23 did to `crosscheck.yml`'s pairs. `budgets.ts` parses them and stays
deliberately dumb — `enforce` is typed `string | null`, not the closed union, so
an unrecognised keyword reaches `escalation.ts` as itself and is reported
`unverifiable` instead of silently reading as "this rung declares no
obligation". A rung with an `action` and no `enforce` gets the same treatment:
a rule nothing can check is a finding, not an absence. `src/escalation.ts` and
`smith escalation check <session-id>` do the asserting; see operator-guide §2c.

A **failed round** is one `gate-outcome` with outcome `blocked`; a **retry** is
a `coder`/`tester`/`uiux` dispatch. The builder/judge split is read out of
`budgets.yml` rather than invented — `task.judges` names spec-reviewer,
reviewer, verifier and grader, and `context_window.narrowing_roles` adds
security-reviewer and merger. Every rung a task reached is checked, not only the
highest: skipping the tier rung on the way to the operator rung is the
coordination error the ladder's own note names.

**Two honest remainders.** Rung 3 asserts the *bound*, not the notification —
no event records the handoff, so the check says "the task did not run again
until an operator answer appeared" and the detail string admits that is all it
says. Closing the other half needs a new event type, i.e. a taxonomy version
bump plus an architecture §8 edit, which is a bigger change than the gap
warrants right now.

The second remainder is the one running it against real data produced, and it
changed the design. `dogfood-envkit-1`'s `task-1b-parse-quotes` blocked twice
and then passed — three rounds — with **no `dispatch_decision` event anywhere
against it** (D-46's gap, fixed later than that session). The first
implementation read retries from dispatches alone and reported `not-applicable`:
"the task was not dispatched again, the tier rung was never exercised", exit 0.
That is a clean bill of health issued over a hole in the record, by the audit
built to stop exactly that. "The task ran again" is now read from two
independent traces — a builder dispatch, or the next `gate-outcome` — and the
dogfood log correctly returns `unverifiable`, exit 1, naming the missing
dispatch. The lesson generalises past this module: *an audit that reads one
trace reports the trace's gaps as the world's clean state.*

## P9-33 — `epic.alarm_ratio` must have a reader, and it must say when it cannot see

Evidence: D-9, D-12. `epic.alarm_ratio: 0.7` has been in `budgets.yml` since
Phase 1. D-12's audit of which policy numbers reach a runtime host gave it a
flat **no**: parsed into `BudgetPolicy`, asserted in `budgets.test.ts`, read by
no production path. Its only host was the `/bs status` playbook in `SKILL.md` —
an instruction to a human to flag any epic ≥70%, honoured by remembering.
An alarm that fires when somebody remembers to look is not an alarm.

The obvious fix — sum `task-result-recorded.token_usage.total_tokens` per epic
and compare — is wrong in a way that matters, and D-9 is the proof. A judge
returns findings, not a Result, so its tokens are in no result event and never
will be. On `envkit-config-loader` the declared task budgets summed to 545,000
against a 2,000,000 cap, 27% and comfortably under the alarm, while the run's
real cost was several times that. The measured half of the bill is not a small
sample of the whole; it is a systematically biased one, and a check built on it
reports "under" precisely when the unmeasured half is what breached the alarm.

So the check is built on the asymmetry rather than around it. Unrecorded spend
is monotone: every hole in the record can only make the real bill *bigger*.
Therefore a crossing is a fact — the tokens we cannot see do not un-cross a
threshold the tokens we can see already crossed — and is reported even when the
record is incomplete. A *non*-crossing is a claim about the record, not about
the world, and gets no such benefit. `under` requires the projected ceiling to
be under too, where the projection prices every dispatch that reached no result
at its role's declared cap. A role `budgets.yml` prices nowhere cannot be
priced at all, so the ceiling has a hole in it, so the epic is `unverifiable`
rather than clean. `at-risk` is D-9's shape given a name: measured under,
projected over.

`security-reviewer`, `merger`, `tester`, `uiux`, `planner` and `scribe` are all
dispatched and none are priced. They are deliberately left unpriced rather than
given an invented number — a made-up cap would make the projection look
complete without making it true — and the omission now shows up in every report
that touches one, as `rolesWithoutCap`.

Two two-trace reads, both found by running the module against the real log
rather than by reasoning about it. Task→epic comes from qualified ids **and**
from `wave-admitted`/`wave-merged`'s `epic_id` + `task_ids`, indexed under both
the admitted spelling and the bare one: dogfood admitted wave 1 as
`envkit-config-loader/task-0-toolchain` and recorded every later event for it
under the bare id (D-14), so a map keyed on one spelling attributes none of
them. A dispatch's task id comes from the record **and** from `payload.task_id`:
fifteen of nineteen dogfood dispatches carry only the payload copy, and reading
one level reports fifteen unattributable dispatches on a run where every single
dispatch names its task. Both are the P9-32 lesson again — an audit that reads
one trace reports that trace's gaps as the world's clean state.

Verified against `dogfood-envkit-1`: **zero tokens measured** across zero of
five tasks, 1,150,000 projected, `unverifiable` on `security-reviewer`, exit 1.
That session's log contains no `task-result-recorded` and no
`budget-check-result` event at all, so there is nothing to measure and the whole
number is projection — a measured-only alarm would have printed
"0 / 1,400,000 — under" and exited 0 on an epic that cost over a million
tokens. Also fixed from that run: `epic-closed` carries the synthetic task id
`envkit-config-loader/epic`, which the first version counted as a sixth task on
a five-task epic. It stays in the attribution index and is out of the task
count.

No new event type, and no `taxonomy.yml` version bump: the check is read-only
over events that already exist. 27 unit tests, red first — the suite failed to
import before `budgetAlarm.ts` existed, and one expectation was wrong rather
than the code (900,000 against a 1,000,000 cap is `alarm`, not `over-cap`).

**Status: fixed, 2026-08-10, branch `smith/phase-9/budget-alarm`.** (`smith
budget alarm`, operator-guide §9a. This entry shipped without the status line
every other entry carries — added at close-out.)

## P9-34 — The novelty gate had no hand-authored entry point

Evidence: this list's own "Rule candidates from the run" section, below. Fourteen
evidence-backed rules sat in a markdown file that no agent reads. The pipeline
that would carry them to a dispatch prompt — `lessons compile` → `lessons.md` →
`buildLessonsBlock` — starts at a `lesson-candidate-raised` event, and until now
the only production writer of that event was `dream()` (`lessons.ts:774`).
`dream` scans an event log for decision checkpoints and knows exactly four
shapes: plan sign-off, waiver decision, escalation, gate block
(`CHECKPOINT_EXTRACTORS`, `lessons.ts:648`). A rule distilled by a human reading
a whole run is none of those four, so there was no way in that went through the
gate.

There was a way in that went *around* it. `smith event append` will write a
`lesson-candidate-raised` event with any payload that satisfies the schema, and
`checkNovelty` never runs. So the one countermeasure the lessons subsystem has
against the failure mode architecture §9/§17 names — naive experience
accumulation measurably degrading agents — was optional for exactly the author
most likely to be wrong about whether their rule is new.

`smith lessons raise` is that entry point: it takes the statement, the taxonomy
tags and at least one provenance event id, resolves the provenance against a
real event log, runs `checkNovelty` against every existing candidate and
approved statement, and writes the same two-event shape `dream` writes — a
`lesson-candidate-raised`, then a chained `lesson-status-changed →
novelty-rejected` when the gate refuses. Exit 1 on rejection, so a driver script
cannot mistake a rejection for a raise. Every validation runs before any write:
an out-of-taxonomy tag, an unknown provenance id, a colliding lesson id, a
`claim-path` scope with no `claim_path`, or an empty statement all leave the log
byte-identical. The id is `lesson-raised-<sha256(statement)[0..12]>`, so raising
the same text twice collides on the id rather than quietly forking a second
copy — verified against the real log: exit 1, `lessons.duplicate-lesson`, line
count unchanged.

Two non-fatal warnings, because both cases are legitimate and both are usually
mistakes: a file-scoped `rule` with no `finding_category` (injected at dispatch,
can never escalate — `findMatchingLesson` opens with `if (!lesson.category)
continue`), and a `claim_path` on a scope that never consults it.

**The bigger hole, since fixed:** `transitionLesson` accepted an approval-time
`--statement` edit and wrote it as a `lesson-edited` event with no novelty check
anywhere on the path. The text that landed in `lessons.md` therefore need not be
the text the gate scored. The approval-with-edit flow exists for a good reason —
an operator sharpening a clumsy sentence — but as built, it was a gate bypass
with a better UI than `smith event append`. All fourteen rules were approved
unedited on purpose, so that this defect stayed a defect rather than becoming a
habit.

**Status: fixed, 2026-08-10, branch `smith/phase-9/approval-novelty-gate`.**
`transitionLesson` now runs `checkNovelty` on the edited statement, against the
same corpus `raise` uses, before either event is written — a duplicate edit
throws `lessons.edit-not-novel` and leaves the log byte-identical. Three
decisions worth stating, because each one is a place the fix could have been
wrong:

- **The lesson's own row is excluded from the corpus.** Scored against itself, a
  punctuation fix scores 1.0 and every cosmetic edit is refused — a gate that
  fires on the legitimate case and teaches operators to reach for the override.
  A test pins this directly: editing `Never hand-edit a lockfile.` to
  `Never hand-edit a lockfile!` is a 1.0 self-match and must still approve.
- **The override exists and is recorded.** `--accept-duplicate` lands the edit
  and writes `novelty_override: true`, `novelty_score` and `duplicate_of` onto
  the `lesson-edited` payload. Refusing outright would just push the operator
  back to `smith event append`, which records nothing at all.
- **Only text entering memory is scored.** A transition to `invalidated` or
  `superseded` returns `novelty: null`. Scoring a statement on its way out
  answers no question anyone asked.

Exit code follows `lessons raise`'s rule, extended: **exit 1 whenever the text
that is now in memory is not novel**, whether it got there by override or
unedited. The transition is applied either way; the exit code is the "look at
this", not a rollback.

13 unit tests for `raise`, plus 7 for the approval gate and 1 CLI end-to-end,
all red first. Documented in the operator guide.

## P9-35 — The novelty gate is an exact-duplicate detector at its defaults

Evidence: measured, not reasoned. All fourteen candidates passed the gate — the
highest pairwise similarity in the whole set was **0.024**, against a 0.8
threshold. That is not fourteen deeply novel rules; it is a threshold that was
never in play. So the gate was probed directly with a deliberate near-duplicate
raised against a real statement already in the log, then rejected (not deleted —
the log is hash-chained; `smith lessons reject` with a note saying it was a
probe).

`checkNovelty` is word-shingle Jaccard, default threshold 0.8, shingle size 3.
Against D-38's statement ("A check that silently borrows its tools from the
inspector is measuring the inspector."):

| mutation | score | verdict |
| --- | --- | --- |
| identical | 1.000 | rejected |
| trailing period dropped | 1.000 | rejected |
| one word inserted | 0.667 | **passes** |
| one word dropped | 0.643 | **passes** |
| `silently` → `quietly` | 0.600 | **passes** |
| clause reordered | 0.625 | **passes** |
| same meaning, reworded | 0.000 | **passes** |

A single interior word changes three shingles. On an *n*-word statement that is
three of *n*-2, so the ceiling on similarity after one word change is
`(n-5)/(n+1)`, and a length sweep confirms the crossing exactly: 10w 0.455, 15w
0.625, 20w 0.714, 25w 0.769, 28w 0.793 — all blind — then 29w 0.800 rejected,
30w 0.806, 35w 0.833, 40w 0.854. **A statement must reach 29 words before one
changed word can even in principle trip the threshold.** Most of the fourteen
are shorter than that. Every one of them could be re-raised tomorrow with one
synonym swapped and the gate would take it.

This is the failure the gate was built to prevent, arriving through the gate.
The countermeasure is against accumulation, and accumulation is what
near-duplicates *are* — nobody re-raises a lesson verbatim; they re-raise it in
their own words a month later.

The fix is not a lower threshold. 0.6 would have rejected the one-word-inserted
probe and still passed the reworded one, while starting to reject genuinely
distinct short rules — Jaccard on 3-shingles cannot see meaning at any
threshold. The honest options are (a) length-aware scoring, so a 12-word rule is
not held to a metric that is structurally incapable of firing on it, (b) an
embedding-similarity gate as a second opinion, or (c) accepting that the
mechanical gate only catches verbatim re-raises and making the *operator* the
near-duplicate check, with `mostSimilar` surfaced at approval time instead of
only at raise time. The numbers exist so the choice is made against measurement.

**Status: (c) built, 2026-08-10, branch `smith/phase-9/approval-novelty-gate`;
(a) built, 2026-08-27, branch `feat/vue-contract-gate`. (b) remains unbuilt.**
Every `lessons approve` — edited or not — now returns a `novelty` block: the
text that was scored, the nearest statement in the corpus, its score, and
*that lesson's id*, so the operator reading an approval sees the thing it most
resembles by name rather than having to remember the corpus. A 0.6
near-duplicate still lands; it lands with the operator having been shown what
it is near. That is the whole of (c) — it moves
the check to the human, it does not make the metric smarter, and the table above
still describes exactly what the mechanical gate can and cannot see.

(a) is now built. `effectiveNoveltyThreshold` lowers the bar for each *pair* to
`(n-2s+1)/(n+1)` — the score an *n*-word statement gets after one interior word
is swapped, which is the worst case of the three one-word edits and so the bar
that catches all of them — using the **shorter** of the two statements, because
the shorter one owns the scarce shingles. It never raises the operator's
threshold (`Math.min`): whoever configured 0.4 asked for a looser gate, not a
corrected one. Below `2*shingle_size+1` words it declines to judge and returns
the configured bar unchanged — there a near-copy and two unrelated statements
that happen to share one three-word run both score exactly one shingle, no
threshold separates them, and `novelty-rejected` is terminal, so a false
rejection is permanent loss. The knob is `lessons.novelty_length_aware`
(default `true`); there is deliberately no CLI flag, because
`--novelty-threshold` already lets an operator state a one-run bar in the units
they are thinking in and a second flag that silently rescales the first is a
worse override.

Measured against the real 25-statement corpus in `factory/policies/lessons.md`,
mutating every statement in turn:

| mutation | caught before | caught after |
| --- | --- | --- |
| one word substituted | 16/25 | **25/25** |
| one word inserted | 19/25 | **25/25** |
| one word deleted | 19/25 | **25/25** |
| two words changed | 0/25 | 0/25 |

No genuine pair in the corpus is newly judged redundant: the highest real
pairwise similarity is **0.0238**, and the lowest bar the correction put in play
is **0.400** — sixteen times the headroom. The last row is the honest boundary,
not an oversight: the correction is calibrated to exactly one edit, and a
two-word rewrite still walks through. So does containment — a nine-word rule
quoted verbatim inside a fourteen-word candidate tops out at 0.583 against its
own text. Both, and rewording that shares no shingles at all, remain (b)'s
problem; Jaccard on 3-shingles cannot see meaning at any threshold, corrected or
not.

The polarity guard has the same shape and was left alone deliberately.
`polarityDiffers` only runs when the score is already above threshold
(`lessons.ts:147`), so a rule that flatly contradicts an approved one in
different words is not flagged — it is not even compared. The approval-time
review does surface it when it *does* fire: `possible_contradiction_of` lands on
the `lesson-edited` payload naming the lesson the new text may contradict.

## P9-36 — The UI's edit route is a third door into memory, ungated

Found while fixing P9-34. `POST /api/lessons/:id/edit` in `ui/server/src/app.ts`
hand-wrote a `lesson-edited` event followed by a `lesson-status-changed` event
with `appendEvent`, never calling `transitionLesson` — so it skipped the novelty
check that P9-34 had just added *and* the legal-transition check that predates
it. The UI could move a lesson between statuses the state machine forbids, and
did: `approve` on an already-approved lesson wrote a second `to_status:
approved` the CLI has refused since P9-1. `reject` had the same hole.

It was not a one-line fix. The route resolved its session from the request body
(`resolveContext`) while the lesson itself is looked up across all sessions in
SQLite. Pointing `transitionLesson` at that context folds whichever log the
request named, which for a lesson raised in a different session is the wrong
log: the lesson is not in it, and the call fails with `lessons.unknown-lesson`
on a lesson that plainly exists.

**Status: fixed, 2026-08-10, branch `smith/phase-9/ui-lesson-gate`.** All three
lesson routes — `approve`, `reject`, `edit` — now call the same
`transitionLesson` the CLI calls. Four decisions, each a place this could have
been fixed badly:

- **The session comes from the lesson, not the caller.** `lessonSession()`
  reads `lessons.session_id` (the projection has carried it since the table
  existed) and that is the log folded and appended to. This is the actual fix;
  everything else follows from it.
- **A `sessionId` in the body is now checked, not used.** It became optional,
  and a value that disagrees with the lesson's own session is refused with
  `lessons.session-mismatch` rather than silently ignored — a caller that
  believes this lesson lives somewhere else believes something false, and
  quietly writing to the right log would hide that. The shipped Vue client
  cannot trigger it: `LessonsPage.vue` already passes the row's own
  `sessionId`, which is why the derivation could not regress it.
- **An archived log says so.** `requireSession()` (P9-28) runs before the fold,
  so a lesson whose session log is gone answers `events.unknown-session` naming
  the path it expected, instead of `lessons.unknown-lesson` — which would be a
  lie, since the lesson is right there in SQLite. This is the archived-log
  question the entry left open; the answer is that the UI refuses and says which
  log it wanted, rather than inventing a new one. **409, not 400**: the request
  is fine, the world is not, and restoring the log makes the same request work.
- **`acceptDuplicate` is forwarded, never defaulted.** The route accepts it and
  `transitionLesson` records the override on the event. The Approve button never
  sets it, so the operator's UI path cannot override the novelty gate by
  accident — the override stays a typed decision.

Every response now carries the P9-35 `novelty` block, so the UI is no longer
blinder than the CLI about what it just let into memory.

7 tests in `ui/server/test/app.test.ts`, red first: the illegal transition
writes nothing; the novelty gate fires on an edit and `acceptDuplicate` records
the override; a cross-session write lands in the owning log and never in the one
the body named; a missing log is named. 21/21 green, plus `pnpm test:ui` 35/35
untouched (the client needed no change, which was the point of deriving rather
than requiring the session).

**Left open at the time:** the client did not *display* the returned `novelty`
block, and `LessonsPage.vue` still offered Approve on a lesson that cannot
legally be approved — the server refuses it and the Banner shows why, but the
button should not be there. This entry claimed neither was testable, "there are
no Vue component tests, only `ui/test/*.ts` lib tests". That was wrong, and the
correction is the interesting part: `ui/test/taxonomy.test.ts` had already been
importing `factory/orchestrator/src/*.ts` from a UI test as a drift guard, and
`lib/timelineDisplay.ts` had already established that logic which needs asserting
gets lifted out of the SFC into `ui/src/lib/`. Both tools were on the shelf. The
premise "untestable" was a statement about where the code sat, not about the
repo.

**Status: closed, 2026-08-12, branch `smith/phase-9/lessons-approve-legality`.**

- **The legality predicate moved to `ui/src/lib/lessonActions.ts`.**
  `lessonActions(status)` derives the footer from a mirror of
  `LEGAL_LESSON_TRANSITIONS`, and `ui/test/lessonActions.test.ts` asserts the
  mirror `toEqual` the real table imported from the orchestrator — the copy
  exists because `lessons.ts` reaches for `node:fs` and `ui/` is a browser
  bundle, so the guard is what keeps a necessary copy from becoming a stale one.
  Unknown status yields no actions: a build that has never heard of a status
  cannot know its legal moves, and "probably fine" is the wrong default on the
  boundary that exists to stop memory poisoning.
- **Edit is gated with Approve, not separately.** The `/edit` route's terminal
  call is `transitionLesson(..., 'approved', ...)`, so an Edit affordance where
  Approve is illegal is the same bug wearing a different label. A test loops the
  whole table asserting `edit === approve` rather than trusting the one line
  that currently makes it true.
- **The missing button explains itself.** `lessonActionsNote()` reads the onward
  statuses out of the table — "from here a lesson can only become superseded or
  invalidated" — so the sentence cannot drift from the transitions it describes,
  and a footer with one button reads as a rule rather than a half-rendered page.
- **The quiet path is the one that needed saying.** `transitionLesson` only
  refuses a non-novel statement when the statement was *edited*, so a plain
  Approve of a near-duplicate was never refused: it entered memory with a
  "Lesson approved." toast and nothing else, and both rules were injected at
  every dispatch afterwards. `noveltyNotice()` now surfaces that, plus the
  polarity conflict — checked first, because a conflict scores as novel by
  construction (§9.6) and two rules that contradict each other is worse news
  than two that agree. A clean novel approval renders nothing, or the operator
  learns to dismiss the banner without reading it.
- **`acceptDuplicate` became an affordance.** `lessons.edit-not-novel`'s message
  says "pass `--accept-duplicate`", a CLI flag nobody reading a Dialog can type.
  The refusal now keeps the Dialog open with the statement intact and offers
  "Approve anyway (record override)"; it is only ever sent on that second press,
  so the override stays the typed decision P9-36 made it.

**15** unit tests in `ui/test/lessonActions.test.ts`, red first (module not
found, then four failures for the note), plus an e2e assertion in
`ui/e2e/lessons.spec.ts`: the fixture's only lesson is already `approved`, so
the Dialog it opens is exactly the bug — the test asserts Approve and Edit are
absent, Reject is present, and the note is shown.

## P9-37 — The taxonomy is copied by hand in four places, and every copy had drifted

Started as one missing value and turned into a sweep. `artifact-check-result`
was in `factory/policies/taxonomy.yml`'s `gate_event` but not in the §8 block of
`docs/specs/black-smith-architecture.md` that the yaml's own header claims to
mirror "value-for-value". Since an agent reads the spec, not the yaml, that is
the most dangerous class of bug this repo has: an agent that reads a list and
believes it.

Checking the other event enums against the code turned up four more, in
increasing order of consequence:

- **The yaml itself was behind the code.** Four gate events are emitted in `src`
  and were declared in neither file: `judges-outstanding` (gate.ts:1010),
  `coverage-evidence` (gate.ts:1118), `quorum-decision` (gate.ts:487,
  planQuorum.ts:435, epic.ts:445) and `finding-reattributed`
  (attribution.ts:242). All four shipped with P9-11, P9-25, the quorum work and
  P9-24 respectively — the code was written, the vocabulary was not updated.
  `gate_event` is now 21 values, each of the four carrying the comment block the
  dimension's older entries already had.
- **`event.schema.json` named an event that does not exist.** Its `event_type`
  description gave `gate-result` as an example. Nothing emits `gate-result`; the
  real event is `gate-outcome`. The description now says why the field is a free
  string and points at the taxonomy for the closed lists.
- **`ui/docs/design-spec.md` presented a partial list as the whole dimension.**
  It named nine `gate_event` subtypes with no hint that more exist. Now marked as
  "the ones this mock renders, not the whole dimension", with the requirement
  that the timeline render an unrecognised subtype rather than drop it —
  which `timelineDisplay.ts` already does (`iconFor` falls through to `history`,
  `titleFor` falls back to the raw `event_type`).
- **`db/queries.ts` dropped twelve of the twenty-one from the operator's
  timeline.** `TIMELINE_EVENT_TYPES` was a hand-written copy of the gate/graph
  dimensions and had fallen eight values behind even before this PR added four.
  The projector inserts every event into `eventsRaw` unfiltered
  (projector.ts:712), so the records were on disk the whole time — `timeline()`
  filtered them out on the way to the screen. `deps-check-result` is the proof
  this was not theoretical: it has had an icon, a title and an ok/fail rule in
  `ui/src/lib/timelineDisplay.ts` since P9-16d, and none of it could ever fire.
  §7 calls the interleaved timeline "a hard requirement" and says "errors and
  gate results attach to the same timeline"; a gate result the operator cannot
  see is one the factory may as well not have logged.

**Status: fixed, 2026-08-10, branch `smith/phase-9/taxonomy-mirror`.**
`taxonomy.yml` is at `version: 4`; §8's yaml block is now a byte-for-byte splice
of it rather than a retyped copy. Two standing guards, both red first:

- `factory/orchestrator/test/taxonomy.test.ts` parses the §8 fence and compares
  it against the loaded taxonomy — version, every dimension in order, every
  error group. Retyping either file without the other now fails a test instead
  of misleading an agent.
- `factory/orchestrator/test/db/queries.test.ts` appends one real event per
  taxonomy value, rebuilds, and asserts `timeline()` returns all of them. It
  tests the behaviour, not the constant, so it stays honest if the filter is
  rewritten.

The fix for the timeline is to stop copying: `timelineEventTypes()` reads
`gate_event` + `graph_event` off the taxonomy (lazily cached, the same pattern as
gate.ts:243 and events.ts:99) and concatenates the four types that are not
taxonomy values — `user_prompt`, `dispatch_decision`, `error-logged`,
`lesson-status-changed`. The next gate event added to the yaml reaches the
operator's screen by construction. Suites green in-session: `pnpm test`,
`test:server`, `test:ui`, all three typechecks, `lint`.

**Still open, and it is the real gap:** `event_type` is a free string
(`events.ts:24`), deliberately — a closed enum at write time would reject an
unknown event and lose the record, which is worse than logging one nobody reads
(`projector.ts:23` says as much). So nothing validates `gate_event` /
`graph_event` at the point of emission. What this entry adds is a guard on
doc↔yaml and a derivation for yaml→timeline; a typo in an `emit()` call still
writes cleanly and lands in the log as a type no dimension declares. The check
that would close it is a lint over `emit()`/`appendEvent` call sites with literal
event types, not a runtime enum — worth doing, not done here.

> **Closed 2026-08-12, after this phase.** PR #72 built that lint —
> `factory/orchestrator/test/helpers/eventTypeScan.ts` scans `src` textually
> (`typescript` is 7.0.2 and ships no JS compiler API) for `event_type:`
> literals and for any helper whose parameter is named `eventType`, resolving
> module-level `const UPPER_SNAKE = 'literal'` indirection: 47 uses, 36 distinct
> types, each held against the taxonomy or against a `FREE_EVENT_TYPES`
> allowlist whose entries name where the type is written and are pruned when
> that stops being true. PR #73 added the reverse direction,
> `UNEMITTED_EVENT_TYPES`, for values the taxonomy declares and nothing emits.
> `event_type` is still a free string at write time, unchanged and on purpose —
> the lint reads literals only, and anything computed at runtime stays free.
> Two findings from the first real run were reported rather than fixed, because
> both are vocabulary decisions: `judge-verdict`, `judge-reported` and
> `epic-closed` are written by `src`, declared by no dimension, and absent from
> `FREE_TIMELINE_EVENT_TYPES`, so they never reach the operator's timeline; and
> `plan-version-superseded` / `task-split` are declared and emitted by nothing.
> The paragraph above stands as the record of what Phase 9 itself left open.

## Rule candidates from the run

The dogfood also produced transferable rules — the kind the lessons pipeline
exists to carry. Each is one sentence and cites its D-number.

**Status: all fourteen are now approved and compiled** into
`factory/policies/lessons.md` via `smith lessons raise` (P9-34) → `lessons
approve` → `db apply` → `lessons compile`, and reach agents at dispatch through
P9-2: 7 stack-wide (planner, scribe), 3 agent-role (grader, merger,
spec-reviewer, verifier), 4 claim-path (coder, reviewer, tester). None carries a
`finding_category`, so none escalates a repeat finding — deliberate, and now
documented in the generated file's own header: a category paired with
`claim_path: **` fires on every finding of that category anywhere in the repo,
and a gate that fires on everything distinguishes nothing. Escalation-worthy
lessons should come from actual repeat findings, which is the same-mistake KPI's
job, not this list's. The list is kept below as the provenance record.

- *Measured spend is a floor, not a total; a check that treats it as a total
  reports "under budget" most confidently on exactly the runs whose unrecorded
  half is what blew the budget.* (D-9, D-12)
- *A differential acceptance criterion must state what the failing output says
  under the hypothesis **and** under the null; if the two are the same text, the
  criterion is vacuous.* (D-11 — the coverage probe "proved" `perFile` with a
  failure the aggregate config produces too.)
- *A function that computes a filesystem path and hands it to a child process
  running with a different `cwd` must resolve it to absolute first.* (D-24)
- *A `**/name*/**` glob matches a directory, never a file of that name.* (D-25)
- *An identifier that is parsed rather than passed will eventually be parsed by
  two functions that disagree, and the disagreement surfaces at the join — the
  last step, and the most expensive place to find it.* (D-28)
- *A constraint stated only in a prompt is a request; if the plan writes it down
  like a limit, something has to be able to say no.* (D-29)
- *When one stage verifies state A and the next ships state B, the pipeline is
  correct only by coincidence.* (D-30)
- *A supervisor that cannot tell silence from assent will eventually mistake a
  corpse for a quorum.* (D-31)
- *Never ask a component for a fact it has no instrument to measure; it will not
  refuse, it will estimate, and the estimate will look exactly like data.*
  (D-35)
- *A controlled vocabulary that is referenced but never shown is a vocabulary the
  writer will reinvent.* (D-37)
- *A check that silently borrows its tools from the inspector is measuring the
  inspector.* (D-38)
- *Plan immutability is a promise to the builder, not to reality; a system that
  can only blame the builder will deadlock the moment the plan is what is
  wrong.* (D-39)
- *A wrapper that collapses a child's exit signal into an exit code has deleted
  the only evidence that distinguishes a crash from a failure, and every
  diagnosis downstream of it will be about the wrong subsystem.* (D-47)
- *Two features that each refuse to guess can still deadlock, because refusing
  is not the same as agreeing on who decides; a system that mints work in one
  component and validates it in another must share one answer to "does this
  task exist", not two correct ones.* (D-48)

## Already on the Phase 9 goal line

Carried from `factory/specs/roadmap.md` and not re-specified here: budget
alarms, the same-mistake KPI, runbooks, the Cloudflare deployment port (moved
from Phase 6), and the always-on dispatch daemon (moved from Phase 7).

**Budget alarms: built** — `smith budget alarm` (operator-guide §9a). Reports
`measuredTokens` next to `projectedTokens` and exits 1 on `unverifiable`, because
the recorded spend is a floor and every hole in the record can only make the
bill bigger.

**Same-mistake KPI: built, and it reads `unverifiable` on every session on
disk** — `smith kpi same-mistake` (operator-guide §10a). §9.7's target
("monotonically decreasing") now has something reading against it, and the first
thing it says is that the number cannot be read yet. On `dogfood-envkit-1`:
14 compiled lessons, **0** of which can escalate anything, 7 gate intakes, 4 of
them deciding nothing, 4 decisions across **1** calendar day. `smith stats
analytics` reports that session as a clean 0.00%; the KPI refuses to, because
the numerator was pinned at zero by the corpus rather than by the factory's
conduct — the same shape as budget alarms, running the other direction. Two
supporting changes ship with it: the gate now records `lessons_escalating` on
every `severity-decisions` event (so a blind run is distinguishable from a clean
one from here on; every event already on disk predates the field and is counted
as a hole), and `analytics()`'s `sameMistakeRateByDay.rate` is now `null` rather
than `0` on a day with no decisions (D-31).

The remaining three — runbooks beyond `docs/runbooks/providers.md`, the
Cloudflare port, the dispatch daemon — are untouched. They moved to Phase 10
rather than staying on a completed phase's goal line; see
`factory/specs/roadmap.md` § Phase 10 — Deployment + ops.

Escalation ladders were on this list until building one turned out to need a
spec of its own — see P9-32.

## Phase 9 close-out

Written 2026-08-10, when the last punch-list entry merged. Cited from
`factory/specs/roadmap.md` § Phase 9, which is `status: completed` on the
strength of what follows. This section is the audit of that claim: what closed,
what was left open on purpose, and — the part worth reading — what a completed
Phase 9 still does not prove.

### What closed

Thirty-seven entries, P9-1 through P9-37. Every one carries a `**Status:**`
line naming a date and a branch; that was itself a close-out repair, since
P9-33 shipped without one and it went unnoticed until this section was written.
The work landed as 42 merged PRs, **#20 through #62**. #38 is the one closed
unmerged: its P9-8 work was reassembled into the Phase 9 integration PR (#55,
"assemble the seventeen punch-list PRs (#38–#54)").

Grouped by what they actually were:

- **Unenforced rules, given enforcement** (P9-1…P9-7, from the interviews).
  The approval verb, dispatch-time lesson injection, the collector/classifier
  split, a host for `sensitive-paths.yml`, the judge immutability guard,
  prompt-injection fencing, cross-session edges. In each case the rule already
  existed in a template or a policy file and nothing read it.
- **Stages that ran, returned success, and were wrong** (P9-8…P9-30, from the
  dogfood). The three that mattered most: producers for the five task-status
  events that had readers and no writers (P9-29), checks that run at the
  integration root instead of only inside task worktrees (P9-26), and an epic
  close that is a logged fact and a folded projection rather than terminal
  output (P9-27).
- **Defects the fixing itself produced** (P9-31…P9-37). Two correct items that
  broke against each other (P9-31), and six variants of "the assertion exists,
  the reader does not" — including this phase's own goal line, whose escalation
  ladder turned out to be prose nothing parsed (P9-32).

Three of the six items the roadmap goal line carried are built, each as a
command rather than as a paragraph: `smith escalation check` (P9-32), `smith
budget alarm` (P9-33), `smith kpi same-mistake`. The other three — runbooks
beyond `docs/runbooks/providers.md`, the Cloudflare port, the dispatch daemon —
were never started and moved to Phase 10 rather than being quietly dropped off
a completed phase. The MCP surface standard
(`docs/standards/mcp.md`, `smith mcp init|check`, hard-gated at epic close)
also landed in this phase and has no punch-list number at all — it came from
operator decisions on 2026-08-07, not from this list, which is why it is easy
to miss when reading the list as a record of the phase.

### What was left open, on purpose

Four things, each with a reason that is not "we ran out of time".

- **P9-35 (a) length-aware scoring and (b) an embedding gate.** Only (c)
  shipped: every `lessons approve` now returns a `novelty` block naming the
  nearest statement and its id, so the operator sees what the new rule most
  resembles. That moves the check to the human; it does not make the metric
  smarter. At its defaults the gate is still an exact-duplicate detector, and
  the entry's table says so rather than implying otherwise. The polarity guard
  was left alone for the same reason: `polarityDiffers` only runs when the
  score is already above threshold (`lessons.ts:147`), so a rule that flatly
  contradicts an approved one in different words is never compared.
- **P9-36's two UI items.** The client does not display the `novelty` block it
  now receives, and `LessonsPage.vue` still offers Approve on a lesson that
  cannot legally be approved — the server refuses and the banner explains, but
  the button should not be there. Blocked on infrastructure, not on judgement:
  this repo has no Vue component tests, only `ui/test/*.ts` lib tests. An
  untested edit to a memory-facing screen is exactly the trade this phase spent
  37 entries arguing against.

  > **Closed 2026-08-12, after this phase**, on branch
  > `smith/phase-9/lessons-approve-legality` — and the reason recorded here was
  > wrong. "No Vue component tests" describes where the logic sat, not what the
  > repo can test: `ui/test/taxonomy.test.ts` was already importing the
  > orchestrator's enums as a drift guard, and `lib/timelineDisplay.ts` had
  > already set the precedent of lifting assertable logic out of the SFC. Both
  > items shipped with 15 unit tests and an e2e assertion. See the closure note
  > under P9-36 above.
- **P9-37's `emit()` lint.** `event_type` is a free string (`events.ts:24`) on
  purpose — a closed enum at write time would reject an unknown event and lose
  the record, which is worse than logging one nobody reads. So the taxonomy is
  now derived rather than copied, and a typo in an `emit()` call still writes
  cleanly and lands as a type no dimension declares. The check that closes it
  is a lint over call sites with literal event types, not a runtime enum.

  > **Closed 2026-08-12, after this phase**, by PRs #72 and #73 — see the
  > closure note under P9-37 above. Two of the four are still open (P9-35's
  > (a)/(b) and envkit's MCP surface); "four things" is the count as the phase
  > closed, not as it stands today.

- **envkit has no MCP surface.** The standard is hard-gated at epic close, but
  envkit's epic closed 2026-08-07 — the same day PRs #30/#31 introduced the
  gate — so MCP-M1/M2 were never applied to it and were not applied
  retroactively. Verified in-session:

      $ node factory/orchestrator/dist/cli.js mcp check envkit
      {"error":{"code":"mcp.no-surface","message":"…/workspaces/envkit/mcp.manifest.json does not exist.
        Run `smith mcp init envkit` before checking the surface.", …}}
      exit=1

  The only project the factory has ever taken end to end does not satisfy the
  standard the factory now enforces on every project after it. That is a
  defensible grandfather clause and an indefensible thing to leave undocumented.

  > **Two corrections, 2026-08-13.** "The standard is hard-gated at epic close"
  > was false when written and stayed false for six days: the gate resolved
  > `required: false` for every epic ever, because `smith mcp init` seeded the
  > milestone with `epics: []` and the gate keyed applicability on that list
  > (`dogfood-mcp-close.md` D-109, fixed). So the grandfather clause above was
  > not a clause — nothing was being enforced on the projects *after* envkit
  > either. And envkit does have a surface now, built by the
  > `envkit-mcp-surface` epic; it sits on
  > `smith/envkit-mcp-surface/integration`, unmerged, because that epic's close
  > was refused on eleven findings. `smith mcp check envkit` no longer errors
  > `mcp.no-surface` — it reports one violation, MCP-M2, which is the milestone
  > still being open.

### What this phase does not prove

Read this part before trusting the word `completed`.

**There is no CI.** No `.github`, no `.circleci`, no `.gitlab-ci.yml`, no
`Jenkinsfile`. Every "green" in this document — 1254 orchestrator tests, 21
server, 35 UI, three typecheck projects, `biome check` over 166 files — is one
local run, on one machine, by one operator, at one moment. Nothing re-runs
them; nothing will notice when one of them stops being true. A phase about
unenforced rules ends with its own verification unenforced, and that is the
largest single hole in everything above.

> **Closed 2026-08-11, after this phase.** `.github/workflows/ci.yml` now runs
> `scripts/check.sh` (the file itself, so the two lists cannot drift) plus a
> Playwright job on every pull request and every push to `main`. The paragraph
> above stands as the record of what Phase 9 itself proved, which is unchanged:
> the hole was real while it was open, and the counts in it were still one local
> run on one machine.

**All three instruments this phase built report that they cannot see.** Run
against `dogfood-envkit-1`, the only real epic on disk:

- `smith kpi same-mistake dogfood-envkit-1` → `"status":"unverifiable"`, exit 1
  — 0 same-mistake of 4 decisions, but none of the 14 compiled lessons can
  escalate anything (14 name no `finding_category`, 3 are not file-scoped), so
  the zero is a property of the corpus, not of the factory's conduct.
- `smith budget alarm dogfood-envkit-1` → `"status":"unverifiable"`,
  `"ok":false`, exit 1 — 0 tokens measured across 0 of 5 tasks, 1,150,000
  projected against a 1,400,000 alarm, and `budgets.yml` declares no cap for
  `security-reviewer`.
- `smith escalation check dogfood-envkit-1` → `"ok":false`, exit 1. Two checks,
  one task: rung 1 `not-applicable` (it declares no action, so there is nothing
  for the log to evidence), rung 2 `unverifiable` — `task-1b-parse-quotes` was
  gated again after 2 failed rounds and no builder dispatch is recorded for it.

This is the intended behaviour and it is still a result: the instruments are
honest, and what they are honest about is that the factory has not yet produced
a record they can read. Three commands that say "unverifiable" are worth more
than three that say "0.00%", and they are worth much less than one measured run.

**No epic has been run end to end since the fixes.** The 37 items were verified
by unit tests against a frozen log, not by a second dogfood. `state/events/`
holds exactly three sessions: `dogfood-envkit-1` (70 events, 2026-08-07),
`dogfood-envkit-followup-1` (6 events, one finding raised and transitioned),
and `phase-9-lessons-1` (31 events, the lessons pass). Nothing has driven a
plan → waves → gates → merge queue → epic close since P9-8 landed. Every claim
that these fixes hold *together* is inference from tests, not observation.

**Nine finding ids are cited as evidence and defined nowhere.** D-1, D-3, D-4,
D-6, D-7, D-9, D-10, D-11 and D-12 are referenced across this file, the
operator guide and the test suite. `docs/specs/dogfood-envkit-findings.md`
begins at D-14 and has since its first commit (42811af); `dogfood-envkit-close.md`
advertised the range as "D-0…D-47" and was wrong at both ends. Grep is the
whole proof:

    $ grep -rho 'D-[0-9]\+' docs/ factory/ | sort -t- -k2 -n -u
    D-0 D-1 D-3 D-4 D-6 D-7 D-9 D-10 D-11 D-12 D-14 … D-49 …

Those citations are left as they are rather than renumbered — renaming an id
nobody can look up does not make it findable, and rewriting the evidence
pointers of a phase about honest records would be the wrong kind of tidy. It is
the same defect class as P9-37, one layer up: a reference kept by hand, drifting
against a source nothing checks it against.

**The phase graded its own homework.** P9-31…P9-37 exist because the list was
written down; a phase driven from memory produces the same seven defects and no
entries for them. That is the strongest argument this document makes for itself
— and it is also the reason to distrust it, because every finding here was
found by the same operator and the same model that wrote the code. The dogfood
half (P9-8…P9-30) is the only part found by something other than introspection,
and it found the worst items on the list.
