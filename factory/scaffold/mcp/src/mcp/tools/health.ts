import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type McpManifest, requireDeclaredTool } from '../guard.js';
import { redact } from '../redact.js';

/**
 * The one tool the scaffold ships: enough to prove the surface is wired end to
 * end, and a worked example of the shape every other tool copies —
 *
 *   1. a typed input schema (MCP-P4), so unknown arguments never reach code;
 *   2. `requireDeclaredTool` with the class this implementation actually is,
 *      so a later change to what it does cannot outrun the manifest;
 *   3. title/description/annotations taken FROM the manifest rather than
 *      restated here, so there is one place an operator has to read to know
 *      what this server can do.
 */
const TOOL_NAME = 'project_health';

const inputSchema = {
  verbose: z
    .boolean()
    .optional()
    .describe('Also list the declared tool surface, not just the server identity.'),
};

export function registerHealthTool(server: McpServer, manifest: McpManifest): void {
  const declared = requireDeclaredTool(manifest, TOOL_NAME, 'read-only');

  server.registerTool(
    declared.name,
    {
      title: declared.title,
      description: declared.description,
      inputSchema,
      annotations: declared.annotations,
    },
    async ({ verbose }) => {
      const payload = {
        name: manifest.name,
        version: manifest.version,
        protocolRevision: manifest.protocolRevision,
        transport: manifest.transport.kind,
        ...(verbose
          ? {
              tools: manifest.tools.map((tool) => ({
                name: tool.name,
                mutation: tool.mutation,
              })),
            }
          : {}),
      };

      // Redacted even though nothing here is secret today: the redaction runs
      // on the way out so it keeps holding when this payload grows.
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(redact(payload), null, 2) }],
      };
    },
  );
}
