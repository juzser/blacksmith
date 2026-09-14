import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { specRefLabel } from '../src/lib/specRef.js';

describe('specRefLabel', () => {
  it('labels a spec finding with its plan version and criterion', () => {
    expect(
      specRefLabel({
        findingScope: 'spec',
        specPlanVersion: 1,
        criterionRef: 'epic-1/task-2:criterion-1',
      }),
    ).toBe('spec · plan v1 · epic-1/task-2:criterion-1');
  });

  it('omits the criterion segment when the finding names none', () => {
    // A spec finding raised before spec_ref was required (D-191-shaped): the
    // scope is still worth saying, the criterion is not there to say.
    expect(specRefLabel({ findingScope: 'spec', specPlanVersion: 2, criterionRef: null })).toBe(
      'spec · plan v2',
    );
  });

  it('omits the plan segment when the finding names no version', () => {
    expect(specRefLabel({ findingScope: 'spec', specPlanVersion: null, criterionRef: 'c-1' })).toBe(
      'spec · c-1',
    );
  });

  it('is null for a diff finding, so the page renders nothing extra', () => {
    expect(specRefLabel({ findingScope: 'diff', specPlanVersion: null, criterionRef: null })).toBe(
      null,
    );
  });

  it('is null when the scope is absent, the way findingScope() reads absence as diff', () => {
    expect(specRefLabel({})).toBe(null);
    expect(specRefLabel({ findingScope: undefined, criterionRef: 'c-1' })).toBe(null);
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = join(HERE, '..', 'src', 'pages');

describe('the task detail page shows the label', () => {
  // .vue templates are read by neither tsc nor biome here, so the only thing
  // that keeps the column from silently losing the label again is a test that
  // reads the source. The helper is the contract; the page has to call it.
  it('calls specRefLabel in the findings table', () => {
    const src = readFileSync(join(PAGES, 'TaskDetailPage.vue'), 'utf8');
    expect(src).toContain('specRefLabel(');
  });
});
