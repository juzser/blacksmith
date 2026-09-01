// MCP surface: the agent-callable face every project leaving the factory ships
// (docs/standards/mcp.md). Four jobs live here and nothing else:
//
//   addMcpSurface()  — layer factory/scaffold/mcp/ onto an ALREADY scaffolded
//                      project, and register the milestone that makes it due.
//   checkManifest()  — turn the numbered baseline in docs/standards/mcp.md into
//                      pass/fail over a declared manifest.
//   runMcpCheck()    — what `smith mcp check` prints: the manifest verdict plus
//                      the roadmap's own (MCP-M1/M2, "the surface is due").
//   resolveMcpSurface()/mcpBlockers()
//                    — what the epic-close gate refuses on.
//
// checkManifest is deliberately pure and filesystem-free: `smith mcp check` and
// the epic-close gate both call it, and a gate that needs a working directory
// to render a verdict is a gate that behaves differently in CI than on a
// laptop. Rule ids (MCP-P1, MCP-T4, ...) are the contract with the doc — when
// one changes here, the doc's numbered list changes in the same commit.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SmithError } from './errors.js';
import { PROJECTS_DIR, ROADMAP_PATH, SCAFFOLD_DIR, WORKSPACES_DIR } from './paths.js';
import {
  loadRoadmap,
  type MilestoneDef,
  ownsEpic,
  readRoadmapText,
  roadmapDeclaresId,
} from './roadmap.js';
import {
  copyTemplateDir,
  mergePackageJson,
  PACKAGE_FRAGMENT_NAME,
  validateProjectName,
} from './scaffold.js';

export class McpError extends SmithError {}

/**
 * The wire revision the factory pins — chosen to be what the Tier-1 TypeScript
 * SDK actually negotiates, not the newest revision on paper. Verified against
 * @modelcontextprotocol/sdk@1.30.0 (the only published dist-tag as of
 * 2026-08-07), whose LATEST_PROTOCOL_VERSION is '2025-11-25'. Pinning the
 * newer MCP_TARGET_REVISION today would produce a standard nothing can build.
 */
export const MCP_PROTOCOL_REVISION = '2025-11-25';

/**
 * Where the pin moves once the SDK ships it. 2026-07-28 removes the
 * initialize/initialized handshake and the Mcp-Session-Id header outright, so
 * the scaffold is written to depend on neither — see docs/standards/mcp.md
 * "Forward compatibility" for the migration trigger.
 */
export const MCP_TARGET_REVISION = '2026-07-28';

/** Suffix of the milestone every project must close before its final one. */
export const MCP_MILESTONE_SUFFIX = 'mcp-surface';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const MUTATION_CLASSES = ['read-only', 'write', 'destructive', 'outbound'] as const;
export type MutationClass = (typeof MUTATION_CLASSES)[number];

export interface McpViolation {
  /** Rule id from docs/standards/mcp.md's numbered baseline. */
  rule: string;
  /** JSON-pointer-ish location inside the manifest. */
  path: string;
  message: string;
}

export interface McpCheckResult {
  ok: boolean;
  violations: McpViolation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttps(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('https://');
}

/** MCP-T1/T2/T3/T4/T5 — one tool entry against the tool-surface policy. */
function checkTool(
  tool: unknown,
  index: number,
  seen: Set<string>,
  violations: McpViolation[],
): void {
  const at = `/tools/${index}`;
  if (!isRecord(tool)) {
    violations.push({ rule: 'MCP-T5', path: at, message: 'Tool entry must be an object.' });
    return;
  }

  const name = tool.name;
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
    violations.push({
      rule: 'MCP-T5',
      path: at,
      message: `Tool name must match ${TOOL_NAME.source}; got ${JSON.stringify(name)}.`,
    });
  } else if (seen.has(name)) {
    violations.push({ rule: 'MCP-T5', path: at, message: `Duplicate tool name "${name}".` });
  } else {
    seen.add(name);
  }

  const mutation = tool.mutation;
  if (typeof mutation !== 'string' || !MUTATION_CLASSES.includes(mutation as MutationClass)) {
    violations.push({
      rule: 'MCP-T2',
      path: at,
      message: `Tool must declare a mutation class (${MUTATION_CLASSES.join(' | ')}); got ${JSON.stringify(mutation)}.`,
    });
    return; // every remaining rule is relative to the class — nothing left to say
  }

  // Hints are read out of an unvalidated object on purpose: a missing hint is
  // a policy violation reported under the rule its mutation class belongs to,
  // never a silently-defaulted `false`.
  const hints = isRecord(tool.annotations) ? tool.annotations : {};
  const { readOnlyHint, destructiveHint, openWorldHint } = hints;

  if (mutation === 'read-only') {
    if (readOnlyHint !== true || destructiveHint !== false || openWorldHint !== false) {
      violations.push({
        rule: 'MCP-T1',
        path: at,
        message:
          'A read-only tool must annotate readOnlyHint: true, destructiveHint: false, openWorldHint: false.',
      });
    }
  }

  if (mutation === 'write' || mutation === 'destructive') {
    if (readOnlyHint !== false) {
      violations.push({
        rule: 'MCP-T2',
        path: at,
        message: `A ${mutation} tool must annotate readOnlyHint: false.`,
      });
    }
    if (mutation === 'destructive' && destructiveHint !== true) {
      violations.push({
        rule: 'MCP-T2',
        path: at,
        message: 'A destructive tool must annotate destructiveHint: true.',
      });
    }
  }

  if (mutation === 'outbound' && openWorldHint !== true) {
    violations.push({
      rule: 'MCP-T3',
      path: at,
      message: 'An outbound tool must annotate openWorldHint: true.',
    });
  }

  if (mutation !== 'read-only') {
    const approval = isRecord(tool.approval) ? tool.approval : undefined;
    const signed =
      approval !== undefined &&
      typeof approval.operator === 'string' &&
      approval.operator.length > 0 &&
      typeof approval.date === 'string' &&
      ISO_DATE.test(approval.date) &&
      typeof approval.milestone === 'string' &&
      approval.milestone.length > 0;
    if (!signed) {
      violations.push({
        rule: 'MCP-T4',
        path: at,
        message: `A ${mutation} tool needs approval: { operator, date (YYYY-MM-DD), milestone } recorded at the mcp surface milestone.`,
      });
    }
  }
}

/** MCP-X1..X4 — transport declaration and, for the HTTP opt-in, its preconditions. */
function checkTransport(transport: unknown, violations: McpViolation[]): void {
  const at = '/transport';
  if (!isRecord(transport) || (transport.kind !== 'stdio' && transport.kind !== 'http')) {
    violations.push({
      rule: 'MCP-X1',
      path: at,
      message: 'Transport must be { kind: "stdio" } or the declared HTTP opt-in { kind: "http" }.',
    });
    return;
  }
  if (transport.kind === 'stdio') return; // no port, no listener, nothing further to prove

  const access = isRecord(transport.access) ? transport.access : undefined;
  if (access?.cloudflareAccess !== true) {
    violations.push({
      rule: 'MCP-X2',
      path: `${at}/access`,
      message:
        'An HTTP surface must sit behind Cloudflare Access (mcp.md MCP-X2: nothing is exposed beyond localhost without something authenticating in front of it).',
    });
  }

  const rs = isRecord(transport.resourceServer) ? transport.resourceServer : undefined;
  if (!rs) {
    violations.push({
      rule: 'MCP-X3',
      path: `${at}/resourceServer`,
      message: 'An HTTP surface must declare itself an OAuth 2.0 protected resource.',
    });
    return;
  }
  if (!isHttps(rs.canonicalUri)) {
    violations.push({
      rule: 'MCP-X3',
      path: `${at}/resourceServer/canonicalUri`,
      message: 'The canonical resource URI must be an https:// URL — it is the token audience.',
    });
  }
  if (!Array.isArray(rs.authorizationServers) || rs.authorizationServers.length === 0) {
    violations.push({
      rule: 'MCP-X3',
      path: `${at}/resourceServer/authorizationServers`,
      message: 'Declare at least one authorization server issuer.',
    });
  } else if (!rs.authorizationServers.every(isHttps)) {
    violations.push({
      rule: 'MCP-X3',
      path: `${at}/resourceServer/authorizationServers`,
      message: 'Every authorization server issuer must be an https:// URL.',
    });
  }
  if (rs.resourceIndicators !== true) {
    violations.push({
      rule: 'MCP-X3',
      path: `${at}/resourceServer/resourceIndicators`,
      message: 'RFC 8707 resource indicators are mandatory — they are what binds a token to us.',
    });
  }
  if (rs.tokenPassthrough !== false) {
    violations.push({
      rule: 'MCP-X4',
      path: `${at}/resourceServer/tokenPassthrough`,
      message:
        'Token passthrough is never allowed: the server MUST NOT accept a token that was not issued for its own canonical URI.',
    });
  }
}

/**
 * The manifest-checkable subset of docs/standards/mcp.md. Source-level rules
 * (MCP-P3 session-independence, MCP-S1 output redaction) are not decidable from
 * a declaration and are enforced where the code is, not here.
 */
export function checkManifest(manifest: unknown): McpCheckResult {
  const violations: McpViolation[] = [];

  if (!isRecord(manifest)) {
    return {
      ok: false,
      violations: [{ rule: 'MCP-P2', path: '/', message: 'Manifest must be a JSON object.' }],
    };
  }

  if (manifest.protocolRevision !== MCP_PROTOCOL_REVISION) {
    violations.push({
      rule: 'MCP-P1',
      path: '/protocolRevision',
      message: `Pin the wire revision to ${MCP_PROTOCOL_REVISION} (what the Tier-1 SDK negotiates); got ${JSON.stringify(manifest.protocolRevision)}.`,
    });
  }

  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    violations.push({
      rule: 'MCP-P2',
      path: '/name',
      message: 'Manifest must name the server.',
    });
  }
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
    violations.push({
      rule: 'MCP-P2',
      path: '/version',
      message: `Server version must be semver; got ${JSON.stringify(manifest.version)}.`,
    });
  }

  checkTransport(manifest.transport, violations);

  if (!Array.isArray(manifest.tools)) {
    violations.push({ rule: 'MCP-T5', path: '/tools', message: 'Manifest must declare tools[].' });
  } else {
    const seen = new Set<string>();
    manifest.tools.forEach((tool, index) => {
      checkTool(tool, index, seen, violations);
    });
  }

  return { ok: violations.length === 0, violations };
}

export interface McpSurfaceOptions {
  projectName: string;
  /** Defaults to `<projectsDir>/<projectName>`. */
  targetDir?: string;
  /** The root the project is looked for in; defaults to PROJECTS_DIR. */
  projectsDir?: string;
  /** Defaults to factory/scaffold/. */
  templateDir?: string;
  roadmapPath?: string;
  /** Skip the roadmap write — for callers that only want the file tree. */
  skipRoadmap?: boolean;
}

export interface McpSurfaceResult {
  targetDir: string;
  manifestPath: string;
  filesWritten: string[];
  milestoneId: string;
  protocolRevision: string;
  transport: 'stdio';
}

/**
 * Layers the MCP surface onto an existing project. Unlike scaffoldProject this
 * REQUIRES the directory to already be a project (a package.json is the tell) —
 * an MCP server with no project behind it has nothing to expose, and silently
 * creating one would hide a mistyped project name.
 */
export function addMcpSurface(opts: McpSurfaceOptions): McpSurfaceResult {
  validateProjectName(opts.projectName);

  const templateDir = path.join(opts.templateDir ?? SCAFFOLD_DIR, 'mcp');
  const targetDir = opts.targetDir ?? path.join(opts.projectsDir ?? PROJECTS_DIR, opts.projectName);
  const manifestPath = path.join(targetDir, 'mcp.manifest.json');

  if (!existsSync(path.join(targetDir, 'package.json'))) {
    throw new McpError(
      'mcp.unknown-project',
      `${targetDir} is not a scaffolded project (no package.json). Run \`smith new ${opts.projectName}\` first.`,
      { targetDir, projectName: opts.projectName },
    );
  }
  if (existsSync(manifestPath)) {
    throw new McpError(
      'mcp.surface-exists',
      `${manifestPath} already exists. Edit the manifest in place; re-scaffolding would discard declared tools and their operator sign-off.`,
      { manifestPath, projectName: opts.projectName },
    );
  }
  // Read the roadmap before writing anything, and throw here if it cannot be
  // read. The registration is the LAST step below, so a roadmap this command
  // cannot open used to fail after mcp.manifest.json existed — and the retry
  // then hit `mcp.surface-exists` above, which refuses on purpose. A mistyped
  // --roadmap-path left a half-initialised surface that the only command able
  // to finish it would permanently decline to touch.
  if (!opts.skipRoadmap) readRoadmapText(opts.roadmapPath);

  const filesWritten: string[] = [];
  copyTemplateDir(
    templateDir,
    targetDir,
    opts.projectName,
    filesWritten,
    new Set([PACKAGE_FRAGMENT_NAME]),
  );
  mergePackageJson(targetDir, path.join(templateDir, PACKAGE_FRAGMENT_NAME));

  const milestoneId = opts.skipRoadmap
    ? `${opts.projectName}-${MCP_MILESTONE_SUFFIX}`
    : registerMcpMilestone(opts.projectName, opts.roadmapPath);

  return {
    targetDir,
    manifestPath,
    filesWritten,
    milestoneId,
    protocolRevision: MCP_PROTOCOL_REVISION,
    transport: 'stdio',
  };
}

/**
 * Appends the `<project> — mcp surface` milestone to the roadmap. This is what
 * makes the surface *due*: docs/standards/mcp.md requires it to be closed
 * before the project's final milestone, and `smith epic close` refuses while
 * checkManifest is red.
 */
export function registerMcpMilestone(
  projectName: string,
  roadmapPath: string = ROADMAP_PATH,
): string {
  const id = `${projectName}-${MCP_MILESTONE_SUFFIX}`;
  const text = readRoadmapText(roadmapPath);
  // roadmapDeclaresId, not `text.includes('- id: ' + id)`: the substring is
  // not what parseRoadmap means by a declaration, and appending a second copy
  // of a milestone it already holds costs the whole file — milestoneId is the
  // milestones table's primary key, so parseRoadmap refuses the roadmap from
  // the duplicate onward, and `smith mcp init` cannot be run twice to undo it.
  if (roadmapDeclaresId(text, id)) return id; // idempotent — already registered

  const block =
    `\n## ${projectName} — mcp surface\n` +
    `- id: ${id}\n` +
    '- status: planned\n' +
    `- project: ${projectName}\n` +
    // Seeded, not empty: this list is what the epic-close gate reads to decide
    // the surface is due (resolveMcpSurface/ownsEpic), and `[]` matched no epic
    // at all — the gate shipped unreachable. Naming the epic here also states
    // in the roadmap itself which epic closes the milestone, the way
    // envkit-config-loader already does, instead of leaving it to convention.
    `- epics: [${id}]\n` +
    '- goal: Declare and harden the MCP surface — `smith mcp check` green against ' +
    'docs/standards/mcp.md. Required before the final milestone can close.\n';
  writeFileSync(roadmapPath, `${text.trimEnd()}\n${block}`, 'utf8');
  return id;
}

const MANIFEST_NAME = 'mcp.manifest.json';

/** The project's own `<project>-mcp-surface` milestone, if the roadmap declares one. */
function findSurfaceMilestone(
  milestones: readonly MilestoneDef[],
  project: string,
): MilestoneDef | null {
  return (
    milestones.find((m) => m.project === project && m.milestoneId.endsWith(MCP_MILESTONE_SUFFIX)) ??
    null
  );
}

/**
 * The roadmap half of the standard — docs/standards/mcp.md Enforcement step 2,
 * "the milestone is mandatory and closes before the project's final milestone".
 * checkManifest can only judge a manifest that exists; a project that never
 * registered the milestone has nothing to judge, which is the failure mode
 * these two rules cover.
 */
export function checkRoadmapMcpMilestone(
  project: string,
  milestones: readonly MilestoneDef[],
): McpViolation[] {
  const surface = findSurfaceMilestone(milestones, project);
  if (!surface) {
    return [
      {
        rule: 'MCP-M1',
        path: `/milestones/${project}`,
        message: `Project "${project}" has no \`${project}-${MCP_MILESTONE_SUFFIX}\` milestone. Run \`smith mcp init ${project}\` to register it.`,
      },
    ];
  }
  if (surface.status === 'completed') return [];

  // Only a violation once the rest of the project is done: while other work is
  // still open the surface is legitimately pending, and firing here would make
  // MCP-M2 a permanent red for every project from its first day.
  const others = milestones.filter(
    (m) => m.project === project && m.milestoneId !== surface.milestoneId,
  );
  if (others.length === 0 || !others.every((m) => m.status === 'completed')) return [];

  return [
    {
      rule: 'MCP-M2',
      path: `/milestones/${surface.milestoneId}`,
      message: `Every other "${project}" milestone is completed while ${surface.milestoneId} is "${surface.status}". A project reaching its last milestone without a closed MCP surface is not finished.`,
    },
  ];
}

/** How `targetDir` was arrived at — reported so a verdict names its subject. */
export type McpTargetSource = 'flag' | 'cwd' | 'default';

export interface McpTarget {
  targetDir: string;
  source: McpTargetSource;
}

export interface McpTargetOptions {
  projectName: string;
  /** `--target-dir`. Wins over everything, from anywhere. */
  targetDir?: string;
  /** Defaults to `process.cwd()`. Injectable so tests need not chdir. */
  cwd?: string;
  /**
   * The roots a project's checkouts are looked for in, first one winning when
   * nothing else answers. Defaults to PROJECTS_DIR then WORKSPACES_DIR: a
   * project lands beside this clone now, but one scaffolded before that still
   * sits under `workspaces/` and is not going to be forgotten for it.
   * Injectable for the same reason as `cwd`.
   */
  projectRoots?: readonly string[];
}

/**
 * Every checkout of `projectName` across every root: `<root>/<p>` plus each
 * task worktree beside it. Roots are searched in order and the result is
 * deduplicated, so overlapping roots enlarge the search without doubling a
 * candidate in the list an ambiguity refusal prints.
 */
function projectCheckouts(projectName: string, roots: readonly string[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const take = (dir: string): void => {
    if (seen.has(dir)) return;
    seen.add(dir);
    found.push(dir);
  };

  for (const root of roots) {
    const main = path.join(root, projectName);
    if (existsSync(main)) take(main);
    const worktreeRoot = path.join(root, '.wt', projectName);
    if (!existsSync(worktreeRoot)) continue;
    for (const entry of readdirSync(worktreeRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(worktreeRoot, e.name))
      .sort()) {
      take(entry);
    }
  }
  return found;
}

/** True when `cwd` is `dir` or lives under it — path-segment-wise, not by prefix. */
function isWithin(dir: string, cwd: string): boolean {
  const rel = path.relative(dir, cwd);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * D-133. Which checkout `smith mcp check <project>` is about.
 *
 * The old answer was `<root>/<project>`, unconditionally. During an epic that
 * is a *different valid checkout* from the one the caller is standing in —
 * task work happens in `<root>/.wt/<project>/<task-id>` — so the command
 * parsed a manifest the task had never touched and returned `ok: true`,
 * `violations: []`, exit 0, both before and after the very edit the check
 * existed to grade. A well-formed wrong answer is worse than a refusal, because
 * nothing about it invites a second look.
 *
 * So: an explicit `--target-dir` wins; otherwise the caller's own checkout
 * answers it; otherwise, if more than one checkout exists, refuse and name them
 * all. The default root is only assumed when nothing else is a candidate — and
 * "more than one" now spans every root, so a project that exists both beside
 * this clone and under the legacy `workspaces/` is a refusal, not a coin flip.
 */
export function resolveMcpTarget(opts: McpTargetOptions): McpTarget {
  if (opts.targetDir) return { targetDir: path.resolve(opts.targetDir), source: 'flag' };

  const roots = opts.projectRoots ?? [PROJECTS_DIR, WORKSPACES_DIR];
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const checkouts = projectCheckouts(opts.projectName, roots);

  // Deepest match wins: nothing nests today, but a checkout inside a checkout
  // should resolve to the inner one rather than to whichever came first.
  const containing = checkouts
    .filter((dir) => isWithin(dir, cwd))
    .sort((a, b) => b.length - a.length);
  if (containing[0]) return { targetDir: containing[0], source: 'cwd' };

  if (checkouts.length > 1) {
    throw new McpError(
      'mcp.ambiguous-target',
      `"${opts.projectName}" has ${checkouts.length} checkouts and ${cwd} is not inside any of them, so there is nothing to infer the target from. Pass --target-dir with one of:\n${checkouts
        .map((dir) => `  ${dir}`)
        .join('\n')}`,
      { projectName: opts.projectName, cwd, candidates: checkouts },
    );
  }

  // Exactly one checkout: that one, wherever it lives. Constructing
  // `<first root>/<project>` instead would have named a directory that does not
  // exist while a real one sat under the second root — the single-root code
  // this replaced got away with it only because the two were always the same
  // path. Nothing at all: the root a new project would land in, so the caller
  // is told where the surface is expected rather than where it is missing from.
  return {
    targetDir: checkouts[0] ?? path.join(roots[0] ?? PROJECTS_DIR, opts.projectName),
    source: 'default',
  };
}

export interface McpCheckReport extends McpCheckResult {
  projectName: string;
  /** The checkout that was graded. A verdict that does not name it is not one. */
  targetDir: string;
  targetSource: McpTargetSource;
  manifestPath: string;
  roadmapPath: string;
}

export interface McpCheckOptions extends McpTargetOptions {
  roadmapPath?: string;
}

/**
 * `smith mcp check` — the manifest verdict and the roadmap verdict in one
 * report. Refuses (rather than reporting a red) when there is no manifest at
 * all: "your surface is broken" and "you have no surface" are different
 * answers, and collapsing them would let `smith mcp init` be skipped silently.
 */
export function runMcpCheck(opts: McpCheckOptions): McpCheckReport {
  validateProjectName(opts.projectName);
  const { targetDir, source } = resolveMcpTarget(opts);
  const manifestPath = path.join(targetDir, MANIFEST_NAME);
  const roadmapPath = opts.roadmapPath ?? ROADMAP_PATH;

  if (!existsSync(manifestPath)) {
    throw new McpError(
      'mcp.no-surface',
      `${manifestPath} does not exist. Run \`smith mcp init ${opts.projectName}\` before checking the surface.`,
      { manifestPath, projectName: opts.projectName },
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (cause) {
    throw new McpError(
      'mcp.unreadable-manifest',
      `${manifestPath} is not valid JSON: ${(cause as Error).message}`,
      { manifestPath, projectName: opts.projectName },
    );
  }

  const violations = [
    ...checkManifest(manifest).violations,
    ...checkRoadmapMcpMilestone(opts.projectName, loadRoadmap(roadmapPath)),
  ];
  return {
    ok: violations.length === 0,
    violations,
    projectName: opts.projectName,
    targetDir,
    targetSource: source,
    manifestPath,
    roadmapPath,
  };
}

/**
 * What an epic-close gate needs to know about the surface: whether this epic is
 * the one that owes it, and — if so — what the manifest says.
 */
/**
 * Why no verdict could be rendered. D-198: these two states had collapsed into
 * `check: null`, and they take opposite remedies — `smith mcp init` declares a
 * surface that does not exist and REFUSES over one that does (mcp.surface-exists,
 * "edit the manifest in place"). A blocker that cannot tell them apart names the
 * wrong one half the time, and the half it gets wrong is a loop: the gate says
 * init, init says edit.
 *
 * Deliberately not the parser's message. That string can quote a slice of the
 * manifest back, and a blocker is persisted, not printed — guardrails.md's "no
 * secrets in outputs" covers the event log. `smith mcp check` is where the
 * parser's own words belong, and the blocker now says so.
 */
export type McpManifestProblem = 'missing' | 'unreadable';

export interface McpSurfaceStatus {
  /** True when the epic sits under a `<project>-mcp-surface` milestone. */
  required: boolean;
  milestoneId: string | null;
  manifestPath: string | null;
  /** null means "no verdict could be rendered" — see `problem` for which way. */
  check: McpCheckResult | null;
  /** Null exactly when `check` holds a verdict. */
  problem: McpManifestProblem | null;
}

/** The explicit "this epic owes no surface" value. Named so a skip is legible in a diff. */
export const MCP_SURFACE_NOT_REQUIRED: McpSurfaceStatus = Object.freeze({
  required: false,
  milestoneId: null,
  manifestPath: null,
  check: null,
  problem: null,
});

export interface ResolveMcpSurfaceOptions {
  epicId: string;
  /** The project working directory — where mcp.manifest.json lives. */
  projectDir: string;
  roadmapPath?: string;
}

/**
 * Reads the roadmap to decide whether this epic is under the mcp surface
 * milestone, and if so renders checkManifest over the project's real manifest.
 * A missing or unparseable manifest resolves to `check: null` rather than
 * throwing — mcpBlockers turns that into a refusal, so the gate reports the
 * problem instead of crashing the verdict that was meant to report it.
 *
 * `check` is checkManifest alone — deliberately not the roadmap rules that
 * `smith mcp check` also runs. Both M rules are meaningless or harmful here:
 *
 * - MCP-M1 ("no `<project>-mcp-surface` milestone") cannot fire. Reaching this
 *   line at all means a surface milestone was found and claims this epic.
 * - MCP-M2 fires when the surface milestone is not yet `completed` while every
 *   other milestone is. Nothing in this codebase ever writes a milestone
 *   status — registerMcpMilestone seeds `planned`, epic.ts never touches the
 *   roadmap, and only a human edit moves it to `completed`. So blocking the
 *   close on MCP-M2 would require the operator to mark the surface done before
 *   the gate would let them close the epic that makes it done, leaving the gate
 *   to rubber-stamp an assertion the operator had already been forced to write.
 *   That is the circularity D-108 described; it is unreal today only because
 *   the manifest rules are the ones wired here.
 *
 * MCP-M2's honest host is the *final* milestone's close — the standard's
 * "closes before the project's final milestone" — not this epic's. Wiring it
 * here is the tempting fix and it is the wrong one.
 */
export function resolveMcpSurface(opts: ResolveMcpSurfaceOptions): McpSurfaceStatus {
  const milestone = loadRoadmap(opts.roadmapPath).find(
    (m) => m.milestoneId.endsWith(MCP_MILESTONE_SUFFIX) && ownsEpic(m, opts.epicId),
  );
  if (!milestone) return MCP_SURFACE_NOT_REQUIRED;

  const manifestPath = path.join(opts.projectDir, MANIFEST_NAME);
  let check: McpCheckResult | null = null;
  let problem: McpManifestProblem | null = 'missing';
  if (existsSync(manifestPath)) {
    problem = 'unreadable';
    try {
      check = checkManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
      problem = null;
    } catch {
      // The reason stays here on purpose (see McpManifestProblem). runMcpCheck
      // is the caller that renders it, and it re-reads the file to do so.
    }
  }
  return { required: true, milestoneId: milestone.milestoneId, manifestPath, check, problem };
}

/**
 * The hard gate, expressed as blockers rather than its own refusal path
 * (operator decision of 2026-08-07). summarizeEpic folds these into
 * EpicSummary.blockers, which runEpicVerdict already turns into
 * hold/mechanical-blockers and closeEpic already refuses without
 * --override-rationale — so the override records the overridden MCP rules by
 * name, and there is exactly one override policy in the codebase.
 */
export function mcpBlockers(epicId: string, status: McpSurfaceStatus): string[] {
  if (!status.required) return [];
  const milestone = status.milestoneId ?? MCP_MILESTONE_SUFFIX;
  const manifest = status.manifestPath ?? MANIFEST_NAME;
  // Fail closed on `check === null` exactly as before; `problem` only chooses
  // the wording, so a status that somehow carries neither still blocks.
  if (!status.check) {
    return [
      status.problem === 'unreadable'
        ? `epic ${epicId} is under milestone ${milestone} but its MCP surface at ${manifest} exists and could not be read, so no verdict could be rendered — fix the manifest in place and run \`smith mcp check\` for the parser's own message. Do not re-run \`smith mcp init\`: it refuses over an existing manifest, because re-scaffolding would discard the declared tools and their operator sign-off.`
        : `epic ${epicId} is under milestone ${milestone} but has no MCP surface at ${manifest} — run \`smith mcp init\` and declare it.`,
    ];
  }
  return status.check.violations.map(
    (v) => `mcp surface ${milestone}: ${v.rule} at ${v.path} — ${v.message}`,
  );
}
