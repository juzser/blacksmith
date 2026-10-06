# `/bs ui` — serve the local dashboard

`bs ui serve [--port 4680] [--db state/smith.db] [--state-dir …]
[--roadmap-path …] [--claude-config-dir …]`. If it errors `ui.not-built`,
run `pnpm build:ui` first (builds `ui/server/dist` + `ui/dist`), then retry,
and print the local URL (`http://127.0.0.1:<port>`).

Besides the event log, the server reads — read-only — the local Claude Code
session registry and transcripts, from `--claude-config-dir`, else
`$CLAUDE_CONFIG_DIR`, else Claude Code's default, and serves them as
`GET /api/cli-sessions`, loopback-only.

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
