import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENTS_DIR,
  DB_MIGRATIONS_DIR,
  LESSONS_MD_PATH,
  REPO_ROOT,
  SCAFFOLD_DIR,
  SCHEMA_DIR,
  TAXONOMY_PATH,
} from '../src/paths.js';

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

  it('ships every read-only root paths.ts resolves', () => {
    // The state roots are deliberately absent: `state/` is written at run
    // time, and a tarball entry for it would be an empty directory npm drops
    // anyway. Everything the CLI only *reads* is here.
    const roots = [
      DB_MIGRATIONS_DIR,
      SCHEMA_DIR,
      SCAFFOLD_DIR,
      AGENTS_DIR,
      path.dirname(TAXONOMY_PATH),
      LESSONS_MD_PATH,
    ];
    for (const abs of roots) {
      const rel = path.relative(REPO_ROOT, abs);
      expect(isShipped(rel), `${rel} is read by the CLI and not in package.json#files`).toBe(true);
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
