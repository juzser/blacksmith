// Scaffolder tests. `pnpm install` is deliberately never run here (network +
// minutes-slow) — instead we validate the scaffold's OWN check commands
// would have something valid to run against: every JSON/YAML file parses,
// every .ts file is syntactically valid (checked with the ALREADY-installed
// root repo's Biome binary — typescript@7's npm package is the Go-native
// rewrite and no longer ships the classic transpileModule() compiler API, so
// Biome's parser is the available syntax-only check that needs no
// node_modules inside the scaffolded tree itself), and the expected file set
// + substitutions are exactly right. Noted per the task brief: this is
// "structure + parseability", not a real `pnpm install && pnpm run lint &&
// ...` run.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { REPO_ROOT, SCAFFOLD_DIR } from '../src/paths.js';
import { parseRoadmap, RoadmapError } from '../src/roadmap.js';
import {
  copyTemplateDir,
  registerProjectInRoadmap,
  ScaffoldError,
  scaffoldProject,
  validateProjectName,
} from '../src/scaffold.js';
import type { StackAnswers } from '../src/stack.js';
import { git, runOrThrow } from './helpers/process.js';

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

/**
 * A UI operator's stack answers, injected rather than read from
 * factory/policies/stack.yml.
 *
 * The shipped answers say `frontend: none` — most projects are not UI
 * projects — so a `--ui` test that read the file would be asserting against
 * whatever this clone's operator happened to answer, and would go red the day
 * they answered honestly. Tests that exercise the UI layer name the answers
 * they are testing.
 */
function uiStack(overrides: Partial<StackAnswers> = {}): StackAnswers {
  return {
    language: 'typescript',
    frontend: 'vue',
    designSystem: 'none',
    designSystemSource: '',
    styling: 'plain-css',
    backend: 'none',
    database: 'none',
    orm: 'none',
    packageManager: 'pnpm',
    repoShape: 'single',
    lint: 'biome',
    testUnit: 'vitest',
    testE2e: 'playwright',
    ci: 'github-actions',
    hosting: 'unspecified',
    ...overrides,
  };
}

/** A throwaway design-system kit on disk, to vendor from. */
function mkDesignKit(prefix: string): string {
  const dir = mkScratch(prefix);
  const kit = path.join(dir, 'kit');
  mkdirSync(path.join(kit, 'components'), { recursive: true });
  writeFileSync(path.join(kit, 'tokens.css'), ':root {\n  --ds-accent: #0a7;\n}\n', 'utf8');
  writeFileSync(path.join(kit, 'components', 'button.css'), '.ds-button {\n}\n', 'utf8');
  return kit;
}

function assertParseableJson(filePath: string): void {
  expect(() => JSON.parse(readFileSync(filePath, 'utf8'))).not.toThrow();
}

function assertParseableYaml(filePath: string): void {
  expect(() => parseYaml(readFileSync(filePath, 'utf8'))).not.toThrow();
}

/** Runs the scaffold's own Biome config against one file, relative to the scaffolded project root. */
function assertValidTypeScriptSyntax(targetDir: string, relPath: string): void {
  expect(() =>
    execFileSync(BIOME_BIN, ['check', relPath], { cwd: targetDir, encoding: 'utf8' }),
  ).not.toThrow();
}

/**
 * Runs `body` against a git that sees exactly `config` and nothing else — no
 * system config, no `~/.gitconfig`, no `GIT_AUTHOR_*`/`EMAIL` inherited from
 * whoever started vitest. `user.useConfigOnly` is what makes the sandbox
 * faithful: it disables the guess-from-username-and-hostname path, which is
 * the only reason an unconfigured laptop commits at all.
 */
function withGitConfig(workDir: string, config: string, body: () => void): void {
  const configPath = path.join(workDir, 'sandbox-gitconfig');
  writeFileSync(configPath, config, 'utf8');
  const overrides: Record<string, string | undefined> = {
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: undefined,
    GIT_AUTHOR_EMAIL: undefined,
    GIT_COMMITTER_NAME: undefined,
    GIT_COMMITTER_EMAIL: undefined,
    EMAIL: undefined,
  };
  const saved = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('scaffold.ts', () => {
  it('rejects a non-kebab-case project name', () => {
    expect(() => validateProjectName('Not Valid')).toThrow(ScaffoldError);
    expect(() => validateProjectName('_bad')).toThrow(ScaffoldError);
    expect(() => validateProjectName('good-name-2')).not.toThrow();
  });

  it('scaffolds the base file set with name substitution, all parseable, no git by default skip flag off', () => {
    const workDir = mkScratch('smith-scaffold-base-');
    const targetDir = path.join(workDir, 'wt', 'acme-widgets');

    const result = scaffoldProject({
      projectName: 'acme-widgets',
      ui: false,
      targetDir,
      templateDir: SCAFFOLD_DIR,
      repoRoot: REPO_ROOT,
      // This suite never installs (see the file header); the toolchain run is
      // exercised with an injected runner in "scaffold toolchain (P9-19)".
      skipToolchain: true,
    });

    expect(result.targetDir).toBe(targetDir);
    expect(result.branch).toBe('setup');

    const expectedFiles = [
      'package.json',
      'tsconfig.json',
      'biome.json',
      'pnpm-workspace.yaml',
      'vitest.config.ts',
      '.gitignore',
      'AGENTS.md',
      '.github/workflows/ci.yml',
      'src/index.ts',
      'test/index.test.ts',
    ];
    for (const rel of expectedFiles) {
      expect(existsSync(path.join(targetDir, rel)), `missing ${rel}`).toBe(true);
    }
    // No UI files leaked into a non-UI scaffold.
    expect(existsSync(path.join(targetDir, 'design'))).toBe(false);
    expect(existsSync(path.join(targetDir, 'src/styles'))).toBe(false);
    expect(existsSync(path.join(targetDir, 'vite.config.ts'))).toBe(false);

    const pkg = JSON.parse(readFileSync(path.join(targetDir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('acme-widgets');

    const agentsMd = readFileSync(path.join(targetDir, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('acme-widgets — Agent Router');
    expect(agentsMd).not.toContain('__PROJECT_NAME__');

    assertParseableJson(path.join(targetDir, 'package.json'));
    assertParseableJson(path.join(targetDir, 'tsconfig.json'));
    assertParseableJson(path.join(targetDir, 'biome.json'));
    assertParseableYaml(path.join(targetDir, '.github/workflows/ci.yml'));
    assertValidTypeScriptSyntax(targetDir, 'src/index.ts');
    assertValidTypeScriptSyntax(targetDir, 'test/index.test.ts');
    assertValidTypeScriptSyntax(targetDir, 'vitest.config.ts');

    // git init + first commit on `setup`, never touching main.
    const branch = git(targetDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    expect(branch).toBe('setup');
    const log = git(targetDir, ['log', '--oneline']);
    expect(log.split('\n').filter(Boolean)).toHaveLength(1);

    expect(result.commands.ghRepoCreate).toContain('gh repo create acme-widgets');
    expect(result.commands.push).toContain('push -u origin setup');
  });

  // Found by black-smith's own first CI run, not by review: the GitHub runner
  // has no git identity AND an empty GECOS name, so git refuses to invent one
  // and `git commit` dies with `fatal: empty ident name`. Every `smith new` in
  // a fresh container hits it; macOS hides it because the OS supplies a full
  // name for git to guess from. The scaffolder creates the repo it commits to,
  // so nothing outside it can configure the identity first — the fallback has
  // to live in the product.
  it('commits on a machine with no git identity at all (fresh container, CI runner)', () => {
    const workDir = mkScratch('smith-scaffold-noident-');
    const targetDir = path.join(workDir, 'wt', 'acme-anon');

    withGitConfig(workDir, '[user]\n\tuseConfigOnly = true\n', () => {
      const result = scaffoldProject({
        projectName: 'acme-anon',
        ui: false,
        targetDir,
        templateDir: SCAFFOLD_DIR,
        repoRoot: REPO_ROOT,
        skipToolchain: true,
      });
      expect(result.commitIdentity).toBe('fallback');
    });

    const log = git(targetDir, ['log', '--format=%an <%ae>']).trim();
    expect(log.split('\n').filter(Boolean)).toHaveLength(1);
    // A placeholder, and legibly one: nobody should read this as a person who
    // reviewed the scaffold.
    expect(log).toBe('black-smith <black-smith@localhost>');
  });

  it('leaves a configured identity alone — the fallback is a fallback', () => {
    const workDir = mkScratch('smith-scaffold-ident-');
    const targetDir = path.join(workDir, 'wt', 'acme-named');

    withGitConfig(
      workDir,
      '[user]\n\tuseConfigOnly = true\n\tname = Ada Lovelace\n\temail = ada@example.com\n',
      () => {
        const result = scaffoldProject({
          projectName: 'acme-named',
          ui: false,
          targetDir,
          templateDir: SCAFFOLD_DIR,
          repoRoot: REPO_ROOT,
          skipToolchain: true,
        });
        expect(result.commitIdentity).toBe('configured');
      },
    );

    expect(git(targetDir, ['log', '-1', '--format=%an <%ae>']).trim()).toBe(
      'Ada Lovelace <ada@example.com>',
    );
  });

  // P9-16(c). A scaffolded project lives at `workspaces/<name>` — INSIDE
  // black-smith's own tree. pnpm decides which workspace it belongs to by
  // walking UP until it finds a `pnpm-workspace.yaml`, so a project with no
  // marker of its own silently joins the factory's workspace: `pnpm install`
  // run in the new project writes black-smith's lockfile and links into
  // black-smith's `node_modules`. Measured before the fix: `pnpm root -w` in
  // a fresh scaffold answered `<black-smith>/node_modules`.
  it('plants its own workspace root so pnpm stops at the project (P9-16c)', () => {
    const workDir = mkScratch('smith-scaffold-nested-');
    // Stand-in for black-smith: a workspace root ABOVE the scaffold target.
    const parentDir = path.join(workDir, 'parent');
    mkdirSync(path.join(parentDir, 'workspaces'), { recursive: true });
    writeFileSync(
      path.join(parentDir, 'pnpm-workspace.yaml'),
      "packages:\n  - 'workspaces/*'\n",
      'utf8',
    );
    writeFileSync(
      path.join(parentDir, 'package.json'),
      '{"name":"parent","private":true}\n',
      'utf8',
    );
    const targetDir = path.join(parentDir, 'workspaces', 'acme-widgets');

    scaffoldProject({
      projectName: 'acme-widgets',
      ui: false,
      targetDir,
      templateDir: SCAFFOLD_DIR,
      repoRoot: REPO_ROOT,
      skipGit: true,
      // Written before P9-19 gave the scaffold a toolchain run; without this
      // the test installs from the network before it measures anything, which
      // is minutes of nothing to do with where pnpm thinks the workspace root
      // is. `pnpm root -w` below needs no node_modules to answer.
      skipToolchain: true,
    });

    const marker = path.join(targetDir, 'pnpm-workspace.yaml');
    expect(existsSync(marker), 'missing pnpm-workspace.yaml').toBe(true);
    expect(parseYaml(readFileSync(marker, 'utf8')).packages).toEqual(['.']);

    // The half that measures rather than asserts: pnpm's OWN answer to
    // "which workspace am I in". A file that exists but does not stop the
    // walk would pass the check above and still leave the bug in place.
    const nodeModules = runOrThrow('pnpm', ['root', '-w'], { cwd: targetDir }).stdout.trim();
    expect(realpathSync(path.dirname(nodeModules))).toBe(realpathSync(targetDir));
  });

  it('--ui adds Vue+Vite, generates the style entry, and merges package.json', () => {
    const workDir = mkScratch('smith-scaffold-ui-');
    const targetDir = path.join(workDir, 'wt', 'acme-dashboard');

    scaffoldProject({
      projectName: 'acme-dashboard',
      ui: true,
      targetDir,
      templateDir: SCAFFOLD_DIR,
      repoRoot: REPO_ROOT,
      stack: uiStack(),
      skipGit: true,
      skipToolchain: true,
    });

    for (const rel of [
      'vite.config.ts',
      'index.html',
      'src/main.ts',
      'src/App.vue',
      'src/shims.d.ts',
      'src/styles/main.css',
    ]) {
      expect(existsSync(path.join(targetDir, rel)), `missing ${rel}`).toBe(true);
    }

    const appVue = readFileSync(path.join(targetDir, 'src/App.vue'), 'utf8');
    expect(appVue).toContain('acme-dashboard');
    expect(appVue).not.toContain('__PROJECT_NAME__');

    const pkg = JSON.parse(readFileSync(path.join(targetDir, 'package.json'), 'utf8'));
    expect(pkg.dependencies.vue).toBeDefined();
    expect(pkg.devDependencies.vite).toBeDefined();
    expect(pkg.scripts['build:ui']).toBeDefined();
    // Base scripts survive the merge.
    expect(pkg.scripts.build).toBe('tsc -p tsconfig.json');

    assertParseableJson(path.join(targetDir, 'package.json'));
    assertValidTypeScriptSyntax(targetDir, 'src/main.ts');
    assertValidTypeScriptSyntax(targetDir, 'src/shims.d.ts');
    assertValidTypeScriptSyntax(targetDir, 'vite.config.ts');

    // `design_system: none` vendors nothing — the project owns its components
    // — and `styling: plain-css` puts no utility layer in the lockfile. Both
    // used to be unconditional: every scaffolded UI project got Tailwind and a
    // copy of this repo's own private kit, whatever its operator wanted.
    expect(existsSync(path.join(targetDir, 'design'))).toBe(false);
    expect(pkg.devDependencies['@tailwindcss/vite']).toBeUndefined();
    const css = readFileSync(path.join(targetDir, 'src/styles/main.css'), 'utf8');
    expect(css).not.toContain('tailwindcss');
    expect(css).not.toContain('design/');
    expect(css).toContain('.app {');
  });

  it('--ui with styling: tailwind layers the utility CSS over the same template', () => {
    const workDir = mkScratch('smith-scaffold-tw-');
    const targetDir = path.join(workDir, 'wt', 'acme-tw');

    scaffoldProject({
      projectName: 'acme-tw',
      ui: true,
      targetDir,
      templateDir: SCAFFOLD_DIR,
      repoRoot: REPO_ROOT,
      stack: uiStack({ styling: 'tailwind' }),
      skipGit: true,
      skipToolchain: true,
    });

    const css = readFileSync(path.join(targetDir, 'src/styles/main.css'), 'utf8');
    expect(css).toContain("@import 'tailwindcss';");

    const pkg = JSON.parse(readFileSync(path.join(targetDir, 'package.json'), 'utf8'));
    expect(pkg.devDependencies['@tailwindcss/vite']).toBeDefined();
    // The layer overwrites vite.config.ts rather than shipping a second one:
    // one plugin list, with Tailwind added to it.
    const vite = readFileSync(path.join(targetDir, 'vite.config.ts'), 'utf8');
    expect(vite).toContain('tailwindcss()');
    expect(vite).toContain('vue()');
    assertValidTypeScriptSyntax(targetDir, 'vite.config.ts');
  });

  it('--ui vendors the named design system and imports its tokens', () => {
    const kit = mkDesignKit('smith-scaffold-ds-');
    const workDir = mkScratch('smith-scaffold-dsproj-');
    const targetDir = path.join(workDir, 'wt', 'acme-ds');

    scaffoldProject({
      projectName: 'acme-ds',
      ui: true,
      targetDir,
      templateDir: SCAFFOLD_DIR,
      repoRoot: REPO_ROOT,
      stack: uiStack({ designSystem: 'acme-ds', designSystemSource: kit }),
      skipGit: true,
      skipToolchain: true,
    });

    // Vendored, not referenced: the copy is verbatim and recursive, so the
    // scaffolded project builds with the network unplugged.
    expect(readFileSync(path.join(targetDir, 'design/tokens.css'), 'utf8')).toBe(
      readFileSync(path.join(kit, 'tokens.css'), 'utf8'),
    );
    expect(existsSync(path.join(targetDir, 'design/components/button.css'))).toBe(true);

    const css = readFileSync(path.join(targetDir, 'src/styles/main.css'), 'utf8');
    expect(css).toContain("@import '../../design/tokens.css';");
  });

  it('refuses a design_system_source that does not exist, before creating anything', () => {
    const workDir = mkScratch('smith-scaffold-dsmiss-');
    const targetDir = path.join(workDir, 'wt', 'acme-dsmiss');

    expect(() =>
      scaffoldProject({
        projectName: 'acme-dsmiss',
        ui: true,
        targetDir,
        templateDir: SCAFFOLD_DIR,
        repoRoot: REPO_ROOT,
        stack: uiStack({
          designSystem: 'acme-ds',
          designSystemSource: path.join(workDir, 'no-such-kit'),
        }),
        skipGit: true,
        skipToolchain: true,
      }),
    ).toThrow(ScaffoldError);
    // A refusal that leaves half a project behind is a refusal the operator
    // has to clean up; the old best-effort copy left one that also imported a
    // directory it had never written, and reported success.
    expect(existsSync(targetDir)).toBe(false);
  });

  it('refuses --ui when the operator does not build a frontend', () => {
    const workDir = mkScratch('smith-scaffold-nofe-');
    const targetDir = path.join(workDir, 'wt', 'acme-nofe');

    expect(() =>
      scaffoldProject({
        projectName: 'acme-nofe',
        ui: true,
        targetDir,
        templateDir: SCAFFOLD_DIR,
        repoRoot: REPO_ROOT,
        stack: uiStack({ frontend: 'none' }),
        skipGit: true,
        skipToolchain: true,
      }),
    ).toThrow(/frontend/);
    expect(existsSync(targetDir)).toBe(false);
  });

  it('refuses a frontend the templates cannot build, rather than handing over Vue', () => {
    const workDir = mkScratch('smith-scaffold-react-');
    const targetDir = path.join(workDir, 'wt', 'acme-react');

    expect(() =>
      scaffoldProject({
        projectName: 'acme-react',
        ui: true,
        targetDir,
        templateDir: SCAFFOLD_DIR,
        repoRoot: REPO_ROOT,
        stack: uiStack({ frontend: 'react' }),
        skipGit: true,
        skipToolchain: true,
      }),
    ).toThrow(/react/);
    expect(existsSync(targetDir)).toBe(false);
  });

  it('--ui variant: shims.d.ts declares every non-.ts asset type main.ts imports (real tsc typecheck needs node_modules — vue, etc. — which this test policy deliberately never installs; this is the targeted fallback assertion instead)', () => {
    const workDir = mkScratch('smith-scaffold-shims-');
    const targetDir = path.join(workDir, 'wt', 'acme-shims');

    scaffoldProject({
      projectName: 'acme-shims',
      ui: true,
      targetDir,
      templateDir: SCAFFOLD_DIR,
      repoRoot: REPO_ROOT,
      stack: uiStack(),
      skipGit: true,
      skipToolchain: true,
    });

    const mainTs = readFileSync(path.join(targetDir, 'src/main.ts'), 'utf8');
    const shims = readFileSync(path.join(targetDir, 'src/shims.d.ts'), 'utf8');

    // Matches BOTH `import x from '...'` AND bare side-effect imports
    // (`import '...'`, no `from` at all — exactly main.ts's CSS import
    // shape; a `from`-only regex silently misses this import style).
    const importedAssetExts = new Set(
      [...mainTs.matchAll(/import\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"]/g)]
        .map((m) => (m[1] as string).split('.').pop() ?? '')
        .filter((ext) => ext !== '' && ext !== 'ts' && ext !== 'js'),
    );
    expect(importedAssetExts.size).toBeGreaterThan(0); // sanity: main.ts does import a non-.ts asset (styles/main.css)
    expect(importedAssetExts).toContain('css'); // the specific import this fix is about
    for (const ext of importedAssetExts) {
      expect(shims, `shims.d.ts is missing declare module '*.${ext}'`).toContain(
        `declare module '*.${ext}'`,
      );
    }
  });

  it('refuses to scaffold into a non-empty target directory', () => {
    const workDir = mkScratch('smith-scaffold-exists-');
    const targetDir = path.join(workDir, 'wt', 'dup');
    scaffoldProject({
      projectName: 'dup',
      skipToolchain: true,
      ui: false,
      targetDir,
      templateDir: SCAFFOLD_DIR,
      repoRoot: REPO_ROOT,
      skipGit: true,
    });
    expect(() =>
      scaffoldProject({
        projectName: 'dup',
        skipToolchain: true,
        ui: false,
        targetDir,
        templateDir: SCAFFOLD_DIR,
        repoRoot: REPO_ROOT,
        skipGit: true,
      }),
    ).toThrow(ScaffoldError);
  });
});

/**
 * P9-19. The scaffold declares an 80% coverage floor and a CI workflow; these
 * assert the declarations have something behind them. They are still
 * structure-level, for the reason stated at the top of this file — the real
 * `pnpm install && pnpm run lint && … && pnpm run test:coverage` run against a
 * freshly scaffolded project is acceptance evidence recorded in the punch-list
 * entry, not something this suite pays for on every run.
 */
describe('the scaffold can run its own gates (P9-19)', () => {
  function scaffold(prefix: string, name: string, ui: boolean): string {
    const workDir = mkScratch(prefix);
    const targetDir = path.join(workDir, 'wt', name);
    scaffoldProject({
      projectName: name,
      ui,
      targetDir,
      templateDir: SCAFFOLD_DIR,
      repoRoot: REPO_ROOT,
      stack: ui ? uiStack() : undefined,
      skipGit: true,
      skipToolchain: true,
    });
    return targetDir;
  }

  function listFiles(dir: string, base = dir): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      return statSync(full).isDirectory()
        ? listFiles(full, base)
        : [path.relative(base, full).split(path.sep).join('/')];
    });
  }

  it('is its own pnpm workspace root, so pnpm install works where the scaffolder puts it', () => {
    const targetDir = scaffold('smith-scaffold-ws-', 'acme-ws', false);
    const wsPath = path.join(targetDir, 'pnpm-workspace.yaml');
    expect(existsSync(wsPath), 'missing pnpm-workspace.yaml').toBe(true);
    // The default target is REPO_ROOT/workspaces/<name>, and pnpm walks UP for
    // a workspace root: without this file it finds black-smith's own, which
    // declares no `packages`, and every install in a scaffolded project dies
    // with ERR_PNPM_INVALID_WORKSPACE_CONFIGURATION before resolving a single
    // dependency (measured, P9-19). Declaring the project its own root is what
    // stops the walk.
    expect(parseYaml(readFileSync(wsPath, 'utf8'))).toEqual({ packages: ['.'] });
  });

  it('ships a provider and a script for the coverage floor it declares', () => {
    const targetDir = scaffold('smith-scaffold-cov-', 'acme-cov', false);
    const pkg = JSON.parse(readFileSync(path.join(targetDir, 'package.json'), 'utf8'));

    expect(pkg.scripts['test:coverage']).toBe('vitest run --coverage');
    // Pinned to the same version as vitest itself: the coverage provider is
    // not an independent package, and a drifting pair is its own red run.
    expect(pkg.devDependencies['@vitest/coverage-v8']).toBe(pkg.devDependencies.vitest);
  });

  it('runs coverage in CI, and triggers on the branch the scaffold actually creates', () => {
    const workDir = mkScratch('smith-scaffold-ci-');
    const targetDir = path.join(workDir, 'wt', 'acme-ci');
    const result = scaffoldProject({
      projectName: 'acme-ci',
      ui: false,
      targetDir,
      templateDir: SCAFFOLD_DIR,
      repoRoot: REPO_ROOT,
      skipGit: true,
      skipToolchain: true,
    });

    const ci = parseYaml(readFileSync(path.join(targetDir, '.github/workflows/ci.yml'), 'utf8'));
    // `on` is a plain string key under YAML 1.2 (the `yaml` package's default);
    // the 1.1 boolean-`on` reading is checked too so a schema change here fails
    // loudly instead of silently skipping the assertion.
    // Read as `.true`, not `[true]`: a JS object key is a string either way,
    // and only the type checker sees the boolean.
    const on = ci.on ?? ci.true;
    expect(on.push.branches, 'CI never fires on the branch smith new leaves behind').toContain(
      result.branch,
    );

    const runs: string[] = ci.jobs.check.steps.map((s: { run?: string }) => s.run ?? '');
    expect(runs.some((r) => r.includes('test:coverage'))).toBe(true);
    // The coverage run runs the suite; a separate `pnpm run test` step would
    // only pay for it twice.
    expect(runs).not.toContain('pnpm run test');
  });

  it('--ui: every src module the floor counts is either tested or named as excluded', () => {
    const targetDir = scaffold('smith-scaffold-uicov-', 'acme-uicov', true);

    const config = readFileSync(path.join(targetDir, 'vitest.config.ts'), 'utf8');
    const excludeBlock = /exclude:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? '';
    const excluded = [...excludeBlock.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);

    const srcFiles = listFiles(path.join(targetDir, 'src')).filter((rel) => rel.endsWith('.ts'));
    const tests = listFiles(path.join(targetDir, 'test'))
      .map((rel) => readFileSync(path.join(targetDir, 'test', rel), 'utf8'))
      .join('\n');
    const untested = srcFiles.filter(
      (rel) => !rel.endsWith('.d.ts') && !tests.includes(`../src/${rel.replace(/\.ts$/, '.js')}`),
    );

    // Sanity: the mount entrypoint really is untestable-by-construction, so a
    // broken detector fails here rather than passing vacuously.
    expect(untested).toContain('main.ts');
    for (const rel of untested) {
      expect(excluded, `src/${rel} is counted by the floor and no test covers it`).toContain(
        `src/${rel}`,
      );
    }
    expect(excluded).toContain('src/**/*.d.ts');
  });
});

describe('scaffold toolchain (P9-19)', () => {
  interface Invocation {
    command: string;
    args: readonly string[];
    cwd: string;
  }

  /** Never touches the network: records what it was asked to run and answers. */
  function recorder(opts: { failAt?: string; onInstall?: (cwd: string) => void } = {}) {
    const calls: Invocation[] = [];
    const run = (command: string, args: readonly string[], cwd: string) => {
      calls.push({ command, args, cwd });
      const line = [command, ...args].join(' ');
      if (line === 'pnpm install') opts.onInstall?.(cwd);
      return opts.failAt !== undefined && line.includes(opts.failAt)
        ? { exitCode: 1, output: `boom: ${line}\n` }
        : { exitCode: 0, output: '' };
    };
    return { calls, run };
  }

  it('installs first, then runs the same gates CI runs, in the same order', () => {
    const workDir = mkScratch('smith-toolchain-ok-');
    const targetDir = path.join(workDir, 'wt', 'acme-tc');
    const { calls, run } = recorder();

    const result = scaffoldProject({
      projectName: 'acme-tc',
      ui: false,
      targetDir,
      templateDir: SCAFFOLD_DIR,
      repoRoot: REPO_ROOT,
      skipGit: true,
      runCommand: run,
    });

    expect(calls.map((c) => [c.command, ...c.args].join(' '))).toEqual([
      // No --frozen-lockfile: this install is what CREATES the lockfile that
      // CI's --frozen-lockfile then checks against.
      'pnpm install',
      'pnpm run lint',
      'pnpm run typecheck',
      'pnpm run typecheck:test',
      'pnpm run test:coverage',
      'pnpm run build',
    ]);
    expect(calls.every((c) => c.cwd === targetDir)).toBe(true);
    expect(result.toolchain.status).toBe('verified');
    expect(result.toolchain.steps.map((s) => s.name)).toEqual([
      'install',
      'lint',
      'typecheck',
      'typecheck:test',
      'test:coverage',
      'build',
    ]);
    expect(result.toolchain.steps.every((s) => s.ok)).toBe(true);
  });

  it('names the gate that went red and stops there, the way CI does', () => {
    const workDir = mkScratch('smith-toolchain-red-');
    const targetDir = path.join(workDir, 'wt', 'acme-red');
    const { calls, run } = recorder({ failAt: 'run typecheck' });

    const result = scaffoldProject({
      projectName: 'acme-red',
      ui: false,
      targetDir,
      templateDir: SCAFFOLD_DIR,
      repoRoot: REPO_ROOT,
      skipGit: true,
      runCommand: run,
    });

    expect(result.toolchain.status).toBe('failed');
    expect(result.toolchain.failedStep).toBe('typecheck');
    expect(calls.map((c) => c.args.at(-1))).toEqual(['install', 'lint', 'typecheck']);
    const failed = result.toolchain.steps.find((s) => s.name === 'typecheck');
    expect(failed?.ok).toBe(false);
    expect(failed?.exitCode).toBe(1);
    // The operator needs the output to act on it, and the exact line to re-run.
    expect(failed?.output).toContain('boom');
    expect(failed?.command).toBe('pnpm run typecheck');
    // The tree still exists: a half-built project the operator can fix beats a
    // deleted one they have to re-derive.
    expect(existsSync(path.join(targetDir, 'package.json'))).toBe(true);
  });

  it('commits the lockfile the install produced — the toolchain runs before git init', () => {
    const workDir = mkScratch('smith-toolchain-git-');
    const targetDir = path.join(workDir, 'wt', 'acme-lock');
    const { run } = recorder({
      onInstall: (cwd) => writeFileSync(path.join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n'),
    });

    scaffoldProject({
      projectName: 'acme-lock',
      ui: false,
      targetDir,
      templateDir: SCAFFOLD_DIR,
      repoRoot: REPO_ROOT,
      runCommand: run,
    });

    // ci.yml's `pnpm install --frozen-lockfile` fails on step one of the first
    // PR unless the lockfile is in the very first commit.
    const tracked = execFileSync('git', ['ls-files'], { cwd: targetDir, encoding: 'utf8' });
    expect(tracked.split('\n')).toContain('pnpm-lock.yaml');
  });

  it('says the toolchain was skipped rather than reporting a green it never ran', () => {
    const workDir = mkScratch('smith-toolchain-skip-');
    const targetDir = path.join(workDir, 'wt', 'acme-skip');
    const { calls, run } = recorder();

    const result = scaffoldProject({
      projectName: 'acme-skip',
      ui: false,
      targetDir,
      templateDir: SCAFFOLD_DIR,
      repoRoot: REPO_ROOT,
      skipGit: true,
      skipToolchain: true,
      runCommand: run,
    });

    expect(calls).toHaveLength(0);
    expect(result.toolchain.status).toBe('skipped');
    expect(result.toolchain.steps).toEqual([]);
    expect(result.toolchain.reason).toBeTruthy();
  });
});

describe('template destination collisions (D-179)', () => {
  // The `.tmpl` suffix is stripped at copy time, so `x.yaml` and `x.yaml.tmpl`
  // in one template directory are two sources for one destination. readdirSync
  // does not sort, so which one survives is the filesystem's answer, not the
  // repo's — and every existing assertion here is `existsSync`, which either
  // file satisfies.
  it('writes each destination exactly once for the real template tree', () => {
    const workDir = mkScratch('smith-scaffold-once-');
    const targetDir = path.join(workDir, 'acme-widgets');

    const result = scaffoldProject({
      projectName: 'acme-widgets',
      ui: false,
      targetDir,
      templateDir: SCAFFOLD_DIR,
      repoRoot: REPO_ROOT,
      skipGit: true,
      skipToolchain: true,
    });

    const timesWritten = new Map<string, number>();
    for (const file of result.filesWritten) {
      timesWritten.set(file, (timesWritten.get(file) ?? 0) + 1);
    }
    const twice = [...timesWritten].filter(([, n]) => n > 1).map(([file]) => file);
    expect(twice, 'a destination was written more than once').toEqual([]);
  });

  it('refuses a template directory whose entries collide on one destination', () => {
    const workDir = mkScratch('smith-scaffold-collide-');
    const srcDir = path.join(workDir, 'src-tmpl');
    const destDir = path.join(workDir, 'out');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(path.join(srcDir, 'config.json'), '{"from":"plain"}\n');
    writeFileSync(path.join(srcDir, 'config.json.tmpl'), '{"from":"tmpl"}\n');

    expect(() => copyTemplateDir(srcDir, destDir, 'acme-widgets', [])).toThrow(ScaffoldError);
  });
});

describe('registerProjectInRoadmap', () => {
  it('appends a bootstrap milestone once, idempotently on a second call', () => {
    const workDir = mkScratch('smith-scaffold-roadmap-');
    const roadmapPath = path.join(workDir, 'roadmap.md');
    writeFileSync(roadmapPath, '# Roadmap\n');

    registerProjectInRoadmap('acme-widgets', roadmapPath);
    const once = readFileSync(roadmapPath, 'utf8');
    expect(once).toContain('## acme-widgets — bootstrap');
    expect(once).toContain('- project: acme-widgets');

    registerProjectInRoadmap('acme-widgets', roadmapPath);
    const twice = readFileSync(roadmapPath, 'utf8');
    expect(twice).toBe(once);
  });

  // The test above composes the writer with itself, which proves only that it
  // recognises its own spelling. What it has to recognise is what parseRoadmap
  // reads: a `- id:` field on a trimmed line, /^-\s*id\s*:\s*(.*)$/, not the
  // literal string `- id: acme-widgets-bootstrap` anywhere in the file. The
  // roadmap is hand-maintained, so the two definitions part company on the
  // first bullet a human types.
  it('recognises a bootstrap id the parser reads but its own spelling misses', () => {
    const roadmapPath = path.join(mkScratch('smith-scaffold-roadmap-'), 'roadmap.md');
    // No space after the colon — one character, and parseRoadmap does not care.
    writeFileSync(
      roadmapPath,
      '# Roadmap\n\n## acme-widgets — bootstrap\n- id:acme-widgets-bootstrap\n' +
        '- status: planned\n- project: acme-widgets\n- epics: []\n- goal: Scaffolded.\n',
    );
    const before = readFileSync(roadmapPath, 'utf8');

    registerProjectInRoadmap('acme-widgets', roadmapPath);

    expect(readFileSync(roadmapPath, 'utf8')).toBe(before);
    // The point of not appending: a duplicate id is not a stray section, it is
    // the milestones table's primary key, and parseRoadmap refuses the entire
    // roadmap from the second copy onward. `smith new` would have taken the
    // roadmap away from every reader of it as its closing act.
    expect(parseRoadmap(readFileSync(roadmapPath, 'utf8')).map((m) => m.milestoneId)).toEqual([
      'acme-widgets-bootstrap',
    ]);
  });

  it('names a roadmap it cannot read instead of raising a bare ENOENT', () => {
    const missing = path.join(mkScratch('smith-scaffold-roadmap-'), 'nope.md');

    expect(() => registerProjectInRoadmap('acme-widgets', missing)).toThrow(RoadmapError);
  });
});
