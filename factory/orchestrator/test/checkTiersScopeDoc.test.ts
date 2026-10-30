import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';

// The check-tiers scope doc is a predefined architecture: it describes the
// mechanism before the verbs exist. These assertions pin what the doc must say
// while it is planned. The marker and the status lines are the two assertions
// the epic's later tasks edit when the doc ships.
const DOC = path.join(REPO_ROOT, 'docs', 'specs', 'check-tiers-scope.md');
const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');

describe('docs/specs/check-tiers-scope.md', () => {
  it('exists', () => {
    expect(existsSync(DOC)).toBe(true);
  });

  const doc = (): string => readFileSync(DOC, 'utf8');

  it('carries the PLANNED-NAMESPACE: checks marker on its own line', () => {
    expect(doc().split('\n')).toContain('<!-- PLANNED-NAMESPACE: checks -->');
  });

  it('names the three tier values and the pre-merge default', () => {
    const text = doc();
    for (const tier of ['pre-merge', 'post-merge', 'pre-release']) {
      expect(text).toContain(`\`${tier}\``);
    }
    expect(text).toMatch(/absent[^.]*`pre-merge`|`pre-merge`[^.]*default/i);
  });

  it('contains the decisions.json example as a fenced block', () => {
    const block = doc().match(/```json\n(\[[\s\S]*?\])\n```/);
    expect(block).not.toBeNull();
    const decisions = JSON.parse(block?.[1] as string) as Array<Record<string, string>>;
    expect(decisions.map((d) => d.decision)).toEqual(['approve', 'decline']);
    expect(decisions[0]?.to_tier).toBe('post-merge');
  });

  it('says every option shows runs covered, minutes spent and minutes saved', () => {
    const text = doc().replace(/\s+/g, ' ');
    expect(text).toMatch(
      /every (proposal )?option shows[^.]*runs covered[^.]*minutes spent[^.]*minutes saved/i,
    );
  });

  it('says the operator is asked once, as one batch', () => {
    expect(doc().replace(/\s+/g, ' ')).toMatch(
      /asked once[^.]*one batch|one batch[^.]*asked once/i,
    );
  });

  it('says this is a predefined architecture that becomes a feature as it ships', () => {
    expect(doc().replace(/\s+/g, ' ')).toMatch(
      /predefined architecture[^.]*becomes a feature as it ships/i,
    );
  });

  it('follows each of the three parts heading with Status: planned.', () => {
    const lines = doc().split('\n');
    const headings = lines.flatMap((line, i) =>
      /^## .*(tier declaration|where each tier runs|learning loop)/i.test(line) ? [i] : [],
    );
    expect(headings).toHaveLength(3);
    for (const i of headings) {
      const next = lines.slice(i + 1).find((line) => line.trim() !== '');
      expect(next).toBe('Status: planned.');
    }
  });

  it('is linked from docs/specs/README.md Scopes table and docs/README.md', () => {
    const scopes = read('docs/specs/README.md').split('## Scopes')[1] ?? '';
    expect(scopes.split('## Records')[0]).toContain('](check-tiers-scope.md)');
    expect(read('docs/README.md')).toContain('](specs/check-tiers-scope.md)');
  });
});
