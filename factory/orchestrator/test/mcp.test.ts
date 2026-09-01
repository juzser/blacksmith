// MCP-surface tests. Same deliberate limit as scaffold.test.ts: `pnpm install`
// is never run inside the scaffolded tree (network + minutes-slow), so what is
// asserted here is "the emitted surface is structurally right, parses, and
// satisfies the same checkManifest() the epic-close gate will run" — not a live
// handshake against a client. The one thing that IS executed for real is
// checkManifest itself, which is black-smith's own code and is what turns the
// numbered baseline in docs/standards/mcp.md into a pass/fail.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SmithError } from '../src/errors.js';
import {
  addMcpSurface,
  checkManifest,
  checkRoadmapMcpMilestone,
  MCP_PROTOCOL_REVISION,
  MCP_SURFACE_NOT_REQUIRED,
  MCP_TARGET_REVISION,
  McpError,
  type McpManifestProblem,
  mcpBlockers,
  registerMcpMilestone,
  resolveMcpSurface,
  resolveMcpTarget,
  runMcpCheck,
} from '../src/mcp.js';
import { REPO_ROOT } from '../src/paths.js';
import { parseRoadmap, RoadmapError } from '../src/roadmap.js';
import { scaffoldProject } from '../src/scaffold.js';

const BIOME_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'biome');

let scratchDirs: string[] = [];

function mkScratch(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  scratchDirs = [];
});

/** A real base-scaffolded project (the only thing an MCP surface can be added to). */
function scaffoldedProject(projectName = 'demo'): string {
  const targetDir = path.join(mkScratch('bs-mcp-'), projectName);
  // skipToolchain: this suite asserts on the MCP surface, not on an install —
  // no test in this tree reaches the network.
  scaffoldProject({ projectName, ui: false, targetDir, skipGit: true, skipToolchain: true });
  return targetDir;
}

/**
 * A projects root holding <root>/<project> plus one task worktree per id,
 * laid out exactly as worktree.ts does it: `.wt` is a *sibling* of the project
 * checkout, so a project's checkouts are enumerable without asking git.
 */
function workspacesWith(taskIds: string[]): { workspacesDir: string; project: string } {
  const workspacesDir = mkScratch('bs-mcp-ws-');
  const project = path.join(workspacesDir, 'demo');
  scaffoldProject({
    projectName: 'demo',
    ui: false,
    targetDir: project,
    skipGit: true,
    skipToolchain: true,
  });
  for (const taskId of taskIds) {
    mkdirSync(path.join(workspacesDir, '.wt', 'demo', taskId), { recursive: true });
  }
  return { workspacesDir, project };
}

function readManifest(targetDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(targetDir, 'mcp.manifest.json'), 'utf8'));
}

/**
 * The shape `baseManifest()` hands back. `checkManifest` takes `unknown` on
 * purpose — validating a manifest nobody has typed yet is its whole job — so
 * there is no exported type to borrow, and this one exists for the fixture
 * alone. `approval` is optional because half the rules below are about the tool
 * that is missing it, and `tools` is a non-empty tuple so `tools[0]` is known
 * to be there without a non-null assertion on every line that mutates it.
 */
interface ToolFixture {
  name: string;
  title: string;
  description: string;
  mutation: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  approval?: { operator: string; date: string; milestone: string };
}

interface ManifestFixture {
  name: string;
  version: string;
  protocolRevision: string;
  transport: { kind: string };
  tools: [ToolFixture, ...ToolFixture[]];
}

/** Minimal conformant manifest, for mutating one rule at a time. */
function baseManifest(): ManifestFixture {
  return {
    name: 'demo',
    version: '0.1.0',
    protocolRevision: MCP_PROTOCOL_REVISION,
    transport: { kind: 'stdio' },
    tools: [
      {
        name: 'project_health',
        title: 'Project health',
        description: 'Reports the surface revision.',
        mutation: 'read-only',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ],
  };
}

function rulesOf(manifest: unknown): string[] {
  return checkManifest(manifest).violations.map((v) => v.rule);
}

describe('addMcpSurface', () => {
  it('rejects a non-kebab-case project name', () => {
    // The rule is the scaffolder's and stays there — a second copy would drift,
    // and `smith mcp init` naming a project differently from `smith new` is a
    // worse outcome than an error code from a neighbouring module.
    expect(() => addMcpSurface({ projectName: 'Not Valid' })).toThrow(SmithError);
    try {
      addMcpSurface({ projectName: 'Not Valid' });
    } catch (error) {
      expect((error as SmithError).code).toBe('scaffold.invalid-project-name');
    }
  });

  it('refuses a directory that is not a scaffolded project', () => {
    const targetDir = mkScratch('bs-mcp-empty-');
    expect(() => addMcpSurface({ projectName: 'demo', targetDir, skipRoadmap: true })).toThrow(
      /mcp.unknown-project|not a scaffolded project/i,
    );
  });

  it('refuses to overwrite an MCP surface that already exists', () => {
    const targetDir = scaffoldedProject();
    addMcpSurface({ projectName: 'demo', targetDir, skipRoadmap: true });
    expect(() => addMcpSurface({ projectName: 'demo', targetDir, skipRoadmap: true })).toThrow(
      McpError,
    );
  });

  it('writes the manifest and the stdio entry point, substituting the project name', () => {
    const targetDir = scaffoldedProject('billing-api');
    const result = addMcpSurface({ projectName: 'billing-api', targetDir, skipRoadmap: true });

    const relative = result.filesWritten.map((f) => path.relative(targetDir, f)).sort();
    expect(relative).toEqual([
      'mcp.manifest.json',
      path.join('src', 'mcp', 'README.md'),
      path.join('src', 'mcp', 'guard.ts'),
      path.join('src', 'mcp', 'redact.ts'),
      path.join('src', 'mcp', 'server.ts'),
      path.join('src', 'mcp', 'tools', 'health.ts'),
      path.join('test', 'mcp', 'guard.test.ts'),
      path.join('test', 'mcp', 'redact.test.ts'),
      path.join('test', 'mcp', 'surface.test.ts'),
    ]);

    expect(readManifest(targetDir).name).toBe('billing-api');
    const server = readFileSync(path.join(targetDir, 'src/mcp/server.ts'), 'utf8');
    expect(server).not.toContain('__PROJECT_NAME__');
  });

  it('lands under src/ and test/ so the project’s own lint, typecheck and test gates cover it', () => {
    const targetDir = scaffoldedProject();
    addMcpSurface({ projectName: 'demo', targetDir, skipRoadmap: true });

    // The base template's three configs all scope themselves to src/**/*.ts and
    // test/**/*.test.ts. An MCP surface parked anywhere else would be invisible
    // to the gates that are supposed to keep it honest.
    const biome = JSON.parse(readFileSync(path.join(targetDir, 'biome.json'), 'utf8'));
    expect(biome.files.includes).toContain('src/**/*.ts');
    const tsconfig = JSON.parse(readFileSync(path.join(targetDir, 'tsconfig.json'), 'utf8'));
    expect(tsconfig.include).toContain('src/**/*.ts');
  });

  it('merges the SDK dependency and the serve script into package.json', () => {
    const targetDir = scaffoldedProject();
    addMcpSurface({ projectName: 'demo', targetDir, skipRoadmap: true });

    const pkg = JSON.parse(readFileSync(path.join(targetDir, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@modelcontextprotocol/sdk']).toBeTruthy();
    expect(pkg.dependencies.zod).toBeTruthy();
    expect(pkg.scripts['mcp:serve']).toContain('dist/mcp/server.js');
    // the fragment must not clobber what the base template already established
    expect(pkg.scripts.test).toBe('vitest run');
    expect(pkg.name).toBe('demo');
  });

  it('emits JSON that parses and TypeScript the project’s own Biome accepts', () => {
    const targetDir = scaffoldedProject();
    const result = addMcpSurface({ projectName: 'demo', targetDir, skipRoadmap: true });

    for (const file of result.filesWritten) {
      if (file.endsWith('.json')) {
        expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow();
      }
    }
    const sources = result.filesWritten
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.relative(targetDir, f));
    expect(sources.length).toBeGreaterThan(0);
    expect(() =>
      execFileSync(BIOME_BIN, ['check', ...sources], { cwd: targetDir, encoding: 'utf8' }),
    ).not.toThrow();
  });

  it('registers the mcp surface milestone in the roadmap', () => {
    const targetDir = scaffoldedProject();
    const roadmapPath = path.join(mkScratch('bs-mcp-roadmap-'), 'roadmap.md');
    writeFileSync(roadmapPath, '# Roadmap\n', 'utf8');

    const result = addMcpSurface({ projectName: 'demo', targetDir, roadmapPath });

    expect(result.milestoneId).toBe('demo-mcp-surface');
    const text = readFileSync(roadmapPath, 'utf8');
    expect(text).toContain('## demo — mcp surface');
    expect(text).toContain('- id: demo-mcp-surface');
    expect(text).toContain('- project: demo');
    // Not `[]`: this is the list the epic-close gate reads, and seeding it
    // empty is what left the gate unreachable for every project.
    expect(text).toContain('- epics: [demo-mcp-surface]');
  });

  it('refuses an unreadable roadmap before it writes any of the surface', () => {
    // Ordering, not just error typing. addMcpSurface writes the template tree
    // first and registers the milestone last, so a roadmap it cannot read
    // failed *after* mcp.manifest.json existed — and the next attempt then hit
    // `mcp.surface-exists`, which refuses on purpose ("re-scaffolding would
    // discard the declared tools and their operator sign-off"). A typo in the
    // roadmap path left the operator with a half-initialised surface and the
    // one command that finishes the job permanently refusing to run.
    const targetDir = scaffoldedProject();
    const missing = path.join(mkScratch('bs-mcp-roadmap-'), 'nope.md');

    expect(() => addMcpSurface({ projectName: 'demo', targetDir, roadmapPath: missing })).toThrow(
      RoadmapError,
    );
    expect(existsSync(path.join(targetDir, 'mcp.manifest.json'))).toBe(false);
  });
});

describe('registerMcpMilestone', () => {
  it('is idempotent', () => {
    const roadmapPath = path.join(mkScratch('bs-mcp-roadmap-'), 'roadmap.md');
    writeFileSync(roadmapPath, '# Roadmap\n', 'utf8');

    registerMcpMilestone('demo', roadmapPath);
    const once = readFileSync(roadmapPath, 'utf8');
    registerMcpMilestone('demo', roadmapPath);
    expect(readFileSync(roadmapPath, 'utf8')).toBe(once);
  });

  it('appends without disturbing milestones already there', () => {
    const roadmapPath = path.join(mkScratch('bs-mcp-roadmap-'), 'roadmap.md');
    writeFileSync(roadmapPath, '# Roadmap\n\n## demo — bootstrap\n- id: demo-bootstrap\n', 'utf8');

    registerMcpMilestone('demo', roadmapPath);
    const text = readFileSync(roadmapPath, 'utf8');
    expect(text).toContain('- id: demo-bootstrap');
    expect(text).toContain('- id: demo-mcp-surface');
  });

  // The two tests above are the writer composed with itself: it wrote the
  // milestone, so of course it recognises it. `- id: <id>` as a substring of
  // the whole file is not what any reader in this factory means by "the
  // roadmap declares this milestone" — parseRoadmap reads a *field*, off a
  // trimmed line, inside a `## ` section, with /^-\s*id\s*:\s*(.*)$/. The
  // two definitions agree on exactly the spelling the writer itself emits,
  // and the roadmap is a hand-maintained file (architecture §12, "the planner
  // maintains it"), so they disagree the moment a human types it.
  it('is idempotent against every spelling parseRoadmap accepts, not just its own', () => {
    const roadmapPath = path.join(mkScratch('bs-mcp-roadmap-'), 'roadmap.md');
    // `- id:demo-mcp-surface`: no space after the colon. One character.
    writeFileSync(
      roadmapPath,
      '# Roadmap\n\n## demo — mcp surface\n- id:demo-mcp-surface\n- status: planned\n' +
        '- project: demo\n- epics: [demo-mcp-surface]\n- goal: Declare the surface.\n',
      'utf8',
    );
    expect(parseRoadmap(readFileSync(roadmapPath, 'utf8')).map((m) => m.milestoneId)).toEqual([
      'demo-mcp-surface',
    ]);

    const before = readFileSync(roadmapPath, 'utf8');
    expect(registerMcpMilestone('demo', roadmapPath)).toBe('demo-mcp-surface');
    expect(readFileSync(roadmapPath, 'utf8')).toBe(before);

    // What appending a second copy costs, and why this is not cosmetic: the
    // id is the milestones table's primary key, so parseRoadmap refuses the
    // *entire file* from the duplicate onward — and that is the same file
    // `smith mcp check`, the epic-close gate and db rebuild's milestone
    // projection each read. One `smith mcp init` and none of them can read
    // it; a second `smith mcp init` cannot undo it, because now there really
    // are two. The command whose job is to register a milestone took the
    // roadmap away from every consumer of it instead.
    expect(parseRoadmap(readFileSync(roadmapPath, 'utf8')).map((m) => m.milestoneId)).toEqual([
      'demo-mcp-surface',
    ]);
  });

  it('does not read its own registration off a longer id that begins with it', () => {
    const roadmapPath = path.join(mkScratch('bs-mcp-roadmap-'), 'roadmap.md');
    // `demo-mcp-surface-hardening` contains `- id: demo-mcp-surface`.
    writeFileSync(
      roadmapPath,
      '# Roadmap\n\n## demo — mcp surface hardening\n- id: demo-mcp-surface-hardening\n' +
        '- status: planned\n- project: demo\n- epics: []\n- goal: Harden it.\n',
      'utf8',
    );

    expect(registerMcpMilestone('demo', roadmapPath)).toBe('demo-mcp-surface');
    const milestones = parseRoadmap(readFileSync(roadmapPath, 'utf8'));
    expect(milestones.map((m) => m.milestoneId)).toEqual([
      'demo-mcp-surface-hardening',
      'demo-mcp-surface',
    ]);
    // The dead end this is really about. The id the writer returns is what
    // `smith mcp init` prints as milestoneId, so it reported success over a
    // file it had not written to — and MCP-M1 then goes on telling the
    // operator to "Run `smith mcp init`", the command they just ran, which
    // will keep answering that it is already registered.
    expect(checkRoadmapMcpMilestone('demo', milestones)).toEqual([]);
  });

  it('names a roadmap it cannot read instead of raising a bare ENOENT', () => {
    const missing = path.join(mkScratch('bs-mcp-roadmap-'), 'nope.md');

    let thrown: unknown;
    try {
      registerMcpMilestone('demo', missing);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RoadmapError);
    expect((thrown as RoadmapError).code).toBe('roadmap.unreadable');
    expect((thrown as RoadmapError).message).toContain(missing);
  });
});

describe('checkManifest — the numbered baseline', () => {
  it('passes the manifest the scaffold actually ships', () => {
    const targetDir = scaffoldedProject();
    addMcpSurface({ projectName: 'demo', targetDir, skipRoadmap: true });

    const result = checkManifest(readManifest(targetDir));
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('rejects a manifest that is not an object', () => {
    expect(checkManifest(null).ok).toBe(false);
    expect(checkManifest('nope').ok).toBe(false);
  });

  it('MCP-P1: rejects a protocol revision other than the pinned one', () => {
    const manifest = { ...baseManifest(), protocolRevision: MCP_TARGET_REVISION };
    expect(rulesOf(manifest)).toContain('MCP-P1');
  });

  it('MCP-P2: requires a server name and a semver version', () => {
    expect(rulesOf({ ...baseManifest(), name: '' })).toContain('MCP-P2');
    expect(rulesOf({ ...baseManifest(), version: 'v1' })).toContain('MCP-P2');
  });

  it('MCP-T1: a read-only tool may not claim destructive or open-world behaviour', () => {
    const manifest = baseManifest();
    manifest.tools[0].annotations.destructiveHint = true;
    expect(rulesOf(manifest)).toContain('MCP-T1');

    const openWorld = baseManifest();
    openWorld.tools[0].annotations.openWorldHint = true;
    expect(rulesOf(openWorld)).toContain('MCP-T1');
  });

  it('MCP-T1: a read-only tool must actually set readOnlyHint', () => {
    const manifest = baseManifest();
    manifest.tools[0].annotations.readOnlyHint = false;
    expect(rulesOf(manifest)).toContain('MCP-T1');
  });

  it('MCP-T2: a destructive tool must be annotated as destructive and not read-only', () => {
    const manifest = baseManifest();
    manifest.tools[0].mutation = 'destructive';
    manifest.tools[0].approval = { operator: 'ops', date: '2026-08-07', milestone: 'demo-mcp' };
    // annotations left at their read-only values
    const rules = rulesOf(manifest);
    expect(rules).toContain('MCP-T2');
  });

  it('MCP-T3: an outbound tool must set openWorldHint', () => {
    const manifest = baseManifest();
    manifest.tools[0].mutation = 'outbound';
    manifest.tools[0].annotations.readOnlyHint = false;
    manifest.tools[0].approval = { operator: 'ops', date: '2026-08-07', milestone: 'demo-mcp' };
    expect(rulesOf(manifest)).toContain('MCP-T3');
  });

  it('MCP-T4: every non-read-only tool needs recorded operator sign-off', () => {
    const manifest = baseManifest();
    manifest.tools[0].mutation = 'write';
    manifest.tools[0].annotations.readOnlyHint = false;
    expect(rulesOf(manifest)).toContain('MCP-T4');
  });

  it('MCP-T4: accepts a fully declared, signed-off destructive tool', () => {
    const manifest = baseManifest();
    manifest.tools[0].mutation = 'destructive';
    manifest.tools[0].annotations = {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    };
    manifest.tools[0].approval = {
      operator: 'ops',
      date: '2026-08-07',
      milestone: 'demo-mcp-surface',
    };
    expect(checkManifest(manifest).violations).toEqual([]);
  });

  it('MCP-T5: rejects malformed and duplicated tool names', () => {
    const bad = baseManifest();
    bad.tools[0].name = 'Project-Health';
    expect(rulesOf(bad)).toContain('MCP-T5');

    const dup = baseManifest();
    dup.tools.push({ ...dup.tools[0] });
    expect(rulesOf(dup)).toContain('MCP-T5');
  });

  it('MCP-X1: stdio is the default and declares no network exposure', () => {
    const targetDir = scaffoldedProject();
    const result = addMcpSurface({ projectName: 'demo', targetDir, skipRoadmap: true });
    expect(result.transport).toBe('stdio');
    expect(readManifest(targetDir).transport).toEqual({ kind: 'stdio' });
  });

  it('MCP-X1: rejects an unknown transport kind', () => {
    expect(rulesOf({ ...baseManifest(), transport: { kind: 'websocket' } })).toContain('MCP-X1');
  });

  it('MCP-X2: an HTTP surface without Cloudflare Access in front is a violation', () => {
    const manifest = {
      ...baseManifest(),
      transport: {
        kind: 'http',
        access: { cloudflareAccess: false },
        resourceServer: {
          canonicalUri: 'https://mcp.example.com',
          authorizationServers: ['https://auth.example.com'],
          resourceIndicators: true,
          tokenPassthrough: false,
        },
      },
    };
    expect(rulesOf(manifest)).toContain('MCP-X2');
  });

  it('MCP-X3: an HTTP surface must be a resource server with indicators over https', () => {
    const manifest = {
      ...baseManifest(),
      transport: {
        kind: 'http',
        access: { cloudflareAccess: true },
        resourceServer: {
          canonicalUri: 'http://mcp.example.com',
          authorizationServers: [],
          resourceIndicators: false,
          tokenPassthrough: false,
        },
      },
    };
    const rules = rulesOf(manifest);
    expect(rules).toContain('MCP-X3');
  });

  it('MCP-X4: token passthrough is never allowed', () => {
    const manifest = {
      ...baseManifest(),
      transport: {
        kind: 'http',
        access: { cloudflareAccess: true },
        resourceServer: {
          canonicalUri: 'https://mcp.example.com',
          authorizationServers: ['https://auth.example.com'],
          resourceIndicators: true,
          tokenPassthrough: true,
        },
      },
    };
    expect(rulesOf(manifest)).toContain('MCP-X4');
  });

  it('accepts a fully hardened HTTP opt-in', () => {
    const manifest = {
      ...baseManifest(),
      transport: {
        kind: 'http',
        access: { cloudflareAccess: true },
        resourceServer: {
          canonicalUri: 'https://mcp.example.com',
          authorizationServers: ['https://auth.example.com'],
          resourceIndicators: true,
          tokenPassthrough: false,
        },
      },
    };
    expect(checkManifest(manifest).violations).toEqual([]);
  });

  it('reports every violation at once rather than stopping at the first', () => {
    const manifest = { ...baseManifest(), protocolRevision: '1999-01-01', version: 'nope' };
    const rules = rulesOf(manifest);
    expect(rules).toContain('MCP-P1');
    expect(rules).toContain('MCP-P2');
  });

  it('names the offending path so the operator can find it', () => {
    const manifest = baseManifest();
    manifest.tools[0].annotations.readOnlyHint = false;
    const violation = checkManifest(manifest).violations.find((v) => v.rule === 'MCP-T1');
    expect(violation?.path).toBe('/tools/0');
  });
});

describe('the manifest JSON Schema', () => {
  it('is registered under the shared schema directory', () => {
    expect(existsSync(path.join(REPO_ROOT, 'factory/specs/schema/mcp-manifest.schema.json'))).toBe(
      true,
    );
  });
});

interface MilestoneFixture {
  id: string;
  project: string;
  status: string;
  epics?: string[];
}

/** Parses through roadmap.ts on purpose: the gate reads real roadmap.md rows, not hand-built structs. */
function milestones(rows: MilestoneFixture[]) {
  const text = rows
    .map(
      (m) =>
        `## ${m.id}\n- id: ${m.id}\n- status: ${m.status}\n- project: ${m.project}\n- epics: [${(m.epics ?? []).join(', ')}]\n`,
    )
    .join('\n');
  return parseRoadmap(`# Roadmap\n\n${text}`);
}

function roadmapFile(rows: MilestoneFixture[]): string {
  const file = path.join(mkScratch('bs-mcp-roadmap-'), 'roadmap.md');
  const text = rows
    .map(
      (m) =>
        `## ${m.id}\n- id: ${m.id}\n- status: ${m.status}\n- project: ${m.project}\n- epics: [${(m.epics ?? []).join(', ')}]\n`,
    )
    .join('\n');
  writeFileSync(file, `# Roadmap\n\n${text}`, 'utf8');
  return file;
}

describe('checkRoadmapMcpMilestone — the surface is due', () => {
  it('MCP-M1: a project with no mcp surface milestone is missing its due date', () => {
    const violations = checkRoadmapMcpMilestone(
      'demo',
      milestones([{ id: 'demo-bootstrap', project: 'demo', status: 'completed' }]),
    );
    expect(violations.map((v) => v.rule)).toEqual(['MCP-M1']);
  });

  it('MCP-M1: another project’s mcp milestone does not satisfy this one', () => {
    const violations = checkRoadmapMcpMilestone(
      'demo',
      milestones([
        { id: 'demo-bootstrap', project: 'demo', status: 'planned' },
        { id: 'other-mcp-surface', project: 'other', status: 'planned' },
      ]),
    );
    expect(violations.map((v) => v.rule)).toEqual(['MCP-M1']);
  });

  it('MCP-M2: a project whose other milestones are all done is not finished while the surface is open', () => {
    const violations = checkRoadmapMcpMilestone(
      'demo',
      milestones([
        { id: 'demo-bootstrap', project: 'demo', status: 'completed' },
        { id: 'demo-ship', project: 'demo', status: 'completed' },
        { id: 'demo-mcp-surface', project: 'demo', status: 'planned' },
      ]),
    );
    expect(violations.map((v) => v.rule)).toEqual(['MCP-M2']);
  });

  it('stays quiet while the project still has other work open', () => {
    expect(
      checkRoadmapMcpMilestone(
        'demo',
        milestones([
          { id: 'demo-bootstrap', project: 'demo', status: 'in-progress' },
          { id: 'demo-mcp-surface', project: 'demo', status: 'planned' },
        ]),
      ),
    ).toEqual([]);
  });

  it('passes a project that closed its surface', () => {
    expect(
      checkRoadmapMcpMilestone(
        'demo',
        milestones([
          { id: 'demo-bootstrap', project: 'demo', status: 'completed' },
          { id: 'demo-mcp-surface', project: 'demo', status: 'completed' },
        ]),
      ),
    ).toEqual([]);
  });
});

describe('mcpBlockers — what the epic-close gate refuses on', () => {
  it('says nothing about an epic that is not under an mcp surface milestone', () => {
    expect(mcpBlockers('epic-1', MCP_SURFACE_NOT_REQUIRED)).toEqual([]);
  });

  it('fails closed when the manifest could not be read', () => {
    const blockers = mcpBlockers('epic-1', {
      required: true,
      milestoneId: 'demo-mcp-surface',
      manifestPath: '/nope/mcp.manifest.json',
      check: null,
      problem: 'missing',
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('demo-mcp-surface');
    expect(blockers[0]).toContain('mcp.manifest.json');
  });

  it('reports one blocker per violation, each naming its rule', () => {
    const manifest = { ...baseManifest(), protocolRevision: '1999-01-01', version: 'nope' };
    const blockers = mcpBlockers('epic-1', {
      required: true,
      milestoneId: 'demo-mcp-surface',
      manifestPath: '/w/demo/mcp.manifest.json',
      check: checkManifest(manifest),
      problem: null,
    });
    expect(blockers).toHaveLength(2);
    expect(blockers.join('\n')).toContain('MCP-P1');
    expect(blockers.join('\n')).toContain('MCP-P2');
  });

  it('says nothing when the declared surface is green', () => {
    expect(
      mcpBlockers('epic-1', {
        required: true,
        milestoneId: 'demo-mcp-surface',
        manifestPath: '/w/demo/mcp.manifest.json',
        check: checkManifest(baseManifest()),
        problem: null,
      }),
    ).toEqual([]);
  });

  describe('D-198: the remedy a blocker names has to be one the codebase accepts', () => {
    const unread = (problem: McpManifestProblem): string =>
      mcpBlockers('epic-1', {
        required: true,
        milestoneId: 'demo-mcp-surface',
        manifestPath: '/w/demo/mcp.manifest.json',
        check: null,
        problem,
      })[0] ?? '';

    it('sends an operator with no manifest to `smith mcp init`', () => {
      const blocker = unread('missing');
      expect(blocker).toContain('smith mcp init');
      expect(blocker).toContain('demo-mcp-surface');
    });

    it('does not send an operator with an unreadable manifest to `smith mcp init`', () => {
      // init refuses over an existing manifest (mcp.surface-exists), so telling
      // them to run it is a loop: the gate says init, init says edit in place.
      const missing = unread('missing');
      const unreadable = unread('unreadable');
      expect(missing).not.toEqual(unreadable);
      expect(unreadable).toContain('refuses over an existing manifest');
      expect(unreadable).toContain('smith mcp check');
      expect(missing).not.toContain('smith mcp check');
    });

    it('is the remedy the code actually accepts — the loop, executed', () => {
      const targetDir = scaffoldedProject();
      addMcpSurface({ projectName: 'demo', targetDir, skipRoadmap: true });
      // The operator did what mcp.surface-exists told them to: edited the
      // manifest in place. They left a trailing comma.
      writeFileSync(path.join(targetDir, 'mcp.manifest.json'), '{ "name": "demo", }', 'utf8');
      const roadmapPath = roadmapFile([
        { id: 'demo-mcp-surface', project: 'demo', status: 'planned', epics: ['epic-mcp'] },
      ]);

      const status = resolveMcpSurface({ epicId: 'epic-mcp', projectDir: targetDir, roadmapPath });
      expect(status.check).toBe(null);
      expect(status.problem).toBe('unreadable');

      // What the old blocker told them to run, run:
      expect(() => addMcpSurface({ projectName: 'demo', targetDir, skipRoadmap: true })).toThrow(
        /already exists/,
      );
      // ...so the blocker has to state the fact that throw just demonstrated,
      // rather than naming it as the way out.
      expect(mcpBlockers('epic-mcp', status)[0]).toContain('refuses over an existing manifest');
    });
  });
});

describe('resolveMcpSurface', () => {
  it('is not required for an epic outside the mcp surface milestone', () => {
    const status = resolveMcpSurface({
      epicId: 'epic-boot',
      projectDir: mkScratch('bs-mcp-none-'),
      roadmapPath: roadmapFile([
        { id: 'demo-bootstrap', project: 'demo', status: 'in-progress', epics: ['epic-boot'] },
        { id: 'demo-mcp-surface', project: 'demo', status: 'planned', epics: ['epic-mcp'] },
      ]),
    });
    expect(status.required).toBe(false);
    expect(status.check).toBeNull();
  });

  it('checks the real manifest for an epic under the milestone', () => {
    const targetDir = scaffoldedProject();
    addMcpSurface({ projectName: 'demo', targetDir, skipRoadmap: true });

    const status = resolveMcpSurface({
      epicId: 'epic-mcp',
      projectDir: targetDir,
      roadmapPath: roadmapFile([
        { id: 'demo-mcp-surface', project: 'demo', status: 'planned', epics: ['epic-mcp'] },
      ]),
    });
    expect(status.required).toBe(true);
    expect(status.milestoneId).toBe('demo-mcp-surface');
    expect(status.check?.ok).toBe(true);
  });

  it('fires for the epic the milestone `smith mcp init` actually writes', () => {
    // The gate could not fire in production. registerMcpMilestone() seeds
    // `- epics: []`, resolveMcpSurface() keyed `required` on that list, and
    // nothing ever filled it in — so `smith epic close` skipped the MCP
    // surface gate for every project, silently. The tests above stayed green
    // because each hands the resolver an `epics: [...]` written by hand; no
    // test composed the writer with the reader. This one does, and that is
    // the whole reason a dead gate shipped (dogfood-mcp-1, contrast #348).
    const targetDir = scaffoldedProject();
    addMcpSurface({ projectName: 'demo', targetDir, skipRoadmap: true });
    const roadmapPath = path.join(mkScratch('bs-mcp-roadmap-'), 'roadmap.md');
    writeFileSync(roadmapPath, '# Roadmap\n', 'utf8');
    registerMcpMilestone('demo', roadmapPath);

    const status = resolveMcpSurface({
      epicId: 'demo-mcp-surface',
      projectDir: targetDir,
      roadmapPath,
    });
    expect(status.required).toBe(true);
    expect(status.milestoneId).toBe('demo-mcp-surface');
    expect(status.check?.ok).toBe(true);
  });

  it('gates the real envkit surface epic in the shipped roadmap', () => {
    // Pinned to the roadmap this repo ships rather than a fixture: envkit is
    // the project that ran the surface epic, `smith mcp check envkit` reports
    // MCP-M2 against it, and the epic that owes the surface must not be able
    // to close unexamined. projectDir is scratch on purpose — workspaces/ is
    // gitignored, so the manifest is absent on CI and `check` is null there;
    // `required` is the property under test and is identical on every box.
    const status = resolveMcpSurface({
      epicId: 'envkit-mcp-surface',
      projectDir: mkScratch('bs-mcp-envkit-'),
    });
    expect(status.required).toBe(true);
    expect(status.milestoneId).toBe('envkit-mcp-surface');
  });

  it('carries the manifest rules to the close and deliberately not MCP-M1/M2', () => {
    // The dogfood prescribed wiring checkRoadmapMcpMilestone into the gate
    // too ("hole 2"). That fix would break the gate rather than complete it,
    // and this test is what stops a later reader from "finishing the job".
    //
    // MCP-M1 cannot fire here — reaching the gate at all means the milestone
    // exists. MCP-M2 fires while the surface milestone is not `completed`, and
    // nothing in the factory ever writes a milestone status: registerMcpMilestone
    // seeds `planned`, epic.ts never touches the roadmap, only a human edit
    // moves it. So an MCP-M2 blocker would make the operator declare the
    // surface done in order to be allowed to close the epic that makes it
    // done, leaving the gate to confirm an assertion it had just compelled.
    // That rule's honest host is the final milestone's close (D-115).
    const targetDir = scaffoldedProject();
    addMcpSurface({ projectName: 'demo', targetDir, skipRoadmap: true });
    const roadmapPath = roadmapFile([
      { id: 'demo-bootstrap', project: 'demo', status: 'completed' },
      {
        id: 'demo-mcp-surface',
        project: 'demo',
        status: 'planned',
        epics: ['demo-mcp-surface'],
      },
    ]);

    // The trigger really is live in this fixture — otherwise the assertion
    // below would pass for the trivial reason that there is nothing to carry.
    const roadmapViolations = checkRoadmapMcpMilestone(
      'demo',
      parseRoadmap(readFileSync(roadmapPath, 'utf8')),
    );
    expect(roadmapViolations.map((v) => v.rule)).toEqual(['MCP-M2']);

    const status = resolveMcpSurface({
      epicId: 'demo-mcp-surface',
      projectDir: targetDir,
      roadmapPath,
    });
    expect(status.required).toBe(true);
    expect(status.check?.violations.map((v) => v.rule)).toEqual([]);
    expect(mcpBlockers('demo-mcp-surface', status)).toEqual([]);
  });

  it('leaves the verdict null when the manifest is missing or unparseable', () => {
    const roadmapPath = roadmapFile([
      { id: 'demo-mcp-surface', project: 'demo', status: 'planned', epics: ['epic-mcp'] },
    ]);

    const missing = mkScratch('bs-mcp-missing-');
    expect(resolveMcpSurface({ epicId: 'epic-mcp', projectDir: missing, roadmapPath }).check).toBe(
      null,
    );

    const broken = mkScratch('bs-mcp-broken-');
    writeFileSync(path.join(broken, 'mcp.manifest.json'), '{ not json', 'utf8');
    expect(resolveMcpSurface({ epicId: 'epic-mcp', projectDir: broken, roadmapPath }).check).toBe(
      null,
    );
  });

  it('names the roadmap when the gate cannot read it, rather than dying in Node', () => {
    // The test above is this function's stated design: a manifest that cannot
    // be read "resolves to `check: null` rather than throwing — mcpBlockers
    // turns that into a refusal, so the gate reports the problem instead of
    // crashing the verdict that was meant to report it". The roadmap is the
    // *other* file the same function reads, one line earlier, and it read it
    // with a bare loadRoadmap. A missing roadmap therefore did the exact
    // thing the comment rules out, and did it before the manifest logic the
    // comment is attached to could run.
    //
    // Not resolved to `required: false`, note. Fail-open on a gate is the one
    // outcome worse than a crash: it would skip the MCP surface check for
    // every epic whenever the roadmap went missing, which is precisely the
    // silent-dead-gate failure `fires for the epic the milestone actually
    // writes` above exists to prevent. The fix is a typed error, not a
    // shrug.
    const missing = path.join(mkScratch('bs-mcp-noroadmap-'), 'nope.md');

    let thrown: unknown;
    try {
      resolveMcpSurface({
        epicId: 'epic-mcp',
        projectDir: mkScratch('bs-mcp-pd-'),
        roadmapPath: missing,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RoadmapError);
    expect((thrown as RoadmapError).code).toBe('roadmap.unreadable');
    expect((thrown as RoadmapError).message).toContain(missing);
  });
});

describe('runMcpCheck', () => {
  it('is green on a freshly initialised surface with its milestone registered', () => {
    const targetDir = scaffoldedProject();
    addMcpSurface({ projectName: 'demo', targetDir, skipRoadmap: true });
    const roadmapPath = roadmapFile([
      { id: 'demo-mcp-surface', project: 'demo', status: 'planned' },
    ]);

    const report = runMcpCheck({ projectName: 'demo', targetDir, roadmapPath });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.manifestPath).toBe(path.join(targetDir, 'mcp.manifest.json'));
  });

  it('reports manifest and roadmap violations together', () => {
    const targetDir = scaffoldedProject();
    addMcpSurface({ projectName: 'demo', targetDir, skipRoadmap: true });
    const manifestPath = path.join(targetDir, 'mcp.manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.protocolRevision = '1999-01-01';
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

    const report = runMcpCheck({
      projectName: 'demo',
      targetDir,
      roadmapPath: roadmapFile([{ id: 'demo-bootstrap', project: 'demo', status: 'completed' }]),
    });
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.rule).sort()).toEqual(['MCP-M1', 'MCP-P1']);
  });

  it('refuses a project that has no surface to check', () => {
    const targetDir = scaffoldedProject();
    expect(() => runMcpCheck({ projectName: 'demo', targetDir })).toThrow(McpError);
  });

  it('names the checkout it graded, so a pass says what it is about', () => {
    const { workspacesDir, project } = workspacesWith([]);
    addMcpSurface({ projectName: 'demo', targetDir: project, skipRoadmap: true });
    const roadmapPath = roadmapFile([
      { id: 'demo-mcp-surface', project: 'demo', status: 'planned' },
    ]);

    const report = runMcpCheck({
      projectName: 'demo',
      roadmapPath,
      projectRoots: [workspacesDir],
      cwd: project,
    });
    expect(report.ok).toBe(true);
    expect(report.targetDir).toBe(project);
    expect(report.targetSource).toBe('cwd');
  });
});

// D-133. `mcp check <project>` resolved its target as <root>/<project>,
// which during an epic is a DIFFERENT valid checkout from the one the caller is
// standing in: task work happens in <root>/.wt/<project>/<task-id>. The
// wrong answer was well-formed — ok:true, violations:[], exit 0 — both before
// and after the manifest edit the criterion existed to regression-check,
// because in both cases it parsed a file the task never touched.
describe('resolveMcpTarget', () => {
  it('grades the worktree the caller is standing in', () => {
    const { workspacesDir, project } = workspacesWith(['task-3-manifest-truth']);
    const worktree = path.join(workspacesDir, '.wt', 'demo', 'task-3-manifest-truth');

    expect(
      resolveMcpTarget({
        projectName: 'demo',
        projectRoots: [workspacesDir],
        cwd: path.join(worktree, 'src'),
      }),
    ).toEqual({ targetDir: worktree, source: 'cwd' });
    expect(
      resolveMcpTarget({ projectName: 'demo', projectRoots: [workspacesDir], cwd: project }),
    ).toEqual({
      targetDir: project,
      source: 'cwd',
    });
  });

  // The invocation AC[7] specified verbatim, run from the black-smith repo root
  // while a task worktree was open. There is no cwd to read the intent from, so
  // the only honest answers are "which one?" and a wrong one.
  it('refuses to guess from outside every checkout while worktrees are open', () => {
    const { workspacesDir, project } = workspacesWith(['task-3-manifest-truth']);
    const worktree = path.join(workspacesDir, '.wt', 'demo', 'task-3-manifest-truth');

    try {
      resolveMcpTarget({ projectName: 'demo', projectRoots: [workspacesDir], cwd: REPO_ROOT });
      expect.unreachable('resolveMcpTarget should refuse rather than pick one');
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as SmithError).code).toBe('mcp.ambiguous-target');
      // Both candidates by name: the operator has to pick, so they need the list.
      expect((err as SmithError).message).toContain(project);
      expect((err as SmithError).message).toContain(worktree);
    }
  });

  it('falls back to <root>/<project> when it is the only checkout', () => {
    const { workspacesDir, project } = workspacesWith([]);
    expect(
      resolveMcpTarget({ projectName: 'demo', projectRoots: [workspacesDir], cwd: REPO_ROOT }),
    ).toEqual({
      targetDir: project,
      source: 'default',
    });
  });

  it('lets an explicit --target-dir win over both, from anywhere', () => {
    const { workspacesDir } = workspacesWith(['task-3-manifest-truth']);
    const elsewhere = mkScratch('bs-mcp-explicit-');
    expect(
      resolveMcpTarget({
        projectName: 'demo',
        targetDir: elsewhere,
        projectRoots: [workspacesDir],
        cwd: REPO_ROOT,
      }),
    ).toEqual({ targetDir: elsewhere, source: 'flag' });
  });

  // A sibling project's worktree is not this project's, and neither is a path
  // that merely starts with the same characters.
  it('does not read the cwd as a checkout it only resembles', () => {
    const { workspacesDir, project } = workspacesWith([]);
    expect(
      resolveMcpTarget({
        projectName: 'demo',
        projectRoots: [workspacesDir],
        cwd: `${project}-ui`,
      }),
    ).toEqual({
      targetDir: project,
      source: 'default',
    });
  });
});

// A project no longer lands inside this clone by default, but one scaffolded
// before that change still sits under `workspaces/`. Both roots are searched,
// or the move would strand every project already there.
describe('resolveMcpTarget across project roots', () => {
  it('still finds a project left in the legacy workspaces/ root', () => {
    const { workspacesDir, project } = workspacesWith([]);
    const projectsDir = mkScratch('bs-mcp-projects-');

    expect(
      resolveMcpTarget({
        projectName: 'demo',
        projectRoots: [projectsDir, workspacesDir],
        cwd: REPO_ROOT,
      }),
    ).toEqual({ targetDir: project, source: 'default' });
  });

  it('refuses to guess when one name has a checkout under each root', () => {
    const { workspacesDir, project } = workspacesWith([]);
    const projectsDir = mkScratch('bs-mcp-projects-');
    const beside = path.join(projectsDir, 'demo');
    mkdirSync(beside, { recursive: true });

    try {
      resolveMcpTarget({
        projectName: 'demo',
        projectRoots: [projectsDir, workspacesDir],
        cwd: REPO_ROOT,
      });
      expect.unreachable('two checkouts of one name is not something to pick between');
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as SmithError).code).toBe('mcp.ambiguous-target');
      expect((err as SmithError).message).toContain(beside);
      expect((err as SmithError).message).toContain(project);
    }
  });

  it('assumes the first root, which is where a new project lands', () => {
    const projectsDir = mkScratch('bs-mcp-projects-');
    const workspacesDir = mkScratch('bs-mcp-ws-empty-');

    expect(
      resolveMcpTarget({
        projectName: 'demo',
        projectRoots: [projectsDir, workspacesDir],
        cwd: REPO_ROOT,
      }),
    ).toEqual({ targetDir: path.join(projectsDir, 'demo'), source: 'default' });
  });
});
