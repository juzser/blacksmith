# `/bs new <project> [--ui]` — scaffold a target project

1. Ask where the project should live, then run `smith new <project> [--ui]
   [--target-dir <dir>]`. Without `--target-dir` it lands beside this repo, in
   `<repo-parent>/<project>`, which is a default rather than a requirement —
   the answer becomes the `<project-dir>` every later command takes, so take
   it here rather than assuming it six steps in. The call
   copies `factory/scaffold/` (TS strict, Biome, Vitest, CI) and layers
   whatever `factory/policies/stack.yml` answered for: `--ui` adds the
   frontend, generates `src/styles/main.css`, and vendors the named design
   system into `design/` if there is one. Then it installs and runs the
   project's own gates, commits it on a `setup` branch, and registers a
   bootstrap milestone in `factory/specs/roadmap.md` — all in one call.
   An answer the templates cannot build (`frontend: react`) makes it **refuse
   before creating anything**, rather than quietly handing over the frontend
   they do ship. `smith stack check` says in advance which answers are
   honoured, merely recorded, or refused.
2. The gate run is `pnpm install` then `lint`, `typecheck`, `test:coverage`,
   `build` — `ci.yml`'s order, so the lockfile lands in the first commit and no
   epic ever needs a serial `task-0-toolchain` (P9-19). It takes a minute or
   two. Read `toolchain` in the JSON result:
   - `verified` — every gate passed; plan the first epic against it.
   - `failed` — `failedStep` names the gate, its `output` is the tail, and
     `command` is the exact line to re-run by hand. The command exits **1** and
     the tree is left in place to fix. Do not plan an epic against it.
   - `skipped` — only when `--skip-toolchain` was passed (offline). Nothing was
     proven; say so rather than reporting a green.
3. The JSON result's `commands.ghRepoCreate` and `commands.push` are for the
   **operator to run themselves** — never execute them from this session
   (guardrails.md: only the operator pushes a brand-new remote/creates the
   repo; this skill only prints what to run).
4. Tell the operator: target dir, branch (`setup`), the `toolchain` verdict, and
   the two commands.
