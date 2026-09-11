import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, SCAFFOLD_DIR } from '../src/paths.js';

// ---------------------------------------------------------------------------
// What the published tarball must carry, pinned without running `npm pack`.
//
// `package.json#files` is an allowlist npm reads and nothing else checks. The
// CLI resolves every asset it reads off `paths.ts`, so a directory that file
// names and the allowlist omits is a `smith` that installs cleanly from the
// registry and fails on first use with ENOENT — after publish, when the
// version is already taken. Each check below is one way that happened or
// nearly did while the package was being cut (docs/specs/plugin-port-scope.md
// PP-3).
// ---------------------------------------------------------------------------

interface Manifest {
  readonly name: string;
  readonly private?: boolean;
  readonly publishConfig?: { readonly access?: string };
  readonly bin: Record<string, string>;
  readonly files: readonly string[];
  readonly dependencies: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as Manifest;

/** The allowlist's positive entries, as repo-relative directory prefixes. */
const shipped = manifest.files.filter((entry) => !entry.startsWith('!'));

function isShipped(rel: string): boolean {
  return shipped.some((entry) => rel === entry || rel.startsWith(`${entry}/`));
}

interface PathConstant {
  /** The identifier the constant is joined onto, or `none` if it is computed. */
  readonly anchor: string;
  /** The literal segments below that anchor, as one repo-relative path. */
  readonly rel: string;
}

/**
 * Every path constant `paths.ts` exports, read out of its source text.
 *
 * Out of the *text*, not out of the module: what the allowlist has to agree
 * with is the path as it is spelled, and under an install both roots resolve
 * somewhere this suite could never stand. So the anchor is the first argument
 * of the `path.join` the constant is built from and the rest are its literal
 * segments -- a constant built by calling a function instead (the two roots,
 * and `PROJECTS_DIR`) reports `none` and has to be excused by name below.
 * Initializers in that file contain no semicolons, so one non-greedy match per
 * declaration is enough, and it survives the formatter wrapping a long join.
 */
function declaredPathConstants(): Map<string, PathConstant> {
  const src = readFileSync(
    path.join(REPO_ROOT, 'factory', 'orchestrator', 'src', 'paths.ts'),
    'utf8',
  );
  const declared = new Map<string, PathConstant>();
  for (const match of src.matchAll(/export const ([A-Z][A-Z0-9_]*) = ([^;]+);/g)) {
    const call = /^path\.(?:join|resolve)\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,([\s\S]*)\)$/.exec(
      (match[2] as string).trim(),
    );
    const segments = [...(call?.[2] ?? '').matchAll(/'([^']*)'/g)].map((seg) => seg[1] as string);
    declared.set(match[1] as string, {
      anchor: call?.[1] ?? 'none',
      rel: segments.length > 0 ? path.join(...segments) : '',
    });
  }
  return declared;
}

/** The anchors themselves: roots, not paths under a root. */
const ROOTS = new Set(['REPO_ROOT', 'WORK_ROOT']);

/**
 * The constants the CLI *writes*. Each is held to hanging off `WORK_ROOT` and
 * to being absent from the allowlist; everything else `paths.ts` exports is
 * held to the opposite.
 */
const WRITTEN = new Set([
  'DOTENV_PATH',
  'SANDBOX_LEASE_DIR',
  'SPECS_ACTIVE_DIR',
  'STATE_ARTIFACTS_DIR',
  'STATE_DAEMON_DIR',
  'STATE_DB_PATH',
  'STATE_EVENTS_DIR',
  'WORKSPACES_DIR',
]);

/** Constants that are under neither root, each with the reason. */
const UNROOTED = new Map([
  [
    'PROJECTS_DIR',
    "Where a project `smith new` creates goes, which is outside this tree by construction (D-42) -- beside the clone when there is one, and the operator's own directory when the CLI is an installed package.",
  ],
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const abs = path.join(dir, entry);
    return statSync(abs).isDirectory() ? walk(abs) : [abs];
  });
}

describe('the published package', () => {
  it('is public under the name the plugin will invoke', () => {
    expect(manifest.name).toBe('@juzser/blacksmith');
    expect(manifest.private).toBeUndefined();
    expect(manifest.publishConfig?.access).toBe('public');
  });

  it('ships the binary it declares', () => {
    expect(isShipped(manifest.bin.smith as string)).toBe(true);
  });

  it('ships every root paths.ts reads, and ships none it writes', () => {
    // This check used to hold a hand-written list of the six roots somebody
    // remembered, and `ROADMAP_PATH` was simply not in it -- so 0.1.0 shipped
    // with `smith new` failing on `roadmap.unreadable` at the first ENOENT a
    // user could reach. A list inside a guard is the hole the guard exists to
    // close, so the list is gone: membership is now read off `paths.ts`, and
    // *shipped* is the default. A constant added there joins this check the
    // moment it is declared, and the only way out is the two named exceptions
    // below, each of which is itself checked.
    const declared = declaredPathConstants();
    expect(declared.size, 'the declaration scan read nothing out of paths.ts').toBeGreaterThan(25);

    for (const [name, { anchor, rel }] of declared) {
      if (ROOTS.has(name)) continue;

      if (UNROOTED.has(name)) {
        expect(anchor, `${name} is excused as unrooted but hangs off ${anchor}`).toBe('none');
        continue;
      }
      if (WRITTEN.has(name)) {
        expect(anchor, `${name} is written by the CLI and must hang off WORK_ROOT`).toBe(
          'WORK_ROOT',
        );
        // The other half of the bargain, and the one with teeth: a written
        // path inside the tarball is a directory `npm i` replaces wholesale,
        // so shipping one deletes the operator's own state on every upgrade.
        expect(isShipped(rel), `${rel} is written at run time and must not ship`).toBe(false);
        continue;
      }
      expect(anchor, `${name} is read by the CLI and must hang off REPO_ROOT`).toBe('REPO_ROOT');
      expect(isShipped(rel), `${rel} is read by the CLI and not in package.json#files`).toBe(true);
      expect(
        existsSync(path.join(REPO_ROOT, rel)),
        `${rel} is in package.json#files and not in the tree`,
      ).toBe(true);
    }
  });

  it('keeps every excused constant earning its excuse', () => {
    // An exception outlives what it excused: a constant can be renamed or
    // deleted and leave its entry here reading like a decision. Both lists are
    // held to naming something `paths.ts` still declares.
    const declared = declaredPathConstants();
    for (const name of [...ROOTS, ...WRITTEN, ...UNROOTED.keys()]) {
      expect(
        declared.has(name),
        `${name} is classified here but paths.ts no longer exports it`,
      ).toBe(true);
    }
  });

  it('ships the operator console it tells people to drive it from', () => {
    // `.claude/agents` ships because the orchestrator reads the role templates
    // out of it. `.claude/skills/bs` is the other half of the same product --
    // the `/bs` playbooks that dispatch those roles -- and an install that
    // carries the roles without the playbooks is a CLI with no way in.
    for (const rel of ['.claude/agents/coder.md', '.claude/skills/bs/SKILL.md']) {
      expect(isShipped(rel), `${rel} is part of the product and not in package.json#files`).toBe(
        true,
      );
      expect(existsSync(path.join(REPO_ROOT, rel)), `${rel} is not in the tree`).toBe(true);
    }
  });

  it('carries no scaffold template under a name npm-packlist always drops', () => {
    // `.gitignore` and `.npmignore` are stripped from every tarball
    // unconditionally, allowlist or not. The first dry-run pack of this
    // package lost `factory/scaffold/base/.gitignore` that way -- 29 of 30
    // template files, and the missing one is what keeps `node_modules/` out
    // of every project `smith new` creates. Templates spell it `.gitignore.tmpl`
    // and the scaffolder strips the suffix at copy time.
    const dropped = walk(SCAFFOLD_DIR)
      .map((abs) => path.relative(REPO_ROOT, abs))
      .filter((rel) => ['.gitignore', '.npmignore'].includes(path.basename(rel)));
    expect(dropped).toEqual([]);
  });

  it('depends on exactly what the CLI imports', () => {
    // Everything under `dependencies` is installed by every `npx` of the
    // CLI. Before this pin the list carried a UI framework the CLI never
    // loads (PP-3): a user running `smith epic verdict` downloaded Vue.
    const src = path.join(REPO_ROOT, 'factory', 'orchestrator', 'src');
    const imported = new Set<string>();
    for (const abs of walk(src)) {
      if (!abs.endsWith('.ts')) continue;
      for (const match of readFileSync(abs, 'utf8').matchAll(/from\s+'([^'.][^']*)'/g)) {
        const spec = match[1] as string;
        if (spec.startsWith('node:')) continue;
        const name = spec.startsWith('@')
          ? spec.split('/').slice(0, 2).join('/')
          : (spec.split('/')[0] as string);
        imported.add(name);
      }
    }
    expect([...imported].sort()).toEqual(Object.keys(manifest.dependencies).sort());
  });
});
