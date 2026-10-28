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

function errorOf(fn: () => unknown): PlaybookError {
  try {
    fn();
  } catch (error) {
    if (error instanceof PlaybookError) return error;
    throw error;
  }
  throw new Error('expected a PlaybookError');
}

describe('sliceSection by name (finding aae952a5, module half)', () => {
  it('takes a heading without its trailing parenthetical, against the real dispatch.md', () => {
    const cut = sliceSection(dispatch, 'Round counting and escalation');
    expect(cut.split('\n')[0]).toBe('## Round counting and escalation (agent-interviews.md N-4)');
    expect(cut).toBe(
      sliceSection(dispatch, 'Round counting and escalation (agent-interviews.md N-4)'),
    );
  });

  it('lets an exact heading win over a name match', () => {
    const md = '## A\nexact\n## A (x)\nnamed\n';
    expect(sliceSection(md, 'A')).toBe('## A\nexact\n');
    expect(sliceSection(md, 'A (x)')).toBe('## A (x)\nnamed\n');
  });

  it('refuses two name matches, naming both full headings', () => {
    const md = '## B (x)\none\n### B (y)\ntwo\n';
    const err = errorOf(() => sliceSection(md, 'B'));
    expect(err.code).toBe('playbook.ambiguous-section');
    expect(JSON.stringify(err.details)).toContain('## B (x)');
    expect(JSON.stringify(err.details)).toContain('### B (y)');
  });

  it('reads a hard-wrapped, padded name like the one-line name', () => {
    expect(sliceSection(dispatch, 'Round counting\n  and escalation')).toBe(
      sliceSection(dispatch, 'Round counting and escalation'),
    );
    expect(sliceSection(dispatch, '  Round   counting and escalation \n')).toBe(
      sliceSection(dispatch, 'Round counting and escalation'),
    );
  });

  it('lists the playbook headings, outside fences and in order, on an unknown name', () => {
    const md = '# T\n## A\n```\n## Fake\n```\n### B (x)\n#### C\n## D\n';
    const err = errorOf(() => sliceSection(md, 'Nope'));
    expect(err.code).toBe('playbook.unknown-section');
    expect(err.details).toEqual({ heading: 'Nope', sections: ['## A', '### B (x)', '## D'] });
  });

  it('lists every dispatch.md section when a name is unknown', () => {
    const err = errorOf(() => sliceSection(dispatch, 'Dispatch contract'));
    const sections = (err.details as { sections: string[] }).sections;
    expect(sections).toContain('## Round counting and escalation (agent-interviews.md N-4)');
    expect(sections).toContain('## The task id goes on the event, not in the payload');
    expect(sections.every((s) => /^#{2,3} /.test(s))).toBe(true);
    expect(sections.filter((s) => s.startsWith('## ')).length).toBeGreaterThan(10);
  });

  it('never matches a heading inside a fence, or by prefix or substring', () => {
    expect(codeOf(() => sliceSection('## A (x)\n```\n## B (y)\n```\n', 'B'))).toBe(
      'playbook.unknown-section',
    );
    expect(codeOf(() => sliceSection('## Alpha beta (x)\n', 'Alpha'))).toBe(
      'playbook.unknown-section',
    );
    expect(codeOf(() => sliceSection('## Alpha (x) (y)\n', 'Alpha (x)'))).toBeUndefined();
    expect(codeOf(() => sliceSection('## Alpha (x) (y)\n', 'Alpha'))).toBe(
      'playbook.unknown-section',
    );
  });
});

describe('sliceSection by name, edge cases (tester)', () => {
  it('still cuts the byte-identical Return discipline heading brief compose uses', () => {
    const heading = 'Return discipline (agent-interviews.md M-6)';
    const md = `## Intro\nx\n## ${heading}\nbody\n## After\n`;
    expect(sliceSection(md, heading)).toBe(`## ${heading}\nbody\n`);
    expect(codeOf(() => sliceSection(md, 'Return discipline (agent-interviews.md M-7)'))).toBe(
      'playbook.unknown-section',
    );
  });

  it('strips only one trailing parenthetical group, and only after a space', () => {
    const md = '## Alpha (x) (y)\na\n## Beta(z)\nb\n';
    expect(codeOf(() => sliceSection(md, 'Alpha (x)'))).toBeUndefined();
    expect(codeOf(() => sliceSection(md, 'Alpha'))).toBe('playbook.unknown-section');
    expect(codeOf(() => sliceSection(md, 'Beta'))).toBe('playbook.unknown-section');
    expect(codeOf(() => sliceSection(md, 'Beta(z)'))).toBeUndefined();
  });

  it('keeps an exact duplicate ambiguous even when a name match exists', () => {
    const md = '## A\none\n### A\ntwo\n## A (x)\nthree\n';
    const err = errorOf(() => sliceSection(md, 'A'));
    expect(err.code).toBe('playbook.ambiguous-section');
    expect((err.details as { sections: string[] }).sections).toEqual(['## A', '### A']);
  });

  it('names an ambiguity across ## and ### in document order', () => {
    const md = '### B (y)\none\n## B (x)\ntwo\n';
    const err = errorOf(() => sliceSection(md, 'B'));
    expect((err.details as { sections: string[] }).sections).toEqual(['### B (y)', '## B (x)']);
  });

  it('cuts a name-matched ### section by its own level', () => {
    const md = '## A\n### B (y)\nb\n#### C\nc\n### D\nd\n';
    expect(sliceSection(md, 'B')).toBe('### B (y)\nb\n#### C\nc\n');
  });

  it('matches a very long heading in linear time', () => {
    const long = `${'word ( '.repeat(20000)}end`;
    const md = `## ${long} (x)\nbody\n`;
    const start = Date.now();
    expect(sliceSection(md, long)).toBe(`${md.split('\n')[0]}\nbody\n`);
    expect(codeOf(() => sliceSection(md, `${long} x`))).toBe('playbook.unknown-section');
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
