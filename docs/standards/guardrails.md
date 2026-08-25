# Guardrails

> Hard rules the factory enforces mechanically — hooks and CI, not trust.
> Phase 2 ships the enforcement (guard hook + permission config + CI jobs);
> this document is the contract they implement. Violations are S1
> ("stop the line") unless stated otherwise.

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

## CI

- `pnpm install --frozen-lockfile` only — CI never resolves new dependency
  versions.
- Gate parity: CI re-runs lint + typecheck + tests; a local-green/CI-red
  divergence blocks the queue until explained (error class `env-failure`).
