import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENTS_DIR } from '../src/paths.js';
import {
  beginFence,
  endFence,
  FRAGMENTS_DIR,
  listFragments,
  parseSharedRegions,
  stampFragments,
  syncTemplates,
} from '../src/templateFragments.js';

// ---------------------------------------------------------------------------
// MD-5. Six judge templates carried the same read-only rule, six workers the
// same `token_usage` paragraph, three judges the same "never set finding_id"
// rule — each copy hand-maintained, and the copies had drifted: the finding
// rule in three wordings, one a sentence shorter than the others. A template
// is what Claude Code reads verbatim as a system prompt, so the text has to
// stay *in* the file; the fragment is the source and the template carries a
// stamped copy inside a `SHARED:` fence. These tests are what makes the fence
// a contract rather than a comment: every region equals its fragment byte for
// byte, every fragment is stamped somewhere, and the sync that repairs a
// drifted region is idempotent on a clean one.
// ---------------------------------------------------------------------------

/** The fragments this PR introduced. A fifth is fine — but it must be listed here on purpose. */
const EXPECTED_FRAGMENTS = [
  'finding-fields',
  'read-only-judge-guard',
  'read-only-judge-rule',
  'token-usage',
];

/** Which templates carry which fragment, so a region silently dropped from a role fails by name. */
const EXPECTED_REGIONS: Record<string, string[]> = {
  'read-only-judge-rule': [
    'grader',
    'reviewer',
    'security-reviewer',
    'spec-reviewer',
    'uiux',
    'verifier',
  ],
  'read-only-judge-guard': [
    'grader',
    'reviewer',
    'security-reviewer',
    'spec-reviewer',
    'uiux',
    'verifier',
  ],
  'token-usage': ['coder', 'grader', 'merger', 'researcher', 'tester', 'uiux'],
  'finding-fields': ['reviewer', 'security-reviewer', 'spec-reviewer'],
};

describe('shipped templates vs .claude/fragments (MD-5)', () => {
  it('ships exactly the expected fragments, each a non-empty newline-terminated body', () => {
    const fragments = listFragments();
    expect([...fragments.keys()]).toEqual(EXPECTED_FRAGMENTS);
    for (const [name, body] of fragments) {
      expect(body, `${name}.md is empty`).not.toBe('');
      expect(body.endsWith('\n'), `${name}.md is not newline-terminated`).toBe(true);
      expect(body.endsWith('\n\n'), `${name}.md ends in a blank line`).toBe(false);
      expect(body.startsWith('#'), `${name}.md starts with a heading; a fragment is a body`).toBe(
        false,
      );
      expect(body.startsWith('---'), `${name}.md carries front matter`).toBe(false);
    }
  });

  it('no fragment carries a splice marker the dispatcher would act on', () => {
    // A fragment stamped into six templates would put six copies of a
    // LESSONS marker (or a spliced block's fence) into the dispatch surface.
    for (const [name, body] of listFragments()) {
      expect(body, `${name}.md carries a LESSONS marker`).not.toMatch(/<!-- LESSONS:/);
      expect(body, `${name}.md carries a spliced-block fence`).not.toMatch(
        /COMPILED LESSONS|OPEN FINDINGS|UNTRUSTED DATA|SHARED:/,
      );
    }
  });

  it('every SHARED region in every shipped template equals its fragment byte for byte', () => {
    const report = syncTemplates();
    expect(report.drifted).toEqual([]);
    expect(report.unused).toEqual([]);
    expect(report.written).toEqual([]);
  });

  it('every fragment is stamped into exactly the templates that are expected to carry it', () => {
    const report = syncTemplates();
    const carriers = new Map<string, string[]>();
    for (const { file, regions } of report.templates) {
      for (const region of regions) {
        const list = carriers.get(region.name) ?? [];
        list.push(path.basename(file, '.md'));
        carriers.set(region.name, list);
      }
    }
    const actual = Object.fromEntries([...carriers].map(([k, v]) => [k, v.sort()]));
    expect(actual).toEqual(EXPECTED_REGIONS);
  });

  it('a template names each fragment at most once', () => {
    for (const { file, regions } of syncTemplates().templates) {
      const names = regions.map((r) => r.name);
      expect(new Set(names).size, `${file} stamps a fragment twice`).toBe(names.length);
    }
  });

  it('the fragments directory is where the module says it is', () => {
    expect(FRAGMENTS_DIR).toBe(
      path.join(path.dirname(path.dirname(AGENTS_DIR)), '.claude', 'fragments'),
    );
  });
});

describe('parseSharedRegions', () => {
  it('finds fenced regions in order with their bodies', () => {
    const text = [
      'intro',
      beginFence('one'),
      'a',
      'b',
      endFence('one'),
      '',
      beginFence('two'),
      endFence('two'),
      'outro',
      '',
    ].join('\n');
    expect(parseSharedRegions(text)).toEqual([
      { name: 'one', start: 1, end: 4, body: 'a\nb\n' },
      { name: 'two', start: 6, end: 7, body: '' },
    ]);
  });

  it('treats a fence quoted inside a sentence as prose', () => {
    const text = `The fence is written \`${beginFence('x')}\` on its own line.\n`;
    expect(parseSharedRegions(text)).toEqual([]);
  });

  it('refuses an END with no BEGIN', () => {
    expect(() => parseSharedRegions(`${endFence('x')}\n`, 'f.md')).toThrow(
      expect.objectContaining({ code: 'fragments.unbalanced-fence' }),
    );
  });

  it('refuses a BEGIN that is never closed', () => {
    expect(() => parseSharedRegions(`${beginFence('x')}\nbody\n`, 'f.md')).toThrow(
      expect.objectContaining({ code: 'fragments.unbalanced-fence' }),
    );
  });

  it('refuses an END naming a different fragment than the open BEGIN', () => {
    expect(() => parseSharedRegions(`${beginFence('x')}\n${endFence('y')}\n`)).toThrow(
      expect.objectContaining({ code: 'fragments.unbalanced-fence' }),
    );
  });

  it('refuses a nested BEGIN', () => {
    const text = `${beginFence('x')}\n${beginFence('y')}\n${endFence('y')}\n${endFence('x')}\n`;
    expect(() => parseSharedRegions(text)).toThrow(
      expect.objectContaining({ code: 'fragments.nested-fence' }),
    );
  });

  it('refuses a fragment name outside the grammar', () => {
    for (const bad of ['Token', 'a_b', '-x', '1x']) {
      expect(() => parseSharedRegions(`${beginFence(bad)}\n${endFence(bad)}\n`)).toThrow(
        expect.objectContaining({ code: 'fragments.invalid-fragment-name' }),
      );
    }
  });
});

describe('stampFragments', () => {
  const fragments = new Map([
    ['rule', 'the rule\nin two lines\n'],
    ['empty', ''],
  ]);

  it('rewrites a drifted region and leaves the rest of the file alone', () => {
    const text = `# T\n\n${beginFence('rule')}\nold\n${endFence('rule')}\n\nafter\n`;
    const { text: out, regions } = stampFragments(text, fragments);
    expect(out).toBe(
      `# T\n\n${beginFence('rule')}\nthe rule\nin two lines\n${endFence('rule')}\n\nafter\n`,
    );
    expect(regions).toEqual([{ name: 'rule', drifted: true }]);
  });

  it('is byte-identical on a template that is already in sync', () => {
    const text = `${beginFence('rule')}\nthe rule\nin two lines\n${endFence('rule')}\n${beginFence('empty')}\n${endFence('empty')}\n`;
    const { text: out, regions } = stampFragments(text, fragments);
    expect(out).toBe(text);
    expect(regions).toEqual([
      { name: 'rule', drifted: false },
      { name: 'empty', drifted: false },
    ]);
  });

  it('refuses a region naming a fragment that does not exist', () => {
    expect(() => stampFragments(`${beginFence('nope')}\n${endFence('nope')}\n`, fragments)).toThrow(
      expect.objectContaining({ code: 'fragments.unknown-fragment' }),
    );
  });
});

describe('syncTemplates on a copy of the shipped tree', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function copyTree(): { agentsDir: string; fragmentsDir: string } {
    dir = mkdtempSync(path.join(tmpdir(), 'smith-fragments-'));
    const agentsDir = path.join(dir, 'agents');
    const fragmentsDir = path.join(dir, 'fragments');
    cpSync(AGENTS_DIR, agentsDir, { recursive: true });
    cpSync(FRAGMENTS_DIR, fragmentsDir, { recursive: true });
    return { agentsDir, fragmentsDir };
  }

  it('reports a drifted region without writing, then repairs it when asked, then is idempotent', () => {
    const { agentsDir, fragmentsDir } = copyTree();
    const graderPath = path.join(agentsDir, 'grader.md');
    const original = readFileSync(graderPath, 'utf8');
    const drifted = original.replace(
      'you cannot read your\nown meter',
      'you can read your\nown meter',
    );
    expect(drifted).not.toBe(original);
    writeFileSync(graderPath, drifted, 'utf8');

    const dry = syncTemplates({ agentsDir, fragmentsDir });
    expect(dry.drifted).toEqual([{ file: 'grader.md', name: 'token-usage' }]);
    expect(dry.written).toEqual([]);
    expect(readFileSync(graderPath, 'utf8')).toBe(drifted);

    const wet = syncTemplates({ agentsDir, fragmentsDir, write: true });
    expect(wet.drifted).toEqual([{ file: 'grader.md', name: 'token-usage' }]);
    expect(wet.written).toEqual(['grader.md']);
    expect(readFileSync(graderPath, 'utf8')).toBe(original);

    const again = syncTemplates({ agentsDir, fragmentsDir, write: true });
    expect(again.drifted).toEqual([]);
    expect(again.written).toEqual([]);
  });

  it('names a fragment no template carries', () => {
    const { agentsDir, fragmentsDir } = copyTree();
    writeFileSync(path.join(fragmentsDir, 'orphan.md'), 'nobody stamps me\n', 'utf8');
    expect(syncTemplates({ agentsDir, fragmentsDir }).unused).toEqual(['orphan']);
  });

  it('refuses a fragments directory holding a file that is not a fragment', () => {
    const { agentsDir, fragmentsDir } = copyTree();
    writeFileSync(path.join(fragmentsDir, 'README.md'), '# not a fragment\n', 'utf8');
    expect(() => syncTemplates({ agentsDir, fragmentsDir })).toThrow(
      expect.objectContaining({ code: 'fragments.invalid-fragment-name' }),
    );
  });

  it('reads templates non-recursively, the same set check.sh validates', () => {
    const { agentsDir, fragmentsDir } = copyTree();
    mkdirSync(path.join(agentsDir, 'nested'));
    writeFileSync(
      path.join(agentsDir, 'nested', 'x.md'),
      `${beginFence('nope')}\n${endFence('nope')}\n`,
      'utf8',
    );
    expect(() => syncTemplates({ agentsDir, fragmentsDir })).not.toThrow();
  });
});
