import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SEVERITY_POLICY_PATH } from '../src/paths.js';
import {
  decide,
  LESSON_SCOPES,
  type LessonRule,
  loadSeverityPolicy,
  parseLessons,
  parseSeverityPolicy,
  type SeverityPolicy,
} from '../src/severity.js';
import { loadTaxonomy } from '../src/taxonomy.js';

const MINI_POLICY_YAML = `
levels:
  S1-stop-the-line:
    blocks_merge: true
  S2-major:
    blocks_merge: true
  S3-minor:
    blocks_merge: false
  S4-nit:
    blocks_merge: false
`;

const policy: SeverityPolicy = parseSeverityPolicy(MINI_POLICY_YAML);

const noLessons: readonly LessonRule[] = [];

describe('parseSeverityPolicy', () => {
  it('parses blocks_merge per level from severity.yml-shaped YAML', () => {
    expect(policy.levels['S1-stop-the-line']?.blocksMerge).toBe(true);
    expect(policy.levels['S3-minor']?.blocksMerge).toBe(false);
  });

  it("the real repo severity.yml matches the operator-defined policy (S1/S2 block, S3/S4 don't)", async () => {
    const { loadSeverityPolicy } = await import('../src/severity.js');
    const real = loadSeverityPolicy();
    expect(real.levels['S1-stop-the-line']?.blocksMerge).toBe(true);
    expect(real.levels['S2-major']?.blocksMerge).toBe(true);
    expect(real.levels['S3-minor']?.blocksMerge).toBe(false);
    expect(real.levels['S4-nit']?.blocksMerge).toBe(false);
  });
});

describe('decide (severity x context table)', () => {
  it.each([
    ['S1-stop-the-line', 'block'],
    ['S2-major', 'block'],
    ['S3-minor', 'waiver-batch'],
    ['S4-nit', 'log-only'],
  ])('%s with no matching lesson -> action=%s, no escalation', (severity, action) => {
    const decision = decide(
      { finding_category: 'correctness', severity },
      { filePath: 'src/foo.ts', lessons: noLessons },
      policy,
    );
    expect(decision.severity).toBe(severity);
    expect(decision.action).toBe(action);
    expect(decision.sameMistake).toBe(false);
    expect(decision.blocks).toBe(severity === 'S1-stop-the-line' || severity === 'S2-major');
  });

  const matchingLesson: LessonRule = {
    lessonId: 'lesson-1',
    scope: 'claim-path',
    category: 'correctness',
    claimPath: 'src/**',
    agentRole: '',
    caseType: '',
    statement: 'never do the thing again',
  };

  it.each([
    ['S4-nit', 'S3-minor', 'waiver-batch'],
    ['S3-minor', 'S2-major', 'block'],
    ['S2-major', 'S1-stop-the-line', 'block'],
  ])('escalates %s -> %s on a same-mistake match', (from, expectedTo, expectedAction) => {
    const decision = decide(
      { finding_category: 'correctness', severity: from },
      { filePath: 'src/foo.ts', lessons: [matchingLesson] },
      policy,
    );
    expect(decision.severity).toBe(expectedTo);
    expect(decision.action).toBe(expectedAction);
    expect(decision.sameMistake).toBe(true);
    expect(decision.matchedLessonId).toBe('lesson-1');
  });

  it('up-caps escalation at S1 (never escalates past stop-the-line)', () => {
    const decision = decide(
      { finding_category: 'correctness', severity: 'S1-stop-the-line' },
      { filePath: 'src/foo.ts', lessons: [matchingLesson] },
      policy,
    );
    expect(decision.severity).toBe('S1-stop-the-line');
    expect(decision.blocks).toBe(true);
    expect(decision.sameMistake).toBe(true);
  });

  it('does not match when the category differs', () => {
    const decision = decide(
      { finding_category: 'security', severity: 'S4-nit' },
      { filePath: 'src/foo.ts', lessons: [matchingLesson] },
      policy,
    );
    expect(decision.sameMistake).toBe(false);
    expect(decision.severity).toBe('S4-nit');
  });

  it('never matches a category-less lesson, whatever the finding category', () => {
    // Injectable at dispatch (P9-2), but there is no category for it to be the
    // same mistake as — an empty category must not act as a wildcard.
    const categoryless: LessonRule = {
      lessonId: 'lesson-no-category',
      scope: 'stack-wide',
      category: '',
      claimPath: '**',
      agentRole: '',
      caseType: '',
      statement: 'Always name what you did not reach.',
    };
    for (const category of ['correctness', 'security', '']) {
      const decision = decide(
        { finding_category: category, severity: 'S4-nit' },
        { filePath: 'src/foo.ts', lessons: [categoryless] },
        policy,
      );
      expect(decision.sameMistake).toBe(false);
      expect(decision.matchedLessonId).toBeNull();
    }
  });

  it('does not match when the file is outside the lesson claim_path scope', () => {
    const decision = decide(
      { finding_category: 'correctness', severity: 'S4-nit' },
      { filePath: 'ui/foo.ts', lessons: [matchingLesson] },
      policy,
    );
    expect(decision.sameMistake).toBe(false);
  });

  it('a stack-wide lesson (no claim_path) covers every file', () => {
    const stackWide: LessonRule = {
      lessonId: 'lesson-2',
      scope: 'stack-wide',
      category: 'security',
      claimPath: '**',
      agentRole: '',
      caseType: '',
      statement: 'always validate input',
    };
    const decision = decide(
      { finding_category: 'security', severity: 'S4-nit' },
      { filePath: 'anywhere/at/all.ts', lessons: [stackWide] },
      policy,
    );
    expect(decision.sameMistake).toBe(true);
  });

  // Interview N-8: `security` is file-scoped like claim-path. A security lesson
  // is written against the paths it guards ("src/auth/**"), and a repeat
  // security finding on one of those paths is the exact case same-mistake
  // escalation exists for — leaving it out of FILE_SCOPED would compile
  // security lessons that can never escalate anything.
  it('a security-scoped lesson escalates a repeat finding on the path it guards', () => {
    const securityLesson: LessonRule = {
      lessonId: 'lesson-sec',
      scope: 'security',
      category: 'security',
      claimPath: 'src/auth/**',
      agentRole: '',
      caseType: '',
      statement: 'session tokens are never logged, not even at debug level',
    };
    const onGuardedPath = decide(
      { finding_category: 'security', severity: 'S3-minor' },
      { filePath: 'src/auth/session.ts', lessons: [securityLesson] },
      policy,
    );
    expect(onGuardedPath.sameMistake).toBe(true);
    expect(onGuardedPath.severity).toBe('S2-major');

    const offGuardedPath = decide(
      { finding_category: 'security', severity: 'S3-minor' },
      { filePath: 'src/ui/button.ts', lessons: [securityLesson] },
      policy,
    );
    expect(offGuardedPath.sameMistake).toBe(false);
  });

  it('agent-role and case-type scoped lessons never participate in the per-file match', () => {
    const agentRole: LessonRule = {
      lessonId: 'lesson-3',
      scope: 'agent-role',
      category: 'correctness',
      claimPath: '**',
      agentRole: 'coder',
      caseType: '',
      statement: 'coder should always do X',
    };
    const decision = decide(
      { finding_category: 'correctness', severity: 'S4-nit' },
      { filePath: 'src/foo.ts', lessons: [agentRole] },
      policy,
    );
    expect(decision.sameMistake).toBe(false);
  });
});

describe('LESSON_SCOPES', () => {
  // The compile side (lessons.ts) and the parse side (severity.ts) used to keep
  // separate copies of this list; a scope added to one and not the other made
  // compileLessons drop the lesson into no bucket at all — silently, with no
  // error anywhere (interview N-8). One exported const, and this test to keep it
  // honest against the taxonomy it mirrors.
  it('matches taxonomy.yml lesson_scope exactly, in order', () => {
    const tx = loadTaxonomy();
    expect([...LESSON_SCOPES]).toEqual(tx.dimensions.lesson_scope);
  });
});

describe('parseLessons', () => {
  it('parses rule entries with lesson_id, finding_category, claim_path, statement, grouped by scope', () => {
    const markdown = `# Compiled Lessons

## claim-path

### Never edit lockfiles in workers

- lesson_id: lesson-001
- finding_category: maintainability
- claim_path: **/pnpm-lock.yaml
- statement: Lockfiles are regenerated by the merge queue.

## stack-wide

### Always validate input

- lesson_id: lesson-002
- finding_category: security
- statement: Untrusted input must be validated at the boundary.
`;
    const lessons = parseLessons(markdown);
    expect(lessons).toHaveLength(2);
    expect(lessons[0]).toMatchObject({
      lessonId: 'lesson-001',
      scope: 'claim-path',
      category: 'maintainability',
      claimPath: '**/pnpm-lock.yaml',
    });
    // claim_path omitted -> defaults to "**" (stack-wide convention, lessons.md).
    expect(lessons[1]).toMatchObject({
      lessonId: 'lesson-002',
      scope: 'stack-wide',
      category: 'security',
      claimPath: '**',
    });
  });

  it('joins an indented continuation line onto the bullet it follows (lessons.md doc-block example, verbatim)', () => {
    // Regression: continuation lines of a multi-line `- statement:` bullet
    // used to be silently dropped — this is lessons.md's OWN documented
    // example, and it used to round-trip truncated mid-sentence.
    const markdown = `## claim-path

### Never hand-edit a lockfile in a worker

- lesson_id: lesson-2026-08-01-003
- finding_category: maintainability
- claim_path: **/pnpm-lock.yaml
- statement: Lockfiles are regenerable and regenerated by the merge queue;
  a worker editing one directly is always a mistake, not a judgment call.
`;
    const lessons = parseLessons(markdown);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.statement).toBe(
      'Lockfiles are regenerable and regenerated by the merge queue; a worker editing one directly is always a mistake, not a judgment call.',
    );
  });

  it('parses an entry with no finding_category (optional per lesson.schema.json)', () => {
    const markdown = `## agent-role

### Emit a research-request

- lesson_id: lesson-003
- statement: Emit a research_request instead of exploring the repo yourself.
`;
    expect(parseLessons(markdown)).toEqual([
      {
        lessonId: 'lesson-003',
        scope: 'agent-role',
        category: '',
        claimPath: '**',
        agentRole: '',
        caseType: '',
        statement: 'Emit a research_request instead of exploring the repo yourself.',
      },
    ]);
  });

  // D-129: `agent-role` and `case-type` are selector scopes with no selector
  // field — every entry in them matched every dispatch. The compiled file now
  // carries the selector, and the parser has to read it back or the filter
  // downstream has nothing to filter on.
  it('parses the agent_role and case_type selector bullets (D-129)', () => {
    const markdown = `## agent-role

### Graders do not re-run the tests

- lesson_id: lesson-005
- agent_role: grader
- statement: A grader that re-runs the suite is grading the runner, not the work.

## case-type

### Refactors carry no behaviour change

- lesson_id: lesson-006
- case_type: refactor
- statement: A refactor that changes a test expectation is not a refactor.
`;
    expect(parseLessons(markdown)).toEqual([
      {
        lessonId: 'lesson-005',
        scope: 'agent-role',
        category: '',
        claimPath: '**',
        agentRole: 'grader',
        caseType: '',
        statement: 'A grader that re-runs the suite is grading the runner, not the work.',
      },
      {
        lessonId: 'lesson-006',
        scope: 'case-type',
        category: '',
        claimPath: '**',
        agentRole: '',
        caseType: 'refactor',
        statement: 'A refactor that changes a test expectation is not a refactor.',
      },
    ]);
  });

  it('still skips an entry with no statement', () => {
    const markdown = `## agent-role

### Half an entry

- lesson_id: lesson-004
- finding_category: process
`;
    expect(parseLessons(markdown)).toEqual([]);
  });

  it('skips placeholder/empty sections without throwing', () => {
    const markdown = `## agent-role

_(none yet)_

## claim-path

_(none yet)_
`;
    expect(parseLessons(markdown)).toEqual([]);
  });

  // Was "no lessons yet, per Phase 2" and asserted `[]`. That held only while
  // the file was empty; phase-9 compiled 14 approved lessons into it. The
  // assertion worth keeping is not the count but the two ways this file can
  // silently lie to the gate: the header's own fenced EXAMPLE entry being read
  // as real, and a real entry being dropped (interview N-8, where `security`
  // vanished at compile time because the two scope lists disagreed).
  it('the real committed lessons.md parses to exactly its own entries — no example, no drops', async () => {
    const { readFileSync } = await import('node:fs');
    const { REPO_ROOT } = await import('../src/paths.js');
    const path = await import('node:path');
    const text = readFileSync(path.join(REPO_ROOT, 'factory', 'policies', 'lessons.md'), 'utf8');
    const parsed = parseLessons(text);

    // Counted independently of the parser, so a parser that drops an entry
    // cannot agree with itself.
    const bulletIds = [...text.matchAll(/^- lesson_id: (.+)$/gm)].map((m) => (m[1] ?? '').trim());
    // The header documents the format with a worked example inside a fenced
    // block; it carries a `- lesson_id:` bullet and must not become a rule.
    const EXAMPLE_ID = 'lesson-2026-08-01-003';
    expect(bulletIds).toContain(EXAMPLE_ID);
    expect(parsed.map((l) => l.lessonId)).not.toContain(EXAMPLE_ID);
    expect(parsed).toHaveLength(bulletIds.length - 1);

    for (const lesson of parsed) {
      expect(lesson.lessonId).not.toBe('');
      expect(lesson.statement).not.toBe('');
      expect(LESSON_SCOPES).toContain(lesson.scope);
    }
  });
});

describe('loadSeverityPolicy', () => {
  // The convention budgets.test.ts, crosscheck.test.ts and scheduler.test.ts
  // all keep: the loader's default and the paths.ts constant must name one
  // file. severity.ts could not be held to it until now, because it declared
  // its own copy of the path rather than importing one.
  it('reads the same file SEVERITY_POLICY_PATH points to', () => {
    const text = readFileSync(SEVERITY_POLICY_PATH, 'utf8');
    expect(parseSeverityPolicy(text)).toEqual(loadSeverityPolicy());
  });
});
