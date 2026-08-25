# Security Policy

## Supported versions

Black Smith has no released versions. It runs **from a clone** and the only
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
  judging, or influence its own verdict. `smith worktree fingerprint` /
  `verify` bracket this deliberately.
- **Secret leakage.** A credential value reaching the event log, a projection,
  a PR body, a screenshot, or a judge prompt. See
  [`docs/standards/guardrails.md`](docs/standards/guardrails.md) "No secrets
  in outputs".
- **The guard hook.** `.claude/hooks/guard.sh` and the deny list in
  `.claude/settings.json` block `push origin main`, force-pushes,
  history rewriting, and unbounded `rm -rf`. A bypass is in scope.
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
- **Running the factory against a repository you do not trust.** Black Smith
  executes that repository's own test commands.

## Known gaps, stated rather than papered over

- **Secret scanning is not wired into CI.**
  [`docs/standards/guardrails.md`](docs/standards/guardrails.md) § CI
  describes a gitleaks gate on every PR; `.github/workflows/ci.yml` does not
  run one today. Treat that line as intent, not as an enforced control, and
  check your own diffs.
- **Budget caps are prompt-level.** The per-epic and per-task token caps in
  [`factory/policies/budgets.yml`](factory/policies/budgets.yml) are stated to
  agents and counted after the fact; the loop runner does not hard-stop a
  session at the cap.
- **CI is one Linux runner.** No matrix — see `README.md § Known platform
  gaps`.

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
