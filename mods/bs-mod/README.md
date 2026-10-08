# bs-mod

The live HUD for Blacksmith: what your epic is doing, above the Claude Code
prompt. It is optional. Blacksmith runs the same without it.

```
/plugin marketplace add juzser/blacksmith
/plugin install bs-mod@blacksmith
```

bs-mod is a Claude Code plugin module, not skills or agents. It needs a
Claude Code build that loads plugin modules. It was written and tested on
2.1.292, and no older build has been checked. `claude plugin details bs-mod`
shows it once installed.

## What it shows

- **The band** sits above the prompt in every session. It starts with a blank
  row and a separator, then a row of tabs.
  - With an epic in view, the band has four tabs.
    - **Overview** shows active agents, tasks done, budget, the current wave
      or phase, and the epic's tier. Its tab and labels are soft white under Mocha and Latte, and the theme's grey otherwise.
    - **Current** shows the work in flight. One head row carries the wave
      or phase, a progress bar with tasks done, the live agents and the
      spend against the cap. Below it, a **Tasks** section lists the wave's
      tasks in aligned columns (status, id, title, role, time), and a
      **Prompts** section shows the two newest prompts you gave for it.
    - **Next** shows what comes next, with the same Tasks and Prompts
      sections.
    - Active work is marked in teal, in the bar, the tallies and the task
      marks.
    - **Past** shows what is done, grouped by the wave that merged it.
  - The letters `o`, `c`, `n` and `p` switch tabs while the band has focus.
  - With no epic, the band is idle. It shows this session's agent count and a
    hint to pin an epic.
  - The band stacks over other plugins' bands rather than hiding them.
- **The pane** gives the full view of one epic.
- **Toasts** report a wave admitted, a gate failure, a merge, a waiver
  pending, an escalation, an error above minor severity, a spec change
  proposed, and the epic closing. They come from this session's epics and a
  pinned one, never from a watched one. The log a session starts on, and any
  event older than two minutes, never toasts, so opening a session on a long
  log stays quiet.
- **Colors.** The band and the pane color by meaning in Catppuccin pastels:
  Mocha under a dark `/config` theme (`dark-ansi` too), Latte under a light
  one. A daltonized theme, `auto`, or a theme the HUD cannot read keeps the
  terminal theme's own colors, with active work in teal. Neutral body text stays in
  the theme's colors. The Overview tab, its labels and the Tasks and Prompts
  dividers take a soft white under Mocha and Latte, and the theme's `inactive`
  grey otherwise. Changing the theme repaints
  the HUD at once.
- **Watching.** Normally the HUD follows the epics whose events name this
  session. When nothing is pinned and the session has no such epic, it
  watches the newest running epic under the session's own roots instead, and
  sends no toasts for it.

## The command

| Command | Does |
|---|---|
| `/bs-mod` | Opens the pane on the epic in view. |
| `/bs-mod <epic-id>` | Pins that epic and opens its pane. It refuses an id with no event log under the known roots. |
| `/bs-mod auto` | Drops the pin, so the HUD follows this session again. |
| `/bs-mod off` / `/bs-mod on` | Hides or shows the band. |

## Where it looks for event logs

It reads Blacksmith's `state/events/*.jsonl` directly, a few lines at a time.
It looks in these directories:

- `$BS_HOME/state/events` and `$SMITH_HOME/state/events`, each when the
  variable holds an absolute path.
- `<cwd>/state/events`. A clone writes its logs into itself.
- `<cwd>/.blacksmith/state/events`. This is where `bs init` puts a project's
  logs.
- Roots learned from Bash commands the session runs. A command that sets
  `BS_HOME`/`SMITH_HOME`, or that runs a clone's
  `factory/orchestrator/dist/cli.js`, teaches the mod that root's
  `state/events`. It keeps up to 20 learned roots.

The first three entries are the session's own roots. A learned root is shared by
every session, so the HUD searches only its own roots for an epic to watch.

## Developing it

Load this checkout's copy into one session. This installs nothing:

```bash
claude --plugin-dir "$PWD/mods/bs-mod"
```

From the repo root, three checks cover the mod:

```bash
claude plugin validate mods/bs-mod   # manifest, hooks.json, what register.tsx reads and writes
claude plugin test mods/bs-mod       # hooks/*.test.ts, in Claude Code's own test runner
pnpm exec tsc -p mods/bs-mod         # types; needs .claude-plugin/types/
```

Claude Code generates `.claude-plugin/types/` when a session loads the mod:
the engine's API types and the base `tsconfig.json` this folder extends. The
folder is gitignored, so load the mod once with `--plugin-dir` before the
type check.

`scripts/check.sh` runs the first two checks whenever `claude` is on PATH.
CI has no `claude`, so there they print `SKIP`. The marketplace wiring is
checked in CI anyway, by `factory/orchestrator/test/pluginManifest.test.ts`.
The repo's vitest does not run this folder's tests, and Biome and the
tsconfigs leave it out: its tests import Claude Code's own test kit, which
only its runner provides. The repo-wide guards still read it, so its prose
stays in English like the rest of the repo.

`types/index.d.ts` is the mod's own contract for the state it keeps. It is
committed, unlike `.claude-plugin/types/`.

A release bumps `.claude-plugin/plugin.json`'s `version` together with the
package's. A test enforces that. An installed plugin updates only when that
string changes.
