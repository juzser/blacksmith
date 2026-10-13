import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Modules whose exports must each have a consumer. A plain array so a later
// task can extend it.
const GUARDED_MODULES = ['liveness', 'format', 'kanban'];

const SRC = join(__dirname, '..', 'src');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|vue|js)$/.test(entry.name) ? [path] : [];
  });
}

function exportNames(code: string): string[] {
  const names: string[] = [];
  const re =
    /^export\s+(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) names.push(m[1] as string);
  return names;
}

function count(code: string, name: string): number {
  const escaped = name.replace(/\$/g, '\\$');
  return (code.match(new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'g')) ?? []).length;
}

function deadExports(modules: readonly string[]): string[] {
  const files = sourceFiles(SRC).map((path) => ({
    path,
    code: stripComments(readFileSync(path, 'utf8')),
  }));
  const dead: string[] = [];
  for (const name of modules) {
    const own = join(SRC, 'lib', `${name}.ts`);
    const ownCode = files.find((f) => f.path === own)?.code ?? '';
    for (const exported of exportNames(ownCode)) {
      const usedElsewhere = files.some((f) => f.path !== own && count(f.code, exported) > 0);
      // One occurrence is the declaration itself.
      const usedInside = count(ownCode, exported) > 1;
      if (!usedElsewhere && !usedInside) dead.push(`${name}.${exported}`);
    }
  }
  return dead;
}

describe('ui/src/lib exports', () => {
  it('has no export that nothing uses', () => {
    expect(deadExports(GUARDED_MODULES)).toEqual([]);
  });
});
