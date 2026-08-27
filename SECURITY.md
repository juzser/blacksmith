# Security Policy

## Supported versions

Blacksmith has no released versions. It runs **from a clone** and the only
supported code is the current `main`. Fixes land on `main`; there are no
backport branches.

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private vulnerability reporting: the repository's **Security**
tab → **Report a vulnerability**. That opens a private advisory visible only
to you and the maintainers.

Please include:

- what an attacker can do, not only what looks wrong;
- the smallest reproduction you have — a command, a spec file, an event
  payload;
- the commit SHA you saw it on;
- whether it needs the factory to be *running an epic*, or only a checkout.

You should get an acknowledgement within a few days. This is a small
project — there is no bounty and no SLA, and a fix may take longer than an
acknowledgement does. If a report is accepted, the advisory is where the fix
and the disclosure timing get agreed.

**Never put a credential in a report.** If a report needs one to make sense,
say so and it will be handled in the advisory thread.

## What is in scope

This is an orchestrator that runs language-model agents against a git
checkout. The interesting attack surface is the boundary between *untrusted
text* and *things that execute*:

- **Prompt injection through fetched or quoted text.** `smith prompt wrap`
  exists to fence such text as data before it reaches a prompt
  (`wrapIngested`, `factory/orchestrator/src/provenance.ts`). A path where
  untrusted text reaches a dispatch unfenced is in scope.
- **Escaping the worktree.** Workers are confined to
  `workspaces/.wt/<project>/<task-id>` and to their spec's path claims. A way
  for a task to write outside its claims without failing the gate is in scope.
- **Bypassing a gate.** Anything that lets a task reach the merge queue with
  a failing schema check, a failing test gate, or an unresolved S1/S2 finding.
- **Judge integrity.** A read-only judge that can mutate the tree it is
  judging, reach the network, or influence its own verdict. The role sandbox
  (`smith sandbox`, plus the `judge-*` rules in
  [`factory/policies/guardrails.yml`](factory/policies/guardrails.yml))
  refuses those commands up front, and `smith worktree fingerprint` / `verify`
  bracket the run to catch what a text matcher cannot see. Both halves are
  stated in
  [`docs/standards/guardrails.md`](docs/standards/guardrails.md) "The role
  sandbox"; a way past *both* is in scope.
- **Grading one's own work.** A tester that can edit the implementation it is
  covering, so a red test turns green by changing the subject rather than the
  test. `role_write_scopes` in the same file fences it to test files; a write
  it reaches outside them is in scope.
- **Secret leakage.** A credential value reaching the event log, a projection,
  a PR body, a screenshot, or a judge prompt. See
  [`docs/standards/guardrails.md`](docs/standards/guardrails.md) "No secrets
  in outputs".
- **The guard hook.** `.claude/hooks/guard.sh` — a transport shim over
  `smith policy hook` — and the deny list in `.claude/settings.json` block
  pushes to `main`, force-pushes, history rewriting, and unbounded deletion.
  A bypass is in scope, and so is a shim that fails *open*: when the policy
  layer cannot answer, the hook escalates to the operator and never emits an
  `allow` envelope, because a hook's `allow` outranks the operator's own deny
  list.
- **The local dashboard.** `smith ui serve` binds a local HTTP server with
  write routes (waivers, lesson approve/reject). Anything that turns it into
  a remote-write surface is in scope.

## What is out of scope

- **The models themselves.** A model producing wrong or low-quality output is
  a bug, not a vulnerability. That is what the gates are for.
- **Provider accounts and keys.** Codex and DeepSeek credentials are yours;
  their handling inside this repo is in scope, their security is not.
- **Anything requiring an operator to approve it.** Deploys, outbound sends,
  and merges to `main` are deliberately gated on a human. "The operator could
  approve something bad" is the design, not a flaw.
- **Running the factory against a repository you do not trust.** Blacksmith
  executes that repository's own test commands.

## Known gaps, stated rather than papered over

- **`.vue` single-file components are not type-checked.** `vue-tsc` needs
  Volar, Volar needs TypeScript's classic Node compiler API, and this repo
  runs TypeScript 7's native port, which does not expose one. The hole is
  narrower than it was: `ui/test/vueContract.test.ts` compiles every SFC with
  Vue's own compiler and fails the gate on anything the compiler had to leave
  for runtime — an identifier no binding provides, an unregistered component
  or directive, an import the template does not use — and on any call site
  passing a prop, event or slot the component it calls never declared. That
  is a contract check, not a type check: it knows a prop exists, not that a
  `string` was passed where a `number` was declared. The rest of the
  mitigation is structural — UI logic lives in `ui/src/lib/*.ts`, which is
  type-checked, linted and unit-tested, and the SFCs stay thin.
- **Per-task budget caps are advisory.** `smith wave check` refuses to admit
  a wave whose declared cost would cross the epic's `cap_tokens`, so the epic
  cap in [`factory/policies/budgets.yml`](factory/policies/budgets.yml) is
  enforced before any of that wave's tokens are spent. The per-task caps are
  not, and deliberately: a cap a worker polices mid-task is pressure on the
  work it is measuring (D-29). Nothing hard-stops a session already running.
- **CI is one Linux runner.** No matrix — see
  [`INSTALL.md`](INSTALL.md#known-platform-gaps) § Known platform gaps.

## Handling secrets in this repo

- All credentials live in environment variables. `.env` is gitignored;
  `.env.example` is the only committed env file and carries variable **names**
  only.
- Nothing auto-loads `.env` — there is no dotenv dependency. Load it yourself
  (`node --env-file=.env ...`).
- `factory/policies/crosscheck.yml` references provider key **env var names**,
  never values.
- Credential-shaped strings that appear in the test suite are deliberately
  synthetic fixtures named inside acceptance criteria. They are not live
  credentials, and they must stay synthetic.
