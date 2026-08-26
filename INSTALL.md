# Installing Black Smith

**This file is a runbook, not a description.** Every step below is a command
with an expected result and a failure branch, so it can be executed top to
bottom — by you, or by a Claude Code session on your behalf.

**To have Black Smith install itself:** open a Claude Code session in the
clone and say *"install Black Smith"*. The session reads
[`CLAUDE.md`](CLAUDE.md), which points it here, and works through
[Part 2](#part-2--the-install-run) step by step. It will stop and ask you
before anything that touches the machine outside the clone.

Black Smith runs **from a clone**, not as a globally installed package. The
event log (`state/events/`), the SQLite projection (`state/smith.db`), and
every worker worktree (`workspaces/`) live inside the checkout —
`factory/orchestrator/src/paths.ts` resolves all of them relative to the repo
root — so put the clone somewhere you're happy to keep it.

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

| Requirement | Why | Needed for |
|---|---|---|
| **Node ≥ 22** | `engines` in `package.json`; ESM + `node:` builtins throughout | everything |
| **pnpm 9.3.0** (lockfile v9 — the version local development runs and CI pins) | install and every `pnpm run` script | everything |
| **git ≥ 2.17** | `worktree add` / `remove` / `list --porcelain` *is* the isolation mechanism | running epics |
| **bash** | `scripts/check.sh` and `.claude/hooks/*.sh` | the check gate + guard hook |
| **python3 + PyYAML** | `check.sh` parses the policy YAML and resolves every schema's `x-taxonomy` reference | the check gate |
| **Claude Code CLI** | the planner and every worker run as Claude Code sessions/subagents | running epics |
| Codex CLI *(optional)* | Phase 8 cross-provider judge — `codex exec --json`, ChatGPT-subscription auth, no API key | only if you enable `codex` |
| `DEEPSEEK_API_KEY` in `.env` *(optional)* | Phase 8 API judge | only if you enable `deepseek` |
| Chromium for Playwright *(optional)* | `pnpm test:e2e` | UI e2e only — see [Known gaps](#known-platform-gaps) |

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

---

## Part 2 — The install run

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
  with no bash on `PATH` the safety hook cannot run at all.
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
git --version       # expect 2.17 or higher
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

**Expect:** the `smith` usage banner listing the command namespaces.

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
mean PyYAML was not found. Neither is a passing install.

### Step 5 — Install the Claude Code CLI

Needed to drive an actual epic: the planner and every worker run as Claude
Code sessions. Follow Anthropic's current install instructions for the
platform you are on, then confirm it is on `PATH`:

```bash
claude --version
```

Without it, the CLI and the gate still work — you simply cannot dispatch the
agents that do the work.

### Step 6 — Link the `smith` command *(optional)*

```bash
pnpm link --global     # or a global install
```

Turns `node factory/orchestrator/dist/cli.js plan validate ...` into
`smith plan validate ...`. Every example in the docs works either way. This
one writes outside the clone, so an agent must ask first.

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

Both providers ship `enabled: false` in
[`factory/policies/crosscheck.yml`](factory/policies/crosscheck.yml) —
**nothing calls an external model until you opt in.** The full procedure,
including shadow-mode calibration before promotion, is
[`docs/runbooks/providers.md`](docs/runbooks/providers.md).

- **Codex** — install the Codex CLI; auth is a ChatGPT subscription, no API
  key.
- **DeepSeek** — put `DEEPSEEK_API_KEY` in `.env`. Copy `.env.example` as the
  starting point. `.env` is gitignored and the event logger redacts
  credential-shaped values before write; never commit a key.

---

## Part 4 — Verify the install

The one command that answers "did this work":

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

Then take the CLI for a walk — [`README.md`](README.md#first-commands) has
real, verified `smith` invocations, and
[`docs/guide/operator-guide.md`](docs/guide/operator-guide.md) is the deep
walkthrough.

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
