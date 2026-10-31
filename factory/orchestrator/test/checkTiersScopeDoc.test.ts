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

  const flat = (): string => doc().replace(/\s+/g, ' ');
  const thresholdsSection = (): string =>
    (doc().split(/^### Thresholds$/m)[1] ?? '').split(/^## /m)[0] ?? '';

  it('states every threshold with its value in the Thresholds section', () => {
    const section = thresholdsSection().replace(/\s+/g, ' ');
    expect(section).toMatch(/window is 30 days/i);
    for (const [name, value] of [
      ['MIN_RUNS', '20'],
      ['MIN_MEASURED_MINUTES', '30'],
      ['POST_MERGE_BATCH', '4'],
      ['DECLINE_QUIET_DAYS', '90'],
    ] as const) {
      expect(section, name).toMatch(new RegExp(`\`${name}\` \\(${value}\\)`));
    }
    expect(section).toMatch(/S1 8, S2 4, S3 2, S4 1/);
  });

  it('says thresholds are named constants in v1', () => {
    expect(thresholdsSection().replace(/\s+/g, ' ')).toMatch(/named, exported constants in v1/i);
  });

  it('states every guardrail of D7-D9', () => {
    const text = flat();
    const guardrails: Array<[string, RegExp]> = [
      ['non-operator actor', /a non-operator actor/],
      ['reply not an array', /a reply that is not an array/],
      ['shape error', /a shape error/],
      ['check not in the file', /a check not in the file/],
      ['declared tier', /a declared tier/],
      ['stage-bound check', /a stage-bound check/],
      ['sensitive-path guard', /a sensitive-path guard/],
      ['S1 or S2 catch', /an S1 or S2 catch in the window/],
      ['unconfirmed failure', /an unconfirmed failure in the window/],
      [
        'overlay unreadable, tracked or un-excludable',
        /unreadable, tracked or un-excludable overlay/,
      ],
      ['whole batch refused, nothing appended', /refuses the whole batch, appending nothing/],
      ['project file never written', /the project's file is never written/],
      ['declared tier never moved automatically', /declared tier is never moved automatically/],
      ['promotion only earlier', /only ever moves a check earlier/],
      ['red-at-base promotes nothing', /predates the batch promotes nothing/],
      ['decided never resurfaces', /decided proposal never resurfaces/],
      ['stage check stays pre-merge', /coverage check stays pre-merge/],
      [
        'unknown keys, ids and duplicates refused',
        /unknown keys, unknown or decided ids and duplicates are refused/,
      ],
    ];
    for (const [name, re] of guardrails) {
      expect(text, name).toMatch(re);
    }
  });

  it('is linked from docs/specs/README.md Scopes table and docs/README.md', () => {
    const scopes = read('docs/specs/README.md').split('## Scopes')[1] ?? '';
    expect(scopes.split('## Records')[0]).toContain('](check-tiers-scope.md)');
    expect(read('docs/README.md')).toContain('](specs/check-tiers-scope.md)');
  });
});
