# Black Smith — Operator Interview

> **Recorded answers — 2026-08-03** (compiled into `docs/standards/stack.md`
> and `docs/standards/agent-constraints.md`):
> A2 = Vue 3 + Vite · A6/A8 = pnpm + Biome · D2: S2 = security/data-loss,
> broken core flow, a11y WCAG AA failure, new flaky test (visual-vs-HDS and
> perf >20% are S3) · E1 = 2M tokens/epic, alarm at 70%.
> All other questions accepted the recommended defaults. Re-answer any
> question below to trigger a recompile.

> **Amendment — 2026-08-05.** The old **E2 (concurrency: max workers in
> parallel)** was removed, not re-answered: concurrency is now uncapped.
> Parallelism is bounded by the path-claim graph rather than a worker count,
> and fan-out buys wall-clock without buying tokens, so a headcount knob
> bounded nothing that the per-epic token cap did not already bound. The old
> E3 (escalation ladder) is now E2.

> Purpose: your answers compile into (a) `docs/standards/stack.md` — the one
> stack every scaffolded project uses — and (b) per-subagent constraint blocks
> baked into agent templates. Answer inline under each `> Answer:` line, or
> answer in chat and Hans fills this in. Every question has a recommended
> default — leave an answer blank to accept it. Re-runnable: edit any answer
> later and the standards recompile.

## A. Unified stack (→ stack.md + scaffold)

**A1. Language.**
Recommended: TypeScript everywhere (strict mode).
> Answer:

**A2. Frontend framework.**
Options: Vue/Nuxt · React/Next · Svelte/SvelteKit · plain Vite + TS.
Recommended: pick the one you already ship at work — consistency beats taste.
> Answer:

**A3. Styling.**
Recommended: HDS tokens + adoption kit for every UI project; Tailwind (or
vanilla-extract) as the utility layer under HDS. Confirm HDS is mandatory for
all Black Smith projects or only operator-facing ones.
> Answer:

**A4. Backend/runtime.**
Recommended: Cloudflare Workers (Hono) as default API runtime; Node only when
Workers can't (long-running, heavy binaries).
> Answer:

**A5. Database.**
Recommended: SQLite locally / Cloudflare D1 deployed, via Drizzle ORM (one
schema, both targets). Alternatives: Postgres/Supabase if you need relational
scale.
> Answer:

**A6. Package manager + repo shape.**
Recommended: pnpm; single-repo per project (no monorepo) unless a project has
3+ deployable units.
> Answer:

**A7. Testing stack.**
Recommended: Vitest (unit) + Playwright (e2e + screenshots). Coverage floor —
see C2.
> Answer:

**A8. Lint/format.**
Recommended: Biome (one tool, fast) — or ESLint+Prettier if editor/CI parity
with work projects matters.
> Answer:

**A9. CI.**
Recommended: GitHub Actions — lint + test + build on PR; the merge queue's
gates run locally but CI is the public record.
> Answer:

**A10. Hosting.**
Recommended: Cloudflare (Pages/Workers + D1 + R2 + Access). Confirm, and note
any project class that must host elsewhere.
> Answer:

## B. Planner constraints

**B1. Autonomy level.** When may the planner start executing without you?
Options: (a) always waits for spec sign-off · (b) sign-off per epic, then free
· (c) free under a token budget, report after.
Recommended: (b).
> Answer:

**B2. Inferred-task confidence threshold.** Auto-schedule planner-invented
tasks at confidence ≥ X. Recommended: 0.8 to start, tune after 2 weeks of data.
> Answer:

**B3. Scope guard.** May the planner ever extend an epic's budget itself, or
is budget extension always a question to you? Recommended: always asks.
> Answer:

## C. Coder constraints

**C1. TDD strictness.** Options: (a) strict — failing test must exist before
implementation, gate-enforced · (b) tests required in same task, order free.
Recommended: (a) for logic, (b) for UI glue.
> Answer:

**C2. Coverage floor.** Gate fails below X% line coverage on claimed paths.
Recommended: 80% logic, no floor on generated/UI-glue files.
> Answer:

**C3. Dependency policy.** Adding a new npm dependency: (a) free · (b) allowed
from a curated allowlist, else asks · (c) always asks.
Recommended: (b) — allowlist grows via lessons.
> Answer:

**C4. Comment/doc style.** Any hard rules the coder must follow beyond the
scaffold's lint config (JSDoc, English-only, none)?
> Answer:

## D. Tester + reviewer calibration

**D1. Screenshot spec.** For UI tasks: which viewports (desktop-only or
+mobile 390px?), light/dark both? Recommended: desktop + mobile, both themes,
4 shots max per feature.
> Answer:

**D2. Severity calibration — what is S2 (blocks merge) for you?** Tick all
that block: data loss · security · broken core flow · a11y failure (WCAG AA) ·
visual regression vs HDS · perf regression >20% · flaky test introduced.
Recommended: all except visual regression (S3) and perf (S3 unless user-facing).
> Answer:

**D3. Waiver batching.** Ask about S3/S4 findings: (a) at epic end, one batch
· (b) daily digest · (c) immediately per task.
Recommended: (a).
> Answer:

**D4. e2e scope.** Every task ships e2e for its acceptance criteria, or only
epic-level e2e? Recommended: epic-level e2e + unit per task.
> Answer:

## E. Budgets + models

**E1. Per-epic token cap.** Default cap for a mid-size epic (planner + all
workers). Recommended: 5M tokens, alarm at 70%.
> Answer:

**E2. Escalation ladder.** After 2 failed rounds on a task: escalate coder
sonnet→opus automatically, or ask first? Recommended: automatic, logged.
> Answer:

## F. Cross-check providers

**F1. Providers to wire in phase 8.** Codex (OpenAI) + DeepSeek confirmed?
Others (Gemini, Qwen)? Note which you hold API keys for.
> Answer:

**F2. Quorum triggers.** Cross-provider check fires on: S1/S2 findings ·
epic final verdict · same-mistake findings · low-confidence planner verdicts.
Trim or extend? Recommended: keep all four, nothing more (cost).
> Answer:

## G. Notifications + review flow

**G1. Channel.** Where do escalations/waivers/PR-ready notices reach you?
Options: Slack DM (via hans-slack) · dashboard-only · email.
Recommended: Slack DM for blocking items, dashboard for everything else.
> Answer:

**G2. PR review granularity.** You review: (a) only the integration PR per
epic · (b) also spot-check task PRs. Recommended: (a); task PRs stay readable
for audit anyway.
> Answer:

**G3. Lesson review cadence.** Approve/reject lesson candidates: weekly batch
in UI, or as-they-come Slack nudges? Recommended: weekly batch.
> Answer:
