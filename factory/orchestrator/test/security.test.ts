import { describe, expect, it } from 'vitest';
import {
  loadSensitivePathsPolicy,
  parseSensitivePathsPolicy,
  SecurityError,
  type SensitivePathsPolicy,
  securityTriggers,
} from '../src/security.js';

/** A policy with only the fields a test cares about; the rest stay inert. */
function policy(overrides: Partial<SensitivePathsPolicy> = {}): SensitivePathsPolicy {
  return {
    globs: [],
    exclude: [],
    cases: [],
    epicTags: [],
    scheduledRecheck: false,
    ...overrides,
  };
}

describe('loadSensitivePathsPolicy', () => {
  it('reads the shipped factory/policies/sensitive-paths.yml', () => {
    const loaded = loadSensitivePathsPolicy();
    expect(loaded.globs.length).toBeGreaterThan(0);
    expect(loaded.exclude.length).toBeGreaterThan(0);
    expect(loaded.cases).toContain('infra');
    expect(loaded.epicTags).toContain('security');
    expect(loaded.scheduledRecheck).toBe(true);
  });

  it('throws when the file has no globs — an empty trigger list is a silent trigger', () => {
    expect(() => parseSensitivePathsPolicy('version: 1\n')).toThrowError(/globs/);
  });

  it('accepts the older other_triggers.epic_cases spelling', () => {
    const parsed = parseSensitivePathsPolicy(
      'globs: ["**/auth/**"]\nother_triggers:\n  epic_cases: [infra]\n',
    );
    expect(parsed.cases).toEqual(['infra']);
  });
});

// A scalar where a list belongs is the YAML typo that does not announce itself:
// `cases: infra` parses without complaint, and every trigger it governs goes
// dark. This file already refuses an empty `globs` for exactly that reason --
// "a path trigger with an empty glob list never fires" -- and the other three
// arms of the same dispatch condition earn the same refusal. Measured on the
// shipped policy, one such typo turns `dispatchSecurityReviewer` from true to
// false with an empty trigger list: not a weaker review, no review.
describe('parseSensitivePathsPolicy — a trigger it cannot read is a trigger that never fires', () => {
  const withGlobs = (rest: string): string => `globs: ["**/auth/**"]\n${rest}`;

  it('refuses a scalar other_triggers.cases instead of silently emptying it', () => {
    expect(() =>
      parseSensitivePathsPolicy(withGlobs('other_triggers:\n  cases: infra\n')),
    ).toThrowError(/other_triggers\.cases/);
  });

  it('refuses a scalar under the older epic_cases spelling too', () => {
    expect(() =>
      parseSensitivePathsPolicy(withGlobs('other_triggers:\n  epic_cases: infra\n')),
    ).toThrowError(/other_triggers\.epic_cases/);
  });

  it('refuses a scalar other_triggers.epic_tags', () => {
    expect(() =>
      parseSensitivePathsPolicy(withGlobs('other_triggers:\n  epic_tags: security\n')),
    ).toThrowError(/other_triggers\.epic_tags/);
  });

  // The one arm that fails loud rather than silent -- an ignored exclusion
  // over-fires -- but the operator still never learns their exclusion is dead.
  it('refuses a scalar exclude', () => {
    expect(() => parseSensitivePathsPolicy(withGlobs('exclude: "**/*.md"\n'))).toThrowError(
      /exclude/,
    );
  });

  // `globs: "**/auth/**"` already throws, but under the wrong diagnosis: the
  // file has a glob, it just is not a list. The message has to say which.
  it('tells a scalar globs apart from a missing one', () => {
    expect(() => parseSensitivePathsPolicy('globs: "**/auth/**"\n')).toThrowError(
      /globs must be a list of strings/,
    );
    expect(() => parseSensitivePathsPolicy('version: 1\n')).toThrowError(/has no globs/);
  });

  // `.map(String)` turned this into the glob '7', which matches nothing and
  // says nothing.
  it('refuses a list entry that is not a string', () => {
    expect(() => parseSensitivePathsPolicy('globs: ["**/auth/**", 7]\n')).toThrowError(
      /globs must be a list of strings/,
    );
  });

  // `=== true` reads a quoted YAML boolean -- the most ordinary slip in the
  // file -- as "no scheduled recheck".
  it('refuses a scheduled_recheck that is not a boolean', () => {
    expect(() =>
      parseSensitivePathsPolicy(withGlobs('other_triggers:\n  scheduled_recheck: "true"\n')),
    ).toThrowError(/scheduled_recheck/);
  });

  // The block itself, not just its keys: `other_triggers: security` takes all
  // three non-path arms dark in one line.
  it('refuses an other_triggers that is not a block of keys', () => {
    expect(() => parseSensitivePathsPolicy(withGlobs('other_triggers: security\n'))).toThrowError(
      /other_triggers/,
    );
  });

  it('names the field and the value it could not read', () => {
    try {
      parseSensitivePathsPolicy(withGlobs('other_triggers:\n  cases: infra\n'));
      expect.unreachable('a scalar cases must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(SecurityError);
      expect((error as SecurityError).code).toBe('security.invalid-policy');
      expect((error as SecurityError).message).toMatch(/other_triggers\.cases.*"infra"/s);
    }
  });

  // The guard against over-correcting: every one of these keys is optional,
  // and an operator who disables an arm in writing has said something.
  it('still accepts a document that omits the block, and an empty list stays legal', () => {
    const bare = parseSensitivePathsPolicy('globs: ["**/auth/**"]\n');
    expect(bare.exclude).toEqual([]);
    expect(bare.cases).toEqual([]);
    expect(bare.epicTags).toEqual([]);
    expect(bare.scheduledRecheck).toBe(false);

    const disabled = parseSensitivePathsPolicy(
      withGlobs('exclude: []\nother_triggers:\n  cases: []\n  scheduled_recheck: false\n'),
    );
    expect(disabled.exclude).toEqual([]);
    expect(disabled.cases).toEqual([]);
    expect(disabled.scheduledRecheck).toBe(false);
  });
});

// The table from dogfood-envkit-findings.md D-25: the paths the file claimed to
// cover and did not. Each of these is a real file a real task claimed.
describe('securityTriggers — the D-25 fixture table', () => {
  const shipped = loadSensitivePathsPolicy();

  it.each([
    ['src/parse.ts', 'untrusted input parsing'],
    ['src/auth.ts', 'authentication in a single file, not a directory'],
    ['pnpm-lock.yaml', 'the lockfile every JS project actually has'],
    ['src/validate.ts', 'validation of untrusted input'],
    ['src/session.ts', 'session handling in a single file'],
    ['package.json', 'dependency surface'],
    ['.env.example', 'a dotfile, which picomatch hides from * by default'],
    ['.github/workflows/ci.yml', 'a dot-directory, hidden the same way'],
  ])('fires on %s (%s)', (claim) => {
    const result = securityTriggers({ task_id: 't', claims: [claim] }, shipped);
    expect(result.dispatchSecurityReviewer).toBe(true);
    expect(result.triggers.map((t) => t.trigger)).toContain('sensitive-claim-path');
  });

  it.each([
    ['src/index.ts', 'a public API barrel is not a security surface by itself'],
    ['src/coerce.ts', 'type coercion of already-parsed values'],
    ['README.md', 'excluded: documentation'],
    ['src/parse.test.ts', 'excluded: the test file for a sensitive module'],
    ['test/parse.test.ts', 'excluded: same, under a test directory'],
    ['vitest.config.ts', 'test runner config'],
  ])('does not fire on %s (%s)', (claim) => {
    const result = securityTriggers({ task_id: 't', claims: [claim] }, shipped);
    expect(result.dispatchSecurityReviewer).toBe(false);
    expect(result.triggers).toEqual([]);
  });

  it('names the claim and the glob that fired, not just a boolean', () => {
    const result = securityTriggers({ task_id: 't', claims: ['src/parse.ts'] }, shipped);
    expect(result.triggers[0]).toMatchObject({
      trigger: 'sensitive-claim-path',
      claim: 'src/parse.ts',
    });
    expect(result.triggers[0]).toHaveProperty('glob');
  });
});

// The part the punch list calls out as worth a test: the naive `startsWith`
// reading gets this backwards, and a broadly scoped task is exactly the one
// that must not escape the review a narrowly scoped one gets.
describe('securityTriggers — overlap, not containment', () => {
  const authOnly = policy({ globs: ['**/auth/**'] });

  it('fires when the claim is wider than the glob (src/** vs **/auth/**)', () => {
    const result = securityTriggers({ task_id: 't', claims: ['src/**'] }, authOnly);
    expect(result.dispatchSecurityReviewer).toBe(true);
    expect(result.triggers).toEqual([
      { trigger: 'sensitive-claim-path', claim: 'src/**', glob: '**/auth/**' },
    ]);
  });

  it('fires when the claim is narrower than the glob (src/auth/login.ts)', () => {
    const result = securityTriggers({ task_id: 't', claims: ['src/auth/login.ts'] }, authOnly);
    expect(result.dispatchSecurityReviewer).toBe(true);
  });

  it('fires on a directory-form glob whose literal segment is a wildcard', () => {
    const result = securityTriggers(
      { task_id: 't', claims: ['src/**'] },
      policy({ globs: ['**/parse*/**'] }),
    );
    expect(result.dispatchSecurityReviewer).toBe(true);
  });

  it('does not fire when no path could satisfy both (src/*.ts vs **/auth/**)', () => {
    const result = securityTriggers({ task_id: 't', claims: ['src/*.ts'] }, authOnly);
    expect(result.dispatchSecurityReviewer).toBe(false);
  });

  it('does not fire on a disjoint literal claim', () => {
    const result = securityTriggers({ task_id: 't', claims: ['docs/readme.txt'] }, authOnly);
    expect(result.dispatchSecurityReviewer).toBe(false);
  });

  it('reports every (claim, glob) pair that fired, deduplicated per pair', () => {
    const result = securityTriggers(
      { task_id: 't', claims: ['src/auth/login.ts', 'src/session/store.ts'] },
      policy({ globs: ['**/auth/**', '**/session/**'] }),
    );
    expect(result.triggers).toEqual([
      { trigger: 'sensitive-claim-path', claim: 'src/auth/login.ts', glob: '**/auth/**' },
      { trigger: 'sensitive-claim-path', claim: 'src/session/store.ts', glob: '**/session/**' },
    ]);
  });
});

// The same escape one step down: a claim narrowed by *extension* rather than by
// directory. `ui/src/**/*.tsx` can add `ui/src/auth/Login.tsx` tomorrow, so it
// overlaps `**/auth/**` for exactly the reason `src/**` does.
describe('securityTriggers - a claim narrowed by extension still overlaps', () => {
  it('fires a directory glob for an extension-constrained claim', () => {
    const result = securityTriggers(
      { task_id: 't', claims: ['ui/src/**/*.tsx'] },
      policy({ globs: ['**/auth/**'] }),
    );
    expect(result.triggers).toEqual([
      { trigger: 'sensitive-claim-path', claim: 'ui/src/**/*.tsx', glob: '**/auth/**' },
    ]);
  });

  it.each(['src/**/*.py', 'app/**/*.rb', 'src/*.go', 'ui/**/*.tsx', 'svc/**/*.java'])(
    "fires a file glob on %s, not only on the brace set's first extension",
    (claim) => {
      const result = securityTriggers(
        { task_id: 't', claims: [claim] },
        policy({ globs: ['**/*auth*.{ts,tsx,js,jsx,py,go,rs,rb,java}'] }),
      );
      expect(result.dispatchSecurityReviewer).toBe(true);
    },
  );

  it.each(['ui/src/**/*.tsx', 'server/**/*.py', 'app/**/*.rb'])(
    'fires the shipped policy on %s',
    (claim) => {
      const result = securityTriggers(
        { task_id: 't', claims: [claim] },
        loadSensitivePathsPolicy(),
      );
      expect(result.dispatchSecurityReviewer).toBe(true);
    },
  );

  it('does not fire when the two extensions are genuinely disjoint', () => {
    const result = securityTriggers(
      { task_id: 't', claims: ['ui/**/*.vue'] },
      policy({ globs: ['**/*auth*.{ts,tsx}'] }),
    );
    expect(result.dispatchSecurityReviewer).toBe(false);
  });

  it("does not fire when the claim cannot reach the glob's directory", () => {
    const result = securityTriggers(
      { task_id: 't', claims: ['src/*.tsx'] },
      policy({ globs: ['**/auth/**'] }),
    );
    expect(result.dispatchSecurityReviewer).toBe(false);
  });
});

// Exclusions are containment, not overlap: an exclusion only silences a claim
// that is entirely inside it. Otherwise `**/*.test.ts` would silence `src/**`,
// and every broadly scoped task would escape the review by claiming a tree that
// happens to contain a test file.
describe('securityTriggers — exclusions are containment', () => {
  const parsePolicy = policy({
    globs: ['**/*parse*.{ts,tsx,js,jsx}'],
    exclude: ['**/*.test.{ts,tsx,js,jsx}'],
  });

  it('silences a claim that is entirely inside an exclusion', () => {
    const result = securityTriggers({ task_id: 't', claims: ['src/parse.test.ts'] }, parsePolicy);
    expect(result.dispatchSecurityReviewer).toBe(false);
  });

  it('does not silence a wider claim that merely overlaps an exclusion', () => {
    const result = securityTriggers({ task_id: 't', claims: ['src/**'] }, parsePolicy);
    expect(result.dispatchSecurityReviewer).toBe(true);
  });

  it('keeps the sensitive half of a mixed claim set', () => {
    const result = securityTriggers(
      { task_id: 't', claims: ['src/parse.ts', 'test/parse.test.ts'] },
      parsePolicy,
    );
    expect(result.triggers).toEqual([
      {
        trigger: 'sensitive-claim-path',
        claim: 'src/parse.ts',
        glob: '**/*parse*.{ts,tsx,js,jsx}',
      },
    ]);
  });
});

describe('securityTriggers — the other two triggers', () => {
  const inert = policy({ globs: ['**/auth/**'], cases: ['infra'], epicTags: ['security'] });

  it('fires on the task case even when no claim is sensitive', () => {
    const result = securityTriggers(
      { task_id: 't', claims: ['docs/notes.txt'], case: 'infra' },
      inert,
    );
    expect(result.dispatchSecurityReviewer).toBe(true);
    expect(result.triggers).toEqual([{ trigger: 'case', case: 'infra' }]);
  });

  it('does not fire on a case outside the policy list', () => {
    const result = securityTriggers(
      { task_id: 't', claims: ['src/a.txt'], case: 'feature' },
      inert,
    );
    expect(result.dispatchSecurityReviewer).toBe(false);
  });

  it('fires on an operator-supplied epic tag', () => {
    const result = securityTriggers({ task_id: 't', claims: ['src/a.txt'] }, inert, {
      epicTags: ['security'],
    });
    expect(result.triggers).toEqual([{ trigger: 'epic-tag', tag: 'security' }]);
  });

  it('fires on a scheduled recheck only when the policy allows it', () => {
    const allowed = securityTriggers(
      { task_id: 't', claims: ['src/a.txt'] },
      policy({ globs: ['**/auth/**'], scheduledRecheck: true }),
      { scheduledRecheck: true },
    );
    expect(allowed.triggers).toEqual([{ trigger: 'scheduled-recheck' }]);

    const denied = securityTriggers({ task_id: 't', claims: ['src/a.txt'] }, inert, {
      scheduledRecheck: true,
    });
    expect(denied.triggers).toEqual([]);
  });

  it('reports every trigger that fired, not the first', () => {
    const result = securityTriggers(
      { task_id: 't', claims: ['src/auth/login.ts'], case: 'infra' },
      inert,
      { epicTags: ['security'] },
    );
    expect(result.triggers.map((t) => t.trigger)).toEqual([
      'sensitive-claim-path',
      'case',
      'epic-tag',
    ]);
  });

  it('carries the task id through', () => {
    const result = securityTriggers({ task_id: 'epic/task-1', claims: [] }, inert);
    expect(result.taskId).toBe('epic/task-1');
    expect(result.dispatchSecurityReviewer).toBe(false);
  });
});

// The measurement in D-25: run the real epic's claim sets through the file and
// count. Before the rewrite this scored one for six, and the one was wrong.
// Claim sets copied from factory/specs/active/envkit-config-loader/plan-v1.json.
describe('securityTriggers — the envkit claim set, measured', () => {
  const shipped = loadSensitivePathsPolicy();
  const epic = [
    {
      task_id: 'envkit-config-loader/task-0-toolchain',
      case: 'infra',
      claims: ['package.json', 'pnpm-lock.yaml', 'vitest.config.ts'],
    },
    {
      task_id: 'envkit-config-loader/task-1a-parse-core',
      case: 'feature',
      claims: ['src/parse.ts', 'test/parse.test.ts'],
    },
    {
      task_id: 'envkit-config-loader/task-1b-parse-quotes',
      case: 'feature',
      claims: ['src/parse.ts', 'test/parse.test.ts'],
    },
    {
      task_id: 'envkit-config-loader/task-2-coerce',
      case: 'feature',
      claims: ['src/coerce.ts', 'test/coerce.test.ts'],
    },
    {
      task_id: 'envkit-config-loader/task-3-validate',
      case: 'feature',
      claims: ['src/validate.ts', 'test/validate.test.ts'],
    },
    {
      task_id: 'envkit-config-loader/task-4-api',
      case: 'feature',
      claims: ['src/index.ts', 'test/index.test.ts'],
    },
  ];

  it('fires on the four tasks that touch a security surface, and only those', () => {
    const fired = epic
      .filter((task) => securityTriggers(task, shipped).dispatchSecurityReviewer)
      .map((task) => task.task_id);
    expect(fired).toEqual([
      'envkit-config-loader/task-0-toolchain',
      'envkit-config-loader/task-1a-parse-core',
      'envkit-config-loader/task-1b-parse-quotes',
      'envkit-config-loader/task-3-validate',
    ]);
  });

  it('fires on the parse tasks for the parse path, not for something incidental', () => {
    const task = epic[1] as (typeof epic)[number];
    const result = securityTriggers(task, shipped);
    expect(result.triggers).toEqual([
      {
        trigger: 'sensitive-claim-path',
        claim: 'src/parse.ts',
        glob: expect.stringContaining('parse'),
      },
    ]);
  });

  it('fires on the toolchain task for the lockfile, not only for package.json', () => {
    const task = epic[0] as (typeof epic)[number];
    const claims = securityTriggers(task, shipped)
      .triggers.filter((t) => t.trigger === 'sensitive-claim-path')
      .map((t) => (t as { claim: string }).claim);
    expect(claims).toContain('pnpm-lock.yaml');
    expect(claims).toContain('package.json');
    expect(claims).not.toContain('vitest.config.ts');
  });
});
