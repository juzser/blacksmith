# MCP Surface Standard

> Every project Blacksmith ships exposes an MCP surface, declared at a
> mandatory `<project> — mcp surface` milestone near the end of the roadmap.
> Compiled from the operator decisions of 2026-08-07: **stdio by default,
> HTTP a declared opt-in**; **hard gate at epic close**, with an operator
> override; **read-only tools by default**, everything else declared and
> signed off. The rule ids below (MCP-P1, MCP-T4, …) are the contract:
> `factory/orchestrator/src/mcp.ts` reports them as violations,
> `factory/specs/schema/mcp-manifest.schema.json` encodes the shape half, and
> the scaffold's error messages quote them. Change a rule here and those
> change in the same commit.

## Why an MCP surface at all

A project that leaves this factory is going to be operated by agents, not
only by people. Without a declared surface that happens anyway — through
shell access, ad-hoc scripts, and whatever the agent can reach. The manifest
is the alternative: **one file an operator reads to know exactly what an
agent can do with this project**, and a server that cannot do anything the
file does not admit.

The surface is due at the *end* of a project, not at `smith new`. Scaffolding
it on day one would produce a manifest declaring nothing — a rubber stamp,
which is the failure mode this standard exists to prevent. `smith mcp init`
is therefore its own command, run when the tools are known.

## Protocol

- **MCP-P1 — Pin the wire revision.** `protocolRevision` is `2025-11-25`.
  That is what the Tier-1 TypeScript SDK actually negotiates
  (`@modelcontextprotocol/sdk@1.30.0`, the only published dist-tag as of
  2026-08-07, reports `LATEST_PROTOCOL_VERSION: '2025-11-25'`). The newest
  revision on paper is `2026-07-28`; pinning it today would produce a
  standard nothing can build. See *Forward compatibility*.
- **MCP-P2 — Declare identity.** `name` (conventionally the project name) and
  a semver `version`. Clients cache a tool surface against the version, so a
  surface change is a version bump.
- **MCP-P3 — No session-shaped state.** A connection is self-contained. The
  server keeps nothing that must survive a reconnect, and nothing in a tool's
  behaviour depends on the `initialize`/`initialized` handshake or on
  `Mcp-Session-Id`. Both disappear in `2026-07-28`; a surface written this way
  migrates with a version bump instead of a rewrite. *Not decidable from the
  manifest — enforced in review of `src/mcp/`.*
- **MCP-P4 — Typed input, always.** Every tool declares an input schema, so
  unvalidated arguments never reach tool code and a wrong argument type comes
  back as a tool error rather than a crash. The scaffold's `surface.test.ts`
  asserts exactly this for the shipped tool.

## Transport

- **MCP-X1 — stdio is the default.** `transport.kind` is `"stdio"` unless a
  project has argued its way out of it. stdio opens no port and limits reach
  to the MCP client that spawned the process, which is what the spec
  recommends for locally-run servers and what makes the rest of this section
  mostly unnecessary.
- **MCP-X2 — HTTP sits behind an authenticating proxy.** The Streamable HTTP
  opt-in requires `transport.access.cloudflareAccess: true`. Nothing is
  exposed beyond localhost without something that authenticates in front of
  it. The field is named for the proxy this repo was built against; it is the
  one place the stack interview's `hosting` answer is not yet honoured, and it
  is a deliberate hardcode rather than an oversight — see the note in
  [stack.md](stack.md).
- **MCP-X3 — HTTP is an OAuth 2.0 protected resource, declared precisely.**
  `resourceServer` names an https `canonicalUri` (the token audience), at
  least one https `authorizationServers` issuer, and
  `resourceIndicators: true`. RFC 8707 resource indicators are what bind an
  issued token to *this* server rather than to whoever asks next; the `iss`
  returned in the authorization response is validated against the declared
  issuers (RFC 9207) to close the mix-up attack. Scopes are minimized —
  `*`/`all`/`full-access` defeats the point of asking.
- **MCP-X4 — Token passthrough is never allowed.** `tokenPassthrough: false`
  is the only accepted value. The server MUST NOT accept any token that was
  not explicitly issued for its own canonical URI. A server that forwards a
  client's token to a downstream API is a confused deputy with an audit trail
  pointing at the wrong principal.
- **MCP-X5 — A state handle is not an identity.** Session ids and OAuth
  `state` values are non-deterministic and bound to a user identity; the
  server MUST NOT treat possession of one as authentication. *Not decidable
  from the manifest — enforced in review.*
- **MCP-X6 — No SSRF surface in discovery.** Metadata and discovery fetches
  never follow a client-supplied URL, and outbound requests block link-local
  and cloud metadata addresses. *Not decidable from the manifest — enforced
  in review.*

## Tools

Read-only is the default and the only class that ships without a signature.

- **MCP-T1 — read-only means read-only.** A `read-only` tool annotates
  `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`.
- **MCP-T2 — mutation class and annotations agree.** Every tool declares
  `mutation` as one of `read-only | write | destructive | outbound`. A
  `write`/`destructive`/`outbound` tool annotates `readOnlyHint: false`; a
  `destructive` tool annotates `destructiveHint: true`. A read-only tool with
  `destructiveHint: true` is a contradiction, not a nuance. The
  implementation passes the same class to `requireDeclaredTool()`, so a tool
  that quietly starts writing fails to boot instead of shipping under its old
  declaration.
- **MCP-T3 — outbound is marked open-world.** A tool that reaches anything
  outside this project's own state declares `mutation: "outbound"` and
  `openWorldHint: true`. guardrails.md's "no autonomous outbound sends" is
  unchanged by this — see MCP-S3.
- **MCP-T4 — Anything not read-only carries an operator signature.**
  `approval: { operator, date (YYYY-MM-DD), milestone }`, recorded at the
  `mcp surface` milestone. A person decided, on a date, that an agent may do
  this unattended. Unsigned non-read-only tools fail the gate and the server
  refuses to register them.
- **MCP-T5 — The manifest is exhaustive.** Tool names are snake_case
  (`^[a-z][a-z0-9_]{2,63}$`) and unique. The server registers exactly the
  declared tools and nothing else — a server that can do more than the
  manifest admits makes the manifest a lie, which is worse than having none.

## Server behaviour

- **MCP-S1 — Nothing leaves unredacted, and stdout belongs to the protocol.**
  Every tool result, error string, and stderr diagnostic passes through the
  scaffold's `redact()` before it is written. Credential-shaped values and
  secret-looking keys are replaced. A stray `console.log` corrupts the stdio
  stream; an un-redacted one leaks. This is guardrails.md's "No secrets in
  outputs" applied to a surface an agent can call in a loop.
- **MCP-S2 — Credentials never arrive as arguments.** No tool takes a token,
  key, or password as an input parameter. The server reads what it needs from
  its own environment (guardrails.md: "Env only, never committed"), so a
  credential is never in a tool call that gets logged, replayed, or shown to
  a model. *Not decidable from the manifest — enforced in review.*
- **MCP-S3 — Guardrail-gated actions are not tool-shaped.** Anything that
  requires per-invocation operator approval — `wrangler deploy`, production
  commands, outbound sends, webhook registration, writes to `main` — MUST NOT
  be wrapped in an MCP tool. A signed `destructive` tool is permission to act
  inside the project, never a way around an operator gate. *Not decidable from
  the manifest — enforced in review.*

## Enforcement

1. **`smith mcp init <project>`** layers `factory/scaffold/mcp/` onto an
   already-scaffolded project (`src/mcp/`, `test/mcp/`, root
   `mcp.manifest.json`, plus an `mcp:serve` script and the SDK dependency),
   and appends the `<project> — mcp surface` milestone to
   `factory/specs/roadmap.md`. Registering the milestone is what makes the
   surface *due*. The milestone is written with
   `- epics: [<project>-mcp-surface]`, not an empty list: that list is the key
   step 4's gate reads, and seeding it empty is what once left the gate
   unreachable (see the Status note below).
2. **The milestone is mandatory** and closes before the project's final
   milestone. A project reaching its last milestone without one is not
   finished. `checkRoadmapMcpMilestone()` decides this from roadmap.md:
   - **MCP-M1 — The milestone exists.** The project declares a
     `<project>-mcp-surface` milestone. Another project's does not count.
   - **MCP-M2 — It is not the one left open.** Once every *other* milestone of
     the project is `completed`, this one being anything but `completed` is a
     violation. It stays quiet while other work is still open, because a
     surface pending mid-project is the normal case, not a defect.

   Both rules are reachable **only** through step 3's standalone command. No
   gate runs them, so "closes before the project's final milestone" is a rule
   the standard states and nothing enforces — see step 4 for why the
   epic-close gate is the wrong host, and `dogfood-mcp-close.md`'s D-115 for
   the gate that would be the right one.
3. **`smith mcp check <project>`** renders the verdict — `checkManifest()`'s
   violations plus MCP-M1/M2 — as `{ rule, path, message }` with the ids
   above, and **exits 1 when any of them fire** so CI needs no output parsing.
   A project with no `mcp.manifest.json` at all is refused
   (`mcp.no-surface`), not reported as a red: "your surface is broken" and
   "you have no surface" are different answers, and collapsing them would let
   `smith mcp init` be skipped and then waived away as one more violation.

   **Which checkout it grades** (D-133): `--target-dir` if given, else the
   checkout the caller is standing in — `workspaces/<project>` or any
   `workspaces/.wt/<project>/<task-id>` — else, when more than one checkout
   exists and the cwd is inside none of them, it refuses with
   `mcp.ambiguous-target` and names every candidate. `workspaces/<project>` is
   assumed only when it is the only one. The report carries `targetDir` and
   `targetSource` so a verdict names its subject: during an epic the two
   checkouts hold different manifests, and an `ok: true` that does not say
   which file it parsed is not a verdict about the work under review.
4. **`smith epic close` refuses while the check is red** for an epic under
   the `mcp surface` milestone. An epic counts as under it when the
   milestone's `epics:` list names it **or** when the epic id equals the
   milestone id — the convention `smith mcp init` sets up, so a project that
   never hand-edited its roadmap is still gated. The match is deliberately not
   "every epic in the project": the gate belongs to the epic that owes the
   surface, and widening it would block unrelated epics — including ones that
   predate the surface — on a manifest they never owned. The gate rides the
   existing blocker channel:
   `resolveMcpSurface()` reads the roadmap and the manifest, `mcpBlockers()`
   turns each violation into one line of `EpicSummary.blockers`, and
   `runEpicVerdict` holds on `mechanical-blockers` as it already does for a
   red integration-root check. An unreadable or absent manifest fails closed —
   one blocker, not a pass.

   The gate carries the **manifest** rules only, not MCP-M1/M2. M1 cannot fire
   here by construction: the gate applying at all means the milestone exists.
   M2 would be worse than useless — nothing in the factory ever writes a
   milestone status, so blocking on "the surface milestone is not `completed`"
   would make the operator assert the surface is done in order to be allowed
   to close the epic that makes it done, and the gate would then verify an
   assertion it had just compelled. M2 belongs to the final milestone's close,
   which is a gate nobody has built.

   The escape hatch is therefore the same one the
   close gate already has — `--override-rationale`, which records the
   machine's verdict, the rules overridden, and the human's reason in the
   event log. An override is a decision with a name on it, not a bypass.

**Status: all four steps are in place
(`factory/orchestrator/test/{mcp,epic,cli}.test.ts`).**

Step 4 was in place but **unreachable** from the day it shipped until
2026-08-13. `registerMcpMilestone()` wrote `- epics: []` and
`resolveMcpSurface()` decided the surface was due by looking for the epic in
that list, so it matched nothing and `smith epic close` skipped the MCP gate
for every project — silently, since a not-required surface is a legitimate,
unremarkable state. It surfaced in the second dogfood: `smith epic close
--epic envkit-mcp-surface` refused on eleven blockers and not one of them was
an MCP rule. The suite had been green throughout, because every test handed
`resolveMcpSurface()` an `epics: [...]` written by hand — the writer and the
reader were each covered, and nothing composed them. That composition is now
`test/mcp.test.ts`'s "fires for the epic the milestone `smith mcp init`
actually writes", alongside one test pinned to this repo's own shipped
roadmap. **A gate whose applicability is decided by a field the tool
initializes to the disabling value is off, however carefully the rest of it is
written** — and the tests that would have caught it are the ones that run the
two halves together.

`checkManifest` is
deliberately pure and filesystem-free so that `smith mcp check` and the
epic-close gate render identical *manifest* verdicts — a gate that needs a
working directory behaves differently in CI than on a laptop. The two verdicts
are identical on the manifest and differ by design on the roadmap: only the
standalone command adds MCP-M1/M2, per step 4. The filesystem lives one
layer out, in `runMcpCheck()`/`resolveMcpSurface()`, and `epic.ts` stays a fold
over events: it is handed the surface status the way it is handed the
integration head sha, and never reads either itself.

## Forward compatibility

`2026-07-28` is the target revision (`MCP_TARGET_REVISION`). It removes the
`initialize`/`initialized` handshake and the `Mcp-Session-Id` header outright,
which is why MCP-P3 forbids depending on either today.

**Migration trigger:** when `@modelcontextprotocol/sdk` publishes a release
whose `LATEST_PROTOCOL_VERSION` is `2026-07-28`, bump `MCP_PROTOCOL_REVISION`
in `factory/orchestrator/src/mcp.ts`, the `const` in
`factory/specs/schema/mcp-manifest.schema.json`, and the scaffold manifest —
one commit, three files. Existing projects fail `smith mcp check` on MCP-P1
until they bump too, which is the intended pressure: a pin that nobody is
forced off is a pin that rots.

## Adding a tool

The checklist lives with the code it constrains, in the scaffold's
`src/mcp/README.md`, so it stays in front of whoever is writing the tool.
The short version: **declare it in the manifest first** — mutation class,
matching annotations, and a signature if it is not read-only — then implement
it behind `requireDeclaredTool()` with the class the code actually is, with a
typed input schema, redacted output, and a `surface.test.ts` case.
