# `/bs mcp <project>` — layer the MCP surface on

Every project leaving the factory ships an MCP surface
(`docs/standards/mcp.md`). It is due **late** — at the mandatory
`<project> — mcp surface` milestone, once the tools worth exposing are known.
Running this at `smith new` time would produce a manifest declaring nothing,
which is the rubber stamp the standard exists to prevent.

1. Run `smith mcp init <project>`. It layers `src/mcp/`, `test/mcp/`, and a
   root `mcp.manifest.json` onto the already-scaffolded project, merges the
   `mcp:serve` script and the pinned SDK dependency into its `package.json`,
   and appends the `mcp surface` milestone to `factory/specs/roadmap.md`.
   It refuses if the target has no `package.json` (run `/bs new` first) or if
   a manifest already exists — re-scaffolding would discard declared tools and
   their operator sign-off.
2. The scaffold ships one read-only tool (`project_health`) as the worked
   example. Every tool added after it is **declared in the manifest first**,
   with a mutation class and matching annotations; anything that is not
   `read-only` needs `approval: { operator, date, milestone }` — an operator
   signature, taken at this milestone. Never sign one yourself.
3. Tools that wrap a guardrail-gated action (deploy, outbound send, writes to
   `main`) are not allowed at all (mcp.md MCP-S3). A signed `destructive` tool
   is permission to act inside the project, never a way around an operator
   gate.
4. Run `smith mcp check <project>` before closing anything under that
   milestone. Exit 0 means green; exit 1 prints one `{ rule, path, message }`
   per violation. `smith epic close` runs the same check and refuses while it
   is red — the only way past it is `--override-rationale`, which is the
   operator's call and their name in the event log, never yours.
