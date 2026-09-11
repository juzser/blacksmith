# Epic spec — `csb-audit-1`

- **Epic id** — `csb-audit-1`
- **Plan** — `factory/specs/active/csb-audit-1/plan-v1.json` · version 1 · status `active` · `plan validate` → `{"valid":true}`
- **Effort tier** — `medium` (`factory/policies/effort.yml`; `security_floor: medium` pins it here — this epic could not run lower)
- **Project** — `claude-status-bar-macos`, and every worktree is placed beside that clone, never inside this one
- **Shape** — 2 tasks · 2 waves · widest 1 · serial by a declared `artifact` edge
- **Roadmap milestone** — `csb-audit-1`, `factory/specs/roadmap.md:107-113`, status `planned`
- **Provenance** — the first epic cut from the four-axis audit of 2026-09-07 (45 findings: 0 S1, 9 S2, 29 S3, 7 S4)

Nothing in this epic has executed. This document is the step-5 artifact: it exists
to be signed off, amended, or refused.

## What this epic is

Four findings from the audit, chosen by you as *the security and build cluster
only* — the one cluster already doing damage rather than only risking it, and the
one that touches no UI and no `AppState`, so it cannot regress the menu bar.

| Finding | Sev | What is wrong |
|---|---|---|
| **SEC-2** | S2 | `scripts/ensure-signing-identity.sh:56` runs `security set-key-partition-list -S apple-tool:,apple:,codesign: -s "$LOGIN_KEYCHAIN"`. `-s` is a predicate taking no operand, so the keychain path is swallowed as a positional and the command rewrites the partition list of **every** signing private key in the login keychain, destroying `teamid:` partitions irreversibly. |
| **SEC-3** | S2 | `scripts/make-app.sh:80` signs with neither hardened runtime nor entitlements. Measured on the shipped artifact: `flags=0x0(none)`, `TeamIdentifier=not set`, `(no entitlements)`, `DYLD_INSERT_LIBRARIES` honoured. |
| **SEC-1** | S2 | `LiveCredentialWriter.swift:121-141` grants a Keychain ACL to a path handed to `SecTrustedApplicationCreateFromPath` with no signature check. Two of three static candidates sit in user- or admin-writable locations, and `LiveCredentialSelfHeal.swift:51-54` re-asserts the ACL on every launch, wake and unlock — so a bad grant is durable, not a one-off. |
| **ARCH-10** | S3 | The same `make-app.sh` line read as a release concern: deprecated `--deep`, no `--timestamp`, no reproducibility. Lands here because `--options runtime --timestamp` plus dropping `--deep` closes it and SEC-3 in one change. |

**The plan is wider than the roadmap goal line in exactly one place**, and it is
deliberate: the goal line names one SEC-1 site, and there are two.
`AccountCredentialVault.performRepairWrite` (:190-205) is byte-for-byte the same
`compactMap` → `SecTrustedApplicationCreateFromPath` → `SecAccessCreate` shape,
differing only in `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Fixing one
and not the other would close the finding on paper and leave it live. That
widening is RISK-2 and it is question 5 below.

## How this plan was arrived at

27 spec-review rounds. Tier `medium` sets `spec_review_rounds: until-clean`,
defined in `effort.yml` as *"planner ↔ spec-reviewer until nothing S1/S2 is
left"*. Round 27 returned one S3-minor finding and nothing above it, so the draft
froze.

Reviews ran on `sonnet-5` and on the external `codex` provider (`gpt-6-astra`,
reasoning effort high) — never on the planner's own model, per the role contract,
and never on `fable`, per your instruction. The plan carries its own review
history: fourteen `spec_review_r*_disposition` blocks, `planner_findings_v8`/`v9`,
and 16 risks.

Two rounds are worth knowing about because they changed the *reasoning*, not the
plan: at round 4 an external judge found a **false security claim inside the
planner's own fix for that judge's earlier finding**, and at round 5 it found a
second one pointing the opposite way. Both are corrected in place and named as
corrections. The standing rule the plan adopted after them — *"name the event the
claim is true of, or do not make the claim"* — is why the costings below read the
way they do.

### The version number

Draft rounds counted 1→17 in `state/results/`. Plan versions count **amends**, not
drafts (`plan.ts:211` resolves `plan-v<version>.json`, and `plan diff` would reach
for a `plan-v16.json` that never existed). Frozen draft v17 is therefore
**plan v1**. The transform that wrote it computed its own leaf-level diff first
and refused to write unless exactly four scalars changed:

```
leaf diff draft-v17 -> plan-v1 : added=0 removed=0 changed=4
   .status  'draft' -> 'active'   .version 17 -> 1
   .tasks[0].plan_version 17 -> 1  .tasks[1].plan_version 17 -> 1
```

Events before the freeze carry `plan_version: 17`; events after carry `1`. The
drop is this transition, not a mystery.

## Goal-clause coverage

The roadmap goal line names four findings and, inside them, five specific
remedies. All five land on a criterion; nothing outside those four is added.

| Goal clause | Lands on |
|---|---|
| bound with `-l "$SIGNING_IDENTITY_NAME"` | task-1 c1 |
| hardened runtime | task-1 c7 |
| drop `--deep` | task-1 c8 |
| add `--timestamp` | task-1 c9 |
| a signature check before `SecTrustedApplicationCreateFromPath` | task-2 c1, c2, c6 |

| Finding | Criteria |
|---|---|
| SEC-2 | task-1 c1–c6 |
| SEC-3 | task-1 c7, c9 |
| ARCH-10 | task-1 c8, c9 |
| SEC-1 | task-2 c1–c8 |

Seven further criteria belong to **no finding** and exist to stop the fix from
breaking something: task-1 c10 (the designated requirement is preserved, which
protects every existing Keychain "Always Allow" grant from the signing change),
c11 (`swift build`/`swift test` green at a count **equal** to the baseline the
worker measures on its own pristine worktree), c12 (the harness is reachable from
`make` and CI, with the two literals task-2 depends on pinned); task-2 c5 (twelve
existing `trustedPaths: []` call sites keep passing), c9 (no async ripple into
`AppState.swift`), c10 (`swift test` at ≥ the worker's own measured baseline — the
guard against a test deleted to make the suite green), c11 (`CLAUDE.md` stops
asserting pre-change behaviour).

## The `anchor exists` fork — the plan quorum escalated on it

**This is the one item I would not let you sign without reading.**

`smith plan quorum --epic csb-audit-1 --plan-version 1 --confidence 0.85` returned
`outcome: "escalated"`, `reason: "insufficient-providers"`, exit 1. Eleven triggers
fired, all `kind: security` — one from `case: infra` on task-1, ten from
security-sensitive nonfunctional clauses.

| provider | mode | ok | verdict | excluded as finder |
|---|---|---|---|---|
| claude | native | true | confirm | **yes** |
| codex | active | true | **refute** | no |
| deepseek | shadow | true | **refute** | no |

Two independent external providers refuted, on the same point:

> **codex** — "The pinned requirement `anchor exists` establishes that a path has a certificate-backed signature, not that its signer is authorized to read Claude credentials. An attacker can substitute a binary signed with their own self-signed certificate and still pass this gate, so the plan does not close SEC-1 as claimed."

> **deepseek** — "The pinned verifier 'anchor exists' is far too weak… an attacker can simply sign their malicious binary with their own self-signed code-signing certificate and the gate will pass it… The gate must verify that the path's signer matches the expected identity (e.g., the repo's signing certificate), not merely that some anchor exists."

### I checked both against the plan's own text. Here is what holds and what does not.

**The objection is correct, and the plan already makes it — in stronger terms than
the judges did.** RISK-16 states the attack with the actual commands: an attacker
who can overwrite a writable `claude` candidate runs one `openssl req` and one
`codesign -s <their identity>`, satisfies `anchor exists`, enters the trusted
application list, and SEC-1 is reopened. The plan reached this at round 3, from
the same external judge, and has carried it as an open question ever since. So the
quorum did not find a new defect — **it independently re-derived the plan's own
number-one sign-off question.** That is a validation of the review loop, not a
hole in it.

**deepseek's proposed remedy is wrong for the site that matters, and the plan says
why.** "Verify that the path's signer matches the expected identity (e.g., the
repo's signing certificate)" is the plan's ALT-1/ALT-4. At **site 2** it would be
harmless — `AccountVaultSelfHeal.swift:31` only ever supplies
`Bundle.main.bundlePath`, so the repo's own certificate *is* the expected identity
there. At **site 1** it is category-wrong: the binary being trusted is Anthropic's
`claude` CLI, which this repo did not sign and cannot sign. Pinning the repo's
certificate there rejects every legitimate `claude` on every user's machine —
which is site 1's entire purpose. The judges judged text and did not weigh that
asymmetry.

**And a subject-name pin is not a pin at all.** ALT-1 pins the leaf subject CN to
`ClaudeStatusBar Local Signing`. A subject CN is a string chosen by whoever
generates the certificate, and line 28 of this repo's own script — readable by the
attacker, who by hypothesis can already write in the same tree — supplies it. One
extra `-subj` argument defeats it. So ALT-1 costs everything ALT-4 costs and buys
nothing against this attacker. ALT-2 is a disjunction containing that same
forgeable branch, so it is no stronger.

**The four alternatives, as the plan finally costs them:**

| | Rejects an attacker-generated chain? | What it breaks |
|---|---|---|
| **ALT-1** pin leaf subject CN | **No** — one `-subj` argument | Every legitimate third-party `claude`; restores RISK-3's Keychain prompt for all users |
| **ALT-2** `anchor apple or CN=…` | **No** — weakest branch governs | Same, plus `anchor apple` is Apple's own software only |
| **ALT-3a** final file root-owned, not group/world-writable | n/a — tests the precondition, not the signer | Does **not** stop path replacement: unlink and rename are permissions of the *parent* directory, and any component may be an attacker-controlled symlink. Rejects a per-user `~/.claude/local/claude`. |
| **ALT-3b** every component of the fully resolved path | n/a, and it is not defeated by `openssl req` | Rejects per-user installs, and rejects `/usr/local/bin/claude` — admin-group-writable on stock macOS, i.e. Homebrew-style installs on ordinary developer machines |
| **ALT-4** leaf-certificate hash / public-key pin | **Yes** — genuinely | **Distribution**: `ensure-signing-identity.sh` generates a fresh certificate per machine, so there is no single hash to ship. Also rejects every third-party `claude`. |

Neither ALT-3 form closes the TOCTOU window between verifying the path and writing
the Keychain entry; that would need the gate to hold an open file descriptor and
verify what it holds — a larger change to `performWrite`/`performRepairWrite` than
this epic scopes.

### The planner's position, and mine

The planner ships `anchor exists` and records the residual. Its argument: today
the gate **does not exist at all** and any file at a candidate path is trusted,
signed or not. `anchor exists` moves the attacker's cost from *write a file* to
*write a file, generate a certificate, and sign it*, while accepting every
legitimately signed `claude`, which no tighter policy does.

I agree, with one qualification the judges are owed. The step from "write a file"
to "write a file and self-sign it" is real but small — it is one `openssl` command
against an attacker who already has write access to a trusted path. The honest
description of `anchor exists` is **a floor that excludes the unsophisticated case
and the accidental overwrite**, not a gate that establishes trust. It is a strict
improvement on nothing, and it is not what closes SEC-1 against a competent
attacker. Only ALT-3b (which does not care who signed) and ALT-4 (a real pin)
change that attacker's position, and both are rejected on product grounds — which
are yours, not the planner's.

**Where codex's "as claimed" does land:** task-2's objective opens *"Close SEC-1 at
BOTH sites"*, unqualified. The qualification is present in criterion 6 — which
says in as many words that `anchor exists` does not demand the chain reach Apple —
and in RISK-16, but not in the objective's headline verb. Nothing grades against
that verb (the grader grades criteria; `epic goal-check` reads the roadmap line),
so this changes no acceptance criterion and no built artifact. It is a wording
overstatement, and I will fix it in a v2 if you want the objective to say *reduce*
rather than *close*.

**Procedurally:** exit 1 from `plan quorum` is critique-only. I have not rewritten
the plan, and will not on my own authority. The escalation reason is
`insufficient-providers` — a structural verdict about who was eligible to gate,
not a substantive "the plan is wrong".

## Acceptance criteria

### Task 1 — bound the partition list and harden the signature (`case: infra`)

| | |
|---|---|
| c1 | SEC-2, the bound selector — differential, with the null obtained by **static parse** of the script source, because execution cannot reach it |
| c2 | SEC-2, the `-s` flag is gone |
| c3 | SEC-2, the limit something can say no to, now **reachable** |
| c4 | SEC-2, the identity name must **not** be environment-overridable in a real build — this is what stops c3's test seam from becoming a security hole |
| c5 | The dry-run **default** is a limit something can say no to |
| c6 | SEC-2, the comments stay true |
| c7 | SEC-3, hardened runtime measured on the artifact, not inferred, with the baseline artifact's provenance stated |
| c8 | ARCH-10, `--deep` gone and the nesting signed inside-out |
| c9 | ARCH-10 + SEC-3, `--timestamp` applies and does not silently degrade |
| c10 | Regression guard — designated requirement preserved |
| c11 | Regression guard — build and suite green at the worker's own measured baseline |
| c12 | Regression guard — harness reachable from `make` and CI, with task-2's two literals pinned |

### Task 2 — verify a path before it becomes a trusted application (`case: bugfix`)

| | |
|---|---|
| c1 | TDD, site 1, null measured rather than assumed |
| c2 | TDD, site 2 — separate on purpose: a fix to `LiveCredentialWriter` alone leaves this failing |
| c3 | The gate is not inverted — catches a gate that rejects everything |
| c4 | Per-path filtering, not all-or-nothing |
| c5 | Backwards compatibility with the empty-input case, citation measured |
| c6 | **The policy criterion**, differential against the two wrong verifiers specifically |
| c7 | Dev-run behaviour, settled here rather than discovered in production |
| c8 | The rejection is observable in the **shipped app**, not only under a test-injected handler — written so a test-only handler *fails* it |
| c9 | No async ripple, no unclaimed edit, both measured |
| c10 | Suite green and no test deleted to get there, against the worker's own baseline |
| c11 | `CLAUDE.md`, both paragraphs this epic falsifies |
| c12 | The `CLAUDE.md` CI sentence must be true of `ci.yml` **in this task's own worktree** — an empty grep is `blocked`, not a green merge |

The gate lives at the sink — a new
`Sources/StatusBarCore/Accounts/TrustedApplicationGate.swift`, called from both
`performWrite` and `performRepairWrite` — not at the two `trustedPaths` producers,
so a future caller that assembles a path list some other way cannot bypass it.

## Claims map and wave shape

**Wave 1 — task-1** (6 claims, all shell/build; no Swift source):
`scripts/ensure-signing-identity.sh`, `scripts/make-app.sh`,
`scripts/lib/signing-run.sh`, `scripts/signing-argv-test.sh`, `Makefile`,
`.github/workflows/ci.yml`

**Wave 2 — task-2** (7 claims, all Swift plus the living document):
`LiveCredentialWriter.swift`, `AccountCredentialVault.swift`,
`TrustedApplicationGate.swift`, three matching test files, `CLAUDE.md`

The claim sets are disjoint. The serialization is not a slicing failure —
`wave schedule` returned `depth: 2, widest: 1, scheduled: 2, stalled: [],
constraints: []`, and an empty `constraints` is the load-bearing detail: the width
of 1 is a real dependency, not claims drawn badly. The edge is declared:

```json
{"task": "…task-2-verify-a-path…", "dependsOn": "…task-1-bound-the-partition-list…",
 "edge_type": "artifact", "edge_provenance": "declared"}
```

It exists so task-2's c12 can grep task-1's CI step in its own worktree instead of
asserting a sentence about a file that has not landed yet. That is RISK-10, and it
is question 3 below.

## Budget

| Task | Tokens | Diff lines |
|---|---|---|
| task-1 | 260,000 | 480 |
| task-2 | 280,000 | 500 |
| **Epic** | **540,000** | **980** |

Both tasks dispatch at `agent_role: coder`, `origin: user`. Tier `medium` sets
`grader_rounds: 1`, `verifier_severities: [S1-stop-the-line, S2-major]`,
`verifier_s3_spot_check_ratio: 0`, `closing_spec_review: always`.

## Safety constraints that bind every agent in this epic

These are carried verbatim into every dispatch, and they are not negotiable by an
agent:

- **No mutating `/usr/bin/security` subcommand, on any keychain, including a
  temporary one the agent creates itself, and including by sourcing
  `scripts/ensure-signing-identity.sh`.** That command *is* the SEC-2 bug; its
  blast radius is your real login keychain and the damage is irreversible.
  Read-only subcommands are permitted. (Re-graded from S2 to S1 by the planner —
  question 10 below.)
- **Never leave a Keychain item with an ACL naming zero trusted applications.**
  That is strictly worse than the bug being fixed. Refusing the write and leaving
  the old ACL alone is the correct fail-safe.
- **No test may drive a rejection under the default handler** — a rejection under
  `defaultOnReject` appends to your real log under `AppPaths().root`, outside the
  worktree.
- **Do not edit `AppState.swift`.** If the fix appears to require it, stop and
  return `spec-change-proposed` with the compiler error as evidence.
- No credential value, path or Keychain content is echoed — *"a 40-char token is
  present at `<path>:<line>`"*, never the token.
- Never commit, never push, and never edit the target project outside a worktree.

**PF-1, discharged before task-2 dispatches:** RISK-1 records that task-2 — the
one task that rewrites a Keychain ACL — fires **no** path trigger, because
`sensitive-paths.yml`'s credential globs list no `.swift` extension. The epic tag
is what must carry it, so `/bs run` passes `--epic-tag security` and I assert
`dispatchSecurityReviewer: true` before dispatch rather than after.

## What needs your answer before anything runs

Ten questions, **numbered as `planner_notes.open_questions_for_signoff` numbers
them** so you can cross-reference the plan. They are not in order of importance:
**7 is the one that may change the design**, 8 is a correction to your own
document, and 10 is a decision already taken that you may overturn.

1. **RISK-3.** Approve the signature policy — reject unverifiable paths, keep the
   verified ones, refuse the write only when nothing survives — knowing it can
   restore the Keychain prompt for users whose `claude` is an unsigned wrapper
   script.
2. **RISK-14.** Approve that the gate's rejection diagnostic reaches production by
   writing a new file, `trusted-application-gate.log`, under `AppPaths().root`
   (honouring `CLAUDE_STATUS_BAR_HOME`), best-effort, carrying only a timestamp,
   the rejected path and the reason. This is what makes criterion 8 satisfiable by
   something other than a test-only handler. The alternative is dropping the
   diagnostic — in which case a user whose `claude` was dropped from the ACL has
   no way to learn why their prompt came back.
3. **RISK-10.** Approve serializing the epic into **two waves** so task-2's
   `CLAUDE.md` sentence about the new CI step is checked by criterion 12 against
   the `ci.yml` already in its worktree, instead of by prose addressed to an
   integrator that no gate reads. The cost is wall-clock: task-2 cannot start
   until task-1 merges, and does not run at all if task-1 bounces. Draft v2 made
   the opposite trade; round-2 review found the prose it rested on had no owner.
4. **RISK-11.** Approve that vault self-heal **declines to repair** on unsigned
   dev runs (`swift run`, where `Bundle.main.bundlePath` is `.build/debug`),
   leaving the existing ACL untouched and emitting a diagnostic — rather than
   carving the process's own bundle path out of verification.
5. **RISK-2.** Confirm SEC-1's second site is in scope though the goal line names
   only the first.
6. **RISK-5.** Confirm you will launch the hardened-runtime build once before
   merge — no automated check can prove it.
7. **RISK-16 — the `anchor exists` fork.** Approve it as shipped, knowing it
   accepts a certificate the attacker generated, or direct a plan v2 to one of the
   four costed alternatives. **If you ever leaned toward ALT-1 on the strength of
   the draft-v4 text, decide again**: that text claimed ALT-1 "rejects attacker
   chains", and it does not — the claim was withdrawn as false at round 5. *(The
   plan's own wording says "a plan v6"; that is draft numbering. A change from
   here produces plan v2.)*
8. **RISK-8 — a correction to `roadmap.md:113`.** Your goal line says SEC-2 is
   *"triggered by an ordinary `make app`"*; the source says otherwise, because
   `ensure-signing-identity.sh:23` guards the mutating line 56 behind
   `if ! security find-certificate …`. Neither the finding nor its severity
   changes — the blast radius is every signing key in the login keychain either
   way, and a first build is routine — but `smith epic goal-check` reads that line
   at epic close, so the imprecision propagates into the verdict. The planner did
   not and will not edit `roadmap.md`. Approve the one-clause correction quoted
   verbatim in `roadmap_goal_line_discrepancy` — *"…on any machine that does not
   yet have the identity — the call sits inside the `find-certificate` creation
   branch opened at line 23 — which is every fresh machine, every new user
   account, and every keychain reset"* — or leave the line and accept that the
   close-out quotes it as written.
9. **RISK-6.** Accept that `make app` acquires a hard network dependency on
   Apple's timestamp service, given `--timestamp` failing is fatal by design
   rather than silent.
10. **RISK-15 — a decision already taken.** The planner re-graded finding P8-P1
    and its task-2 mirror P8-P5 from **S2-major to S1-stop-the-line** on its own
    judgement: the prohibition on ever running a mutating `security` subcommand.
    It changes nothing about the checks, which are required either way; it changes
    that a bounce on task-1 criterion 3 or task-2 criterion 9 **stops the wave**
    rather than being carried as a major finding, and that a waiver against either
    needs you rather than a reviewer. Say so if you would rather they stay S2.

## What would need a plan v2

- Any of ALT-1 through ALT-4 replacing `anchor exists` — it changes task-2
  functional clause 4 and criterion 6.
- Softening task-2's objective verb from *close* to *reduce* (the codex "as
  claimed" point).
- Dropping SEC-1's second site back out of scope.
- Anything from the deferred clusters: the "the bar lies to you" group (ARCH-1
  hook read-modify-write with no lock, ARCH-2 the absolute path in
  `settings.json`, CQ-1 freshness never consulted, CQ-2 the 900s staleness on
  in-flight tool states), the `AppState` extraction that ARCH-3/5/6, CQ-3/8/9/11
  and PERF-1 all reduce to, and PERF-4's cheap variant (dropping the `PostToolUse`
  registration) — which you deferred because it changes what the bar shows between
  tools and therefore belongs with the UI cluster, not with signing.
