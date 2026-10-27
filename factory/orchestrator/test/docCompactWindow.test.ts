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

  it('INSTALL.md has a section covering the window and the clamp', () => {
    expect(start).toBeGreaterThan(-1);
    expect(section).toContain('autoCompactWindow');
    expect(section).toContain('settings.local.json');
    expect(section).toContain('633000');
    expect(section).toContain('33,000');
    expect(section).toMatch(/100000/);
    expect(section).toMatch(/1000000/);
    expect(section).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    expect(section).toContain('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE');
    expect(section).toContain('modelSettings');
    expect(section).toMatch(/restart/i);
  });

  it('INSTALL.md covers the 200k models, the full JSON layout, the opt-out and the PCT warning', () => {
    expect(section).toContain('153000');
    expect(section).toContain('[1m]');
    expect(section).toContain('"auto"');
    expect(section).toContain('/autocompact');
    expect(section).toContain('368k');
    expect(section).not.toContain('367k');
    expect(section).toContain('about 12% of 1M');
    const block = /```json\n([\s\S]*?)```/.exec(section);
    const parsed = JSON.parse(block?.[1] ?? '{}');
    expect(parsed.autoCompactWindow).toBe(633000);
    // The doc lists the eight ids itself, each at 153000.
    const documented = Object.keys(parsed.modelSettings).sort();
    expect(documented).toEqual(
      [
        'claude-haiku-4-5',
        'claude-opus-4-0',
        'claude-opus-4-1',
        'claude-opus-4-5',
        'claude-opus-4-6',
        'claude-sonnet-4-0',
        'claude-sonnet-4-5',
        'claude-sonnet-4-6',
      ].sort(),
    );
    for (const id of documented) {
      expect(parsed.modelSettings[id].autoCompactWindow).toBe(153000);
    }
  });

  it('INSTALL.md and the changelog state the all-or-nothing ownership rule', () => {
    expect(section).toMatch(/stand or fall together/);
    expect(section).toMatch(/owns only the keys its record proves it wrote/);
    expect(section).toMatch(/removes its own lines/);
    expect(section).toMatch(/Deleting bs's\s+lines is not an opt-out/);
    expect(section).toContain('the environment `bs init` runs in');
    expect(section).toMatch(/never adopts/);
    expect(read('CHANGELOG.md')).toMatch(/stand or fall together/);
    expect(read('CHANGELOG.md')).toMatch(/Deleting bs's lines is not an\s+opt-out/);
  });

  it('the docs place the record in the project and say what deleting it means', () => {
    expect(section).toContain('.claude/bs-settings-record.json');
    expect(section).toMatch(/treat its old lines as yours/);
    expect(section).toMatch(/delete\s+those lines and re-run `bs init`/);
    expect(section).not.toContain('claude-settings.json');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toContain('.claude/bs-settings-record.json');
    expect(changelog).not.toContain('state/claude-settings.json');
  });

  it('the docs say what the env variables do against bs lines, and that empty is env-only', () => {
    expect(section).toMatch(/beats every\s+settings file, so there bs's lines are merely unused/);
    expect(section).toMatch(/stacks on bs's window/);
    expect(section).toMatch(/For the environment variables, an empty value counts as unset/);
  });

  it('the init-never-overwrites paragraph says init removes its own keys when you set yours', () => {
    const at = install.indexOf('`init` never overwrites a file you have already edited');
    expect(install.slice(at, at + 700)).toMatch(/removes its own\s+keys when you set yours/);
    for (const line of install.slice(at, at + 700).split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it('the agent constraints say the yield holds once bs init is re-run', () => {
    expect(read('docs/standards/agent-constraints.md')).toMatch(
      /yields to any value you set, once\s+you\s+re-run\s+`bs init`/,
    );
  });

  it('the clone docs say bs init runs there too', () => {
    const row = install.split('\n').find((l) => l.startsWith('| Upgrading')) ?? '';
    expect(row).toMatch(/`git pull`, build, run `bs init` once in the clone, restart Claude Code/);
    expect(install).not.toContain('has nothing to do here');
  });

  it('the agent constraints no longer contradict themselves about enforcement', () => {
    const constraints = read('docs/standards/agent-constraints.md');
    expect(constraints).not.toContain('prompt-level today');
    expect(constraints).toContain('about 12% of 1M');
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

  describe('round-three wording and width', () => {
    const changelog = read('CHANGELOG.md');
    const entryAt = changelog.indexOf('- **`bs init` sets Claude Code');
    const entry = changelog.slice(entryAt, changelog.indexOf('\n\n', entryAt));
    const constraints = read('docs/standards/agent-constraints.md');
    const bulletAt = constraints.indexOf('- Enforcement is split.');
    const bullet = constraints.slice(bulletAt, constraints.indexOf('\n\n', bulletAt));

    it('the new lines stay within 80 columns', () => {
      for (const [name, text] of [
        ['CHANGELOG entry', entry],
        ['INSTALL section', section],
        ['agent-constraints bullet', bullet],
      ] as const) {
        for (const line of text.split('\n')) {
          expect(line.length, `${name}: ${line}`).toBeLessThanOrEqual(80);
        }
      }
    });

    it('the changelog names the record file and all three hint cases', () => {
      const flat = entry.replace(/\s+/g, ' ');
      expect(flat).not.toContain("project's entry is missing or old");
      expect(flat).toContain('.claude/bs-settings-record.json');
      expect(flat).toMatch(/out of date/);
      expect(flat).toMatch(/overridden/);
      expect(flat).toMatch(/unused or stacked/);
    });

    it('both docs say init stays silent when your values already are the full layout', () => {
      const silent = /stays silent when your own values already are the full recommended layout/;
      expect(entry.replace(/\s+/g, ' ')).toMatch(silent);
      expect(section.replace(/\s+/g, ' ')).toMatch(silent);
    });

    it('the reminder is described as naming the record directory, not always the root', () => {
      const flat = section.replace(/\s+/g, ' ');
      expect(flat).toMatch(/naming the directory that holds the record/);
      expect(flat).toMatch(/or the git root when there is none/);
      expect(flat).not.toContain('Where blocking would be pointless');
      expect(flat).toMatch(/still blocks, but it stays silent/);
    });

    it('the agent constraints bullet fits 80 columns even counting bytes', () => {
      for (const line of bullet.split('\n')) {
        expect(Buffer.byteLength(line), line).toBeLessThanOrEqual(80);
      }
    });
  });
});
