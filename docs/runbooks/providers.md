# Runbook — cross-provider judges (Codex + DeepSeek)

Operator procedure for `factory/policies/crosscheck.yml`'s Phase 8 providers:
key/auth setup, enabling, shadow-mode calibration, promotion, the independent
finder, rollback, cost, and security. Companion to `docs/specs/black-smith-architecture.md` §6 and
`docs/guide/operator-guide.md`; commands assume a built CLI
(`pnpm run build` → `factory/orchestrator/dist/cli.js`, substitute `smith`
if linked).

**These two are worked examples, not the supported set.** Nothing in the
runtime knows either name: a provider is a `crosscheck.yml` entry, and its
`transport` — `cli` (a command that reads a prompt on stdin and writes a
verdict on stdout) or `api` (an OpenAI-compatible chat-completions endpoint)
— is the whole of what decides how it is called. Any provider reachable
either way slots in here with no code change; see
[`docs/guide/extending.md`](../guide/extending.md#add-a-judge-provider) for
the config shape. What is genuinely Codex- and DeepSeek-specific below is
labelled as such, and everything from §2 (enabling) onward applies to
whatever you configure.

## 1. Key / auth setup

- **Codex — CLI transport, ChatGPT-subscription auth.** No API key. Run
  `codex login` once on the machine that runs the factory (interactive,
  outside this repo's automation — the guard hook never runs it for you).
  `factory/orchestrator/src/providers/cli-transport.ts` spawns `codex exec`
  and feeds the assembled judge prompt on stdin; the CLI reuses whatever
  session `codex login` established.

  Deliberately **not** `--json` (D-118): that mode wraps the verdict as an
  escaped string inside an `item.completed` event, one level of escaping
  below where any JSON scanner looks, and puts a `thread.started` banner
  ahead of it. Plain `exec` writes the agent's final message — and only
  that — to stdout. If you add args here, keep that property.

  Plain `exec` has a second property you must also keep in mind: it echoes
  **the entire prompt to stderr**, and `cli-transport.ts` merges stderr into
  the extraction buffer on purpose (D-117 — a judge that answers on stderr has
  to keep working). So any JSON in the prompt itself arrives ahead of the
  verdict. That is survivable only because `extractAndValidate` takes the first
  candidate that *validates*, not the first that parses.

  Re-derived against the live binary on 2026-08-17 (codex-cli 0.147.0,
  subscribed account; the original D-118 derivation had only two calls before
  the account hit its limit). Both layers reproduce unchanged, and so does the
  divergence that motivated the extractor fix — same prompt, same combined
  buffer, the two extractor generations:

  ```
  first parseable  (pre-D-118):  []                       <- echoed from the prompt
  first validating (shipped):    {"verdict":"refute", …}  <- the judge's answer
  ```

  Re-run that comparison — do not reason about it — before changing `args`,
  after a codex-cli upgrade, or if verdicts start coming back as
  `provider.invalid-output` from a CLI that exited 0.

  When the CLI refuses — never logged in, session expired, subscription
  quota exhausted — it exits nonzero, and the transport reports
  `provider.cli-failed` with the exit code and the tail of what the CLI
  printed, e.g.:

  ```json
  {"error":{"code":"provider.cli-failed","message":"Provider \"codex\" CLI judge failed with exit 1 and no usable verdict: You've hit your usage limit.","details":{"provider":"codex","exitCode":1}}}
  ```

  If the binary is missing from `PATH` entirely the code is
  `provider.cli-unavailable` instead. Neither is retried: the prompt is not
  the suspect, so a nudge-and-resend would only spend a second call.
  A `provider.invalid-output` from Codex therefore means what it says — the
  CLI ran, exited clean, and returned something that is not a verdict.

  **`codex login status` does not tell you which plan you are on**, and a
  usage-limit refusal does not tell you which account hit it. It reports
  only `Logged in using ChatGPT`, which is equally true of a Free account
  with no Codex quota at all. When `codex exec` refuses and you believe
  the account is subscribed, read the entitlement out of the id_token
  claims rather than guessing:

  ```bash
  node -e 'const fs=require("fs"),os=require("os"),p=require("path");
  const a=JSON.parse(fs.readFileSync(p.join(os.homedir(),".codex","auth.json"),"utf8"));
  const c=JSON.parse(Buffer.from(a.tokens.id_token.split(".")[1],"base64url").toString("utf8"));
  const x=c["https://api.openai.com/auth"];
  console.log(x.chatgpt_plan_type, x.chatgpt_subscription_active_until, c.email);'
  ```

  `chatgpt_plan_type: free` with a null subscription window means this
  account was never upgraded, whatever was bought elsewhere — check the
  email in the same output before buying anything again. Note the claims
  are refreshed at login (`chatgpt_subscription_last_checked`), so a
  re-login *does* pick up a genuine plan change; re-login is not, however,
  a fix for an account that is simply on Free.

  Only print the two claims above. `auth.json` holds live access and
  refresh tokens; per `docs/standards/guardrails.md` "No secrets in
  outputs", the file must never be dumped into a log, a PR body, or chat.
- **DeepSeek — API transport.** Get a DeepSeek API key from their console,
  then set it in `.env` (gitignored, per `docs/standards/guardrails.md`
  "Secrets, keys, tokens"):

  ```
  DEEPSEEK_API_KEY=sk-...
  ```

  `crosscheck.yml`'s `deepseek.api_key_env: DEEPSEEK_API_KEY` names the
  variable; the code never reads the key from anywhere else and never logs
  it. The CLI reads `.env` into its own environment at start, before any
  command resolves a provider, and sets only names the environment does not
  already hold — so an exported key beats the file and a stale `.env` can
  never quietly replace the one a runner handed you. Exporting it instead
  works exactly as well; the file is the convenience, not the contract.
  A missing key fails fast with a typed error naming the variable, e.g.:

  ```json
  {"error":{"code":"provider.missing-api-key","message":"Environment variable \"DEEPSEEK_API_KEY\" is not set (required for provider \"deepseek\").","details":{"provider":"deepseek","envVar":"DEEPSEEK_API_KEY"}}}
  ```

### Checking both before you spend a call — `smith judge preflight`

Everything above is only knowable after the fact by default: a provider
whose precondition is unmet still gets invoked on every quorum trigger,
fails, and leaves a `judge-verdict` row with `ok: false`. `gate.ts` raises
a trigger on **every** blocking finding without being asked, so a single
missing key turns into one doomed call per finding — pure latency, plus a
log that reads like a provider outage.

```bash
node factory/orchestrator/dist/cli.js judge preflight
```

It reads `crosscheck.yml` and asks only what can be answered locally: is
the `api_key_env` variable set, is the `command` on `PATH`, and does the
arithmetic of the promotions add up. Exit `0` when there is nothing to
fix, exit `1` with a `problems` array when there is:

```json
{
  "policyPath": "factory/policies/crosscheck.yml",
  "offlineSwitch": false,
  "gating": {"activeExternal": [], "shadowExternal": ["codex"], "minProviders": 2, "canDecide": false},
  "problems": ["Provider \"deepseek\" is enabled but its precondition (DEEPSEEK_API_KEY) is unmet. Set it, or set \"enabled: false\" for this runner."]
}
```

Three things it deliberately does **not** do:

- **It never makes a judge call.** A preflight that proved a provider
  answers by asking it a question would cost exactly what it is trying to
  save. A resolvable `command` on `PATH` is reported as resolvable, not as
  authenticated — whether `codex exec` is entitled to run is not knowable
  without spending a call, which is what §3's calibration pass is for.
- **It never prints a key.** Only the variable *name* is reported, per
  `docs/standards/guardrails.md` "No secrets in outputs".
- **It ignores `SMITH_CROSSCHECK_OFFLINE`.** That switch forces every
  provider off at load time (§2), which would hide the exact
  misconfiguration this command exists to find. The switch is reported as
  `offlineSwitch` instead, so a run under it is still legible.

Zero active externals is the shipped default and is reported, never
flagged. Exactly **one** is flagged — see §4 for why that configuration
pays for a gating provider and gets no gating.

**This command answers about the box it runs on, and the answer differs
between boxes on purpose.** What ships today is
`codex: enabled: auto, mode: active` and
`deepseek: enabled: auto, mode: shadow`, so the same commit reports
several sound configurations: on a box with neither the `codex` binary nor
a DeepSeek key both externals are `not-applicable`, there are zero active
externals, and there is nothing to say; on a box that has the binary, codex
is the one active external and that advisory is printed under `notes`,
because this repo declares `accept_non_gating_actives` (§4); a key adds
deepseek as a shadow external, which is invoked and recorded and moves
neither count. No box exits 1, and no box edits the file to get there.

## 2. Enabling a provider

Edit `factory/policies/crosscheck.yml` — never a runtime write, always a
reviewed commit:

```yaml
codex:
  enabled: true
  mode: shadow      # stays shadow through calibration — see §3
```

`enabled: false` means the provider is **never invoked at all**, regardless
of `mode`. `enabled: true` + `mode: shadow` means it runs on every quorum
case the factory actually raises today, and its verdict is recorded — but
the gate never sees it (§3).

### `enabled: auto` — the value that asks the box

`enabled` takes a third value, and it is the one to reach for when the
answer is "wherever this can run":

```yaml
codex:
  enabled: auto     # this box has the binary, or it does not
  mode: active
```

`enabled` is the one field in `crosscheck.yml` that describes a **machine**,
and the file is checked in — so `true` there is a claim about every clone
that will ever read it. That is not a hypothetical: the day codex was first
promoted with a flat `enabled: true`, CI — a box with no `codex` binary —
started failing `smith judge preflight`'s soundness check, correctly, for a
line that was true where it was typed.

`auto` resolves against the same precondition §1 reports on, evaluated on
the box reading the file, at parse time:

| provider | `auto` asks | resolves `true` when |
| --- | --- | --- |
| `transport: cli` | is `command` runnable | it is on `PATH`, or is a path that exists and is executable |
| `transport: api` | is `api_key_env` set | the variable is set to something non-empty |

Both probes are free — no process is spawned, no request is made — and
that bounds what `auto` can know. It reads **installation, not
authentication**: `codex` on `PATH` does not mean `codex login` was run, and
a set `DEEPSEEK_API_KEY` does not mean the key is valid. A box with the
binary and no session resolves `true`, spends a call per trigger, and
records the failure like any other bad verdict. Only a real call knows the
other half, and a check that spends one costs what it is trying to save.

Two consequences worth knowing before you write it:

- **`auto` is an escape hatch, not an amnesty.** A declared `enabled: true`
  over a missing binary is still an unmet precondition and still a preflight
  problem. `auto` changes what you *asked for*, not what the check enforces.
- **A reader can tell the two apart.** Preflight reports a provider `auto`
  switched off as "enabled: auto, and codex is not on PATH here, so this box
  does not use it" — not "disabled in the policy", which would name a
  decision nobody made. The parser records which decider settled it.

`auto` is refused on `kind: native`: claude runs in this process and has no
precondition to ask about, so `auto` there could only mean `true`, and a
switch whose two settings do the same thing reads as considered and is not.
Every other near-miss is refused as before — `yes`, `on`, `Auto` and
`automatic` are all errors, because the whole reason this field is checked
so strictly is that a near-miss here once left a judge switched on.

### Which `quorum_triggers` are wired

`crosscheck.yml` lists four triggers. As of Phase 8 all four have a real
host in the pipeline:

| Trigger | Host | Invoked by |
| --- | --- | --- |
| any S1/S2 finding, before it blocks a task | `src/gate.ts` `intakeAndDecide()` | automatic, on every gate intake |
| same-mistake findings (`judgment.same-mistake`) | `src/gate.ts` `intakeAndDecide()` | automatic, on every gate intake |
| epic-level final verdict, before the integration PR opens | `src/epic.ts` `runEpicVerdict()` | `smith epic verdict` |
| planner verdicts below the confidence threshold | `src/planQuorum.ts` `runPlanQuorum()` | `smith plan quorum` |

The two gate triggers fire on their own; the two new hosts are commands
the operator (or the `/bs` skill) runs at the right moment — nothing polls
for them. A `smith stats providers` run only reflects the cases that were
actually raised, so a clean report means "no disagreement in the cases that
ran", not "every epic was cross-checked".

`smith plan quorum` is **critique-only**: it never rewrites a plan, and
exit 1 means only "an operator must look before approving this plan". Its
three `plan_quorum` triggers are evaluated deterministically before any
provider is called (`mechanical_oracles_first`): epic budget at or above
`budget_ratio` of the per-epic cap in `budgets.yml`, an infra case or a
security-sensitive role/clause, and a confidence below
`confidence_threshold` — either a task's `confidence` field or the
planner's own `--confidence` self-report. Zero triggers means zero cost:
no provider is invoked and no event is written.

Two more limits worth knowing before you promote anything:

- **The critic judges the claim, not the code.** The judge prompt carries
  the finding's summary, category, severity, file path, and claimed
  failure scenario — never the file contents or the diff. Shipping worktree
  source to a third-party API is your decision to make, not the gate's, so
  a critic can only tell you whether the claimed failure is coherent and
  plausible. That makes refutes conservative and confirms weak evidence.
- **A refute deletes the finding.** When an active quorum decides `refute`,
  the gate transitions the finding to `refuted` and it neither blocks nor
  enters the waiver batch. Everything else — a decided `confirm`, either
  kind of escalation, and every shadow-mode case — leaves
  `factory/policies/severity.yml`'s decision exactly as it was.

Sanity-check a single provider directly, without touching the event log or
quorum, before turning it loose on real epics:

```bash
smith judge run --provider codex --request request.json
```

`request.json` is a `JudgeRequest` (`factory/orchestrator/src/providers/
types.ts`): `{"kind":"verify","taskId":"epic-1/task-1","inputRefs":{},
"prompt":"...","schemaName":"judge-verdict","budget":{"timeout_ms":120000,
"max_output_bytes":65536}}`. `--shadow` is an output-only note for your own
bookkeeping (the printed JSON gets a `"shadow":true` field) — it does not
change how the call runs; `crosscheck.yml`'s `mode` is the only thing that
ever grants a provider real gating power.

### Turning every provider off without editing the file

```bash
SMITH_CROSSCHECK_OFFLINE=1 smith gate run ...
```

Set to anything non-empty, it forces every provider except `kind: native`
(claude, the in-process judge) to `enabled: false` as the policy is loaded —
whatever the file says. It is read inside `loadCrosscheckPolicy()`, so it
also covers subprocesses, which inherit the environment.

Two uses. Operationally, it is the fastest kill switch when a judge binary
or a provider API starts misbehaving mid-run: no edit, no commit, no risk of
leaving a toggle flipped afterwards — prefer it over hand-editing
`crosscheck.yml` for anything temporary. Structurally, the unit suite sets
it in `factory/orchestrator/test/setup.ts`, because `enabled` is the one
field in `crosscheck.yml` that tracks a machine rather than the repo, and a
suite that behaves differently on a box with `codex login` done is not
measuring the code. That was not hypothetical: with both providers flipped
on, 18 tests across gate/epic/cli/specFindings stopped asserting and started
timing out at 5000ms, really spawning `codex exec` and really POSTing to
api.deepseek.com.

Providers are still covered — `test/providers/index.test.ts` injects a
policy and a mocked transport rather than relying on the ambient one.

## 3. Shadow mode + calibration procedure

Every provider starts (and stays, until you promote it) `mode: shadow`:
`src/quorum.ts`'s `computeQuorum()` records every shadow verdict as a
`judge-verdict` event (provider tag, verdict, `agreement_with_native`,
latency, and — on a run that reached no verdict — the provider error code
that says why; on such a run `agreement_with_native` is `null`, because
there was no external verdict for the native one to agree with — rows
written before 2026-09-02 spell that case `false`) but the **gating decision falls back to the native
(Claude) verdict alone** whenever no provider in a case is `mode: active`.
Nothing a shadow-mode provider says can block a task, gate an epic, or
force an escalation.

Calibration loop:

1. Run epics as usual with the provider `enabled: true, mode: shadow` for a
   representative stretch (an epic or several, per your risk appetite —
   there's no fixed count baked into the code; use judgment on how much
   evidence you want before trusting a provider with real gating power).
2. Review the numbers:

   ```bash
   smith stats providers [--session <id>] [--since 2026-07-01]
   ```

   ```json
   [{"provider":"codex","runs":42,"verdicts":41,"agreementRate":0.88,"latencySamples":41,"meanLatencyMs":9400,"schemaFailureRate":0.02,"transportFailureRate":0,"failuresByCode":{"provider.invalid-output":1}}]
   ```

   - **`runs`** — every judge run attempted, answered or not. Only the two
     failure rates are measured against it; `agreementRate` and
     `meanLatencyMs` each carry their own denominator, because a run that
     never came back is evidence about the transport and about nothing else.
   - **`verdicts`** / **`agreementRate`** — of the runs that produced a
     schema-valid verdict, the fraction whose verdict matched native. Low
     agreement isn't automatically bad (that's the anti-tunnel-vision point
     — disagreement can mean native missed something), but a very low rate
     deserves a manual read of a few `judge-verdict` events' `rationale`
     fields before you trust the provider with real power. `null` means no
     run answered, so nothing is known about how this provider judges —
     read `failuresByCode` and repair what it names before you read
     anything else here.
   - **`schemaFailureRate`** — fraction of runs where the provider
     **answered** and the answer could not be used: not valid JSON, valid
     JSON the compiled schema rejects, or an answer past the output cap —
     even after the transport's one retry-with-nudge. High here means the
     provider/prompt pairing needs work before promotion, not that the
     provider is untrustworthy per se.
   - **`transportFailureRate`** — fraction of runs where **no usable answer
     ever arrived**: no API key exported, no CLI on `PATH`, a timeout, an
     HTTP error, a provider that is not configured at all. High here says
     nothing whatsoever about how this provider judges — it never judged
     anything. Fix the transport, then re-measure from zero. A rate of 1.0
     here is the signature of a provider that has been silently dead since
     the day it was enabled.
   - **`failuresByCode`** — the failed runs by provider error code, and the
     field that tells you which of the two repairs to make.
     `provider.missing-api-key` is one `export` in your shell;
     `provider.invalid-output` is a prompt and a schema. `{}` means every
     run answered. `unclassified` counts failures logged before the code
     was recorded (D-253) — those rows do not say why they failed, so they
     are charged to neither rate rather than guessed at; re-measure with
     `--since` past the upgrade to get a clean read.
   - **`latencySamples`** / **`meanLatencyMs`** — the mean over runs that
     reported a latency; factor it into whether this provider fits inside
     your gate's timeout budget for real epics. `null` means no run
     reported one, which is not the same as fast.
3. `/bs report`'s digest surfaces a one-line provider-calibration note
   while any provider is still `mode: shadow` (`.claude/skills/bs/SKILL.md`)
   — no separate dashboard page ships for this in Phase 8 (CLI-only,
   `smith stats providers`; a UI page is explicitly out of scope here).

## 4. Promotion

Once you're satisfied: edit `crosscheck.yml`, `mode: shadow` → `mode:
active`, commit. From the next quorum-triggered case onward, that provider
joins the gating pool: `quorum_rule` (majority agreement across at least
`min_providers` participants) applies for real, disagreement escalates to
you with both rationales side by side
(`docs/specs/black-smith-architecture.md` §6 "Diversity quorum"). No code
change, no restart beyond picking up the edited YAML on the next
`loadCrosscheckPolicy()` call.

**Promoting one provider is not enough to change any outcome.**
`asymmetric_roles.finder_ne_critic` excludes whoever raised the finding
from voting on it, and today's findings are raised by the native reviewer —
so with a single `mode: active` provider the gating pool is that one
provider, below `min_providers: 2`, and every case comes back
`insufficient-providers`: the finding still blocks, and you get an
escalation on the gate outcome. That is a deliberate fail-closed default,
not a bug. To actually let the quorum overturn findings you need **two**
active external providers (or a finding whose `found_by_provider` is an
external provider, which puts native back in the pool).

`smith judge preflight` (§1) checks this arithmetic for you: one active
external with `min_providers: 2` is reported as a problem, because that
configuration pays a gating provider's bill for a shadow provider's
influence.

### Running one active provider on purpose

The problem above assumes you walked into it. If you read it and still want
the configuration — the escalation carries a second model's rationale
instead of none, and a second provider starts gating with no further edit —
declare it:

```yaml
quorum_rule:
  min_providers: 2
  accept_non_gating_actives: true
```

Declared, the same sentence is reported under `notes` instead of
`problems`, and `smith judge preflight` stops exiting 1. It silences that
one advisory and nothing else: a provider enabled where it cannot be called
is still a problem, and `gating.canDecide` still reports `false`, because
nothing about the arithmetic changed — only whether the command treats a
decision you already made as a fault. That distinction matters for anything
that runs preflight on a schedule, which cannot tell a permanent exit 1
from a new one.

Leave it unset (the shipped default) if you have not made that choice. It
is not a way to make one active provider gate; there is no such way short
of a second provider.

### Reading back what that arithmetic cost — `smith judge escalations`

`smith judge preflight` tells you *before* the run that a one-active-external
configuration cannot gate. This tells you afterwards what it produced:

```bash
smith judge escalations --session <session-id>
```

It folds the lineage for `quorum-decision` events whose latest word was
`escalate` and splits them by what answering costs. `disagreements` is the
list a person has to read — two providers looked and said different words.
`ungated` is `insufficient-providers`, collapsed to a count and a hint,
because that is not one problem per finding: it is *this* section's arithmetic
reported once per finding. Exit `1` on an open disagreement, **`2` when
nothing was gated at all**, `0` only when there is genuinely nothing open — so
a box running with one active external never reads as clean by accident. Full
description in `docs/guide/operator-guide.md` §3c.

The other reason it exists lives in `mode: shadow`. Promotion (§4) is what
makes an escalation reach the caller: `gate.ts` returns one only when an
active judge took part, so a shadow provider that flatly contradicted the
native reviewer wrote its disagreement to the log and told nobody. During
calibration (§3) that is the reading you want, and this is the command that
surfaces it.

## 5. The independent finder — the additive direction

Sections 1–4 describe a **subtractive** tier. `quorum.ts`'s vocabulary is
`confirm | refute`: a critic is handed one claim the native reviewer already
raised and asked whether it survives. The strongest thing that tier can do
is delete a finding. It is a brake, and it is never an eye — a bug the
native reviewer's context did not surface is a bug no amount of
cross-checking reaches, because nothing outside that context is ever asked
to look.

`independent_finder` in `crosscheck.yml` is the other direction. A finder
from a different vendor reads the same diff in a fresh context, returns its
own evidence against
`factory/specs/schema/finding-evidence.schema.json`, and
`src/crossFinding.ts` reconciles its list against the native reviewer's. A
quorum can now raise, not only lower.

```yaml
independent_finder:
  enabled: false            # ships off
  mode: shadow              # reconciliations recorded, gating nothing
  providers: [codex]        # external only — never the native provider
  send_diff: false          # the operator mandate, below
  max_diff_bytes: 120000
  severity_resolution: highest-wins
```

**`providers` has no code default.** Omit the key and the fallback is the
empty list: the finder names nobody and refuses in those words, rather than
choosing a vendor on your behalf. `codex` above is what *this* repo's
`crosscheck.yml` happens to configure — a worked example, like everything else
named in this runbook, not a value the code falls back to. The other three
knobs do have defaults, and all of them are the off position: `enabled: false`,
`mode: shadow`, `send_diff: false`.

### The four outcomes

Every reconciled pair lands in exactly one bucket, and only one of them
can change anything:

| Outcome | What it means | Effect |
| --- | --- | --- |
| `corroborated` | same fingerprint on both sides | severity may rise (below) |
| `co-located` | same file and category, different claim | none — recorded only |
| `independent-only` | only the finder raised it | `raise-finding`, and only when gating |
| `native-only` | only the native reviewer raised it | none, ever |

`native-only` is `none` **by rule, not by omission**: silence is not a
refutation. The finder was never asked about that claim — it was asked to
read a diff — so its not mentioning something is absence of evidence, and
subtracting on it would let a truncated or lazy second opinion delete real
findings. Refutation stays where it belongs, in §2–§4's critic tier, where
a judge is handed the claim itself.

`co-located` exists because nothing here can tell one bug described twice
from two bugs in one function. It is surfaced for you and merged by nobody.

An `independent-only` finding is **minted, not privileged**. It enters the
gate as an ordinary finding carrying `found_by_provider`, and at S1/S2 it
meets the same `quorum_triggers` critic as any other finding — a third-party
vendor's unshared opinion still has to survive a refute pass before it
blocks a task.

`severity_resolution` decides a corroborated pair the two sides graded
differently: `highest-wins` takes the worse of the two, `native-wins` keeps
the native severity and records the disagreement without acting on it.

### The operator mandate: `send_diff`

A critic judges a **claim**, so §2's tier can send a summary and a failure
scenario and never the source. A finder cannot — it has nothing to read but
the diff. Shipping worktree source to a third-party API is a decision no
code in this repo has standing to make quietly, so it is a switch, it ships
`false`, and `smith crossfind run` **refuses** rather than falling back to a
diffless "find bugs" prompt that would invent findings.

`max_diff_bytes` refuses rather than truncates, for the same reason: half a
diff produces confident findings about code that is not there.

See exactly what would leave the machine before anything does:

```bash
smith crossfind request --task epic-1/task-1 \
  --diff /tmp/task-1.diff --diff-ref smith/epic-1/integration...task-1
```

It prints the `JudgeRequest` and sends nothing. With `send_diff: false` it
refuses, which is the point: the refusal is what tells you the switch is
still off.

### Calibrating it

Same arc as §3, one command:

```bash
smith crossfind run --task epic-1/task-1 \
  --diff /tmp/task-1.diff --diff-ref smith/epic-1/integration...task-1 \
  --session <id> --causal-parent <event-id>
```

Every run writes one `cross-finding-reconciled` event — outcome counts,
which providers ran, which were skipped, which failed, and the ids it would
have minted. Under `mode: shadow` that event is the **only** thing the run
produces, and it is what you read to decide whether to promote. It has a
timeline row in the dashboard for exactly that reason.

Exit code 1 means "this run would have changed a gate" (`report.gates`);
under shadow mode that is always 0, because nothing it says applies.

To reconcile two lists you already have — no provider, no cost, no event —
use `crossfind reconcile`, which takes the native findings and saved finder
runs as files. It is pure, so it answers under `SMITH_CROSSCHECK_OFFLINE`
too.

### Promotion, and what it costs

`mode: shadow` → `mode: active` in `crosscheck.yml`, same operator edit as
§4. Two differences from promoting a critic:

- **`min_providers` does not apply.** The finder is not voting on a claim,
  so one provider is enough to raise. The fail-closed arithmetic in §4 is a
  property of the quorum rule, not of this block.
- **This is the one judge call that costs a diff**, in tokens and in
  exposure. Budget for it per task, not per epic: `max_diff_bytes` is the
  ceiling on a single call, and the finder runs on the whole diff, not on
  one finding's summary.

## 6. Rollback

Two levers, same file, same "operator edit, never a runtime write" rule:

- **`mode: active` → `mode: shadow`** — the provider keeps running and
  getting recorded, but instantly loses gating power again. Use this first;
  it's the low-friction lever and keeps calibration data flowing.
- **`enabled: true` (or `auto`) → `enabled: false`** — the provider stops
  being invoked entirely (no cost, no events, no gating power). Use this for
  a hard stop (e.g. a key was rotated and you haven't reconfigured yet, or
  the CLI binary is misbehaving). A declared `false` is never overridden by
  a box that happens to have the binary — that is the whole difference
  between `false` and `auto`.

There is a third lever that is not this file: `SMITH_CROSSCHECK_OFFLINE=1`
(§2) does what `enabled: false` on every provider does, for one command,
without an edit to revert afterwards. Reach for it when the problem is
urgent and you want no chance of leaving a toggle flipped; reach for the
file when the change should outlive the shell.

Either edit takes effect on the next case; nothing to restart.

## 7. Cost notes

- **Codex** runs on the ChatGPT subscription via `codex exec` (no
  per-token API billing) — the whole point of the CLI-transport choice
  over an API transport for this provider (design decision, Phase 8 brief).
  Cost shows up as subscription usage, not a line item `smith stats`
  tracks; watch your ChatGPT plan's own usage limits if you fan out Codex
  judges heavily.
- **DeepSeek** bills per token on the API, but at an order of magnitude
  below frontier-tier pricing (DeepSeek's own published rates at time of
  writing) — cheap enough to run as a shadow-mode judge on every
  `quorum_triggers` case without materially moving the epic token budget
  (`factory/policies/budgets.yml`'s 4,000,000-token per-epic cap). `raw_usage`
  on each `JudgeResult` (`input_tokens`/`output_tokens`, when the API
  reports them) is available for cost accounting if you want to fold it
  into `smith stats analytics`'s cost-by-provider view later — not wired in
  by Phase 8 (YAGNI: no cost dashboard was asked for).

## 8. Security notes

- **Keys are env-only, never committed.** `crosscheck.yml` references
  `DEEPSEEK_API_KEY` by name; the actual value lives in `.env` (gitignored)
  locally or your CI/deploy secret store, never in this repo
  (`docs/standards/guardrails.md`). Codex has no key at all (subscription
  auth) — nothing to leak there beyond the `codex login` session state.
- **Gitleaks gate.** CI's secret scanner runs on every PR; a committed key
  blocks merge regardless of which file it landed in.
- **Never logged/echoed.** `api-transport.ts` reads the key from
  `process.env` at call time and never places the value in a thrown error,
  a log line, or an event payload — only the env var *name* ever appears in
  diagnostics. A non-2xx HTTP response body is scrubbed of the literal key
  string before it's ever included in an error's `details` (belt-and-
  suspenders — most gateways don't echo credentials back, but this transport
  doesn't rely on that).
- **A skipped provider leaves no trace, so `SMITH_CROSSCHECK_OFFLINE` is an
  operator switch, not an environment setting.** `runQuorumCase()` skips a
  disabled provider before `recordJudgeRun()`, so nothing in the event log
  distinguishes "this provider was never invoked" from "this provider was
  never configured" — true of `enabled: false` in the file as well, but the
  file at least leaves a diff. Today it still cannot change a gate outcome,
  but for an arithmetic reason rather than a configuration one: codex ships
  `enabled: auto, mode: active`, so on a box that has the binary there *is*
  an active external — it just cannot reach `min_providers: 2` on findings
  claude raised, and `computeQuorum()` escalates either way (§4). The moment
  a second provider is enabled, an ambient `SMITH_CROSSCHECK_OFFLINE` in a
  gating environment would silently downgrade real quorum cases back to
  native-only. So: pass it per command, and before you enable a second
  provider, check for it in the environment that runs the gate.
- **The finder is the one provider call that sends source.** Everything in
  §2–§4 sends a claim: a summary, a category, a path, a failure scenario.
  `independent_finder` sends the diff, because a second eye has nothing else
  to read (§5). That is why `send_diff` ships `false` and why the verb
  refuses instead of degrading — the fallback that would have been "ask for
  bugs without showing the code" is worse than no finder at all, since it
  produces findings about code the model never saw. Before you flip it,
  decide the same thing you would decide for any other outbound path: which
  vendor, under which terms, sees this repository's source. `crossfind
  request` prints the exact payload so that decision can be made on the
  bytes rather than on a description of them.
- **Provider output is data, not commands.** Neither transport gives a
  provider write access to worktrees, the event log, or anything callable —
  `runCliJudge`/`runApiJudge` return a schema-validated JSON value
  (`JudgeResult.output`); nothing downstream ever executes provider output
  as code (trust boundary, architecture §6).
