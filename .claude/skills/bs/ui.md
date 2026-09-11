# `/bs ui` — serve the local dashboard

`smith ui serve [--port 4680] [--db state/smith.db] [--state-dir …]
[--roadmap-path …]`. If it errors `ui.not-built`, run `pnpm build:ui`
first (builds `ui/server/dist` + `ui/dist`), then retry. Print the local
URL (`http://127.0.0.1:<port>`).

`--roadmap-path` travels with `--db`/`--state-dir`: the read path
re-projects each session on the first request, and that rebuilds the
milestones table from the roadmap file it was given — unset, it falls
back to black-smith's own `factory/specs/roadmap.md`, so a dashboard
pointed at another project's db would show this repo's roadmap.
