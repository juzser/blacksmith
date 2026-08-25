# The MCP surface

This is `__PROJECT_NAME__`'s agent-callable face. Every project that leaves
black-smith ships one, and it has to be green against
`docs/standards/mcp.md` before the final milestone can close.

## What is here

| File | Job |
| --- | --- |
| `../../mcp.manifest.json` | The declaration. Every tool, its mutation class, its annotations, and — for anything that is not read-only — the operator sign-off. |
| `guard.ts` | The runtime half of the policy. Refuses to register an undeclared, reclassified, or unsigned tool, and refuses to boot on a transport this surface has not implemented. |
| `redact.ts` | Output scrubbing. Two independent nets: by key name and by credential shape. |
| `server.ts` | Wiring. Loads the manifest, builds the server, connects stdio. |
| `tools/health.ts` | The one shipped tool, and the worked example every other tool copies. |

Tests live in `test/mcp/`. `surface.test.ts` connects a real client to a real
server over an in-memory transport, so the assertions are about what an agent
would actually see, not about what the manifest says.

## Adding a tool

1. **Declare it in `mcp.manifest.json` first.** Name it `snake_case`, give it a
   `mutation` class (`read-only` | `write` | `destructive` | `outbound`), and
   set the four annotations to match that class. A read-only tool with
   `destructiveHint: true` is a contradiction and the check will say so.
2. **If it is not read-only, get it signed off.** Add
   `"approval": { "operator": "...", "date": "YYYY-MM-DD", "milestone": "..." }`.
   This is a person deciding, at the MCP milestone, that an agent may do this
   thing unattended. It is not a formality and it is not yours to add for
   yourself.
3. **Write the tool in `tools/`.** Start with `requireDeclaredTool(manifest,
   NAME, <what this code actually does>)`. Pass the class the *implementation*
   is, not the class you wish it were — that argument is what stops a tool that
   quietly started writing from shipping under a read-only declaration.
4. **Give it a typed input schema.** Unvalidated arguments must never reach tool
   code.
5. **Redact on the way out.** `redact()` the payload even when nothing in it is
   secret today; that is what keeps it holding when the payload grows.
6. **Register it in `server.ts`** and add a case to `test/mcp/surface.test.ts`.

Run `smith mcp check` (from the factory) to see the verdict the epic-close gate
will see.

## Why stdio

No port is opened, no listener is exposed, and there is no authorization surface
to get wrong. The MCP security guidance is explicit that servers meant to run
locally should use stdio to limit access to just the MCP client.

Serving over HTTP is a deliberate opt-in, not a config flag. It requires
Cloudflare Access in front, a canonical resource URI over `https`, RFC 8707
resource indicators, and — non-negotiably — no token passthrough: this server
must never accept a token that was not issued for it. Until that work is real,
`requireSupportedTransport` refuses to boot on anything but stdio.

## Two rules that are easy to break by accident

- **stdout belongs to the protocol.** A stray `console.log` corrupts the stream.
  Diagnostics go to stderr, through `redactError` first.
- **Nothing is registered that the manifest does not declare.** The manifest is
  the one place an operator reads to know what this server can do. If the code
  can do more than the manifest admits, that document is a lie.
