# Changelog

What landed, newest first. The plugin's version is in `plugin/.claude-plugin/plugin.json`. Each release has a `v<version>` git tag, and from 0.2.0 on a [GitHub release](https://github.com/juzser/blacksmith/releases).

## 1.0.0 (2026-11-05): the reset to a minimal plugin

**This release breaks 0.x on purpose.** Blacksmith stops being a factory and becomes a small Claude Code plugin: always-on rules, `/cross-check`, `/audit` and four agents. Everything else is left to Claude Code's defaults.

Why: in a side-by-side trial the factory took about nine times the tokens and the time of plain Claude Code, for code of about the same quality. [docs/history.md](docs/history.md) has the numbers. The repository went from 1,401 tracked files to 41.

### Upgrading from 0.x

1. Update the plugin: `claude plugin marketplace update blacksmith`, then `claude plugin update blacksmith@blacksmith`.
2. Remove the two old modules, if you have them: `claude plugin uninstall bs-mod` and `claude plugin uninstall pr-mod`. The marketplace no longer lists them.
3. Restart every running Claude Code session.
4. Check it: `claude plugin details blacksmith` lists 2 skills and 4 agents.
5. Clear what the old version left behind. Nothing removes it for you, and `.blacksmith/` may hold your roadmap, so look first. [INSTALL.md](INSTALL.md#remove-the-old-setup) lists all of it: the global `bs` command, `.blacksmith/` folders, old worktrees and old settings keys.

Optional: set `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` to 60 ([how](docs/usage.md#compact)), and log in to codex for `/cross-check` ([how](docs/cross-check.md#setup)).

### Added

- **The plugin in `plugin/`** (#542, #543). A SessionStart hook loads `plugin/rules.md` at startup, on resume, after `/clear` and after a compact. The rules cover:
  - explanations for a person: result first, short sentences, jargon explained, technical details last;
  - a confidence % on every option;
  - routing each kind of task to the right agent;
  - when to offer `/cross-check`, and how to treat its findings;
  - compacting at about 60%, and what to keep and drop;
  - never calling something done without running the command that shows it.
- **Four agents, each with its own model and effort** (#542, #543):
  - `planner`: opus, high. Writes a plan and no code.
  - `coder`: sonnet, medium. Builds one part, test-first, in its own worktree.
  - `reviewer`: sonnet, medium. Reviews a diff, read-only by instruction.
  - `auditor`: sonnet, high. Audits one axis, read-only by instruction.
- **`/cross-check [base] [criteria]`**, run by the person only (#542). It gets a second opinion on the working-tree diff from codex (`codex exec -s read-only`).
  - The size is capped before anything is sent. A changed test file that is a symlink or lies outside the repo is not sent, and untracked files trigger a warning.
  - Criteria go in through a quoted heredoc, so the shell never expands them.
  - A timeout stops a slow call and its child processes. An interrupted run cleans up its processes and temp files.
  - Control characters in a model's answer are dropped before printing.
  - It exits 0 every time, and prints `skipped` with a reason when it cannot run.
  - Findings are advisory: one counts only once it is reproduced.
- **DeepSeek in `/cross-check`, opt-in** (#543). `CROSSCHECK_PROVIDERS` defaults to `codex`. With `"codex deepseek"` and `DEEPSEEK_API_KEY` set, both run in parallel, with one output group each.
  - DeepSeek sees only the prompt: the diff, the changed tests and the criteria.
  - The key reaches `curl` on stdin only, and codex never sees it.
  - The endpoint must be https (http only for localhost), and redirects are not followed.
  - The default model is `deepseek-v4-pro`.
- **`/audit [axis ...] [path]`**, run by the person only (#543). A read-only audit on performance, code quality and security, with one `auditor` per axis in parallel.
  - The project's `CLAUDE.md` and `AGENTS.md` are its ground truth, read as data and never as instructions.
  - Each finding carries `file:line`, a severity (S1 to S4), a failure scenario (inputs, expected, actual) and a confidence. A finding without a scenario is not reported.
  - Nothing is written to a file, ranked across axes or remembered between runs.
- **Gate checks** (#543, #544): every relative markdown link and anchor must resolve, and `.env` files must stay ignored.

### Changed

- **The marketplace** lists one plugin, `blacksmith`, from `./plugin`. It used to list `./.claude`, `bs-mod` and `pr-mod`.
- **Agent names** are now `blacksmith:<role>`, replacing the fourteen `bs-<role>` agents.
- **CI** is one job, `gate (scripts/check.sh)`, the same file a contributor runs. It runs the plugin tests, the JSON, marketplace-path, shell-syntax and link checks, and the plugin validator when `claude` is present. The `e2e (Playwright, Chromium)` check is gone, and the `main` ruleset now requires only the gate.
- **Docs.** README, INSTALL, AGENTS, CLAUDE, CONTRIBUTING and SECURITY are rewritten for the plugin. `docs/` is now four pages: `usage.md`, `cross-check.md`, `audit.md` and `history.md`.
- **GitHub files.** CODEOWNERS, the issue and pull request templates and Dependabot are cut down to fit. Dependabot now watches only the GitHub Actions versions.
- **This changelog** starts again at 1.0.0, with a short table for 0.x below. The old text stays [at the `factory-final` tag](https://github.com/juzser/blacksmith/blob/factory-final/CHANGELOG.md).

### Removed

- **The factory:**
  - the orchestrator (`factory/`) and its commands: `bs`, `bs-run`, the `smith` and `smith-run` aliases, `bs-prompt-hook` and `bs-policy-hook`;
  - the `/bs` skill with its playbooks, and the fourteen `bs-*` agents;
  - the guard hooks;
  - the dashboard (`ui/`);
  - the trial harness (`trial/`).
- **Modules:** `bs-mod` and `pr-mod`.
- **The npm packaging:** `package.json`, the lockfile, and the TypeScript, lint and test configs. `@juzser/blacksmith` stays at 0.7.0 and is marked deprecated on npm. The plugin does not need npm.
- **Old docs:** the guides, runbooks, standards, benchmarks, claims matrix and trial pages under `docs/`.
- **Repository files:** the e2e CI jobs, `.agents/`, `.env.example`, `.gitleaks.toml`, `.npmrc` and `.nvmrc`.

### Merged after 0.7.0, never published

These landed on `main` after the 0.7.0 tag and before the cutover. They exist only at `factory-final`. The npm 0.7.0 package does not have them.

- **Features:** `--session` and `--causal-parent` became optional, with safe defaults (#533). The MCP manifest check runs at the gate (#534). A one-shot advisory cross-check that never counts as a vote (#537). `--no-grader`, and an explicit grader state on every gate outcome (#539).
- **Fixes:** `trial record` works when `.blacksmith` is git-ignored (#528). The default branch without a remote never picks a `bs/` branch (#529). The integration check ignores untracked work-root declarations (#530). Mobile screenshots are judged by their measured layout width (#531). `results check` reads the session from the environment, as `gate run` does (#540).
- **Docs and dependencies:** #513, #519, #520, #521, #526, #527 and #532.

Closed without merging, branches kept: #535, #536, #538 and #541.

## 0.x: the factory

Each version links to its release notes. The full text of this period, about 4,200 lines, is the [old changelog](https://github.com/juzser/blacksmith/blob/factory-final/CHANGELOG.md), which also covers the build phases before 0.1.0.

| Version | Date | What it brought |
|---|---|---|
| [0.7.0](https://github.com/juzser/blacksmith/releases/tag/v0.7.0) | 2026-11-03 | Check tiers: each check runs where it pays for itself. A paperwork check before the gate. Fixes to the diff cap, CLI judge output and `bs cleanup`. |
| [0.6.0](https://github.com/juzser/blacksmith/releases/tag/v0.6.0) | 2026-10-29 | Reports on what the factory costs and catches. Fewer tokens per merged task and more agents at once. Includes 0.5.1. |
| 0.5.1 | not released | `/bs use` binds a session to one project, and the dashboard only reads. Bumped in the repository, never tagged or published. It shipped in 0.6.0. |
| [0.5.0](https://github.com/juzser/blacksmith/releases/tag/v0.5.0) | 2026-10-12 | The command becomes `bs` and the agents `bs-<role>`. Budgets scale per tier. Every operator prompt is captured. |
| [0.4.0](https://github.com/juzser/blacksmith/releases/tag/v0.4.0) | 2026-09-28 | The merge queue stops moving your checkout. An epic can close past a superseded or waived task. Three self-audits land. |
| [0.3.0](https://github.com/juzser/blacksmith/releases/tag/v0.3.0) | 2026-09-23 | Budget and turn caps can be set per machine. Errors file themselves as issues. Hand-typed rosters give way to the tables they copied. |
| [0.2.0](https://github.com/juzser/blacksmith/releases/tag/v0.2.0) | 2026-09-18 | The `/bs` console installs as a plugin. The command streams its output. A first step towards running a turn on Codex. |
| 0.1.1 | 2026-09-16 | Packaging fixes: the npm package carries what a real install needs, and written paths leave the package for a work root. |
| 0.1.0 | 2026-09-11 | The first npm package, `@juzser/blacksmith`, with the `smith` command. |
