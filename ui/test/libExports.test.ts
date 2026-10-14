import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Modules whose exports must each have a consumer. A plain array so a later
// task can extend it.
const GUARDED_MODULES = [
  'liveness',
  'format',
  'kanban',
  'agentScope',
  'taxonomy',
  'timelineDisplay',
];

// Each entry is a documented test-fixture bound that is deliberately exported
// for a test, so it needs no src consumer.
const TEST_ONLY_EXPORTS = ['liveness.SESSION_ACTIVE_WITHIN_MS'];

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

function deadExports(modules: readonly string[], src: string = SRC): string[] {
  const files = sourceFiles(src).map((path) => ({
    path,
    code: stripComments(readFileSync(path, 'utf8')),
  }));
  const dead: string[] = [];
  for (const name of modules) {
    const own = join(src, 'lib', `${name}.ts`);
    const ownCode = files.find((f) => f.path === own)?.code ?? '';
    for (const exported of exportNames(ownCode)) {
      const usedElsewhere = files.some((f) => f.path !== own && count(f.code, exported) > 0);
      // One occurrence is the declaration itself.
      const usedInside = count(ownCode, exported) > 1;
      if (TEST_ONLY_EXPORTS.includes(`${name}.${exported}`)) continue;
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

describe('the exports guard itself', () => {
  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'lib-exports-'));
    mkdirSync(join(root, 'lib'));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
    return root;
  }

  it('reports an export that nothing references', () => {
    const root = fixture({ 'lib/mod-a.ts': 'export function unusedHelper() { return 1; }\n' });
    expect(deadExports(['mod-a'], root)).toEqual(['mod-a.unusedHelper']);
  });

  it('keeps an export used by another file', () => {
    const root = fixture({
      'lib/mod-a.ts': 'export const usedElsewhere = 1;\n',
      'view.ts': "import { usedElsewhere } from './lib/mod-a';\nconsole.log(usedElsewhere);\n",
    });
    expect(deadExports(['mod-a'], root)).toEqual([]);
  });

  it('keeps an export its own module uses', () => {
    const root = fixture({
      'lib/mod-a.ts': 'export const base = 1;\nconst twice = base * 2;\nconsole.log(twice);\n',
    });
    expect(deadExports(['mod-a'], root)).toEqual([]);
  });

  it('does not count a mention in a comment as a use', () => {
    const root = fixture({
      'lib/mod-a.ts': '// commentOnly is documented here\nexport const commentOnly = 1;\n',
      'view.ts': '/* commentOnly */\n// commentOnly\n',
    });
    expect(deadExports(['mod-a'], root)).toEqual(['mod-a.commentOnly']);
  });

  it('does not treat a longer name as a use of a shorter one', () => {
    const root = fixture({
      'lib/mod-a.ts': 'export const label = 1;\n',
      'view.ts': 'const labelCount = 2;\nconsole.log(labelCount);\n',
    });
    expect(deadExports(['mod-a'], root)).toEqual(['mod-a.label']);
  });
});
