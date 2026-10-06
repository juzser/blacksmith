# `/bs ui` — serve the local dashboard

`bs ui serve [--port 4680] [--db state/smith.db] [--state-dir …]
[--roadmap-path …] [--claude-config-dir …] [--store <dir>…]`. If it errors `ui.not-built`,
run `pnpm build:ui` first (builds `ui/server/dist` + `ui/dist`), then retry,
and print the local URL (`http://127.0.0.1:<port>`).

Besides the event log, the server reads — read-only — the local Claude Code
session registry, transcripts and prompt history, from `--claude-config-dir`, else
`$CLAUDE_CONFIG_DIR`, else Claude Code's default, and serves them as
`GET /api/cli-sessions`, loopback-only.

Home, Kanban and the project list also read every project with a live CLI
session: its git toplevel is a store when `<top>/.blacksmith/state/events` or
`<top>/state/events` exists (rechecked at most every 5 s), and `--store <dir>`
adds one by hand. Foreign stores are strictly read; their projection lives in
`state/ui-stores/<storeId>.db` of the served clone, kept for a grace period after a
store drops and pruned at startup when stale. In a foreign store an untagged row reads
as the store's label, any other explicit project as itself, so `?project=X` returns each
matching row once. These routes and `/api/tasks/*` are local-only, like
`/api/cli-sessions`. A foreign Kanban card opens through `?store=<storeId>`; its history,
artifacts and waivers stay empty. Details: `docs/guide/dashboard.md`.

**That build needs a clone.** `ui/` is not in the package's `files`, so an
install — npm or plugin — ships no dashboard at all and `ui.not-built` is the
permanent answer there, not a stale build. Check before you advise: if there
is no `ui/` beside the `bs` you are running, say the dashboard is
clone-only and stop, rather than sending the operator to a `pnpm` script they
do not have.

`--roadmap-path` travels with `--db`/`--state-dir`: the read path
re-projects each session on the first request, and that rebuilds the
milestones table from the roadmap file it was given — unset, it falls
back to Blacksmith's own `factory/specs/roadmap.md`, so a dashboard
pointed at another project's db would show the factory's roadmap.
