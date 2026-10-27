# Claims matrix

What the front door says about Blacksmith, and what backs each sentence. A row
is one claim: the text as written, the file that makes it, the code, test or
document that backs it, and the limit the claim carries. A claim that nothing
backs is reworded to what is backed, or removed, in the file that made it, and
the last section lists each such change.

`factory/orchestrator/test/claimsMatrix.test.ts` holds this file to the README
first screen and the five description strings. It cuts the first screen into
claims by structure alone, checks that each claim has a row here, and checks
that every path in the Backed by column exists. A test is named by its file and
its title in quotes. A `\|` inside a claim cell reads as `|`.

## README first screen

| Claim | Source | Backed by | Limits |
|---|---|---|---|
| From feature request to reviewable PR — with an AI engineering workflow. | README | `factory/orchestrator/test/descriptions.test.ts` ("opens the README with the tagline as the first text line under the heading"), `docs/guide/operator-loop.md` | A summary of the flow, not a promise that every request yields a pull request: a run can stop on an escalation or a failed gate. |
| Plan a feature as signed spec contracts, build each in its own git worktree, put the result through review and verification gates, and merge through a queue into one pull request. | README, package.json, marketplace, plugin manifest | `.claude/skills/bs/plan.md`, `factory/orchestrator/src/spec.ts`, `factory/orchestrator/src/worktree.ts`, `factory/orchestrator/src/gate.ts`, `factory/orchestrator/src/queue.ts`, `factory/orchestrator/test/descriptions.test.ts` ("is the same sentence in package.json, the marketplace, the plugin and the README") | One sentence in four places, pinned equal. The sentence names the stages; it does not say how many tasks or waves a run holds. |
| You co-plan the spec. | README | `.claude/skills/bs/plan.md`, `.claude/agents/bs-planner.md`, `.claude/agents/bs-spec-reviewer.md` | The operator reviews and signs the contracts; a planner drafts them. |
| It decomposes, codes, tests, reviews, refutes itself — and hands you exactly one pull request. | README | `.claude/agents/bs-coder.md`, `.claude/agents/bs-tester.md`, `.claude/agents/bs-reviewer.md`, `.claude/agents/bs-verifier.md`, `factory/orchestrator/src/integration.ts`, `factory/orchestrator/test/queue.test.ts` | "Refutes itself" means a verifier whose job is to refute the reviewer's verdict. One pull request per epic; the operator merges it. |
| goal → contracts you sign → one worktree per contract, run in parallel → schema · tests · reviewer · verifier → one pull request you merge | README | `.claude/skills/bs/run.md`, `.claude/skills/bs/wave.md`, `factory/orchestrator/src/waveNext.ts`, `factory/orchestrator/src/waveBudget.ts`, `factory/specs/schema/task-spec.schema.json`, `factory/orchestrator/src/gate.ts` | Contracts run in parallel only when their path claims are disjoint and the wave cap allows it. |
| Two touchpoints. | README | `docs/specs/black-smith-architecture.md`, `docs/guide/operator-loop.md` | The touchpoints are signing the spec and merging the pull request. Escalations and waivers can still stop a run for the operator. |
| Everything between them runs unattended. | README | `.claude/skills/bs/run.md`, `.claude/skills/bs/wave.md`, `docs/specs/black-smith-architecture.md` | Unattended means no prompt to the operator in the happy path. A run that meets an escalation, a waiver decision or an operator-only rule stops and asks. |
| Compared with plain Claude Code | README | `docs/specs/black-smith-architecture.md` | A label for the table below it; the table makes the claims. |
| Spec \| You describe the work in chat \| A planner drafts spec contracts, a spec-reviewer challenges them, and they are frozen when you sign | README | `.claude/agents/bs-planner.md`, `.claude/agents/bs-spec-reviewer.md`, `factory/orchestrator/src/immutability.ts` | The plain Claude Code column is a description of an unstructured session, not a measurement. |
| Plan \| One session holds the plan in its context \| Tasks with disjoint path claims, admitted in waves, each in its own git worktree | README | `factory/orchestrator/src/claims.ts`, `factory/orchestrator/src/waveNext.ts`, `factory/orchestrator/src/waveBudget.ts`, `factory/orchestrator/src/worktree.ts`, `factory/orchestrator/test/claims.test.ts` | The table holds no number on purpose, and a test pins that. |
| Review \| The author checks its own work \| A fresh-context reviewer that never saw the coder's session | README | `.claude/agents/bs-reviewer.md`, `factory/orchestrator/src/judgePreflight.ts`, `factory/orchestrator/src/delegation.ts` | Fresh context is a property of how the reviewer is dispatched; the reviewer is still a model. |
| Verification \| You run the tests and read the diff \| Schema check, tests and coverage evidence, then a verifier whose only job is to refute the reviewer | README | `factory/orchestrator/src/gate.ts`, `factory/orchestrator/src/coverage.ts`, `factory/specs/schema/judge-verdict.schema.json`, `.claude/agents/bs-verifier.md` | Coverage evidence is as strong as the project's own coverage provider. |
| Merge \| You merge what the session produced \| A serial merge queue into one integration branch and one pull request that you merge | README | `factory/orchestrator/src/queue.ts`, `factory/orchestrator/src/integration.ts`, `factory/orchestrator/test/queue.test.ts` | The queue merges one task at a time into the integration branch; it never merges to the main branch. |
| Demo: NOT MEASURED. | README | `docs/trial/methodology.md`, `docs/trial/results.md` | A placeholder that says no demo is published. The trial documents say how a single run is recorded. |
| No single-run recording is published yet. | README | `docs/trial/results.md`, `factory/orchestrator/test/descriptions.test.ts` ("shows either a labelled single-run demo with its run id or a NOT MEASURED placeholder") | True while the placeholder stands; the test requires a run id the moment a recording replaces it. |

## Descriptions

| Claim | Source | Backed by | Limits |
|---|---|---|---|
| Optional live HUD for Blacksmith: a band above the prompt shows the session's epic, wave, agents, budget and what waits on you, with a /bs-mod pane and toasts. A plugin module; needs a Claude Code build with plugin modules. | marketplace, bs-mod entry | `mods/bs-mod/README.md`, `mods/bs-mod/hooks/register.tsx`, `docs/guide/mods.md` | Optional. It needs a Claude Code build that loads plugin modules; without one the factory runs the same. |
| Optional pull-request view: a pane lists the repo's open PRs with CI and merge state, and merges, updates a branch or sends a fix prompt; a band line above the prompt counts them. A plugin module; needs a Claude Code build with plugin modules and the gh CLI. | marketplace, pr-mod entry | `mods/pr-mod/README.md`, `mods/pr-mod/hooks/register.tsx`, `docs/guide/mods.md` | Optional. It needs plugin modules and an authenticated gh CLI; each action is the operator's key press. |
| The Blacksmith factory as Claude Code plugins: the /bs operator console and the role contracts it dispatches, plus two optional plugin modules: bs-mod, a live HUD, and pr-mod, the repo's open pull requests. | marketplace, top level | `.claude/skills/bs/SKILL.md`, `.claude/agents/bs-coder.md`, `mods/bs-mod/README.md`, `mods/pr-mod/README.md` | The marketplace lists three plugins; the two modules are separate installs. |

The package, marketplace and plugin descriptions of the factory itself are the
second row of the first section: the sentence is the same in all four places.

## Quickstart

| Claim | Source | Backed by | Limits |
|---|---|---|---|
| Every command below is one the CLI ships | quickstart | `factory/orchestrator/test/descriptions.test.ts` ("names only bs verbs the CLI dispatches"), `factory/orchestrator/src/cli.ts` | Checked for the bs verbs in the bash blocks. The slash commands run in a Claude Code session and are backed by the skill files. |
| Both halves are required: the package is the bs CLI, the plugin is /bs and the agent roles it dispatches. | quickstart | `package.json`, `.claude-plugin/marketplace.json`, `.claude/skills/bs/SKILL.md`, `.claude/agents/bs-coder.md` | A clone needs neither install; it runs from the checkout. |
| It reports what is present and what is missing, with a reason for each gap. | quickstart | `factory/orchestrator/src/installCheck.ts`, `factory/orchestrator/test/installCheck.test.ts`, `factory/orchestrator/test/doctorCli.test.ts` | It reads the machine and the install; it installs nothing. |
| That creates .blacksmith/ beside your code: the event log, your epic plans, a roadmap and a stack.yml to answer. | quickstart | `factory/orchestrator/src/workroot.ts`, `factory/orchestrator/test/workroot.test.ts` ("seeds the roadmap and the stack answers, named from paths.ts and nowhere else", "creates the directories the CLI writes into") | The event log appears when the first session writes to it. |
| It also merges Claude Code settings into .claude/settings.local.json, keeps a record of the keys it wrote in .claude/bs-settings-record.json, and adds a line for each of those two files to .git/info/exclude. | quickstart | `factory/orchestrator/test/workroot.test.ts` ("leaves a malformed local file untouched and reports it", "reports tracked and appends nothing when settings.local.json is already tracked", "writes the file outside a git repo and reports that"), `factory/orchestrator/test/workrootWindow.test.ts` ("records the revision and every key it wrote, caps included, in the project .claude/", "git-excludes the record like the local settings file", "does not create a record when the write fails (.claude is a file)", "skips the top-level key and every per-model key together when the user has a value", "blocks and retracts when the user sets a top-level value in the local file after bs wrote", "writes nothing and says why for %s"), `factory/orchestrator/test/workroot.test.ts` ("keeps other keys and a cap already set, adding only the missing one") | Skipped: the concurrency caps in a clone (its tracked settings carry them) and a cap already set where Claude Code looks; the window keys when the user has set `autoCompactWindow` in any source (none written, the window lines bs wrote earlier removed); no window when no recommended window can be read; the whole merge when the local file is not a JSON object, with no record then; the exclude line outside a git repository and for a file git already ignores or tracks. |
| /bs plan drafts spec contracts and asks you to sign them. | quickstart | `.claude/skills/bs/plan.md`, `.claude/agents/bs-planner.md` | Signing is the operator's step. |
| /bs run admits a wave, runs each task in its own worktree, grades it through the gates and ends in one pull request that you review and merge. | quickstart | `.claude/skills/bs/run.md`, `.claude/skills/bs/wave.md`, `factory/orchestrator/src/waveNext.ts`, `factory/orchestrator/src/gate.ts`, `factory/orchestrator/src/integration.ts` | A run can pause on an escalation before the pull request. |
| The dashboard: an optional, read-only view of the event log. | quickstart | `docs/guide/dashboard.md`, `ui/server/test/readOnly.test.ts` | Read-only in the sense that the server has no write route; decisions go through the CLI. |

## Plugin guard

| Claim | Source | Backed by | Limits |
|---|---|---|---|
| A clone of this repository enforces Blacksmith's policy on every tool call through a hook. | plugin-guard | `.claude/settings.json`, `.claude/hooks/guard.sh`, `factory/policies/guardrails.yml` | The hook sees the tools its matcher names: Bash, Write, Edit, MultiEdit, NotebookEdit, Agent and Task. |
| A plugin install does not, by default: nothing runs in front of your tool calls and nothing changes for you. | plugin-guard | `.claude/hooks/hooks.json`, `.claude/hooks/plugin-policy.sh`, `factory/orchestrator/test/pluginGuard.test.ts` ("is inert with the switch unset, or set to anything but 1, for every tool input") | The shim process starts on each matched call and exits at once when `BS_PLUGIN_GUARD` is not 1; only the policy decision is skipped. The plugin ships other hooks, such as prompt capture, that are not policy decisions. |
| The plugin guard is an opt-in way to get the same policy decisions in a plugin install. | plugin-guard | `.claude/hooks/plugin-policy.sh`, `factory/orchestrator/src/policyHook.ts`, `factory/orchestrator/test/pluginGuard.test.ts` | The same rules, run through the policy hook the package installs. |
| When it is on, every Bash, Write, Edit, MultiEdit, NotebookEdit, Agent and Task call is passed to Blacksmith's policy hook. | plugin-guard | `.claude/hooks/hooks.json`, `factory/orchestrator/test/pluginGuard.test.ts` ("passes the hook input to the resolved hook unchanged") | Other tools are not matched. |
| A call that breaks a rule is denied; a call that breaks none goes on to Claude Code's normal permission flow, unchanged. | plugin-guard | `factory/orchestrator/test/pluginGuard.test.ts` ("with the switch on and the built hook named, denies a force push to main and allows git status"), `factory/policies/guardrails.yml` | Allowing means no opinion; Claude Code's own permissions still apply. |
| If the guard is on but cannot reach the hook, it asks you instead of allowing the call. | plugin-guard | `factory/orchestrator/test/pluginGuard.test.ts` ("asks, naming bs-policy-hook and BS_POLICY_HOOK, when the switch is on and no hook is found", "asks when the resolved hook exits without a decision") | The shim also answers within a time limit: it asks when the hook has not answered within the watchdog limit, or exits non-zero. A hook that exits 0 with no output is read as no opinion. |
| Set BS_PLUGIN_GUARD=1 in the environment Claude Code starts in. Unset, empty or any other value, the guard does nothing and prints nothing. | plugin-guard | `.claude/hooks/plugin-policy.sh`, `factory/orchestrator/test/pluginGuard.test.ts` ("is inert with the switch unset, or set to anything but 1, for every tool input") | The only switch. |
| The hook is found in this order: the file named by BS_POLICY_HOOK, run with node, then bs-policy-hook on PATH. | plugin-guard | `factory/orchestrator/test/pluginGuard.test.ts` ("prefers BS_POLICY_HOOK over bs-policy-hook on PATH", "falls back to bs-policy-hook on PATH when BS_POLICY_HOOK is unset") | The global package installs the bs-policy-hook command (package.json bin). |
| Setting the switch through an env entry in a Claude Code settings file is not tested here, so this guide does not claim it works. | plugin-guard | `factory/orchestrator/test/pluginGuard.test.ts` ("names the one switch and says a settings-file env entry is not a tested way to set it") | A statement of what is not claimed. |
| A test keeps this block equal to the deny list in the clone's own settings. | plugin-guard | `factory/orchestrator/test/pluginGuard.test.ts` ("carries a deny block equal to the deny list in .claude/settings.json"), `.claude/settings.json` | The deny list is a second layer inside Claude Code; it matches command prefixes only. |

## Changes

No claim was reworded or removed by this matrix. Each claim above has a path or
test that backs it at the revision this file was written against. Two limits are
stated in the rows instead of changing the claims: "Two touchpoints" and
"Everything between them runs unattended" keep their wording, with the stop on
an escalation or waiver noted in the Limits column.
