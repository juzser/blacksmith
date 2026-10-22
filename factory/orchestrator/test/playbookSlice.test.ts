import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PlaybookError, sliceSection, sliceWaveStep } from '../src/playbookSlice.js';

// Epic bs-optimize criterion 7 (module half): runs against the real playbooks,
// so a renumbering or heading rename breaks here, not in a runner.
const skills = path.resolve(__dirname, '../../../.claude/skills/bs');
const wave = readFileSync(path.join(skills, 'wave.md'), 'utf8');
const dispatch = readFileSync(path.join(skills, 'dispatch.md'), 'utf8');

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof PlaybookError ? error.code : `other:${String(error)}`;
  }
  return undefined;
}

describe('sliceWaveStep', () => {
  it('cuts step 4 from its own line to before step 5', () => {
    const cut = sliceWaveStep(wave, 4);
    expect(cut.startsWith('4. ')).toBe(true);
    expect(cut).toContain('bs-coder');
    expect(cut.split('\n').filter((l) => /^(3|5)\. /.test(l))).toEqual([]);
    expect(wave).toContain(cut.trimEnd());
  });

  it('cuts every step 2-10 starting at its own number', () => {
    for (let n = 2; n <= 10; n++) {
      const cut = sliceWaveStep(wave, n);
      expect(cut.startsWith(`${n}. `)).toBe(true);
      expect(cut.split('\n').filter((l) => /^\d+\. /.test(l))).toHaveLength(1);
    }
  });

  it('ends step 10 before EOF or the next heading', () => {
    const cut = sliceWaveStep(wave, 10);
    expect(cut.split('\n').some((l) => /^#{1,6} /.test(l))).toBe(false);
    expect(wave.trimEnd().endsWith(cut.trimEnd()) || wave.includes(`${cut.trimEnd()}\n\n#`)).toBe(
      true,
    );
  });

  it('raises playbook.unknown-step for steps 1 and 11', () => {
    expect(codeOf(() => sliceWaveStep(wave, 1))).toBe('playbook.unknown-step');
    expect(codeOf(() => sliceWaveStep(wave, 11))).toBe('playbook.unknown-step');
  });

  it('ignores numbered lines and headings inside fences', () => {
    const md = '## The steps\n\n2. a\n```\n3. fake\n# not a heading\n```\n   tail\n4. b\n';
    expect(sliceWaveStep(md, 2)).toBe('2. a\n```\n3. fake\n# not a heading\n```\n   tail\n');
    expect(codeOf(() => sliceWaveStep(md, 3))).toBe('playbook.unknown-step');
  });

  it('stops at the next heading and needs the steps heading', () => {
    expect(sliceWaveStep('## The steps\n2. a\n## Next\n3. b\n', 2)).toBe('2. a\n');
    expect(codeOf(() => sliceWaveStep('2. a\n', 2))).toBe('playbook.unknown-step');
  });
});

describe('sliceSection', () => {
  it('keeps the fenced judge line and stops before the next section', () => {
    const cut = sliceSection(
      dispatch,
      'Fingerprint the worktree around every judge (agent-interviews.md N-10, P9-5)',
    );
    expect(cut.startsWith('## Fingerprint the worktree')).toBe(true);
    expect(cut).toContain('# ... dispatch the judge ...');
    expect(cut).not.toContain('## Fetched and quoted text');
  });

  it('cuts the two wave.md sections', () => {
    expect(sliceSection(wave, 'You own the log for what you dispatch')).toMatch(
      /^## You own the log/,
    );
    const whole = sliceSection(wave, 'Run the whole wave at once');
    expect(whole).toMatch(/^## Run the whole wave at once/);
    expect(whole).not.toContain('## The steps');
  });

  it('cuts the return discipline section of dispatch.md', () => {
    expect(sliceSection(dispatch, 'Return discipline (agent-interviews.md M-6)')).toMatch(
      /^## Return discipline/,
    );
  });

  it('runs a ### section to the next heading of the same or higher level', () => {
    const md = '## A\n### B\nb1\n#### C\nc1\n### D\nd1\n## E\n';
    expect(sliceSection(md, 'B')).toBe('### B\nb1\n#### C\nc1\n');
    expect(sliceSection(md, 'A')).toBe('## A\n### B\nb1\n#### C\nc1\n### D\nd1\n');
    expect(sliceSection(md, 'E')).toBe('## E\n');
  });

  it('raises unknown and ambiguous errors', () => {
    expect(codeOf(() => sliceSection(wave, 'No such heading'))).toBe('playbook.unknown-section');
    expect(codeOf(() => sliceSection('## A\nx\n## A\ny\n', 'A'))).toBe(
      'playbook.ambiguous-section',
    );
    expect(codeOf(() => sliceSection('## A\n```\n## A\n```\n', 'A'))).toBeUndefined();
  });
});
