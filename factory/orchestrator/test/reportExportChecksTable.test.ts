import { describe, expect, it } from 'vitest';
import { renderChecksTable } from '../src/reportExport.js';

const HOME = { homeDir: '/opt/example-home' };

describe('renderChecksTable cell counts', () => {
  const out = renderChecksTable(
    'Checks',
    [
      { task: 't1', check: 'unit', state: 'passed' },
      { task: 't1', check: 'lint', state: 'failed', detail: 'a | b\nc' },
      { task: 't2', check: 'unit' },
      { task: 't2', check: 'e2e', state: 'unknown', detail: '' },
    ],
    HOME,
  );
  const lines = out.split('\n');

  it('emits a four-cell row when a check has no detail', () => {
    expect(lines).toContain('| t2 | unit | not run |  |');
    expect(lines).toContain('| t1 | unit | passed |  |');
  });

  it('keeps detail rows whole', () => {
    expect(lines).toContain('| t1 | lint | failed | a \\| b c |');
    expect(lines).toContain('| t2 | e2e | unknown |  |');
  });

  it('gives every table row as many cells as the header', () => {
    const rows = lines.filter((l) => l.startsWith('|'));
    expect(rows).toHaveLength(6);
    for (const r of rows) expect(r.replace(/\\\|/g, '').split('|')).toHaveLength(6);
  });
});
