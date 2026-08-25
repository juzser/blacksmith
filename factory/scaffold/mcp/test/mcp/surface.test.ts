/**
 * The one test that talks the actual protocol.
 *
 * guard.test.ts and redact.test.ts check the policy in isolation; this one
 * wires a real client to a real server over an in-memory transport pair and
 * asserts the surface an agent would actually see. It is the difference between
 * "the manifest is well-formed" and "the server built from that manifest
 * answers tools/list and tools/call".
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { buildServer, loadManifest } from '../../src/mcp/server.js';

interface TextContent {
  type: string;
  text: string;
}

async function connectedClient(): Promise<Client> {
  const server = buildServer(loadManifest());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'surface-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: { content?: unknown }): string {
  const content = result.content as TextContent[] | undefined;
  return content?.[0]?.text ?? '';
}

describe('the MCP surface', () => {
  it('advertises exactly the tools the manifest declares, and nothing else', async () => {
    const manifest = loadManifest();
    const client = await connectedClient();

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      manifest.tools.map((tool) => tool.name).sort(),
    );
    await client.close();
  });

  it('carries the manifest annotations through to the client', async () => {
    const client = await connectedClient();

    const { tools } = await client.listTools();
    const health = tools.find((tool) => tool.name === 'project_health');

    // An agent decides whether a call is safe from these hints, so they have to
    // survive the trip — asserting them on the manifest alone would not prove it.
    expect(health?.annotations?.readOnlyHint).toBe(true);
    expect(health?.annotations?.destructiveHint).toBe(false);
    expect(health?.annotations?.openWorldHint).toBe(false);
    await client.close();
  });

  it('answers project_health with the server identity', async () => {
    const manifest = loadManifest();
    const client = await connectedClient();

    const result = await client.callTool({ name: 'project_health', arguments: {} });
    const payload = JSON.parse(textOf(result)) as Record<string, unknown>;

    expect(payload.name).toBe(manifest.name);
    expect(payload.version).toBe(manifest.version);
    expect(payload.transport).toBe('stdio');
    expect(payload.tools).toBeUndefined();
    await client.close();
  });

  it('lists the declared surface when asked verbosely', async () => {
    const client = await connectedClient();

    const result = await client.callTool({
      name: 'project_health',
      arguments: { verbose: true },
    });
    const payload = JSON.parse(textOf(result)) as { tools?: { name: string }[] };

    expect(payload.tools?.map((tool) => tool.name)).toContain('project_health');
    await client.close();
  });

  it('rejects an argument that is not in the tool input schema', async () => {
    const client = await connectedClient();

    const result = await client.callTool({
      name: 'project_health',
      arguments: { verbose: 'yes-please' },
    });

    // Typed input schemas (MCP-P4) are the reason unvalidated arguments never
    // reach tool code; a wrong type has to come back as an error, not a crash.
    expect(result.isError).toBe(true);
    await client.close();
  });
});
