# Guardrails

> Hard rules the factory enforces mechanically — hooks and CI, not trust.
> This document is the contract. The data it is enforced from lives in
> [`factory/policies/guardrails.yml`](../../factory/policies/guardrails.yml)
> and the matchers in `factory/orchestrator/src/policy.ts`;
> [`.claude/hooks/guard.sh`](../../.claude/hooks/guard.sh) is a transport
> shim that pipes each `Bash` tool call into `smith policy hook` and relays
> the answer. Violations are S1 ("stop the line") unless stated otherwise.
>
> To ask what the rules would say about a command without running it:
> `smith policy check --command '<cmd>'` — exit 1 means denied, and the output
> names the rule. The matchers read command text, not intent, so they are
> deliberately loose: they over-refuse at the edges rather than let a real
> violation through. They live in tested TypeScript rather than as regexes in
> YAML because the bash predecessor silently allowed everything on macOS for
> eight phases and no test noticed.

## Secrets, keys, tokens

- **Env only, never committed.** All credentials live in environment
  variables: `.env` locally (gitignored), `.dev.vars` for Workers dev
  (gitignored), `wrangler secret` for deployed Workers, GitHub Actions
  secrets for CI. Code references names, never values.
- **`.env.example` is the only committed env file** — variable names and
  comments, no values.
- **Provider keys** (Codex, DeepSeek, any future judge) follow the same rule:
  `crosscheck.yml` references env var names only.
- **No secrets in outputs.** Agents never echo credential values into logs,
  the event log, PR bodies, commit messages, screenshots, or chat. The event
  logger redacts values matching a denylist (key/token/secret/password
  patterns) before write.
- **Secret scanning gate.** CI runs a scanner (gitleaks) on every PR; a hit
  blocks merge. A secret that reaches git history is S1: rotate the
  credential immediately, purge history, file a lesson.

## Git actions

- **`main`/`master` is untouchable by agents.** No direct push, no
  force-push, no merge by the factory — the operator is the only one who
  merges integration PRs into `main`. Enforced twice: GitHub branch
  protection (require PR, forbid force-push and deletion) + a local guard
  hook that blocks `push origin main`, `push --force`, and base-branch
  merges from any agent session.
- **Merge queue only.** Task branches merge into `smith/<epic>/integration`
  exclusively through the serial merge queue after gates pass — never by
  hand, never in parallel.
- **No history rewrite on shared branches.** `rebase`/`commit --amend` are
  allowed only on a task branch before it enters the merge queue; never on
  `smith/<epic>/integration` or `main`.
- **No destructive git ops** outside a worker's own worktree: no
  `reset --hard`, `clean -fdx`, or branch deletion beyond the worker's task
  branch after merge.

## Filesystem

- Workers write only inside their assigned worktree, and only within their
  spec's path claims (out-of-claim edits fail the gate — S3 `claim-violation`
  unless the edit touches guardrail-protected files, then S1).
- `rm -rf` and equivalents are blocked outside `workspaces/` and `state/`.

## Deploy + outbound

- **No deploy without the operator.** `wrangler deploy`/`pages publish` and
  any production-affecting command require explicit operator approval per
  invocation — never autonomous, never batched into a gate.
- **No autonomous outbound sends.** HTTP POSTs to third parties, Slack/email
  sends, and webhook registrations require operator approval; judges'
  provider API calls are the one exception (read-only judgment, budgeted,
  logged).

## The judge sandbox

Six roles judge work they did not do — grader, reviewer, verifier,
spec-reviewer, security-reviewer, uiux. Their bodies say "you never modify the
worktree", and until this shipped that sentence *was* the enforcement. It is
now backed. They hold `Read, Grep, Glob, Bash` and no `Edit`/`Write`, so
`Bash` is the only way one of them can change anything — and the hook already
sits on every `Bash` call.

The orchestrator opens a lease over a worktree before handing it to a judge
(`smith sandbox open <dir> --role <role> --task <id> --session <id>`) and
closes it once the verdict is filed. While that lease is open, three further
S1 rules apply to any command run inside that directory, on top of everything
above:

| Rule | What it refuses |
| --- | --- |
| `judge-network` | Outbound access of any kind — `curl`, `wget`, `gh`, `git fetch`/`clone`, package installs. A judge that cannot verify something records a finding; it does not go and fetch what it is missing. |
| `judge-write` | Every write except the judge's own verdict, under `state/results/` or `state/artifacts/`. Redirects into the tree, in-place edits, staging, moves, permission changes, editors. If the code needs changing, that is a finding, not an edit. |
| `judge-sandbox-escape` | `smith sandbox` itself. A lease the leaseholder can lift is not a lease. |

The lease is keyed by worktree path and matched by containment, so stepping
two directories down stays inside it, and a command in a different worktree is
untouched — an ordinary coder session in the same repo sees none of these
rules. `smith sandbox status` lists what is currently open.

`researcher` is deliberately outside the sandbox: fetching is its job, and it
reaches the network through `WebFetch`/`WebSearch` rather than through `Bash`.

**What this is not.** It is not a container, a seccomp profile, or a read-only
mount. It reads command text, so a write smuggled through an interpreter
(`python3 -c`, opening a file for writing) is invisible to it and always will
be. That is exactly why `smith worktree fingerprint`/`verify` stays in the
pipeline behind it: the sandbox refuses up front the writes a matcher can see,
the fingerprint catches after the fact the ones it cannot. Neither half is
sold as the other.

## CI

- `pnpm install --frozen-lockfile` only — CI never resolves new dependency
  versions.
- Gate parity: CI re-runs lint + typecheck + tests; a local-green/CI-red
  divergence blocks the queue until explained (error class `env-failure`).
