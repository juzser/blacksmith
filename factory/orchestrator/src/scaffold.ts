// New-project scaffolder (architecture §14 "Unified stack standard").
// `factory/scaffold/base/` is the always-copied template tree;
// `factory/scaffold/ui/` layers Vue+Vite on top for `--ui` projects, and
// `factory/scaffold/ui-tailwind/` layers the utility CSS over that when the
// operator answered `styling: tailwind`. What gets layered is not this
// module's opinion: factory/policies/stack.yml holds the answers, stack.ts
// parses them, and an answer these templates cannot build stops the scaffold
// (requireScaffoldable) instead of quietly producing a different project —
// which is what the old hardcoded "Vue + Tailwind + a private design system"
// path did to anyone who wanted something else. Deterministic file copy +
// string substitution only — no LLM calls, no network, no git push (guardrails.md:
// only the operator pushes/creates the remote; this module prints the
// commands for them to run, never executes them).
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { SmithError } from './errors.js';
import { runGit as git } from './git.js';
import { REPO_ROOT, ROADMAP_PATH, SCAFFOLD_DIR, WORKSPACES_DIR } from './paths.js';
import { readRoadmapText, roadmapDeclaresId } from './roadmap.js';
import { loadStackAnswers, requireScaffoldable, type StackAnswers } from './stack.js';

export class ScaffoldError extends SmithError {}

const PROJECT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const PLACEHOLDER = '__PROJECT_NAME__';
/** Extensions worth scanning for the placeholder token — binary/lockfile-shaped files are skipped. */
const TEXT_EXTENSIONS = new Set([
  '.json',
  '.ts',
  '.vue',
  '.md',
  '.yml',
  '.yaml',
  '.html',
  '.css',
  '.gitignore',
]);
/** Template-only files that get merged, not copied verbatim (see mergePackageJson). */
export const PACKAGE_FRAGMENT_NAME = 'package.fragment.json';
/**
 * Suffix stripped at copy time. `biome.json` specifically CANNOT live under
 * that literal name inside factory/scaffold/base/: Biome's own config
 * discovery treats every `biome.json` it finds as a project root, and a
 * nested one under black-smith's OWN root config trips "Found a nested root
 * configuration" and fails `pnpm exec biome check .` on THIS repo — a
 * problem that only exists while the template lives inside black-smith's
 * tree, not in the scaffolded project itself (which rightly wants
 * `biome.json` as ITS OWN root config). Renaming the template file sidesteps
 * discovery here without weakening the shipped config.
 */
const TEMPLATE_SUFFIX = '.tmpl';

export function validateProjectName(name: string): void {
  if (!PROJECT_NAME_PATTERN.test(name)) {
    throw new ScaffoldError(
      'scaffold.invalid-project-name',
      `Project name "${name}" must be lowercase kebab-case (^[a-z][a-z0-9-]*$).`,
      { name },
    );
  }
}

function destFileName(entry: string): string {
  return entry.endsWith(TEMPLATE_SUFFIX) ? entry.slice(0, -TEMPLATE_SUFFIX.length) : entry;
}

function isTextFile(destFilePath: string): boolean {
  const ext = path.extname(destFilePath) || path.basename(destFilePath); // .gitignore has no extname
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Recursively copy `srcDir` into `destDir`, substituting PLACEHOLDER in text
 * file contents. Exported for mcp.ts, which layers a template onto an ALREADY
 * scaffolded project rather than creating one — same copy semantics, different
 * precondition, so it reuses this instead of growing a second copier that
 * could drift on placeholder or `.tmpl` handling.
 */
export function copyTemplateDir(
  srcDir: string,
  destDir: string,
  projectName: string,
  filesWritten: string[],
  skip: Set<string> = new Set(),
): void {
  // Stripping TEMPLATE_SUFFIX means `x.yaml` and `x.yaml.tmpl` in ONE template
  // directory are two sources for one destination, and readdirSync does not
  // sort: which one survived was the filesystem's answer, not the repo's, and
  // the loser's edits were discarded in silence (D-179). Refuse instead —
  // there is no legitimate reason for two entries in the same directory to
  // target the same file. The map is per-directory on purpose: `ui/` copying
  // over a file `base/` already wrote is layering, which is by design.
  const claimedBy = new Map<string, string>();
  for (const entry of readdirSync(srcDir)) {
    if (skip.has(entry)) continue;
    const destName = destFileName(entry);
    const priorEntry = claimedBy.get(destName);
    if (priorEntry !== undefined) {
      throw new ScaffoldError(
        'scaffold.duplicate-destination',
        `Template entries "${priorEntry}" and "${entry}" both copy to "${destName}" in ${srcDir}. Delete one — the surviving copy is whichever the filesystem lists last.`,
        { srcDir, destName, entries: [priorEntry, entry] },
      );
    }
    claimedBy.set(destName, entry);
    const srcPath = path.join(srcDir, entry);
    const destPath = path.join(destDir, destName);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copyTemplateDir(srcPath, destPath, projectName, filesWritten, skip);
      continue;
    }
    mkdirSync(path.dirname(destPath), { recursive: true });
    if (isTextFile(destPath)) {
      const text = readFileSync(srcPath, 'utf8').split(PLACEHOLDER).join(projectName);
      writeFileSync(destPath, text, 'utf8');
    } else {
      copyFileSync(srcPath, destPath);
    }
    filesWritten.push(destPath);
  }
}

interface PackageJsonShape {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/** Deep-merges a `package.fragment.json` (ui variant's extra scripts/deps) onto the base package.json. */
export function mergePackageJson(targetDir: string, fragmentPath: string): void {
  const packageJsonPath = path.join(targetDir, 'package.json');
  const base = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJsonShape;
  const fragment = JSON.parse(readFileSync(fragmentPath, 'utf8')) as PackageJsonShape;

  for (const section of ['scripts', 'dependencies', 'devDependencies'] as const) {
    base[section] = { ...(base[section] ?? {}), ...(fragment[section] ?? {}) };
  }

  writeFileSync(packageJsonPath, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
}

/** Verbatim recursive copy — no placeholder substitution, no `.tmpl` stripping. */
function copyTree(srcDir: string, destDir: string, written: string[]): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const src = path.join(srcDir, entry);
    const dest = path.join(destDir, entry);
    if (statSync(src).isDirectory()) {
      copyTree(src, dest, written);
      continue;
    }
    copyFileSync(src, dest);
    written.push(dest);
  }
}

/**
 * Vendor the operator's design system into `<project>/design/`.
 *
 * Vendored, never referenced from an external repo: a design system a project
 * cannot build offline is a dependency on somebody else's uptime. What is
 * copied comes from stack.yml, not from here — this repo used to hardcode its
 * own dashboard's private kit as `hds/` in every scaffolded project, which
 * made every project downstream of a design system its operator could not
 * obtain. `design_system: none` vendors nothing, which is the right answer
 * for a project that owns its own components.
 *
 * A named source that does not exist is a refusal, not a skip. The previous
 * version's `if (!existsSync(src)) continue` meant a moved kit produced a
 * project whose stylesheet imported a directory that was never written, and
 * the scaffold reported success. Resolution is split out from the copy so the
 * refusal lands before the target directory exists, rather than leaving half
 * a project for the operator to clean up.
 */
function resolveDesignSystemSource(stack: StackAnswers, repoRoot: string): string | null {
  if (stack.designSystem === 'none' || stack.designSystemSource === '') return null;
  const source = stack.designSystemSource;
  const sourceDir = path.isAbsolute(source) ? source : path.join(repoRoot, source);
  if (!existsSync(sourceDir)) {
    throw new ScaffoldError(
      'scaffold.design-system-missing',
      `factory/policies/stack.yml names design_system_source ${source}, which does not exist (looked in ${sourceDir}). Fix the path or set design_system: none.`,
      { designSystem: stack.designSystem, source, sourceDir },
    );
  }
  return sourceDir;
}

/** Copy the resolved kit in. Resolution already happened, and already refused. */
function vendorDesignSystem(targetDir: string, sourceDir: string | null): string[] {
  if (sourceDir === null) return [];
  const written: string[] = [];
  copyTree(sourceDir, path.join(targetDir, DESIGN_DIR), written);
  return written;
}

/** Where a vendored kit lands, and the token file the style entry imports if it finds one. */
const DESIGN_DIR = 'design';
const DESIGN_TOKENS_FILE = 'tokens.css';

/**
 * Write `src/styles/main.css`, which is generated rather than copied.
 *
 * Its whole content is a consequence of two answers — whether Tailwind is the
 * utility layer, and whether a design system was vendored — so a static
 * template could only be right for one combination. It was: `@import
 * 'tailwindcss'` over `@import '../../hds/hds-tokens.css'`, both unconditional.
 */
function writeStyleEntry(targetDir: string, stack: StackAnswers): string {
  const lines = [
    '/* Style entry, generated once from the stack answers',
    ` * (styling: ${stack.styling}, design_system: ${stack.designSystem}).`,
    ' * Yours from here — nothing regenerates this file.',
    ' */',
  ];
  if (stack.styling === 'tailwind') lines.push("@import 'tailwindcss';");
  const tokens = path.join(targetDir, DESIGN_DIR, DESIGN_TOKENS_FILE);
  if (existsSync(tokens)) lines.push(`@import '../../${DESIGN_DIR}/${DESIGN_TOKENS_FILE}';`);
  else if (stack.designSystem !== 'none') {
    lines.push(
      `/* ${stack.designSystem} is vendored under ${DESIGN_DIR}/ but ships no`,
      ` * ${DESIGN_TOKENS_FILE} — import its entry point here. */`,
    );
  }
  lines.push(
    '',
    '.app {',
    '  margin: 0 auto;',
    '  max-width: 60rem;',
    '  padding: 2rem 1.5rem;',
    '}',
    '',
  );
  const dest = path.join(targetDir, 'src', 'styles', 'main.css');
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, lines.join('\n'), 'utf8');
  return dest;
}

const SETUP_BRANCH = 'setup';

/**
 * Who the first commit is attributed to when the machine can name nobody.
 * Deliberately not a person and not a deliverable address: nobody authored
 * this commit, so a later `git log` should name the step it belongs to rather
 * than implicate whoever's laptop happened to run it.
 */
const FALLBACK_IDENTITY = { name: 'setup', email: 'setup@localhost' };

/** 'configured' when the machine already names a committer, 'fallback' when this repo had to. */
export type CommitIdentity = 'configured' | 'fallback' | 'skipped';

/**
 * git needs an identity to commit, and on a machine with none it guesses one
 * from the username and hostname — unless the username is empty (`fatal: empty
 * ident name`) or `user.useConfigOnly` turned guessing off. A GitHub runner is
 * the first case, which is how black-smith's own CI found this: every
 * `smith new` inside a fresh container died on the scaffold's first commit.
 *
 * The scaffolder creates this repo, so no one outside it gets a chance to
 * configure an identity in between — the fallback has to live here. It is
 * written repo-locally, so it can never leak into the operator's global
 * config, and only when git itself says it has nothing.
 */
function ensureCommitIdentity(targetDir: string): CommitIdentity {
  try {
    git(targetDir, ['var', 'GIT_COMMITTER_IDENT']);
    return 'configured';
  } catch {
    git(targetDir, ['config', 'user.name', FALLBACK_IDENTITY.name]);
    git(targetDir, ['config', 'user.email', FALLBACK_IDENTITY.email]);
    return 'fallback';
  }
}

/** git init + first commit on a `setup` branch — never touches/pushes main (guardrails.md). */
function initGitRepo(targetDir: string): CommitIdentity {
  git(targetDir, ['init']);
  git(targetDir, ['checkout', '-b', SETUP_BRANCH]);
  const identity = ensureCommitIdentity(targetDir);
  git(targetDir, ['add', '-A']);
  git(targetDir, ['commit', '-m', 'Initial project scaffold']);
  return identity;
}

export interface CommandResult {
  exitCode: number | null;
  /** stdout and stderr interleaved, as the operator would have seen them. */
  output: string;
}

export type RunCommand = (command: string, args: readonly string[], cwd: string) => CommandResult;

/**
 * Install, then the project's own gates in the order ci.yml runs them.
 *
 * The order is the point (P9-19): a scaffold that proves a different sequence
 * than CI proves nothing about CI. `pnpm install` carries no
 * `--frozen-lockfile` because this run is what CREATES the lockfile that CI's
 * frozen install then checks against — the reason the first PR out of any epic
 * used to red-CI on step one.
 */
const TOOLCHAIN_STEPS: readonly { name: string; command: string; args: readonly string[] }[] = [
  { name: 'install', command: 'pnpm', args: ['install'] },
  { name: 'lint', command: 'pnpm', args: ['run', 'lint'] },
  { name: 'typecheck', command: 'pnpm', args: ['run', 'typecheck'] },
  { name: 'typecheck:test', command: 'pnpm', args: ['run', 'typecheck:test'] },
  { name: 'test:coverage', command: 'pnpm', args: ['run', 'test:coverage'] },
  { name: 'build', command: 'pnpm', args: ['run', 'build'] },
];

/** Enough of a failing step's tail to diagnose from, bounded so a runaway log can't become the CLI's entire output. */
const OUTPUT_TAIL_BYTES = 4096;

export interface ToolchainStepReport {
  name: string;
  /** The exact line to re-run by hand. */
  command: string;
  ok: boolean;
  exitCode: number | null;
  /** Tail of the combined output — present only when the step failed. */
  output?: string;
}

export interface ToolchainReport {
  status: 'verified' | 'failed' | 'skipped';
  steps: ToolchainStepReport[];
  /** The first step that went red, when there was one. */
  failedStep?: string;
  /** Why nothing ran, when nothing ran. */
  reason?: string;
}

export interface ScaffoldOptions {
  projectName: string;
  ui: boolean;
  /** Defaults to REPO_ROOT/workspaces/<projectName>. */
  targetDir?: string;
  templateDir?: string; // defaults to factory/scaffold/
  /** Resolves a relative `design_system_source`; defaults to REPO_ROOT. */
  repoRoot?: string;
  /**
   * The operator's stack answers; defaults to factory/policies/stack.yml.
   * Injected by tests so a unit test asserts against the answers it names
   * rather than against whatever this clone's operator happens to run.
   */
  stack?: StackAnswers;
  /** Skip git init/commit — used by tests that only care about the file tree. */
  skipGit?: boolean;
  /**
   * Skip the install and gate run. The scaffold still succeeds and the report
   * says `skipped` with a reason — a scaffold that quietly reported nothing is
   * the D-3 gap with extra steps. For offline operators and for tests, which
   * have no business installing from the network.
   */
  skipToolchain?: boolean;
  /** Injection seam for the toolchain runner; defaults to a real spawnSync. */
  runCommand?: RunCommand;
}

export interface ScaffoldCommands {
  ghRepoCreate: string;
  push: string;
}

export interface ScaffoldResult {
  targetDir: string;
  filesWritten: string[];
  branch: string;
  commands: ScaffoldCommands;
  toolchain: ToolchainReport;
  /** Whose name is on the first commit: the machine's, or the placeholder this repo had to invent. */
  commitIdentity: CommitIdentity;
}

const defaultRunCommand: RunCommand = (command, args, cwd) => {
  const proc = spawnSync(command, [...args], { cwd, encoding: 'utf8' });
  if (proc.error) return { exitCode: null, output: proc.error.message };
  return { exitCode: proc.status, output: `${proc.stdout ?? ''}${proc.stderr ?? ''}` };
};

/**
 * Install the toolchain and run the project's own gates against it, so the
 * first epic planned in this project inherits a repo whose checks are known to
 * pass rather than a serial `task-0-toolchain` that claims the hottest files in
 * the tree (D-3, D-4). The cost belongs to scaffolding, not to that epic's
 * budget.
 *
 * Stops at the first red step, exactly as ci.yml's step list does: the answer
 * the operator needs is which gate went red first, and running four more
 * commands against a tree that failed `install` produces noise, not evidence.
 * Never throws — a scaffold whose gates fail is still a tree worth keeping and
 * fixing; the caller decides what a failed report is worth (`smith new` exits
 * non-zero on one).
 */
function runToolchain(targetDir: string, run: RunCommand): ToolchainReport {
  const steps: ToolchainStepReport[] = [];
  for (const step of TOOLCHAIN_STEPS) {
    const line = [step.command, ...step.args].join(' ');
    const { exitCode, output } = run(step.command, step.args, targetDir);
    const ok = exitCode === 0;
    steps.push({
      name: step.name,
      command: line,
      ok,
      exitCode,
      ...(ok ? {} : { output: output.slice(-OUTPUT_TAIL_BYTES) }),
    });
    if (!ok) return { status: 'failed', steps, failedStep: step.name };
  }
  return { status: 'verified', steps };
}

export function scaffoldProject(opts: ScaffoldOptions): ScaffoldResult {
  validateProjectName(opts.projectName);
  const stack = opts.stack ?? loadStackAnswers();
  // Before the directory is created, not after: a refusal that leaves half a
  // project behind is a refusal the operator has to clean up.
  requireScaffoldable(stack, { ui: opts.ui });

  const templateDir = opts.templateDir ?? SCAFFOLD_DIR;
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const designSystemDir = opts.ui ? resolveDesignSystemSource(stack, repoRoot) : null;
  const targetDir = opts.targetDir ?? path.join(WORKSPACES_DIR, opts.projectName);

  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new ScaffoldError(
      'scaffold.target-exists',
      `Refusing to scaffold into a non-empty directory: ${targetDir}.`,
      { targetDir },
    );
  }
  mkdirSync(targetDir, { recursive: true });

  const filesWritten: string[] = [];
  const baseDir = path.join(templateDir, 'base');
  copyTemplateDir(baseDir, targetDir, opts.projectName, filesWritten);

  if (opts.ui) {
    const uiDir = path.join(templateDir, 'ui');
    copyTemplateDir(
      uiDir,
      targetDir,
      opts.projectName,
      filesWritten,
      new Set([PACKAGE_FRAGMENT_NAME]),
    );
    mergePackageJson(targetDir, path.join(uiDir, PACKAGE_FRAGMENT_NAME));
    if (stack.styling === 'tailwind') {
      // A layer, not a variant: it overwrites vite.config.ts with the same
      // file plus the plugin, and merges the dependency in. `plain-css`
      // projects never see Tailwind in their lockfile, which is the point.
      const tailwindDir = path.join(templateDir, 'ui-tailwind');
      copyTemplateDir(
        tailwindDir,
        targetDir,
        opts.projectName,
        filesWritten,
        new Set([PACKAGE_FRAGMENT_NAME]),
      );
      mergePackageJson(targetDir, path.join(tailwindDir, PACKAGE_FRAGMENT_NAME));
    }
    filesWritten.push(...vendorDesignSystem(targetDir, designSystemDir));
    filesWritten.push(writeStyleEntry(targetDir, stack));
  }

  // Before the commit, not after: `pnpm install` is what writes
  // pnpm-lock.yaml, and a lockfile outside the first commit is a lockfile
  // ci.yml's `--frozen-lockfile` cannot see.
  const toolchain: ToolchainReport = opts.skipToolchain
    ? {
        status: 'skipped',
        steps: [],
        reason: 'skipToolchain was set — no install ran, and no gate was proven.',
      }
    : runToolchain(targetDir, opts.runCommand ?? defaultRunCommand);

  const commitIdentity: CommitIdentity = opts.skipGit ? 'skipped' : initGitRepo(targetDir);

  return {
    targetDir,
    filesWritten,
    branch: SETUP_BRANCH,
    toolchain,
    commitIdentity,
    commands: {
      ghRepoCreate: `gh repo create ${opts.projectName} --private --source=${targetDir} --remote=origin --push=false`,
      push: `git -C ${targetDir} push -u origin ${SETUP_BRANCH}`,
    },
  };
}

/**
 * Appends a bootstrap milestone for the new project to factory/specs/
 * roadmap.md (architecture §12: "the planner maintains it"; a fresh project
 * gets a placeholder milestone so the Projects/Roadmap pages have something
 * to show the moment it exists, edited further as real epics get scoped).
 */
export function registerProjectInRoadmap(
  projectName: string,
  roadmapPath: string = ROADMAP_PATH,
): void {
  const text = readRoadmapText(roadmapPath);
  const id = `${projectName}-bootstrap`;
  // See registerMcpMilestone: the substring `- id: <id>` is not what
  // parseRoadmap reads, and a duplicate id takes the whole roadmap away from
  // every reader of it rather than merely adding a stray section.
  if (roadmapDeclaresId(text, id)) return; // idempotent — already registered
  const block =
    `\n## ${projectName} — bootstrap\n` +
    `- id: ${id}\n` +
    '- status: planned\n' +
    `- project: ${projectName}\n` +
    '- epics: []\n' +
    '- goal: Scaffold complete; awaiting the first planned epic.\n';
  writeFileSync(roadmapPath, `${text.trimEnd()}\n${block}`, 'utf8');
}
