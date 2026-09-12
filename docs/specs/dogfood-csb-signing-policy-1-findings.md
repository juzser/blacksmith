# Dogfood findings — planning `csb-signing-policy-1`

What the factory did while *planning* (not running) the successor epic
`csb-audit-1` named when it closed: four planner rounds, two spec-review
rounds, and one plan-quorum round, in session
`csb-signing-policy-1-2026-09-11` (events `#0`–`#34`). The plan froze as v1
at `#34` after the operator signed it with three approved edits. This file is
the **raw evidence log** for the factory defects that round surfaced,
numbered FD-37.. so it continues `dogfood-csb-audit-1-findings.md` (FD-1..36)
rather than restarting; every item was observed in-session, not inferred.

The distillation an implementer should work from is a roadmap entry, not
this file. This file holds the repro.

Status legend: **confirmed** = reproduced with a command in-session ·
**observed** = seen once, no isolated repro · **open** = stated but
unverified.

---

## The external-provider transport (`factory/orchestrator/src/providers/api-transport.ts`)

**FD-37 — confirmed.** `callChatApi` sends no `max_tokens`
(`api-transport.ts:56-63` builds the body from `model`, `messages`,
`temperature` and the optional `response_format`; nothing else). A reasoning
model (`deepseek-reasoner`) therefore runs to its own 64K cap on a
plan-critique prompt, and the first two `plan quorum` attempts ended as
`length`-truncated output — ≈ $1.13 of credit for two verdicts that never
parsed. The runner `$S/specrev-r3.run-chat2.mjs` had to be written outside
the factory to pass a cap at all.

**FD-38 — confirmed.** On invalid output the transport discards everything
it knew: `extractAndValidate` (`schema-validate.ts:125`) returns only the
parsed/invalid shape, and the caller at `api-transport.ts:166-177` keeps
`usage` but not the raw `content` or the provider's `finish_reason`
(`api-transport.ts:33` does not even type it). The operator cannot tell "the
model stopped mid-JSON" from "the model wrote prose", and the only evidence
is gone.

**FD-39 — confirmed.** The one `NUDGE` retry (`api-transport.ts:17`, applied
unconditionally at `:168-177`) re-sends the whole prompt plus "Return only
valid JSON per schema." — for a `length` truncation that doubles the cost of
a failure the nudge cannot fix. The retry should be conditional on
`finish_reason === 'stop'`.

**FD-40 — observed.** `deepseek-chat` under `response_format:
{type:'json_object'}` answered once with the literal `{"type":"json_object"}`
echoed back. The schema check rejected it correctly; the point is that the
transport treated it as a nudge-able shape error rather than a provider
quirk worth a preflight probe (`smith judge preflight` sends no such probe).

**FD-41 — confirmed.** `extractAndValidate` for an `ARRAY_VALUED_SCHEMAS`
name (`schema-validate.ts:115,133`) validates element-wise when the top
level is an array — but a bare object that validates as one element is also
accepted, and a `{"findings":[…]}` wrapper (the shape `json_object` mode
nudges models toward) is rejected outright. Both are the wrong tolerance:
accept the wrapper whose single key holds an array, refuse the bare object.

**FD-42 — observed, outside the factory.** The hand-written spec-review
runner (FD-44) split the plan into slices so a non-thinking model could
cover it; a judge handed one slice answered about the whole plan twice.
Recorded for whoever builds the first-class path: the request must mark the
slice as the only admissible scope, and the way back must check that each
finding's `file_path` lies inside it.

## Configuration (`factory/policies/crosscheck.yml`)

**FD-43 — confirmed.** `deepseek` pins exactly one model
(`crosscheck.yml:96` `model: deepseek-reasoner`) with no non-thinking
fallback and no per-call deliberation budget; `codex` pins none and
inherits whatever the CLI defaults to, so `smith dispatch check`'s
by-model-id comparison depends on a value the policy never states. When the
reasoner exhausted its cap the only recovery was a hand-written runner
against `deepseek-chat`. Proposal: `models: [primary, fallback]` per
provider plus a `max_tokens` per `mode`, read by the transport.

**FD-44 — open.** There is no first-class external-provider path for the
`spec-reviewer` role: `plan.md:44` requires it on a model other than the
planner's, the Sonnet weekly limit removed the native alternative, and
`smith judge run` accepts no `--model` / `--max-tokens` — its usage is
`--provider <name> --request <request.json> [--shadow]` (`cli.ts:3571`), and
it "touches neither the log nor quorum" by design. The whole
spec-review-on-DeepSeek path ran outside the factory and is therefore not
in the event log as a judge dispatch (it is in the log as prompt records
and operator notes).

## The `/bs plan` playbook (`.claude/skills/bs/plan.md`)

**FD-45 — confirmed.** Step ordering: step 4 (`plan.md:52-58`) runs
`smith plan quorum --epic <epic> --plan-version 1` *before* step 6
(`plan.md:80-82`) writes `factory/specs/active/<epic>/plan-v1.json`, but
`runPlanQuorum` → `loadPlan` (`planQuorum.ts:521`, `plan.ts:211`) reads only
`plan-v<n>.json`. Following the playbook literally fails with a missing-file
error; the session copied the draft to `plan-v1.json` by hand to proceed,
which is a v1 that existed before it was signed. Either quorum takes a
`--plan <path>` or the playbook freezes the draft as `plan-v1.json` with
`status: draft` at step 4 and step 6 becomes "flip status".

**FD-46 — confirmed.** The plan-critique prompt
(`planQuorum.ts:333-347`) hands judges each task's `objective`, case and
token budget — never its acceptance criteria. Both external refutations
(`#29`, `#31`) argued against a criterion the plan already carried in its
`acceptance_criteria` (C4's S4 specimen, C7's NULL-trustedlist case),
because the judge could not see it. A critic of a plan that cannot read the
plan's criteria is critiquing the epic goal, not the plan.

**FD-47 — confirmed.** `PlanQuorumTrigger` entries are not uniform:
`security` triggers carry `matchType`/`matchedValue`
(`planQuorum.ts:173,178,188-190`), `budget` triggers (`:229`) do not, and a
consumer that reads `matchType` across the array throws `KeyError` on the
budget entry (observed in the session's own python post-processing of
`quorum-1.json`). `describeTrigger` (`:285-286`) handles it by kind; the
serialised shape should carry the discriminant on every entry.

**FD-48 — observed (FD-12 recurrence).** A second held escalation now
exists — `plan:csb-signing-policy-1/plan-v1`, beside csb-audit-1's — and no
verb records the operator's answer to it. This session recorded the answer
as a `user_prompt` (`#33`) and the sign-off as `plan-version-created`
(`#34`); the escalation row itself stays `held`.

## Orchestrator ergonomics

**FD-49 — observed.** The Bash tool's ~39 kB output cap forces every long
judge return through "write to a file, read the file" — which is the return
discipline anyway (M-6), but it also means `smith plan quorum`'s own JSON,
at 3 rationales × several kB, is best read from `--out <file>` than from
stdout. `plan quorum` has no `--out` (usage at `cli.ts:1149`: `--epic
--plan-version --session --causal-parent [--confidence] [--actor]
[--state-dir]`).

**FD-50 — observed.** Codex `active` judges spend the operator's ChatGPT
quota and DeepSeek judges spend prepaid credit; nothing in the
`quorum-decision` payload says which purse a verdict cost, so the report
the operator reads after the fact cannot total it. `smith stats providers`
counts calls, not currency.

---

Held escalations at the time of writing: `plan:csb-audit-1/plan-v1`,
`plan:csb-signing-policy-1/plan-v1` (both FD-12/FD-48).
