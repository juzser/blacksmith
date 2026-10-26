import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';

// `bs init` writes Claude Code's `autoCompactWindow`; these tests pin the docs
// that describe it so they cannot drift away silently. They read the working
// tree, never a git revision.

const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

describe('compact window docs', () => {
  const install = read('INSTALL.md');
  const start = install.indexOf('#### Compact earlier on 1M models');
  const rest = install.slice(start + 1);
  const next = rest.search(/\n#{1,4} |\n\*\*A clone/);
  const section = rest.slice(0, next === -1 ? undefined : next);

  it('INSTALL.md has a section covering the window, add-if-absent and the clamp', () => {
    expect(start).toBeGreaterThan(-1);
    expect(section).toContain('autoCompactWindow');
    expect(section).toContain('settings.local.json');
    expect(section).toMatch(/add-if-absent/i);
    expect(section).toContain('633000');
    expect(section).toContain('33,000');
    expect(section).toMatch(/100000/);
    expect(section).toMatch(/1000000/);
    expect(section).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    expect(section).toContain('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE');
    expect(section).toContain('modelSettings');
    expect(section).toMatch(/restart/i);
  });

  it('INSTALL.md covers the 200k models, the JSON layout, the opt-out and the PCT warning', async () => {
    const { OLD_WINDOW_MODELS } = await import('../src/workroot.js');
    expect(section).toContain('153000');
    expect(section).toContain('[1m]');
    expect(section).toContain('"auto"');
    expect(section).toContain('/autocompact');
    expect(section).toContain('367k');
    for (const id of ['claude-opus-4-6', 'claude-sonnet-4-0', 'claude-haiku-4-5']) {
      expect(OLD_WINDOW_MODELS).toContain(id);
    }
    const block = /```json\n([\s\S]*?)```/.exec(section);
    const parsed = JSON.parse(block?.[1] ?? '{}');
    expect(parsed.modelSettings['<model-id>'].autoCompactWindow).toBe(153000);
  });

  it('the README no longer claims bs init writes nothing outside .blacksmith', () => {
    const readme = read('README.md');
    expect(readme).not.toContain('writes nothing anywhere else');
    expect(readme).toContain('#compact-earlier-on-1m-models');
    expect(readme).toContain('#raise-the-concurrency-caps');
  });

  it('the Upgrading row says to re-run bs init in each project', () => {
    const row = install.split('\n').find((l) => l.startsWith('| Upgrading'));
    expect(row).toMatch(/re-run `bs init` in each project/);
    expect(row).toMatch(/restart Claude Code/);
  });

  it('the init-never-overwrites line carries the record nuance', () => {
    const at = install.indexOf('`init` never overwrites a file you have already edited');
    expect(install.slice(at, at + 700)).toContain('#compact-earlier-on-1m-models');
  });

  it('the changelog and the agent constraints point at it', () => {
    expect(read('CHANGELOG.md')).toContain('#compact-earlier-on-1m-models');
    expect(read('docs/standards/agent-constraints.md')).toContain('#compact-earlier-on-1m-models');
  });
});
