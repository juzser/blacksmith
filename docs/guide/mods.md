# Mods

A mod is a Claude Code plugin module, not skills or agents: Claude Code loads
its code from the plugin's `hooks/hooks.json`. This repository has two, each
in its own folder under `mods/`. Both are optional, and Blacksmith runs the
same without them.

Neither is in the npm package. Each installs from this repository's plugin
marketplace, the same one that lists the `blacksmith` plugin.

## bs-mod

The live HUD. A band above the prompt shows the epic in view, and a pane and
toasts give the rest. [`mods/bs-mod/README.md`](../../mods/bs-mod/README.md)
has what each tab shows and the `/bs-mod` commands.

## pr-mod

The open pull requests of the repo the session stands in, as a one-line band
of counts above the prompt and a `/pr-mod` pane that can merge, update a
branch or send a fix prompt.
[`mods/pr-mod/README.md`](../../mods/pr-mod/README.md) has the pane's actions
and the merge gate.

## What each needs

| | bs-mod | pr-mod |
|---|---|---|
| Claude Code | A build that loads plugin modules. Written and tested on 2.1.292; no older build has been checked. | A build that loads plugin modules. |
| Other | Blacksmith's event logs, in a place it looks (below). Its prompt lines also need the prompt recorder. | The `gh` CLI signed in to GitHub, and a session that stands in a repo with a GitHub remote. |

## Where bs-mod gets its data

bs-mod reads Blacksmith's event logs directly. The README lists
[the directories it looks in](../../mods/bs-mod/README.md#where-it-looks-for-event-logs).
It also asks the prompt recorder's entry which store the session's directory
belongs to, once per session and directory, so a checkout whose store sits
elsewhere is still found. With no entry, it skips that step.

The prompt lines are `user_prompt` events:

- The idle band shows this session's two newest prompts. They come from the
  session's own prompt log in the store.
- The **Prompts** section on Current and Next shows the prompts given for the
  epic: those in the epic's own log, and those its events cite.

The blacksmith plugin's recorder writes those events. Its `hooks/hooks.json`
runs one script on each prompt you submit and each option you pick. The
script runs `$BS_PROMPT_HOOK` when you set it (a clone does), else
`bs-prompt-hook` on `PATH` (a global install has it). It writes only when the
session's directory belongs to a Blacksmith store: for example a project where
`bs init` ran, a clone, a worktree of either, or any directory when `BS_HOME`
names a store that exists. INSTALL.md has
[the recorder and how to set it up](../../INSTALL.md#the-install--bs-and-bs).

With nothing recorded, the band still draws. The idle band has no prompt
rows, and Current and Next have no **Prompts** section.

## Install, upgrade, turn off

The released copy, for every session on this machine:

```
# inside Claude Code
/plugin marketplace add juzser/blacksmith
/plugin install bs-mod@blacksmith
/plugin install pr-mod@blacksmith
```

The last two lines are one mod each: take either or both. Then start a new
session. `claude plugin details bs-mod` (or `pr-mod`) shows what was
installed.

To try a checkout's copy in one session without installing anything, start
that session from the checkout's root with `--plugin-dir`:

```bash
claude --plugin-dir "$PWD/mods/bs-mod" --plugin-dir "$PWD/mods/pr-mod"
```

The flag repeats, once per mod; keep the ones you want.

**Upgrade.** An installed plugin stays on its copy until the `version` in its
manifest changes, which happens at a release. Re-fetch the marketplace, update
the plugin, and start a new session:

```bash
claude plugin marketplace update blacksmith
claude plugin update bs-mod@blacksmith
```

**Turn off.** `/bs-mod off` hides the band, and `/bs-mod on` brings it back.
To remove a mod from your sessions, disable the plugin and start a new
session:

```bash
claude plugin disable bs-mod
```

## When it does not show

- **No band at all.** The plugin is not installed or enabled, or the session
  started before the install: start a new session. bs-mod hidden with
  `/bs-mod off` comes back with `/bs-mod on`. A Claude Code build that does
  not load plugin modules shows nothing; check `claude --version`.
- **bs-mod is idle while an epic runs.** The band follows the epic this
  session drives, or the one you pinned. Pin another session's epic with
  `/bs-mod <epic-id>`. If that says no event log was found, the logs sit under
  no directory bs-mod knows: start the session with `BS_HOME` set to the
  absolute path of their store.
- **bs-mod has no prompt lines.** Nothing was recorded for this session or
  epic. See [Where bs-mod gets its data](#where-bs-mod-gets-its-data).
- **No pr-mod band.** That is by design while no PR is open. `/pr-mod` says
  when the directory is not a GitHub repo, and `gh auth status` says whether
  `gh` is signed in.
- **pr-mod shows `stale`.** Its last read of the PR list failed, and the pane
  shows the error. It reads again every 60 s while a PR is open or the pane is
  shown, and Refresh reads at once.
