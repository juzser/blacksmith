# Runbook — the worker harness port (`smith harness`, `smith-run`)

Operator procedure for `factory/policies/harness.yml`: what a harness is, the
shipped default, reading and writing a policy, rendering an invocation, and
actually spawning one with `smith-run`. Companion to
[`../specs/black-smith-architecture.md`](../specs/black-smith-architecture.md)
§18 and §19; commands assume a built CLI (`pnpm run build` →
`factory/orchestrator/dist/cli.js` and `factory/orchestrator/dist/run-cli.js`,
substitute `smith`/`smith-run` if linked).

## 1. Two axes, one file each

Every turn this factory dispatches has two separate questions attached, and
only one of them had a config seam before this port existed:

| Axis | Question it answers | Where it lives |
|---|---|---|
| **provider** | which vendor's model produced the words | `taxonomy.yml` `provider:`, `crosscheck.yml` |
| **harness** | which program held the session — tools, cwd, turn limit | `factory/policies/harness.yml` |

`dispatch_decision` still records who answered and with what weight, never
what ran the turn. That second half is this file.

## 2. `smith harness list` — what this box can serve

```bash
smith harness list
```

No `--policy` means `factory/policies/harness.yml`, the shipped default
(`paths.ts`'s `HARNESS_POLICY_PATH`). On this repo's own shipped file that
prints three harnesses:

```json
{"source":"default","version":2,"defaultHarness":"claude-code","harnesses":[
  {"name":"claude-code","kind":"in-process","isDefault":true,"roles":["planner","coder","reviewer", "..."],"command":null,"envAllowlist":[],"output":"text","models":{}},
  {"name":"codex-cli","kind":"cli","isDefault":false,"roles":["planner","coder","reviewer", "..."],"command":"codex","envAllowlist":["HOME","PATH","CODEX_HOME"],"output":"codex-json","models":{}},
  {"name":"claude-cli","kind":"cli","isDefault":false,"roles":["planner","coder","reviewer", "..."],"command":"claude","envAllowlist":["HOME","PATH","ANTHROPIC_API_KEY","CLAUDE_CONFIG_DIR"],"output":"claude-json","models":{"frontier":"opus","mid":"sonnet","small":"haiku"}}
]}
```

(`roles` trimmed above for width — `summarizeHarnesses()` lists every
taxonomy `agent` role that ships a `.claude/agents/<role>.md` template and
that this harness serves; see §4 for what makes a judge role show up there
at all.)

`--policy <file>` reads a different policy file instead — the same shape
`smith stack show --policy <file>` uses, and the one a custom harness (§6)
is written and tested against before it becomes the default.

## 3. `smith harness plan` — render, never start

```bash
smith harness plan --role coder --task epic-1/task-3 \
  --prompt-file state/prompts/p.md --worktree ../wt/task-3
```

Renders a `WorkerInvocation` and prints it. **It does not start anything** —
architecture §18 rule 3, "nothing that observes may dispatch": `smith` only
ever renders, because an observer that could also dispatch would end up
reading its own output back as evidence a turn happened. The invocation is
the whole answer; starting the process it describes is §19's separate
concern (§5, `smith-run`).

Flags: `--harness <name>` (defaults to the policy's `default:`),
`--role <role>` and `--task <id>` (required), `--prompt-file <path>`
(required — this port renders invocations, not prompts, so there is nothing
to default it from), `--worktree <path>` (required for a judge role that
needs one read — see §4), `--tier <frontier|mid|small>` (overrides the
template's own tier mapping), `--schema <name>` (one of
`factory/specs/schema/*.schema.json` — a harness's `schema_args` are appended
only when this is given, so a turn that names none renders without them; a
harness that instead interpolates `{schema_file}` in its plain `args` still
refuses with no schema named, telling the operator to pass `--schema`).

A `cli` harness renders full `argv`, `cwd`, and an env allowlist. Both shipped
`cli` harnesses run in the worktree they are handed (`cwd` below) and render
with no `-C`/`--add-dir` in `args` at all — a turn with no worktree still
renders:

```bash
smith harness plan --harness codex-cli --role coder --task epic-1/task-3 \
  --prompt-file state/prompts/p.md --worktree ../wt/task-3 --schema result
```

```json
{"harness":"codex-cli","role":"coder","taskId":"epic-1/task-3","access":"worker","promptFile":"state/prompts/p.md","worktree":"../wt/task-3","sandboxRequired":false,"kind":"cli","command":"codex","args":["exec","--json","--color","never","--skip-git-repo-check","-","-s","workspace-write","--output-schema","/abs/path/factory/specs/schema/result.schema.json"],"cwd":"../wt/task-3","envAllowlist":["HOME","PATH","CODEX_HOME"],"template":".claude/agents/coder.md","output":"codex-json","model":null,"tier":"mid","schema":"result","stdin":"prompt","budget":{"timeout_ms":1800000,"max_output_bytes":2097152,"cap_tokens":150000}}
```

`--output-schema` is last because it comes from `schema_args`, appended after
`args` and the role's `worker_args`/`judge_args` — and only because `--schema
result` was given. The same call with no `--schema` renders `args` ending
`"-","-s","workspace-write"`, with no `--output-schema` at all.

An `in-process` invocation (the shipped default, `claude-code`) renders the
`subagent_type` and the template instead — no `argv`, because there is no
separate program to start:

```json
{"harness":"claude-code","role":"coder","taskId":"epic-1/task-3","access":"worker","promptFile":"state/prompts/p.md","worktree":null,"sandboxRequired":false,"kind":"in-process","subagentType":"coder","template":".claude/agents/coder.md"}
```

`envAllowlist` on a `cli` invocation is variable **names**, never values. The
JSON above is what gets printed to a terminal and written into logs; nothing
that passes through this port carries a secret.

## 4. Judges, worktrees, and `judge_args`

A judge role handed a worktree path by an external process has, in effect,
write access a sandbox lease can't revoke — architecture §18 rule 5, "judges
never gain write access". So `planWorkerTurn()` refuses to render a `cli`
invocation for a judge role with a worktree unless the harness's policy entry
declares a non-empty `judge_args`:

```bash
smith harness plan --harness some-cli-harness-with-no-judge-args \
  --role reviewer --task epic-1/task-3 --prompt-file p.md --worktree ../wt/task-3
```

```json
{"error":{"code":"harness.judge-worktree","message":"Harness \"some-cli-harness-with-no-judge-args\" runs a separate program, and reviewer is a judge role. A judge outside this process gets the prompt and nothing else — a worktree path it holds is write access no sandbox lease can revoke (architecture §18 rule 5). some-cli-harness-with-no-judge-args could still serve reviewer a worktree if its policy entry were to declare judge_args that make the program read-only.", ...}}
```

`judge_args` is the escape valve, and it is enforced by the OS or the tool
itself, not by this factory: codex's `-s read-only`, claude's
`--disallowedTools Write,Edit,MultiEdit,NotebookEdit`. Both shipped `cli`
harnesses declare it, which is why `smith harness list` (§2) lists judge
roles like `reviewer` under `codex-cli`/`claude-cli` even though they are
refused a worktree under a harness with empty `judge_args`. A harness that
declares `judge_args` still gets rule 6's fingerprint-before-and-after — a
read-only flag is what the harness *promises*, not what this factory has
*watched happen*.

Which roles are judges is read once, from `guardrails.yml` through
`policy.ts` — never a second hand-written list here or in a custom policy
file.

An `in-process` judge is inside the trust boundary already: it reads under a
`smith sandbox open` lease, which is why `sandboxRequired: true` shows up on
an in-process judge invocation with a worktree, rather than the caller having
to remember to open one.

## 5. `smith-run` — the thing that actually starts a harness

`smith harness plan` stops at the invocation. Something still has to spawn
it, and that something is deliberately **not** a `smith` verb — §18 rule 3
again, this time about the executable boundary rather than the code path:
`smith` never becomes the process whose own exit code and stdout it would
then read back as evidence a turn ran.

```bash
smith harness plan --harness codex-cli --role coder --task epic-1/task-3 \
  --prompt-file state/prompts/p.md --worktree ../wt/task-3 --schema result \
  > /tmp/invocation.json
smith-run /tmp/invocation.json
```

`smith-run` reads one already-rendered `WorkerInvocation` (a file path, or
`-` for stdin), spawns it, and prints a `RunOutcome` as JSON — exit code,
signal, whether it timed out or hit the output-size cap, the parsed answer,
schema validation (when the invocation names a schema), normalised token
usage, whether that usage went `over_budget` against `cap_tokens` (`null`
when the harness sets no cap, or when the output mode reported no usage to
compare — never guessed either way), and `harness_error` — a failure the
harness itself reported (a codex top-level `error` event, or claude's
`is_error: true`) despite exiting 0, `null` when it reported none.

Options: `--prompt-file <path>` (reads the prompt from here instead of
`invocation.promptFile` — useful for replaying one invocation against a
different prompt without re-planning), `--timeout-ms <n>` (overrides
`invocation.budget.timeout_ms` for this run only), `--out <file>` (writes
the JSON result to a file instead of stdout), `--help`.

Exit codes:

| Exit | Meaning |
|---|---|
| `0` | completed (exit 0), answer validated against its schema (or no schema set) |
| `1` | the harness process failed to start, or exited non-zero, or the harness reported an error in its output |
| `2` | completed (exit 0), but schema validation failed |
| `3` | timed out, or exceeded the output size cap |

An `in-process` invocation is refused outright — it names an `Agent`-tool
subagent turn, and there is no separate binary for `smith-run` to spawn:

```
smith-run: Invocation for role "coder" is in-process (harness "claude-code") — smith-run starts programs, not Agent-tool subagents. In-process harnesses run inside the orchestrator session itself and have no separate binary for smith-run to spawn.
```

**`smith-run` opens no event log, no `state/`, no DB.** It is the library
half (`runInvocation()` in `factory/orchestrator/src/runner.ts`) plus a thin
CLI wrapper (`run-cli.ts`) around `spawnCapped()` — the same detached,
group-killed spawn `cli-transport.ts` uses for external judges, reused here
with a `cwd`. Nothing it does is dispatch: it spawns exactly the one process
an already-rendered invocation describes and reports what happened. Writing
a `dispatch_decision`, opening a sandbox lease, or recording anything into
the event log stays the caller's job, same as it always was for an in-process
turn.

## 6. Writing a custom policy file

There is no code fallback beyond the shipped `harness.yml` (§2) — a second
harness is an operator decision, not a side effect of adding a seam. Write a
policy file anywhere and name it:

```bash
smith harness list --policy factory/policies/my-harness.yml
smith harness plan --policy factory/policies/my-harness.yml \
  --harness my-cli --role coder --task epic-1/task-3 --prompt-file p.md
```

Shape (version 2 — see `factory/policies/harness.yml` for the full worked
example with placeholders, `worker_args`, `judge_args`, `schema_args`,
`models`, and `timeout_ms`):

```yaml
version: 2
default: claude-code
harnesses:
  - name: claude-code
    kind: in-process
  - name: my-cli
    kind: cli
    command: my-harness-binary
    args: ["-"]
    worker_args: []
    judge_args: []          # empty: this harness never serves a judge role a worktree
    schema_args: []          # appended last, only when the turn names --schema
    output: text             # or codex-json / claude-json
    env: [HOME, PATH]
    timeout_ms: 1800000
```

No `-C`/`--add-dir` is needed in `args` to point the harness at the worktree:
`cwd` on the rendered invocation already runs the program there.

Placeholders are closed on purpose (`{prompt_file}`, `{worktree}`, `{role}`,
`{task}`, `{model}`, `{schema_file}`) — a typo'd placeholder is refused at
load time, naming the ones that do substitute, rather than reaching the
runner as a literal argument and starting the harness in the wrong directory.

## 7. Troubleshooting

- **`harness.judge-worktree`** — see §4. Either the role is not actually a
  judge (check `guardrails.yml`), or the harness needs a `judge_args` entry
  that makes it read-only, or this call should not carry a worktree at all.
- **`harness.missing-substitution`** — the harness's `args` (or
  `worker_args`/`judge_args`) interpolate a placeholder this request left
  unset. On the shipped policy this should not happen for `{schema_file}`
  any more, because it lives in `schema_args`, appended only when the
  request resolved a schema; it can still happen for a custom policy that
  puts `{schema_file}` in plain `args` — the fix there, and the message
  itself, is `pass --schema <name>`.
- **`harness.unknown-tier`** — `--tier` (or `WorkerTurnRequest.tier`) named
  something other than `frontier`, `mid`, or `small`.
- **`smith-run` exits 1 with a `spawnError`** — the harness `command` is not
  on `PATH`, or the invocation's `cwd`/`worktree` does not exist. The printed
  `RunOutcome.spawnError` names the underlying error (e.g. `ENOENT`).
- **`smith-run` exits 1 with `spawnError: null` and a nonzero `exitCode`,
  or a `harness_error`** — either the harness process itself exited
  non-zero, or it exited 0 but its own output reported a failure (a codex
  top-level `error` event, or claude's `is_error: true`); `RunOutcome.answer`
  can still be non-empty in the second case if the harness reported partial
  progress before the failure.
- **`smith-run` exits 3** — either the process ran past
  `invocation.budget.timeout_ms` (or its `--timeout-ms` override) and the
  whole process group was killed, or its combined output passed
  `budget.max_output_bytes`. Both are reported on the `RunOutcome`
  (`timedOut` / `sizeExceeded`), not only through the exit code.
- **A rendered `cli` invocation looks right but the harness never runs
  anything** — remember `smith harness plan` never starts it. Pipe the
  printed invocation into `smith-run` (§5), or hand it to whatever else in
  your own tooling is meant to spawn it.
