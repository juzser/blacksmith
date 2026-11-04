# pr-mod

The open pull requests of the repo your Claude Code session stands in, in a
pane and a line above the prompt. It is optional. Blacksmith runs the same
without it.

```
/plugin marketplace add juzser/blacksmith
/plugin install pr-mod@blacksmith
```

pr-mod is a Claude Code plugin module, not skills or agents. It needs a
Claude Code build that loads plugin modules, and the `gh` CLI signed in to
GitHub. `claude plugin details pr-mod` shows it once installed.

## What it shows

- **The band** is one line above the prompt: `PR 4 open`, then the counts
  that are not zero: green, CI red, conflict and pending. It shows only while
  a PR is open, marks itself `stale` when the last read failed, and stacks
  over other plugins' bands rather than hiding them.
- **The pane** (`/pr-mod`) lists every open PR, the ones this session created
  with `gh pr create` first, then the newest. A header row carries the repo,
  the number open and how long ago it was fetched, with a Refresh button.
  Each row shows the PR number, its title, its CI state and its merge state.
- **Toasts** report a PR whose CI went red, a new conflict with its base, CI
  turning green or a PR leaving the list on one this session created, and the
  outcome of a button you pressed.
- **Colors.** The band and the pane use Catppuccin pastels:
  Mocha under a dark `/config` theme (`dark-ansi`
  too), Latte under a light one, and the theme's own colors under a
  daltonized theme, `auto`, or one it cannot read. Green is success, red is
  failure, yellow is pending or a conflict. Labels and secondary text are
  soft. Changing the theme repaints at once.

## The pane's actions

| Button | Does |
|---|---|
| Refresh | Reads the PR list now. It is read every 60 s while a PR is open or the pane is shown. |
| Merge | Merges the PR with the repo's first allowed method (squash, merge, rebase). See the gate below. |
| Update branch | Runs `gh pr update-branch`, on a PR that is behind its base. |
| Fix conflict | Sends a prompt into this session asking it to merge the base into the PR's head and resolve the conflict. |
| Fix CI | Sends a prompt into this session naming the failing checks and their runs. |
| Open | Copies the PR's URL and shows it in a toast. |

The fix buttons do not run anything themselves: they submit a prompt into
this session, which you can read and which does the work. After one is sent
it reads `fix sent` until the PR's head moves or 15 minutes pass.

## The merge gate

Merge shows only when the PR can be merged cleanly:

- CI is all green,
- the merge state is `CLEAN`,
- the PR is not a draft,
- and the repo allows a merge method.

Pressing it once only arms it: the button reads `Confirm merge #N (method)`
for 8 seconds. A second press in that window runs `gh pr merge`. Any other
state hides the button, and the row says why where it can, for example a
review that is still required.

## Install, upgrade, turn off

Install from the marketplace (see the top), then start a new session;
`claude plugin details pr-mod` shows what was installed. To try a checkout's
copy in one session without installing anything:

```bash
claude --plugin-dir "$PWD/mods/pr-mod"
```

**Upgrade.** An installed plugin stays on its copy until the `version` in its
manifest changes, which happens at a release:

```bash
claude plugin marketplace update blacksmith
claude plugin update pr-mod@blacksmith
```

**Turn off.** `claude plugin disable pr-mod`, then start a new session.

## When it does not show

- **No band at all.** That is by design while no PR is open. Otherwise the
  plugin is not installed or enabled, or the session started before the
  install. A Claude Code build that does not load plugin modules shows
  nothing: check `claude --version`.
- **`/pr-mod` says the directory is not a GitHub repo.** The session must
  stand in a repo with a GitHub remote. `gh auth status` says whether `gh` is
  signed in.
- **The band shows `stale`.** Its last read of the PR list failed, and the
  pane shows the error. It reads again every 60 s while a PR is open or the
  pane is shown, and Refresh reads at once.

## Developing it

From the repo root, two checks cover the mod. `bash scripts/check.sh` runs
both whenever `claude` is on PATH; CI has none, so there they print `SKIP`:

```bash
claude plugin validate mods/pr-mod   # manifest, hooks.json, what register.tsx reads and writes
claude plugin test mods/pr-mod       # hooks/*.test.ts, in Claude Code's own test runner
```

Claude Code generates `.claude-plugin/types/` when a session loads the mod
(the folder is gitignored). The tests fake `$.process.run`, so none of them
calls `gh`. This mod's version is its own: a release bumps
`.claude-plugin/plugin.json`.
