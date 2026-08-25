/**
 * The startup guard for this project's MCP surface.
 *
 * black-smith checks the manifest statically (`smith mcp check`, and the
 * epic-close gate). This is the runtime half: no tool reaches a client unless
 * the manifest declares it with the mutation class the code claims. The two
 * halves are deliberately separate — a static check the server can ignore is a
 * suggestion, and a runtime check nothing audits is unreviewable — and the
 * shared contract between them is mcp.manifest.json itself.
 *
 * Fail closed: every failure here throws before `connect()`, so a
 * misconfigured surface never starts rather than starting with a hole.
 */

export type MutationClass = 'read-only' | 'write' | 'destructive' | 'outbound';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolApproval {
  operator: string;
  date: string;
  milestone: string;
}

export interface DeclaredTool {
  name: string;
  title: string;
  description: string;
  mutation: MutationClass;
  annotations: ToolAnnotations;
  approval?: ToolApproval;
}

export interface McpManifest {
  name: string;
  version: string;
  protocolRevision: string;
  transport: { kind: string };
  tools: DeclaredTool[];
}

export class SurfaceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SurfaceError';
    this.code = code;
  }
}

/**
 * Look a tool up in the manifest and refuse anything undeclared, reclassified,
 * or unsigned.
 *
 * `mutation` is what the implementation says it does. Passing it in is the
 * whole point: when a tool that used to only read starts writing, the author
 * changes this argument, the manifest no longer agrees, and the surface
 * refuses to boot until an operator signs the new class off. Trusting the
 * manifest alone would make that change silent.
 */
export function requireDeclaredTool(
  manifest: McpManifest,
  name: string,
  mutation: MutationClass,
): DeclaredTool {
  const declared = manifest.tools.find((tool) => tool.name === name);
  if (!declared) {
    throw new SurfaceError(
      'mcp.undeclared-tool',
      `Tool "${name}" is not declared in mcp.manifest.json. Declare it (docs/standards/mcp.md MCP-T5) before registering it.`,
    );
  }
  if (declared.mutation !== mutation) {
    throw new SurfaceError(
      'mcp.mutation-mismatch',
      `Tool "${name}" is implemented as ${mutation} but declared as ${declared.mutation}. Update the manifest and get the new class signed off (MCP-T4).`,
    );
  }
  if (mutation !== 'read-only' && !declared.approval) {
    throw new SurfaceError(
      'mcp.unapproved-tool',
      `Tool "${name}" is ${mutation} and has no operator sign-off in the manifest (MCP-T4).`,
    );
  }
  return declared;
}

/**
 * Refuse to start on a transport this template does not implement. Shipping
 * `stdio` opens no port and presents no auth surface (MCP spec, "Local MCP
 * Server Compromise": servers meant to run locally SHOULD use stdio to limit
 * access to just the MCP client). Serving over HTTP is a deliberate opt-in that
 * has to satisfy MCP-X2..X6 first — Cloudflare Access in front, a canonical
 * resource URI, resource indicators, no token passthrough — so this refuses
 * rather than quietly falling back to a listener nobody reviewed.
 */
export function requireSupportedTransport(manifest: McpManifest): void {
  if (manifest.transport.kind !== 'stdio') {
    throw new SurfaceError(
      'mcp.unsupported-transport',
      `This surface is stdio-only; the manifest declares "${manifest.transport.kind}". Implement the HTTP opt-in against docs/standards/mcp.md MCP-X2..X6 before declaring it.`,
    );
  }
}
