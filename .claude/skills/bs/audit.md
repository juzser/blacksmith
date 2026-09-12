# `/bs audit <project-dir>` — audit a project on four axes and cut one epic

[`dispatch.md`](dispatch.md) binds every agent this playbook dispatches;
none of it is restated here.

The audit playbook (`docs/specs/audit-command-scope.md`). Four judges read
one project at its HEAD — performance, code-quality, architecture, security
— and the store ranks what they return; **you decide nothing about a finding
until the hard stop in step 7**, and the operator decides it there. The
output of a clean audit is one roadmap milestone and one epic spec, which
`/bs plan` then plans like any other; the audit itself writes nothing into
the project's working tree. The mechanics are the seven `audit` verbs of
`smith` and the judgment is this file — an audit outlives the turn that starts it, so keep
the `audit_id` the way you keep a session id.

## 1. Ask for the project directory once

`<project-dir>` below is that answer, a positional on every `audit` verb —
nothing reads a cwd and nothing keeps a "current audit" on the side, so two
audits on two projects cannot be confused. The project must be a git
checkout; a directory this factory did not build is as auditable as one it
did. Then `mkdir -p state/audit` in this clone: the judges' artifacts live
there, under runtime state, never under the project.

## 2. Open the audit

```bash
smith audit open <project-dir> --session <session-id> --causal-parent <event-id>
```

It writes `<project-dir>/.blacksmith/audit.json` (the manifest: id,
worktree, HEAD, fingerprint), cuts a **detached, read-only worktree at
HEAD** beside the project — `<parent>/.wt/<project>/audit`, a fixed
path — and emits `audit-opened`. Keep four fields of its output:
`audit_id`, `worktree` (absolute — it goes into every prompt), `axes`,
and `live`. `live` is what the store already suppresses from earlier
audits of this project — `raised`, `merged` and `accepted` findings, and
`declined` ones less than 90 days old; `fixed` never suppresses, so a
defect that returns after its epic is raised afresh. Read it before you
dispatch: it is the dedupe context, and a judge that re-raises a
suppressed finding is dropped at record, not argued with at the hard
stop. Refusals, each an exit 1 with nothing written:
`audit.project-missing` and `audit.not-a-git-repository` mean the answer
in step 1 is wrong; `audit.already-open` names the open audit and its
worktree — close it (step 9) rather than opening a second;
`audit.worktree-exists` means a previous audit never closed and left the
directory with no manifest naming it — `git worktree remove` it from
inside the project, then retry.

## 3. Fingerprint the worktree once, before any judge runs

The four axes share one worktree, so one fingerprint covers all four:

```bash
smith worktree fingerprint <worktree-dir> > /tmp/<audit-id>.before.json
```

## 4. Dispatch the four axes in parallel

One judge per axis, under the ordinary dispatch contract — nothing about an
audit relaxes it. Three axes are `auditor` (`.claude/agents/auditor.md`, the
axis named in the prompt); the security axis is `security-reviewer`,
unchanged, with the two audit-specific differences its template already
states. Per axis:

- **Lessons.** `smith lessons for-dispatch auditor` (for security,
  `smith lessons for-dispatch security-reviewer`); paste its `text`
  verbatim. No `--plan`/`--task`: an audit has no claims, so only the
  unscoped and stack-wide lessons come back, which is what a whole-tree
  judge should carry.
- **The project's own rules, fenced.** The judge reads the project
  against what the project says about itself, so `CLAUDE.md` — and
  `AGENTS.md` where one exists — go into the prompt verbatim, as
  content under analysis rather than instructions:

  ```bash
  smith prompt wrap <worktree-dir>/CLAUDE.md --kind file-excerpt --source <project>/CLAUDE.md
  ```

  A project with neither file is audited against its code alone; say so
  in the prompt rather than leaving the judge to wonder what it was not
  given.
- **Declare the artifact before the call.** The task id is
  `<audit-id>.<axis>` — an audit has no plan and no task rows, and the
  judge ledger keys on the string you give it:

  ```bash
  smith judge dispatch --task <audit-id>.<axis> --role auditor \
    --artifact /abs/path/to/state/audit/<audit-id>.<axis>.json \
    --model <model-id> --session <session-id> --causal-parent <event-id>
  ```

  `--role security-reviewer` for the security axis. `--model` is the
  concrete id of the model the axis actually runs on, never a
  placeholder; the templates declare the tier, and the escalation
  ladder does not apply — an audit axis runs once, at its declared
  model, and a thin return is a re-poke (below), not a bigger model.
- **Compose the prompt** with: the axis name (exactly one); the
  absolute worktree path, and that it is read-only; the artifact path
  from the declaration above, verbatim; the turn budget from the
  template's `maxTurns` (the harness enforces that number, so the
  prompt may restate it but never raise it — `dispatch.md`); the fenced
  excerpts; the lessons block; and for the security
  axis, that each element carries `confidence` and lives under
  `state/audit/`. Emit `dispatch_decision` before the call and
  `task-result-recorded` or `error-logged` after it, as for any judge.

**On providers.** The spec asks that at least one axis run on the second
provider `crosscheck.yml` declares, when its key is present. Today no
playbook mechanism dispatches a Claude Code agent on another vendor's
model — `smith judge run` calls a provider by hand with a verdict
request, and `smith crossfind run` reads a diff, not a tree — so the
four axes run on Claude models, and that gap is recorded in the spec
rather than papered over here with a dispatch that does not exist. Fable
is never used, on any axis: that is a standing operator constraint, not
a tier choice.

## 5. Verify, report, record — per axis, as each returns

```bash
smith worktree verify <worktree-dir> --before /tmp/<audit-id>.before.json
```

Clean, then the artifact:

```bash
smith judge report --task <audit-id>.<axis> --role auditor \
  --session <session-id> --causal-parent <event-id>
smith audit record <project-dir> --axis <axis> --evidence state/audit/<audit-id>.<axis>.json \
  --session <session-id> --causal-parent <event-id>
```

`--role security-reviewer` on both lines for the security axis, as at
dispatch. `judge report` refuses three ways — `judges.artifact-missing` (the judge
ended on a plan and wrote nothing: re-poke it, and
`smith judge outstanding --session <session-id> --task <audit-id>.<axis>`
exits 1 while the file is still owed, so it is the loop condition),
`judges.artifact-unparseable` (it narrated), `judges.artifact-not-a-list`
(some other shape). `audit record` then refuses the evidence itself —
`audit.evidence-carries-identity` (the judge set `fingerprint`,
`status`, `axis`, `audit_id`, `ts`, `epic` or `same_as`, which are the
store's to mint), `audit.evidence-incomplete` (a `failure_scenario` leg
missing, or no `confidence`), `audit.unknown-severity` (a bare `S2`
instead of the taxonomy string), `audit.confidence-out-of-range`,
`audit.evidence-not-a-list`, `audit.unknown-axis` — and each is a
re-poke of that one judge with the refusal quoted, never a hand-edit of
its file. On success it prints `appended` (fingerprints raised) and
`suppressed` (what the fold dropped: already raised, accepted, or
declined within the last 90 days). `audit.not-open` here means the
manifest is gone — someone closed the audit under you; start again from
step 2.

**Drift.** An exit 1 from `worktree verify` means a judge moved the tree
it was judging, and the tree is shared: discard that return **and every
return not yet verified**, since none of them can now be attributed to
the HEAD the audit opened on. Then

```bash
smith audit close <project-dir> --force --session <session-id> --causal-parent <event-id>
smith audit open <project-dir> --session <session-id> --causal-parent <event-id>
```

`--force` is right here and only here — the drift is the known reason
the close would otherwise refuse. The reopen mints a new `audit_id` on
a fresh worktree; re-run step 3 and re-dispatch the discarded axes
under the new id. Evidence already recorded survives in the store — it
was recorded against a verified tree — so a clean axis is not re-run.

## 6. Consolidate once all four axes are recorded

```bash
smith audit consolidate <project-dir>
```

A pure read, no envelope. It folds the store and prints `clusters` —
the `raised` findings grouped by normalized file path, ranked **severity → convergence
→ confidence**: the worst member first, then how many distinct axes
named the same file, then the judges' own estimate, last. `counts` is
the store by status. A cluster is a suggestion that its members are one
defect seen from several lenses; it is never a merge — that judgment is
the operator's, next.

## 7. Hard stop

Present the ranked clusters to the operator — each cluster with its members
side by side (axis, severity, summary, the scenario), worst first — and ask
for every decision as **one batch**: for each finding, `accept`, `decline`,
or `merge` into a named survivor. Two questions ride along and are asked
here, not separately: whether two members of a cluster are the same defect
(you may propose the merge; only the operator's answer makes it one), and —
once per project, the first time — whether `.blacksmith/` should be added to
the project's `.gitignore`. The audit never edits that file; if the answer
is yes, the operator adds the line, and the question is not asked again.
Then persist each answer:

```bash
smith audit decide <project-dir> --fingerprint <fp> --decision accept \
  --session <session-id> --causal-parent <event-id>
smith audit decide <project-dir> --fingerprint <fp> --decision merge --same-as <survivor-fp> \
  --note "<why>" --session <session-id> --causal-parent <event-id>
```

Refusals: `audit.unknown-finding` (no such fingerprint), `audit.unknown-decision`,
`audit.merge-without-survivor` (`merge` needs `--same-as`),
`audit.same-as-refused` (`accept`/`decline` must not carry it),
`audit.merge-into-self`, `audit.unknown-survivor`. A decline expires
after 90 days — the store is not a waiver register, and an old decline
re-raises as fresh rather than silently holding.

## 8. Cut one epic from what was accepted

```bash
smith audit cut <project-dir> --epic <epic-id> --title "<milestone title>" \
  --session <session-id> --causal-parent <event-id>
```

It stamps the epic id onto every accepted finding, emits `audit-cut`,
and prints two strings; **it edits no file**. Paste `milestone` into
`factory/specs/roadmap.md` as the next milestone block — it already
carries `- project: <basename>` and `- kind: product` — and write `spec`
to `factory/specs/active/<epic-id>/epic-spec.md`. `audit.nothing-accepted`
means step 7 accepted nothing: there is no epic to cut, and closing is
the right next move. One audit cuts one epic; findings accepted after a
cut belong to the next audit's cut, not to a second cut from this one.

## 9. Close the audit

```bash
smith audit close <project-dir> --session <session-id> --causal-parent <event-id>
```

It verifies the worktree one last time against the manifest's
fingerprint, removes the worktree, deletes the manifest, and emits
`audit-closed` with `verified` and any `drift` it saw. A refusal here is
`audit.worktree-moved`: something changed the tree after the last axis
was verified. It is not this playbook's to override — report the drift,
and pass `--force` only on the operator's explicit yes. A worktree that
is already gone closes with `verified: false` and no refusal.

## 10. Hand off

The epic is now an ordinary roadmap milestone: run `/bs plan` on it
([`plan.md`](plan.md)), then `/bs run`. When that run reaches its epic-close
step, it runs
`smith audit resolve <project-dir> --epic <epic-id> --session <session-id> --causal-parent <event-id>`,
which appends `fixed` for every finding the epic carried — repeatable, and
`audit.unknown-epic` if the id was never cut from this store. That is the
only step of an audit that runs outside this playbook, and it is why the
store, not this transcript, is where a finding's life is kept.
