import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { AGENTS_DIR, REPO_ROOT } from '../src/paths.js';
import {
  loadTaxonomy,
  parseTaxonomy,
  TaxonomyError,
  validateErrorClass,
  validateRequiredDimensions,
  validateTag,
} from '../src/taxonomy.js';

const MINI_YAML = `
version: 3
case: [feature, bugfix]
origin: [user, inferred]
agent: [coder, reviewer]
provider: [claude]
model_tier: [frontier, mid, small]
task_status: [todo, ready, completed]
plan_status: [draft, active]
run_status: [queued, running, done]
edge_type: [artifact, claim-order]
edge_provenance: [observed, declared]
finding_category: [correctness]
finding_status: [raised, confirmed]
severity: [S1-stop-the-line, S2-major]
lesson_type: [fact, rule]
lesson_level: [principle]
lesson_status: [candidate, approved]
lesson_scope: [stack-wide]
error:
  spec: [spec-gap, spec-ambiguity]
  contract: [schema-violation, claim-violation]
rules:
  required_dimensions:
    task: [case, origin, task_status]
    dispatch: [agent, provider, model_tier]
    error: [error, severity, task_ref]
    finding: [finding_category, severity, finding_status]
    lesson: [lesson_type, lesson_level, lesson_status, lesson_scope, provenance_event_ids]
    edge: [edge_type, edge_provenance]
`;

describe('parseTaxonomy', () => {
  it('parses dimensions and error groups from YAML', () => {
    const tx = parseTaxonomy(MINI_YAML);
    expect(tx.version).toBe(3);
    expect(tx.dimensions.case).toEqual(['feature', 'bugfix']);
    expect(tx.errorGroups.spec).toEqual(['spec-gap', 'spec-ambiguity']);
    expect(tx.requiredDimensions.task).toEqual(['case', 'origin', 'task_status']);
  });
});

describe('validateTag', () => {
  const tx = parseTaxonomy(MINI_YAML);

  it('accepts a known value in a known dimension', () => {
    expect(() => validateTag(tx, 'case', 'feature')).not.toThrow();
  });

  it.each([
    ['case', 'not-a-real-case'],
    ['severity', 'S5-doesnt-exist'],
    ['agent', 'planner-typo'],
  ])('rejects unknown value %s=%s', (dimension, value) => {
    expect(() => validateTag(tx, dimension, value)).toThrow(TaxonomyError);
  });

  it('rejects an unknown dimension entirely (never silent pass)', () => {
    try {
      validateTag(tx, 'not_a_dimension', 'whatever');
      expect.unreachable('expected validateTag to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TaxonomyError);
      expect((err as InstanceType<typeof TaxonomyError>).code).toBe('taxonomy.unknown-dimension');
    }
  });
});

describe('validateErrorClass (group.class)', () => {
  const tx = parseTaxonomy(MINI_YAML);

  it('accepts a valid group.class pair', () => {
    expect(() => validateErrorClass(tx, 'spec.spec-gap')).not.toThrow();
    expect(() => validateErrorClass(tx, 'contract.claim-violation')).not.toThrow();
  });

  it.each([
    ['missing dot', 'spec-gap'],
    ['unknown group', 'nope.spec-gap'],
    ['unknown class in real group', 'spec.spec-gap-typo'],
    ['class from a different group', 'spec.claim-violation'],
    ['extra dot', 'spec.spec-gap.extra'],
    ['empty string', ''],
  ])('rejects %s: %s', (_label, value) => {
    expect(() => validateErrorClass(tx, value)).toThrow(TaxonomyError);
  });
});

describe('validateRequiredDimensions', () => {
  const tx = parseTaxonomy(MINI_YAML);

  it('passes a fully populated task record', () => {
    expect(() =>
      validateRequiredDimensions(tx, 'task', {
        case: 'feature',
        origin: 'user',
        task_status: 'todo',
      }),
    ).not.toThrow();
  });

  it('throws when a required dimension is missing', () => {
    expect(() =>
      validateRequiredDimensions(tx, 'task', { case: 'feature', origin: 'user' }),
    ).toThrow(TaxonomyError);
  });

  it('throws when a required dimension value is unknown', () => {
    expect(() =>
      validateRequiredDimensions(tx, 'task', {
        case: 'feature',
        origin: 'user',
        task_status: 'not-real',
      }),
    ).toThrow(TaxonomyError);
  });

  it('validates the error record type via group.class on the "error" field', () => {
    expect(() =>
      validateRequiredDimensions(tx, 'error', {
        error: 'spec.spec-gap',
        severity: 'S1-stop-the-line',
        task_ref: 'epic-1/task-1',
      }),
    ).not.toThrow();

    expect(() =>
      validateRequiredDimensions(tx, 'error', {
        error: 'spec.spec-gap-typo',
        severity: 'S1-stop-the-line',
        task_ref: 'epic-1/task-1',
      }),
    ).toThrow(TaxonomyError);
  });

  it('treats provenance_event_ids and task_ref as presence-only (not taxonomy dims)', () => {
    expect(() =>
      validateRequiredDimensions(tx, 'lesson', {
        lesson_type: 'fact',
        lesson_level: 'principle',
        lesson_status: 'candidate',
        lesson_scope: 'stack-wide',
        provenance_event_ids: ['evt-1'],
      }),
    ).not.toThrow();

    expect(() =>
      validateRequiredDimensions(tx, 'lesson', {
        lesson_type: 'fact',
        lesson_level: 'principle',
        lesson_status: 'candidate',
        lesson_scope: 'stack-wide',
        provenance_event_ids: [],
      }),
    ).toThrow(TaxonomyError);
  });

  it('rejects an unknown record type', () => {
    expect(() => validateRequiredDimensions(tx, 'not-a-record-type', {})).toThrow(TaxonomyError);
  });
});

describe('loadTaxonomy (real repo file)', () => {
  it('loads factory/policies/taxonomy.yml and exposes all documented dimensions', () => {
    const tx = loadTaxonomy();
    // Bumped to 5 by D-127, which added `amend-pending` to finding_status.
    expect(tx.version).toBe(5);
    for (const dim of [
      'case',
      'origin',
      'agent',
      'provider',
      'model_tier',
      'task_status',
      'plan_status',
      'run_status',
      'edge_type',
      'edge_provenance',
      'finding_category',
      'finding_scope',
      'finding_status',
      'severity',
      'lesson_type',
      'lesson_level',
      'lesson_status',
      'lesson_scope',
    ]) {
      expect(tx.dimensions[dim], `missing dimension ${dim}`).toBeDefined();
    }
    expect(tx.errorGroups.spec).toContain('spec-gap');
    expect(tx.errorGroups.contract).toContain('claim-violation');
    // P9-8: the queue classifies a nothing-to-merge task under this class, so a
    // taxonomy that lost it would fail the event write, not the type check.
    expect(tx.errorGroups.contract).toContain('uncommitted-work');
  });
});

// P9-20 / D-37: severity is spelled out in full in every judge brief;
// finding_category was left as a pointer at taxonomy.yml, which a judge in a
// fresh context never opens. A reviewer tagged `test-gap` because nothing had
// ever shown it the list. Inlining a vocabulary buys legibility at the price
// of drift, so this test is what pays for it: the literals in the briefs and
// the literals in taxonomy.yml are checked against each other.
describe('judge briefs enumerate finding_category (P9-20)', () => {
  const CATEGORY_WRITING_BRIEFS = ['reviewer', 'security-reviewer', 'spec-reviewer'];

  /** The `- \`finding_category\` — …` bullet, wrapped lines and all. */
  function categoryBullet(text: string): string {
    const lines = text.split('\n');
    const start = lines.findIndex((line) => line.startsWith('- `finding_category`'));
    if (start === -1) return '';
    let end = start + 1;
    while (end < lines.length) {
      const line = lines[end] as string;
      if (line.trim() === '' || /^(- |\*\*|#)/.test(line)) break;
      end++;
    }
    return lines.slice(start, end).join('\n');
  }

  it('every brief that writes a finding_category lists all of them, and no others', () => {
    const declared = loadTaxonomy().dimensions.finding_category ?? [];
    expect(declared.length).toBeGreaterThan(0);

    for (const role of CATEGORY_WRITING_BRIEFS) {
      const bullet = categoryBullet(readFileSync(path.join(AGENTS_DIR, `${role}.md`), 'utf8'));
      expect(bullet, `${role}.md has no finding_category bullet`).not.toBe('');
      expect(bullet, `${role}.md points at taxonomy.yml instead of listing the values`).toContain(
        'one of:',
      );

      const listed = new Set(
        [...bullet.matchAll(/`([a-z0-9-]+)`/g)]
          .map((m) => m[1] as string)
          .filter((value) => value !== 'finding_category'),
      );
      expect([...listed].sort(), `${role}.md finding_category list has drifted`).toEqual(
        [...declared].sort(),
      );
    }
  });

  it('every brief that writes a severity still spells all four out in full', () => {
    const declared = loadTaxonomy().dimensions.severity ?? [];
    for (const role of CATEGORY_WRITING_BRIEFS) {
      const text = readFileSync(path.join(AGENTS_DIR, `${role}.md`), 'utf8');
      for (const value of declared) {
        expect(text, `${role}.md omits severity ${value}`).toContain(value);
      }
    }
  });
});

// P9-37: taxonomy.yml's own header has always promised that it "Mirrors
// docs/specs/black-smith-architecture.md §8 value-for-value; if they diverge,
// that is a bug — fix both in the same PR." Nothing enforced it, and they had
// diverged: §8's `gate_event` was missing `artifact-check-result`, an event
// gate.ts has emitted on every task since P9-22. The cost of that is specific
// to this repo — agents read §8, not the YAML, so a stale list is a spec that
// quietly tells a subagent an event it can see in the log does not exist.
// Same trade as the P9-20 test above: inlining a vocabulary buys legibility,
// and the drift test is what pays for it.
describe('architecture §8 mirrors taxonomy.yml (P9-37)', () => {
  const ARCHITECTURE_PATH = path.join(REPO_ROOT, 'docs', 'specs', 'black-smith-architecture.md');

  /** The first ```yaml fence under the `## 8. Taxonomy` heading. */
  function architectureBlock(): Record<string, unknown> {
    const lines = readFileSync(ARCHITECTURE_PATH, 'utf8').split('\n');
    const heading = lines.findIndex((line) => line.startsWith('## 8. Taxonomy'));
    expect(heading, 'no "## 8. Taxonomy" heading in the architecture spec').toBeGreaterThan(-1);
    const open = lines.indexOf('```yaml', heading);
    expect(open, '§8 has no ```yaml block').toBeGreaterThan(-1);
    const close = lines.indexOf('```', open + 1);
    expect(close, "§8's ```yaml block is never closed").toBeGreaterThan(-1);
    return parseYaml(lines.slice(open + 1, close).join('\n')) as Record<string, unknown>;
  }

  it('declares the same version', () => {
    expect(architectureBlock().version).toBe(loadTaxonomy().version);
  });

  it('lists the same dimensions with the same values, in the same order', () => {
    const doc = architectureBlock();
    const tx = loadTaxonomy();

    // `rules:` is machine-readable in the YAML and prose in §8, directly under
    // the block — the one part of the file the spec deliberately does not
    // mirror verbatim. Everything else is a straight copy.
    const docDimensions = Object.fromEntries(
      Object.entries(doc).filter(([key, value]) => key !== 'rules' && Array.isArray(value)),
    ) as Record<string, string[]>;

    expect(Object.keys(docDimensions).sort()).toEqual(Object.keys(tx.dimensions).sort());
    for (const [dimension, values] of Object.entries(tx.dimensions)) {
      expect(docDimensions[dimension], `§8 has drifted on \`${dimension}\``).toEqual(values);
    }
  });

  it('lists the same error groups with the same classes', () => {
    const errorNode = (architectureBlock().error ?? {}) as Record<string, string[]>;
    const tx = loadTaxonomy();
    expect(Object.keys(errorNode).sort()).toEqual(Object.keys(tx.errorGroups).sort());
    for (const [group, classes] of Object.entries(tx.errorGroups)) {
      expect(errorNode[group], `§8 has drifted on error group \`${group}\``).toEqual(classes);
    }
  });
});
