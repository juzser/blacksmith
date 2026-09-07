# Plugin port — scope

- **Milestone id:** `plugin-port`
- **Status:** `planned`. This is a scope, not a plan. No epic is cut, no
  constant is renamed and no directory is moved until the forks at the end
  are answered by the operator.
- **Requested:** operator, 2026-09-07, after asking how a normal user runs
  Blacksmith today and whether Docker or an exposed service would help. The
  answer to the second question is in "Out of scope"; this document is the
  first one.
- **Measured against:** this clone at `13dd1c9`. Every count below was run,
  not recalled.

## Where the distribution actually stands

- `package.json` is `"private": true` at `"version": "0.0.0"`, with no
  `files` field and no `.npmignore`. Nothing has been published and nothing
  could be.
- The package is named `black-smith`. The repo, the remote, the README and
  every guide call it `blacksmith`. Two names for one thing, and the npm one
  is the one a user would have to type.
- `"bin": { "smith": "factory/orchestrator/dist/cli.js" }` already exists and
  points into `dist/`, which `.gitignore` excludes. The entry point is real;
  the artifact it names is not shipped.
- The only install path `README.md` and `INSTALL.md` describe is clone →
  `pnpm install --frozen-lockfile` → `pnpm run build`. There is no
  Dockerfile, no compose file and no wrangler config in the tree.
- `factory/orchestrator/src/paths.ts` derives the whole factory from one
  anchor: `REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)),
  '..','..','..')`. Twenty exported constants hang off it, and thirty-two
  further `REPO_ROOT` references live outside that module — in `cli.ts`,
  `policy.ts`, `projects.ts`, `roadmap.ts`, `scaffold.ts`, `stack.ts`,
  `ui/server/src/app.ts` and `ui/server/src/paths.ts`.
- `usage.ts` documents 103 commands. Nineteen accept `--state-dir`, three
  accept `--db`, eight accept `--project`. The remaining eighty-four resolve
  their paths from `paths.ts` and cannot be told to look anywhere else.
- `.claude/` holds 13 agent templates, 2 skill files (`SKILL.md` 66,844
  bytes, `wave.md` 16,144), one hook script, and a `settings.json` carrying
  one `PreToolUse` matcher and 12 `permissions.deny` rules.
- `.claude/hooks/guard.sh:54` resolves its own root from
  `${BASH_SOURCE[0]}/../..` and runs
  `$REPO_ROOT/factory/orchestrator/dist/policyHook.js`.

Two of those facts are better news than they look, and the port should be
sized against them rather than against the worst case.

`.claude/skills/bs/SKILL.md` names `factory/orchestrator/dist/cli.js`
exactly once — in the paragraph that introduces the CLI — and speaks
`smith <ns> <action>` everywhere after. The playbook is already written
against a binary on `PATH`, not against a path inside a clone.

And it already refuses to know where the project is: *"The project directory
is an answer you ask for, not a path this file knows."* Every verb that
touches the project's git takes `<project-dir>` or `--project <dir>`,
because `smith new` puts a project *beside* the clone (D-42). The factory
has already stopped assuming that what it builds lives inside it. What it
has not stopped assuming is that *the factory itself* is a clone the
operator is standing in.

## What the operator settled, 2026-09-07

Three decisions, taken before this scope was written and binding on it.

1. **The CLI ships through npm.** The plugin invokes
   `npx -y blacksmith@<pinned-version>`; the plugin repo commits no `dist/`.
   A plugin version and a CLI version then move together, and a user never
   gets a binary the playbook was not written against. The two alternatives
   — vendoring a build into the plugin, or asking the user to clone and
   `pnpm link` — were declined.
2. **Writable state lives in the project**, at `<project>/.blacksmith/`,
   with a `.gitignore` line, rather than in a per-slug directory under
   `~/.blacksmith/projects/<slug>/`. State stays next to the work it
   describes and travels with a backup of it; the cost is one ignored
   directory in the user's repo, which PP-2 makes the plugin write.
3. **Spec first, code after** — this document, reviewed by `spec-reviewer`,
   before an epic is planned.

One thing turned out not to need a decision. **The DeepSeek key needs no
YAML edit at all.** `factory/policies/crosscheck.yml` already ships
`deepseek: enabled: auto`, and `preconditions.ts`'s `apiKeyPresent()`
resolves `auto` against `process.env.DEEPSEEK_API_KEY` at call time — the
file describes a *machine*, not a contract, which is why it can ship one
spelling for every box. A user with a key gets a shadow judge; a user
without one gets no external judge and no error. So PP-5 is not a
configuration problem. It is the narrower problem of getting a key into the
environment without asking a non-developer to edit a dotfile.

## PP-1 — `REPO_ROOT` is three roots wearing one name

This is the port. Everything else is packaging.

Under a clone, three different kinds of path collapse into one anchor and
nobody has had to tell them apart. Under a plugin they separate, because the
plugin root is shared across every project on the machine and is replaced
wholesale on update:

- **`FACTORY_HOME`** — what the factory *is*. Read-only, shipped, identical
  on every machine, overwritten on upgrade. Under a plugin this is
  `${CLAUDE_PLUGIN_ROOT}`; under a clone it stays `REPO_ROOT`.
- **`STATE_ROOT`** — what a run *produced*. Written constantly, per project,
  never shared, safe to delete. Decision 2 puts it at
  `<project>/.blacksmith/`.
- **`PROJECT_ROOT`** — what the operator *declared* about their own work.
  Not shipped and not runtime output: hand-authored, committed, and the
  operator's to own.

| Constant | Root | Note |
| --- | --- | --- |
| `TAXONOMY_PATH`, `SCHEMA_DIR`, `WORKTREE_POLICY_PATH`, `SCHEDULER_POLICY_PATH`, `CROSSCHECK_POLICY_PATH`, `DELEGATION_POLICY_PATH`, `BUDGETS_POLICY_PATH`, `EFFORT_POLICY_PATH`, `SENSITIVE_PATHS_POLICY_PATH`, `GUARDRAILS_POLICY_PATH`, `SEVERITY_POLICY_PATH`, `LESSONS_MD_PATH` | `FACTORY_HOME` | The shipped policy set. |
| `AGENTS_DIR`, `SCAFFOLD_DIR`, `DB_MIGRATIONS_DIR` | `FACTORY_HOME` | Templates, scaffold, migrations. |
| `STATE_EVENTS_DIR`, `STATE_ARTIFACTS_DIR`, `STATE_DB_PATH`, `STATE_DAEMON_DIR`, `SANDBOX_LEASE_DIR` | `STATE_ROOT` | Plus `state/results/` and `state/lessons/`, which PP-2 shows are not in `paths.ts` at all. |
| `SPECS_ACTIVE_DIR`, `ROADMAP_PATH` | `PROJECT_ROOT` | An epic plan and a roadmap are declarations about *this* project. Two projects driven by one plugin must not share one `factory/specs/active/`. |
| `STACK_POLICY_PATH` | `PROJECT_ROOT` | "What this operator builds with", recorded at install. Shipping it in `FACTORY_HOME` would make one user's stack every user's, which is the drift `stack.yml` was created to end. |
| `DOTENV_PATH` | chain | PP-5. |
| `PROJECTS_DIR`, `WORKSPACES_DIR` | neither | See below. |

`PROJECTS_DIR = path.dirname(REPO_ROOT)` is the one that breaks loudest.
Its rationale — a scaffolded project lands *beside* the clone, never inside
it — is right and must survive. But under a plugin the parent of the plugin
root is a marketplace cache directory, so the constant would resolve to
somewhere no project should ever be written. Under a plugin, "beside the
clone" has no referent: there is no clone. The replacement is the rule the
`/bs` skill already follows — *the project directory is an answer you ask
for* — which makes the default the parent of the project the operator named,
and makes `smith new` require a target rather than infer one.
`WORKSPACES_DIR` (`workspaces/` inside the clone, still a legal home for a
project already there) has no meaning at all without a clone and should
resolve to nothing rather than to a path under the plugin root.

The scale of the change is a fact worth stating plainly: 32 call sites
outside `paths.ts`, in 8 modules, each of which has to be read and assigned
to one of three roots. A mechanical find-and-replace would put state under
the plugin root, where the next plugin update deletes it.

## PP-2 — Moving state moves a policy file with it, in two places

`factory/policies/guardrails.yml:168` declares
`write_roots: [state/results, state/artifacts]`, and its judge sandbox glob
list (`:279-280`) repeats them as `state/results/**` and
`state/artifacts/**`. `policy.ts`'s `isUnderWriteRoot` (around
`:1335-1350`) matches those roots **segment-wise against a
repo-root-relative path**, and its own comment records why:
`state/results-of-mine` must not read as inside `state/results`, and
anything that climbed above the root — rendered by `path.relative` with a
leading `..`, or by an absolute path with a leading empty segment — is
refused.

So the write root a judge is allowed is a *literal relative path*, matched
from the root the guard believes it is under. Move state to
`<project>/.blacksmith/results/` and every judge loses permission to write
its own verdict — and loses it in the worst possible way, as a guard
refusing a write, which reads exactly like a guard working correctly. The
same file's line 119 carries the sibling rule: *"rm -rf is only allowed
inside `workspaces/` or `state/`."*

Two consequences for the plan:

1. The write roots must become root-relative to `STATE_ROOT` rather than to
   the repo, in `guardrails.yml`, in `policy.ts`, and in the judge templates
   under `.claude/agents/` that name `state/results/<task-id>.<role>.json` as
   the artifact they produce. That is one change spanning declarations, code
   and prompts, and a plan that changes any two of the three ships a factory
   whose judges cannot file.
2. `state/results/` and `state/lessons/` are **not in `paths.ts`**. They are
   string literals in `artifacts.ts:57`, `immutability.ts:177`, `policy.ts`
   and `cli.ts:2265`. Any port that works from the `paths.ts` export list
   alone will miss them, and will miss them silently until a judge writes.

The migration for an existing clone is its own question, and it is not
hypothetical: this clone holds 4.6M of `state/` across `artifacts`,
`daemon`, `events`, `results`, `sandboxes` and `smith.db`. Fork 3 below asks
whether it moves.

## PP-3 — The package has to become publishable, and is not close

Beyond flipping `private` and setting a real version:

- **The name.** `black-smith` in `package.json` versus `blacksmith`
  everywhere else. Which name npm will actually accept was not measurable
  here — the registry is unreachable from this session, and the check is
  `npm view blacksmith` before anything else in the epic. A scoped name
  (`@juzser/blacksmith`) is always available and is the safe default;
  whichever is chosen, the plugin's `npx` line and the docs must name the
  same string, and `package.json`'s name should stop disagreeing with the
  repo.
- **Dependencies.** The published CLI would currently install a UI
  framework. `dependencies` holds `vue`, `vue-router`, `@vue-flow/core`,
  `hono` and `@hono/node-server` alongside the six the CLI actually needs
  (`ajv`, `ajv-formats`, `better-sqlite3`, `drizzle-orm`, `picomatch`,
  `yaml`). A user running `npx blacksmith epic verdict` should not be
  downloading Vue. The dashboard's dependencies belong behind a workspace, an
  optional dependency, or a second package.
- **`dist/` in the tarball.** `"prepare": "pnpm run build"` runs on a git or
  local install and *not* on install of a published tarball, so the tarball
  must contain `dist/` and the package must declare a `files` field to put it
  there. `dist/` staying gitignored is correct and unaffected — publish
  builds, git does not.
- **What else ships.** `factory/` is 9.0M, `docs/` 4.1M and `ui/` 6.4M in
  this clone. `FACTORY_HOME` needs `factory/policies`,
  `factory/specs/schema`, `factory/scaffold` and the migrations — not
  `factory/specs/active`, not the dogfood findings, not the UI. A `files`
  field cut against the PP-1 table is the mechanism.
- **Native modules.** `better-sqlite3` 13.0.3 publishes prebuilt binaries for
  darwin, linux, linuxmusl and win32 and declares no install script, so
  `npx` compiles nothing on a user's machine. This is the one part of the
  chain that needs no work — worth recording so a later plan does not go
  looking for a build step to add.
- **`engines.node >= 22`** stays, and the plugin must say so before the first
  `npx` rather than after it fails.

## PP-4 — The plugin surface, and the copy that would drift

Mechanically the mapping is small, which is why this item is fourth rather
than first:

| Today | In the plugin |
| --- | --- |
| `.claude/skills/bs/{SKILL.md,wave.md}` | `skills/bs/` |
| `.claude/agents/*.md` (13) | `agents/` |
| `.claude/hooks/guard.sh` | `hooks/` + a `hooks/hooks.json` whose command is `"${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh"` |
| — | `.claude-plugin/plugin.json` (name, version, description, author, license, keywords) |
| — | `.claude-plugin/marketplace.json`, if the plugin is to be installable by URL |

Three things that mapping hides:

**`guard.sh` cannot keep finding its own root.** Line 54 walks two levels up
from `BASH_SOURCE` to reach a clone, and runs `dist/policyHook.js` from it.
Under a plugin, up-two-levels is the plugin root, and `policyHook.js` is
wherever `npx` unpacked the package. The hook has to resolve the CLI the same
way the playbook does, and must degrade the way it already degrades when
`node` is missing: refuse to claim it checked, so every command needs
approval. That existing branch is the right precedent and should not be
weakened to make the port easier.

**The 12 `permissions.deny` rules have no plugin home.** They live in
`.claude/settings.json`, and no official plugin inspected on this machine
ships a `permissions` key — a plugin contributes hooks, not permissions. So
the deny-list either becomes a documented setup step the user applies to
their own settings, or it moves into the layer that *can* travel: `guard.sh`
already returns a decision on `PreToolUse`, and `guardrails.yml` is already
where the rules of this repo are written down. Folding the protected-branch
rules, the history-rewrite rules and the root-deletion rules into the policy
layer makes them portable and testable at once. That is a real design
question and it is a fork, not a detail.

**Two copies of thirteen agent templates.** If the plugin ships `agents/` and
this repo keeps `.claude/agents/`, the factory's own role contracts exist
twice, and `CLAUDE.md`'s first line — *"a second copy is a copy that drifts"*
— stops being true of the repo that wrote it. `AGENTS_DIR` is read at
dispatch for the `<!-- LESSONS:<scope> -->` markers, so the two copies are
not decorative. The plan must pick one source: either the plugin directory is
the only home and this repo consumes its own plugin, or `.claude/` is the
home and the plugin build copies from it as a release step with a check that
fails on divergence. The former is the honest dogfood; the latter is cheaper.

## PP-5 — The key, asked for once

`factory/orchestrator/src/dotenv.ts` is already correct for this and needs no
behavioural change: it never returns, throws or logs a value, and it holds
the rule that matters — *a file never beats the runner*, so an
already-exported name is left alone. What is wrong is only its input.
`DOTENV_PATH` is hard-coded to `REPO_ROOT/.env` (`paths.ts:14`), and under a
plugin there is no clone whose `.env` that could be.

The proposal is a chain, resolved in order and stopping at the first hit per
variable: `process.env` → `<project>/.env` → `$SMITH_HOME/.env`, with
`SMITH_HOME` defaulting to `~/.blacksmith` and the file created `0600`. The
per-user file is what makes the key survive across projects; the project file
is what lets one project override; and the existing precedence rule already
says the shell wins over both.

`/bs setup` is the conversational half: a plugin subcommand that asks, once,
whether the operator wants a second-opinion judge, explains that DeepSeek is
optional and that skipping it costs nothing but the shadow vote, writes the
key to `$SMITH_HOME/.env` if one is given, and then runs
`smith judge preflight` to report which judges this box can reach. Preflight
prints variable *names* and never values, which is exactly the confirmation
an operator needs and the one a log may hold.

Explicitly rejected: storing the key in `.claude/blacksmith.local.md`, the
per-project plugin-settings pattern. That file lives inside the user's repo
tree, and a credential inside a repo tree is a commit waiting to happen.
`docs/standards/guardrails.md` §"Secrets, keys, tokens" is unambiguous — env
only, `.env.example` the only committed env file, code references names and
never values — and this port does not get to make an exception for
convenience. The plugin-settings pattern is for non-secret configuration.

## PP-6 — What the plugin cannot make true

Distribution changes who is running this, and three of the factory's
assumptions are about *whose machine it is*.

- **The guard is advice, not a sandbox.** `guard.sh` refuses commands it can
  parse. It is a `PreToolUse` hook on the user's own machine, running as the
  user, and the agents it guards hold the user's git credentials and run the
  user's test command. That is acceptable for an operator who cloned this
  repo deliberately. It has to be *said*, in the plugin's own README, before
  a user installs it from a marketplace listing.
- **Worktrees are written beside the project.** A plugin user learns that
  their sibling directory acquires `.wt/` checkouts the first time a wave
  runs. Today `AGENTS.md` says so and an operator read it; a plugin user
  reads a marketplace card.
- **Nothing here becomes multi-user.** One `smith.db`, one event log per
  project, `projects.ts` scoping by project and never by user. A plugin
  distributes the factory to many machines; it does not make one machine
  serve many people, and no fork below should be read as asking for that.

## Forks — the operator's to answer before an epic is cut

1. **The npm name.** `blacksmith` if the registry has it,
   `@juzser/blacksmith` otherwise — and does `package.json`'s `name` change
   to match the repo in the same commit?
2. **One repo or two.** Does the plugin live in this repo (a `plugins/`
   subdir, published by a `git-subdir` marketplace source) or in a repo of
   its own? PP-4's drift argument is much cheaper to answer under one repo.
3. **Does this clone migrate?** Blacksmith is run on Blacksmith, so this
   clone is also a project, and its 4.6M of `state/` is the factory's only
   real event corpus. Options: move it to `.blacksmith/` and dogfood the port
   for real; keep `state/` working as a legacy alias so no history moves; or
   support both and carry two spellings forever. The third is the one to
   avoid.
4. **Where do the deny rules go?** A documented setup step, or folded into
   `guardrails.yml` and enforced by the guard (PP-4).
5. **Is the dashboard in scope at all?** `smith ui` binds `127.0.0.1` with no
   auth by architecture §10. It can ship in the plugin as a local-only page,
   or be left out of the first release entirely. Leaving it out shrinks
   PP-3's dependency problem to nothing.

## Out of scope

Named because they were asked about on 2026-09-07 and answered no, so that a
later reader does not reopen them as oversights.

- **Docker, and exposing Blacksmith as a service.** The dashboard and the CLI
  containerise fine; the factory does not. Dispatch is not code — it is
  `.claude/skills/bs/SKILL.md` (1,152 lines) and `wave.md` (259) executed by
  an *interactive* Claude Code session through the `Agent` tool.
  `smith daemon` watches and is forbidden to dispatch (architecture §12). A
  container would hold every deterministic mechanic and nothing that drives
  them. Exposing it additionally requires Claude Code auth inside the
  container, tenant isolation that does not exist, and an authenticated UI
  the architecture deliberately does not have.
- **The Cloudflare port of the UI.** Its own milestone, `cloudflare-port`,
  `status: planned`.
- **A headless dispatch loop.** The thing that would make a container useful.
  It is not this milestone, and it is a much larger one.

## What happens next

This document is the scope. The epic spec —
`factory/specs/active/plugin-port/epic-spec.md`, with acceptance criteria,
claims map, wave shape and budget — is cut after the five forks are
answered, because at least three of them change the task list rather than the
wording of one.
