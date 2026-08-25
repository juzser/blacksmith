import { describe, expect, it } from 'vitest';
import {
  type McpManifest,
  requireDeclaredTool,
  requireSupportedTransport,
  SurfaceError,
} from '../../src/mcp/guard.js';

function manifest(overrides: Partial<McpManifest> = {}): McpManifest {
  return {
    name: 'demo',
    version: '0.0.0',
    protocolRevision: '2025-11-25',
    transport: { kind: 'stdio' },
    tools: [
      {
        name: 'project_health',
        title: 'Project health',
        description: 'Reports the surface.',
        mutation: 'read-only',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ],
    ...overrides,
  };
}

describe('requireDeclaredTool', () => {
  it('returns the declaration for a tool the manifest declares', () => {
    expect(requireDeclaredTool(manifest(), 'project_health', 'read-only').title).toBe(
      'Project health',
    );
  });

  it('refuses a tool the manifest does not declare', () => {
    expect(() => requireDeclaredTool(manifest(), 'delete_everything', 'destructive')).toThrow(
      SurfaceError,
    );
  });

  it('refuses when the implementation mutates more than the manifest admits', () => {
    // The tool used to only read; someone made it write. The manifest still
    // says read-only, so the surface must not start.
    expect(() => requireDeclaredTool(manifest(), 'project_health', 'write')).toThrow(
      /declared as read-only/,
    );
  });

  it('refuses a mutating tool with no operator sign-off', () => {
    const unsigned = manifest({
      tools: [
        {
          name: 'purge_cache',
          title: 'Purge cache',
          description: 'Drops every cached entry.',
          mutation: 'destructive',
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
      ],
    });
    expect(() => requireDeclaredTool(unsigned, 'purge_cache', 'destructive')).toThrow(
      /no operator sign-off/,
    );
  });

  it('accepts a mutating tool once it is signed off', () => {
    const signed = manifest({
      tools: [
        {
          name: 'purge_cache',
          title: 'Purge cache',
          description: 'Drops every cached entry.',
          mutation: 'destructive',
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
          },
          approval: { operator: 'ops', date: '2026-08-07', milestone: 'demo-mcp-surface' },
        },
      ],
    });
    expect(requireDeclaredTool(signed, 'purge_cache', 'destructive').name).toBe('purge_cache');
  });
});

describe('requireSupportedTransport', () => {
  it('accepts stdio', () => {
    expect(() => requireSupportedTransport(manifest())).not.toThrow();
  });

  it('refuses to boot on a transport this surface has not implemented', () => {
    expect(() => requireSupportedTransport(manifest({ transport: { kind: 'http' } }))).toThrow(
      /stdio-only/,
    );
  });
});
