# Installing Blacksmith

The whole install. One command in a shell:

```bash
npm i -g @juzser/blacksmith
```

Two inside a Claude Code session, and an optional third:

```
/plugin marketplace add juzser/blacksmith
/plugin install blacksmith@blacksmith
/plugin install bs-mod@blacksmith
```

Then `bs init` in the project you want it to work on, and you have `/bs`.
Both halves are required and they are different things —
[Which install](#which-install) says why. The third line is optional:
bs-mod is the live HUD, your epic's progress above the prompt, and
Blacksmith runs the same without it.

**To have Blacksmith install itself**, say *"install Blacksmith"* to a Claude
Code session. This file is a runbook, not a description — every step is a
command with an expected result and a failure branch — so the session can
execute it top to bottom. It stops and asks before anything that touches the
machine outside the project.

[Part 2](#part-2--the-clone-runbook) is the long form, and it is the **clone**
path: building a checkout of the factory itself. If you ran the commands
above, the only part of it that is yours is
[Step 5](#step-5--the-stack-interview), the stack interview.

---

## Part 0 — Rules for an agent running this file

If you are a Claude Code session executing this runbook, these are binding:

- **Ask before touching the machine outside the clone.** Package-manager
  installs (`brew`, `apt`, `dnf`, `apk`), anything with `sudo`, global npm
  installs, and `corepack enable` all change the user's system — propose the
  exact command and wait for a yes. Everything inside the clone (`pnpm
  install`, `pnpm run build`, creating `.venv`) you may just do.
- **Never report a step as passing without running it.** Paste the real
  output. `check.sh` degrades to a printed `SKIP` rather than a false `OK`
  when a tool is missing, so read the tail of the output, not just the exit
  code — a run full of `SKIP` lines is not a green run.
- **Report what you skipped.** If an optional step was declined or a
  prerequisite was missing, say so explicitly in your summary rather than
  quietly leaving it out.
- **Do not "fix" the repo to make a check pass.** If `check.sh` fails on a
  clean clone, that is a finding to report, not a file to edit.
- **Stop and ask after two failed attempts** at the same step. Do not loop.

---

## Part 1 — What it needs

**The install** — package and plugin — needs three things:

| Requirement | Why |
|---|---|
| **Node ≥ 22** | `engines` in `package.json`; ESM + `node:` builtins throughout |
| **Claude Code CLI** | `/bs` is a Claude Code skill, and every worker it dispatches is a Claude Code session |
| **git ≥ 2.38** | `worktree add` / `remove` / `list --porcelain` *is* the isolation mechanism, once you run an epic; the merge queue needs `merge-tree --write-tree` (2.38) |

**A clone** needs those, plus the toolchain this repo's own gates run on:

| Requirement | Why | Needed for |
|---|---|---|
| **pnpm 9.3.0** (lockfile v9 — the version local development runs and CI pins) | install and every `pnpm run` script | everything |
| **bash** | `scripts/check.sh` and `.claude/hooks/*.sh` | the check gate + guard hook |
| **python3 + PyYAML** | `check.sh` parses the policy YAML and resolves every schema's `x-taxonomy` reference | the check gate |
| Codex CLI *(optional)* | Phase 8 cross-provider judge — `codex exec --json`, ChatGPT-subscription auth, no API key | only if you enable `codex` |
| `DEEPSEEK_API_KEY` in `.env` *(optional)* | Phase 8 API judge | only if you enable `deepseek` |
| `OPENROUTER_API_KEY` in `.env` *(optional)* | substitutes for codex/deepseek when their own precondition is unmet, and/or adds further judge models | only if you want OpenRouter substitution or extra judges — see [Cross-provider judges](#cross-provider-judges-phase-8) |
| Chromium for Playwright *(optional)* | `pnpm test:e2e` | UI e2e only — see [Known gaps](#known-platform-gaps) |

<details>
<summary><b>No C/C++ toolchain, and no <code>pnpm-workspace.yaml</code></b></summary>

**No C/C++ toolchain is required.** The one native dependency,
`better-sqlite3` (13.0.2), declares no `install`/`postinstall` script at all:
it ships prebuilt binaries for `darwin-{arm64,x64}`, `linux-{arm64,x64}`,
`linuxmusl-{arm64,x64}` and `win32-{arm64,x64}` and picks one at `require`
time (verified in `node_modules/better-sqlite3/prebuilds/` after a clean
`pnpm install --frozen-lockfile` that took 1.6s — nothing compiles).
`@playwright/test` likewise has no postinstall, which is why installing does
not pull down browsers; `playwright install chromium` is an explicit,
separate step.

There is deliberately **no `pnpm-workspace.yaml`**. This is a single-package
repo (the lockfile has one importer, `.`), and pnpm 9 rejects a workspace file
that has no `packages:` key — which is exactly how the first CI run failed, a
week after such a file was committed carrying only build-script settings. If
you switch to pnpm 10+, which blocks dependency build scripts by default,
check `pnpm install`'s output rather than assuming this repo still needs none.

</details>

---

## Which install

| | **The install — package + plugin** | **A clone** |
|---|---|---|
| Command | the block at the top of this file | Part 2 below |
| You get | the `bs` CLI and `/bs`, in whichever project you run `bs init` in | the whole factory: CLI, `/bs`, dashboard, its own tests and gates |
| State lives in | `.blacksmith/` in your project | the checkout itself |
| Upgrading | `npm i -g @juzser/blacksmith@latest`, then `claude plugin marketplace update blacksmith` | `git pull` |
| Not included | the dashboard (`bs ui serve`), `scripts/check.sh`, the repo's own suite | — |

Take the install unless you are hacking on Blacksmith itself.

### The install — `bs` and `/bs`

Two halves, and you need both. The package is the deterministic `bs` CLI
every playbook calls. The plugin is `/bs` and the fourteen agent roles it
dispatches — a router and ten playbooks under `.claude/skills/bs/` that a
session reads and follows. `bs` alone never gives you `/bs`: Claude Code
loads skills from a project's `.claude/`, from `~/.claude/`, or from a plugin,
never from `node_modules`, which is where an install puts the tarball's copy.
And a `/bs` with no `bs` on PATH can run nothing.

The command used to be `smith`. `smith` and `smith-run` still work as
deprecated aliases of `bs` and `bs-run`, each printing one notice to stderr,
and will be removed in a future release.

**Take `latest`** — `0.4.0`. `0.1.1` was the first release that knew it is a
package.
`0.1.0` has no `bs init`, ships no roadmap for `bs new` to read, and
keeps state inside its own install directory, which the next `npm install`
replaces.

```bash
npm i -g @juzser/blacksmith
cd /path/to/your-project
bs init
```

```
# inside Claude Code
/plugin marketplace add juzser/blacksmith
/plugin install blacksmith@blacksmith
/plugin install bs-mod@blacksmith      # optional: the live HUD
```

`claude plugin details blacksmith` prints what the second half added:
`Skills (1)`, `Agents (14)`, roughly 1k tokens always-on, with a playbook's
body read only when its verb runs. This repository is its own marketplace, and
the plugin it lists is the same `.claude/` directory a clone uses — one source
in the repository, nothing exported and nothing to keep in step.

**bs-mod**, the third line, is optional. It is a band above the prompt in
every session: with an epic in view, its agents, tasks done, budget, current
wave and what waits on you, on Overview, Current, Next and Past tabs. `/bs-mod`
opens a pane on the epic, `/bs-mod <epic-id>` pins one, and gate failures,
merges, waivers and escalations arrive as toasts. It is a plugin module rather
than skills and agents, so it needs a Claude Code build that loads plugin
modules: it was written and tested on 2.1.292, and no older build has been
checked. `claude plugin details bs-mod` shows it once installed, and
[`mods/bs-mod/README.md`](mods/bs-mod/README.md) says where it looks for
event logs.

`init` creates `.blacksmith/` beside your code and nothing else:

```
.blacksmith/
  .gitignore                        # state/ and workspaces/ are this machine's
  state/events/  state/artifacts/   # the event log and what agents produce
  factory/specs/active/             # epic plans
  factory/specs/roadmap.md          # a copy, for you to append to
  factory/policies/stack.yml        # a copy, for you to answer — see Step 5
```

The last two are copies **on purpose**. They are the two files you are meant
to edit, and the installed package is not a place to edit anything: the next
`npm install` replaces it wholesale, so an answer typed there would survive
until your first upgrade and then silently not. Everything the factory only
reads — schemas, the other policies, the agent templates — stays in the
package, where an upgrade is supposed to reach it.

`init` never overwrites a file you have already edited, so running it again
after an upgrade is safe and does nothing. Commit `.blacksmith/factory/` if
your team shares the project: the roadmap and the stack answers are
declarations about the project, not about your laptop.

Then do **[Step 5](#step-5--the-stack-interview)** — the stack interview —
against `.blacksmith/factory/policies/stack.yml`. It is the one step of Part 2
that is yours; the rest of it builds a checkout you do not have.

**A clone does not need the plugin.** A checkout already has both halves, and
adding the plugin there is not free: the session then lists two of
everything — `bs` and `blacksmith:bs`, `auditor` and `blacksmith:auditor`,
once for each of the fourteen roles — and pays the always-on cost twice. The
two can also disagree. The plugin's copy is a clone of `main` pinned at the
moment you installed it; the project's copy is whatever branch you have
checked out, so on a feature branch you get two `/bs` whose text differs. Keep
one: `claude plugin disable blacksmith` inside a checkout, or no clone at all.

Where the plugin is the only copy, re-fetch it from GitHub before you
reinstall when a new version lands — the installed payload stays pinned at
the version you installed:

```bash
claude plugin marketplace update blacksmith
```

What the plugin deliberately does **not** activate is this repo's enforcement:
the twelve `permissions.deny` rules in `.claude/settings.json` and the policy
hook in `.claude/hooks/`. A plugin's component set — skills, agents,
commands, hooks, MCP and LSP servers — has no permissions in it, and it loads
hooks only from a `hooks/hooks.json` this plugin does not ship — so
`claude plugin details blacksmith` reports `Hooks (0)`, which is the intended
result, not an omission. Both resolve paths against a checkout, and a hook that
cannot find its policy binary degrades to `ask`: installed as-is it would put a
confirmation prompt in front of every command you run. A clone keeps them,
because in a clone the paths are real.

### A clone

The event log (`state/events/`) and the SQLite projection (`state/smith.db`)
live inside the checkout — `factory/orchestrator/src/paths.ts` resolves both
relative to the repo root — while the projects it builds land *beside* the
clone, with their worktrees beside them. So put the clone somewhere you're
happy to keep it, in a directory you're happy to see projects appear in.
`bs init` has nothing to do here and says so: in a clone the work root and
the package are one directory, which is what makes the two installs one
codebase.

---

## Part 2 — The clone runbook

Every step below builds a checkout. If you installed the package and the
plugin instead, only **[Step 5](#step-5--the-stack-interview)** is yours —
run it against `.blacksmith/factory/policies/stack.yml` and stop there.

Run these in order. Each step says what a good result looks like.

### Step 1 — Platform prerequisites

Pick your platform, run its block, then come back to Step 2. These are the
commands that change the machine, so an agent must get your approval first.

<details open>
<summary><strong>macOS (Apple Silicon and Intel)</strong></summary>

```bash
brew install node@22 git          # or: nvm install 22
corepack enable                   # bundled with Node 22/24 -> provides pnpm
                                  # (or: npm i -g pnpm@9.3.0)

# macOS ships python3 with the Xcode command line tools, but not PyYAML,
# and the system interpreter is PEP 668 "externally managed" — use a venv:
python3 -m venv .venv && .venv/bin/pip install pyyaml
source .venv/bin/activate         # check.sh calls plain `python3`
```

The `source` matters: `check.sh` calls plain `python3`, so the venv has to be
active in the shell that runs it.

</details>

<details>
<summary><strong>Linux — glibc (Debian/Ubuntu, Fedora)</strong></summary>

```bash
sudo apt install -y git bash python3 python3-yaml     # Debian/Ubuntu
# sudo dnf install git bash python3 python3-pyyaml    # Fedora/RHEL
# Node 22 via nvm or NodeSource, then:
corepack enable
```

</details>

<details>
<summary><strong>Linux — musl (Alpine)</strong></summary>

```bash
apk add --no-cache nodejs npm git bash python3 py3-yaml
corepack enable
```

`bash` is not in a base Alpine image and `check.sh` genuinely needs it
(`BASH_SOURCE`, `set -o pipefail`, heredocs) — `sh` will not do. The musl
`better-sqlite3` prebuilds mean the rest still installs without a compiler.

</details>

<details>
<summary><strong>Windows — use WSL2</strong></summary>

Use **WSL2** and follow the Linux instructions inside it. Native Windows is
not supported today, for three reasons that are in the code rather than in a
support policy:

- `scripts/check.sh` and `.claude/hooks/guard.sh` are bash scripts, and the
  guard hook is wired into Claude Code as
  `$CLAUDE_PROJECT_DIR/.claude/hooks/guard.sh` (`.claude/settings.json`) —
  with no bash on `PATH` the safety hook cannot run at all. The *rules* are no
  longer the blocker: they moved into TypeScript behind `bs policy hook`,
  and what is left in bash is a short transport shim. Porting it is the
  smallest of these three problems, but it is not done.
- The test gate spawns each check `detached: true` and kills the whole **POSIX
  process group** on timeout (`testgate.ts` `runOne()`, which exists precisely
  because a per-child kill leaked grandchildren). Windows has no equivalent,
  so a timed-out check would leak processes.
- Target-project test commands are run through `spawn(..., { shell: true })`,
  which on native Windows means `cmd.exe`, not the POSIX shell every policy
  and template assumes.

`better-sqlite3` itself is fine on Windows (prebuilt `win32-x64`/
`win32-arm64`) — the blockers are the shell scripts and process-group
handling, not the native module.

</details>

**Verify before moving on:**

```bash
node --version      # expect v22 or higher
pnpm --version      # expect 9.3.0 (any pnpm 9 works; see Known gaps)
git --version       # expect 2.38 or higher
bash --version      # expect any GNU bash
python3 -c "import yaml; print('pyyaml ok')"
```

*If `python3 -c "import yaml"` fails:* you skipped the PyYAML step, or the
venv is not active in this shell. The check gate's policy/schema half cannot
run without it.

### Step 2 — Clone and install

```bash
git clone https://github.com/juzser/blacksmith.git && cd blacksmith
pnpm install --frozen-lockfile
```

**Expect:** a fast install with nothing compiling. `--frozen-lockfile` is not
optional — it is what guarantees you get the resolved tree CI pins.

*If it fails with a lockfile mismatch:* you are on a pnpm major other than 9.
Install pnpm 9.3.0 rather than regenerating the lockfile.

### Step 3 — Build the CLI

```bash
pnpm run build                          # tsc -> factory/orchestrator/dist/
node factory/orchestrator/dist/cli.js --help
```

**Expect:** the `bs` usage banner listing the command namespaces.

Until this step has run there is no policy layer for `.claude/hooks/guard.sh`
to consult, so it escalates every `Bash` call to you for approval rather than
guessing — a fresh clone prompts more than a built one. The same is true after
a `git pull` that touches `factory/orchestrator/src/`: rebuild.

### Step 4 — Run the gate

```bash
bash scripts/check.sh
```

**Expect:** the run ends with `== PASS ==`.

This is the composite gate, and it is the real proof of a good install. It
checks that every policy YAML parses, every JSON Schema's `x-taxonomy`
annotations resolve against `taxonomy.yml`, every agent template has valid
frontmatter matching the taxonomy's `agent` dimension, and every
`.claude/hooks/*.sh` passes `bash -n`. When `pnpm` is on `PATH` it also runs
Biome, `tsc --noEmit`, the Vitest suite, the server/UI typechecks, the UI
build, and the design-system gates (hardcoded values, emoji, contrast, token
resolution).

A green run today is **2,122 tests across 71 files** in the orchestrator
suite, plus **32** server and **331** UI tests — and, in a separate Playwright
job, **130** e2e tests across 11 specs.

*Read the tail, not the exit code.* Every step degrades to a printed `SKIP`
rather than a false `OK` when its tool is missing. `SKIP` lines for the
TypeScript half mean `pnpm` was not found; `SKIP` lines for the policy half
mean PyYAML was not found. Neither is a passing install. bs-mod's `SKIP` is
expected here whatever else you have: its checks need the `claude` CLI, which
[Step 6](#step-6--install-the-claude-code-cli) installs, so re-run the gate
after that step to see them run.

### Step 5 — The stack interview

Blacksmith has to know what this operator builds with — the planner grounds
task specs in it, the coder writes against it, and `bs new` scaffolds from
it. It ships the answers that assume least: a TypeScript library, no
frontend, no database, no design system. This step replaces them with real
ones.

**Ask the operator all of these in one message,** with the shipped default
beside each. "Keep the defaults" is a complete answer, and so is skipping any
single question.

| Question | Field | Ships as | Values |
| --- | --- | --- | --- |
| What does the code get written in? | `language` | `typescript` | `typescript` · `javascript` · `python` · `go` · `rust` · `other` |
| Is there a frontend? | `frontend` | `none` | `none` · `vue` · `react` · `svelte` · `solid` · `vite-vanilla` · `other` |
| Do UI projects build against a design system? | `design_system` | `none` | `none`, or its name |
| If so, which directory is the kit vendored from? | `design_system_source` | *(empty)* | a path on this machine, or empty |
| What sits under the components? | `styling` | `plain-css` | `plain-css` · `tailwind` · `css-modules` · `vanilla-extract` · `other` |
| What runs the server, if anything? | `backend` | `none` | `none` · `node` · `deno` · `bun` · `cloudflare-workers` · `other` |
| What stores the data? | `database` | `none` | `none` · `sqlite` · `postgres` · `mysql` · `d1` · `other` |
| Reached through what? | `orm` | `none` | `none` · `drizzle` · `prisma` · `kysely` · `other` |
| Which package manager? | `package_manager` | `pnpm` | `pnpm` · `npm` · `yarn` · `bun` |
| One package, or a monorepo? | `repo_shape` | `single` | `single` · `monorepo` |
| Lint and format with? | `lint` | `biome` | `biome` · `eslint-prettier` · `none` |
| Unit tests with? | `test_unit` | `vitest` | `vitest` · `jest` · `node-test` · `none` |
| End-to-end tests with? | `test_e2e` | `playwright` | `playwright` · `cypress` · `none` |
| CI on? | `ci` | `github-actions` | `github-actions` · `gitlab-ci` · `circleci` · `none` |
| Deployed where? | `hosting` | `unspecified` | free text |

Write the answers into [`factory/policies/stack.yml`](factory/policies/stack.yml)
— change the values in place, leave the comments — then read them back and
price them:

```bash
node factory/orchestrator/dist/cli.js stack show
node factory/orchestrator/dist/cli.js stack check
```

**Expect:** `stack check` prints `"ok": true` and one verdict per answer.

There are three verdicts, and only one of them is a problem:

- **`honoured`** — `factory/scaffold/` builds it. `bs new` produces it.
- **`recorded`** — nothing in the scaffold reads this answer; the agents do.
  `database: postgres` does not make the scaffolder write migrations, it makes
  the planner and the coder know what they are writing against. Green on
  purpose: an operator whose stack is wider than the template tree has not
  misconfigured anything, and a check that went red for them is a check they
  would learn to ignore.
- **`refused`** — `bs new` will stop rather than scaffold something else,
  and `stack check` exits 1. Either change the answer or accept that this kind
  of project gets scaffolded by hand.

That refusal is the point of running the interview at all. Answer
`frontend: react` and `bs new --ui` stops, naming the answer and the file;
it does not quietly hand over the Vue project the templates happen to ship and
let you discover the substitution afterwards.

A design system is **vendored, not referenced**: `design_system_source` is
copied into each scaffolded UI project's `design/` directory, so the project
still builds when that directory is gone. A named source that does not exist
is `refused` — a stylesheet importing a kit nobody wrote is worse than no kit.

### Step 6 — Install the Claude Code CLI

Needed to drive an actual epic: the planner and every worker run as Claude
Code sessions. Follow Anthropic's current install instructions for the
platform you are on, then confirm it is on `PATH`:

```bash
claude --version
```

Without it, the CLI and the gate still work — you simply cannot dispatch the
agents that do the work.

### Step 7 — Link the `bs` command *(optional)*

```bash
pnpm link --global     # or a global install
```

Turns `node factory/orchestrator/dist/cli.js plan validate ...` into
`bs plan validate ...`. Every example in the docs works either way. This
one writes outside the clone, so an agent must ask first.

The registry package is the other route to the same command: `npm i -g
@juzser/blacksmith` (or `npx @juzser/blacksmith` for one call) gives you
`bs` with no clone at all. It is the CLI, what it reads and the `/bs`
playbooks, not the dashboard or the docs — README "From npm" says exactly
where that line falls — and an agent running this file must ask before that
install too.

Installed that way, `bs` writes under `.blacksmith/` in the directory you
run it from rather than into its own package directory, which the next
`npm i -g` would replace wholesale. That covers `state/`,
`factory/specs/active/` and the `.env` Part 3 tells you to write. Set
`BS_HOME` to point all of it somewhere fixed instead:

```bash
export BS_HOME=~/.blacksmith         # one home for several projects
```

A clone ignores the question: it keeps writing into itself, as it always has,
unless `BS_HOME` says otherwise. The layout under the root is the same
either way, so every `state/...` path in these docs stays true.

Every `BS_*` variable in these docs was `SMITH_*` before the rename, and the
old name still works as a fallback: `BS_<X>` wins when both are set.

### Step 8 — The bs-mod HUD *(optional)*

A clone has no use for the `blacksmith` plugin, because its `.claude/`
already is that plugin. bs-mod is different: it lives in `mods/bs-mod/`, not
in `.claude/`, so a checkout does not load it on its own. It comes last
because it needs the `claude` CLI from Step 6, and, like Step 7, it is
optional and has a variant that writes outside the clone. Pick one of two:

```
# inside Claude Code: the released copy, in every session on this machine
/plugin marketplace add juzser/blacksmith
/plugin install bs-mod@blacksmith
```

```bash
# working on the mod itself: this checkout's copy, for one session only
claude --plugin-dir "$PWD/mods/bs-mod"
```

The install writes into `~/.claude/` and applies to every session on the
machine, so an agent running this file must ask before it. `--plugin-dir`
installs nothing: it loads the checkout's copy into the one session it starts,
which is how a change to the mod is seen before it is released.

**Expect:** after the install, `claude plugin details bs-mod` lists it, and
a new session shows the band above its prompt. With `--plugin-dir`, the
band shows in that session.

---

## Part 3 — Optional extras

None of these are needed for a working install. Add them when you want the
capability.

### Playwright browser (UI e2e)

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

See the first entry under [Known gaps](#known-platform-gaps) for why
`check.sh` still skips e2e even after this.

### Cross-provider judges (Phase 8)

Both external providers ship `enabled: auto` in
[`factory/policies/crosscheck.yml`](factory/policies/crosscheck.yml): each
resolves for itself, at parse time, against a fact about the box reading the
file — `codex` on `PATH` switches codex on, `DEEPSEEK_API_KEY` switches
deepseek on — so a box with neither calls neither, with no file edit needed
either way. `mode`, unlike `enabled`, is not per-machine: it is whatever the
committed file says, the same on every clone, so promoting a provider from
`shadow` to `active` (`docs/runbooks/providers.md` §4) is a repo-wide
decision an operator makes once, not a per-box switch.

- **Codex** — install the Codex CLI and run `codex login` once on this
  machine; auth is a ChatGPT subscription, no API key. `enabled: auto`
  picks it up with no file edit; only touch `providers.codex.enabled`
  yourself if you want to force it on or off regardless of what this box has.
- **DeepSeek** — put `DEEPSEEK_API_KEY` in `.env`. Copy `.env.example` as the
  starting point. `.env` is gitignored and the event logger redacts
  credential-shaped values before write; never commit a key. Same `auto`
  behaviour as codex above.
- **OpenRouter** — one key covers two cases. Put `OPENROUTER_API_KEY` in
  `.env`. (a) If codex's or deepseek's own precondition is unmet here, that
  provider runs through OpenRouter instead, keeping its own name, `mode`
  and gating power — `openrouter_fallback.model` in `crosscheck.yml` names
  the substitute, already set for both shipped providers. (b) Add
  `OPENROUTER_MODELS` (comma-separated OpenRouter model ids) in `.env` to
  bring in further judges, such as a Gemini or Qwen model. Each new judge
  starts in shadow mode until promoted. A project can also add or override
  providers via `<project-dir>/.blacksmith/crosscheck.yml`'s `providers:`
  map, the highest-precedence of the three config sources. Full mechanism
  and precedence: `docs/runbooks/providers.md` §9.
- **Then check it before a gate does.**
  `bs judge preflight [--project <dir>]` reports, without spending a
  call, whether each enabled provider — a substituted or OpenRouter-only one
  included — can be reached from here: the key's variable name, never its
  value, whether the CLI is on PATH, and (with `--project`) whether the
  project overlay changes any of that. Exit 1 means something configured
  here cannot answer. Run this at the start of every `/bs run`, not only at
  install (`.claude/skills/bs/run.md`) — the offer at that stop is the same
  one: add a key, add a model, pick which providers to run with, or continue
  without cross-check.
- **Skipping all of this is a supported choice, and the default.** No key,
  no CLI login, no `OPENROUTER_API_KEY`: every `enabled: auto` provider
  resolves off, no external judge is ever called, no spend, no transport
  failures, the gate runs on the native verdict alone. To force that for one
  command on a box where a provider *is* switched on, pass
  `BS_CROSSCHECK_OFFLINE=1`.

The full procedure — setup, shadow-mode calibration, promotion, rollback,
OpenRouter — is [`docs/runbooks/providers.md`](docs/runbooks/providers.md).

---

## Part 4 — Verify the install

For the package and the plugin, two commands answer it: `bs --help` lists
every command and namespace, and `claude plugin details blacksmith` reports
`Skills (1)` and `Agents (14)`. If both do, you are installed; the rest of
this part is the clone's. If you took the optional HUD,
`claude plugin details bs-mod` shows it.

In a clone, one command answers "did this work":

```bash
bash scripts/check.sh
```

`== PASS ==`, with no `SKIP` lines you did not consciously accept, means the
install is good.

`.github/workflows/ci.yml` runs this same script on every pull request and
every push to `main` — the file, not a copy of its command list, so the two
cannot drift. Two differences hold in CI: `PyYAML` is installed (the
policy/schema half needs it), and `CI=true` turns the "pnpm not on `PATH`"
`SKIP` into a failure, because a run that quietly skipped the whole TypeScript
half must not report green. A second job installs Chromium and runs
`pnpm test:e2e`, uploading the screenshots as a build artifact.

Then take the CLI for a walk. `bs --help` lists every command and
namespace; [`docs/guide/operator-loop.md`](docs/guide/operator-loop.md) is the
short version of what you actually do, and
[`docs/guide/operator-guide.md`](docs/guide/operator-guide.md) is the deep
walkthrough with real invocations and real output.

---

## Known platform gaps

Stated rather than papered over, in this repo's usual style:

- **`check.sh` still skips `pnpm test:e2e` locally.** Its guard looks for
  `${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}/chromium`, the container the
  UI was built in, and prints `SKIP pnpm test:e2e` when that file is absent.
  Running the specs directly does work now: after
  `pnpm exec playwright install chromium`, `pnpm test:e2e` picks up the
  per-user cache, because `ui/playwright.config.ts` only pins an
  `executablePath` when that path exists (override it with
  `PLAYWRIGHT_CHROMIUM_PATH`). CI takes the second route in its own job.
- **pnpm is not pinned for local development.** There is no `packageManager`
  field, so `corepack enable` gives you whatever pnpm your Node bundles. The
  lockfile is v9 and was written by pnpm 9.3.0, which is what CI pins; pnpm 10
  blocks `better-sqlite3`'s postinstall unless you allow it explicitly.
- **CI is one Linux runner, not a matrix.** `.github/workflows/ci.yml` covers
  `ubuntu-latest` on the `.nvmrc` Node only. Every platform claim above still
  comes from reading the code plus a real install on macOS 26 / arm64; Linux
  is now tested for *this* repo's gate, and WSL2 remains reasoned rather than
  certified.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `check.sh` prints many `SKIP` lines and still exits 0 | `pnpm` or PyYAML not found | Re-run Step 1's verify block; a `SKIP`-heavy run is not a pass |
| `ModuleNotFoundError: yaml` | PyYAML missing, or venv not active in this shell | `source .venv/bin/activate` (macOS), or install the distro `python3-yaml` package |
| `pnpm install` wants to change the lockfile | pnpm major other than 9 | Install pnpm 9.3.0; do not regenerate the lockfile |
| `dist/cli.js` not found | build not run, or stale after a pull | `pnpm run build` |
| `check.sh: command not found` / syntax errors on Alpine | running under `sh`, not `bash` | `apk add bash` and invoke `bash scripts/check.sh` |
| Guard hook never fires in Claude Code | no bash on `PATH` (native Windows) | Use WSL2 |

Still stuck: [`docs/guide/operator-guide.md`](docs/guide/operator-guide.md)
covers behaviour once installed, and
[`CONTRIBUTING.md`](CONTRIBUTING.md) covers the gate you must run before a PR.
