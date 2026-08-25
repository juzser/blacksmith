#!/usr/bin/env node
/**
 * __PROJECT_NAME__'s MCP surface — the agent-callable face of this project.
 *
 * stdio only, by default and on purpose: no port is opened, no listener is
 * exposed, and there is no authorization surface to get wrong. Serving this
 * over HTTP is an opt-in that has to satisfy docs/standards/mcp.md MCP-X2..X6
 * first; `requireSupportedTransport` refuses to boot until that work is real.
 *
 * Two invariants this file exists to hold:
 *   - stdout belongs to the protocol. Every diagnostic goes to stderr, and
 *     goes through redaction first (MCP-S1) — a stray console.log corrupts the
 *     stream, and an un-redacted one leaks.
 *   - nothing is registered that the manifest does not declare. Registration
 *     runs through guard.ts, and a mismatch throws before connect().
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type McpManifest, requireSupportedTransport } from './guard.js';
import { redactError } from './redact.js';
import { registerHealthTool } from './tools/health.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Resolves to the project root from both `src/mcp/` and the built `dist/mcp/`. */
const MANIFEST_PATH = path.resolve(HERE, '..', '..', 'mcp.manifest.json');

export function loadManifest(manifestPath: string = MANIFEST_PATH): McpManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as McpManifest;
}

export function buildServer(manifest: McpManifest): McpServer {
  requireSupportedTransport(manifest);
  const server = new McpServer({ name: manifest.name, version: manifest.version });
  registerHealthTool(server, manifest);
  return server;
}

export async function main(): Promise<void> {
  const manifest = loadManifest();
  const server = buildServer(manifest);
  await server.connect(new StdioServerTransport());
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${redactError(error)}\n`);
    process.exit(1);
  });
}
