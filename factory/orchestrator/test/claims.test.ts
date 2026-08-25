import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaimsError,
  claimsOverlap,
  classifyChanges,
  collectCommittedChanges,
  collectWorkingTreeChanges,
  decideFindingAttribution,
  globsOverlap,
  loadWorktreePolicy,
  postRunCheck,
  resolveFindingOwner,
  validateWave,
  type WaveTask,
  type WaveValidationResult,
  writeRootCheck,
} from '../src/claims.js';
import { git as runGitFixture } from './helpers/process.js';

/**
 * `WaveValidationResult` is a discriminated union: the violation lists exist
 * only on the rejecting arm, so reading one means proving the wave was
 * rejected first. `expect(result.valid).toBe(false)` asserts it without
 * narrowing it; this both asserts and narrows, once, for every test below.
 */
function rejected(result: WaveValidationResult): Extract<WaveValidationResult, { valid: false }> {
  if (result.valid) throw new Error('expected the wave to be rejected, but it validated');
  return result;
}

describe('globsOverlap', () => {
  it.each([
    ['identical globs', 'src/foo/**', 'src/foo/**', true],
    ['parent/child directory globs', 'src/**', 'src/types/**', true],
    ['sibling directories do not overlap', 'src/foo/**', 'src/bar/**', false],
    ['file glob nested under a directory glob', 'src/foo/*.ts', 'src/foo/a.ts', true],
    ['disjoint literal files', 'src/foo/a.ts', 'src/foo/b.ts', false],
    ['unrelated top-level trees', 'db/migrations/**', 'ui/**', false],
    ['identical literal file', 'src/types/index.ts', 'src/types/index.ts', true],
    // Reproduced false negatives (reviewer finding): a directory wildcard
    // with a base vs. a globstar-anchored basename/suffix pattern with no
    // base — both jointly match real paths (e.g. "src/config.ts",
    // "src/x.ts") and must be flagged as overlapping.
    ['dir wildcard vs globstar-anchored basename', 'src/**', '**/config.ts', true],
    ['nested file-extension globs, one anchored under a dir', 'src/**/*.ts', '**/*.ts', true],
    // Genuinely disjoint globstar-anchored basenames must stay false (the
    // fix must not become a blanket true for every glob-vs-glob pair).
    ['disjoint globstar-anchored basenames', '**/pnpm-lock.yaml', '**/config.ts', false],
    ['disjoint globstar-anchored extensions', '**/*.md', '**/*.json', false],
    // Brace sets: one shared alternative -> overlap; no shared extension -> not.
    ['brace set sharing an extension with a dir wildcard', 'src/**', '**/*.{ts,tsx}', true],
    ['brace sets with disjoint extensions', '**/*.{ts,tsx}', '**/*.{md,yaml}', false],
    // `?` single-char wildcard in a globstar-anchored basename.
    ['single-char wildcard basename vs dir wildcard', 'src/**', '**/config?.ts', true],
  ])('%s: %s vs %s -> %s', (_label, a, b, expected) => {
    expect(globsOverlap(a, b)).toBe(expected);
  });
});

describe('claimsOverlap', () => {
  it('reports no overlap for disjoint claim sets', () => {
    const result = claimsOverlap({ claims: ['src/foo/**'] }, { claims: ['src/bar/**'] });
    expect(result.overlaps).toBe(false);
    expect(result.offendingGlobs).toEqual([]);
  });

  it('reports overlap with the offending glob pair', () => {
    const result = claimsOverlap(
      { claims: ['src/foo/**', 'src/shared/util.ts'] },
      { claims: ['src/foo/a.ts'] },
    );
    expect(result.overlaps).toBe(true);
    expect(result.offendingGlobs).toEqual([{ globA: 'src/foo/**', globB: 'src/foo/a.ts' }]);
  });
});

describe('loadWorktreePolicy', () => {
  it('loads serialize-always globs from the real worktree.yml', () => {
    const policy = loadWorktreePolicy();
    expect(policy.serializeAlwaysGlobs).toContain('src/types/**');
    expect(policy.serializeAlwaysGlobs).toContain('**/pnpm-lock.yaml');
  });
});

describe('validateWave', () => {
  const policy = { serializeAlwaysGlobs: ['**/pnpm-lock.yaml', 'src/types/**'] };

  it('accepts a wave whose tasks have pairwise-disjoint claims and no serialize-always collisions', () => {
    // Literal (non-glob) claims: a directory wildcard like "src/foo/**"
    // could in principle also match a serialize-always basename guard like
    // "**/pnpm-lock.yaml" (glob semantics don't know the real file list),
    // so this fixture uses specific files to isolate "genuinely disjoint,
    // no shared-hotspot risk" from that separate directory-wildcard case
    // (covered in the globsOverlap table above).
    const result = validateWave(
      [
        { task_id: 'a', claims: ['src/foo/index.ts'] },
        { task_id: 'b', claims: ['src/bar/index.ts'] },
      ],
      policy,
      [],
    );
    expect(result.valid).toBe(true);
  });

  it('rejects a wave with overlapping claims', () => {
    const result = validateWave(
      [
        { task_id: 'a', claims: ['src/foo/**'] },
        { task_id: 'b', claims: ['src/foo/a.ts'] },
      ],
      policy,
      [],
    );
    expect(rejected(result).overlapViolations).toHaveLength(1);
  });

  it('rejects a wave where two tasks both touch a serialize-always glob', () => {
    const result = validateWave(
      [
        { task_id: 'a', claims: ['src/types/**'] },
        { task_id: 'b', claims: ['src/types/foo.ts'] },
      ],
      policy,
      [],
    );
    const { serializeAlwaysViolations } = rejected(result);
    expect(serializeAlwaysViolations).toHaveLength(1);
    expect(serializeAlwaysViolations[0]).toMatchObject({ taskA: 'a', taskB: 'b' });
  });

  it('a single task alone touching a serialize-always glob is fine', () => {
    const result = validateWave([{ task_id: 'a', claims: ['src/types/**'] }], policy, []);
    expect(result.valid).toBe(true);
  });

  /**
   * The shape this gate compares is not the shape the contract promises.
   * `task-spec.schema.json` declares claims an array of strings with
   * `minItems: 1`, but `validatePlan` is reached from exactly one command
   * (`smith plan validate`); `wave check` reads the same file with a bare
   * `JSON.parse(...) as PlanFile` and hands what it finds straight to
   * `validateWave`. The casts below are not the test cheating — they are
   * what that read already does, written out.
   */
  function refusal(fn: () => unknown): ClaimsError {
    try {
      fn();
    } catch (err) {
      if (err instanceof ClaimsError) return err;
      throw err;
    }
    throw new Error('expected the wave to be refused, but it was answered');
  }

  const unreadable = (claims: unknown) => ({ task_id: 'a', claims }) as unknown as WaveTask;

  it('refuses a claim set written as a bare string instead of comparing its characters', () => {
    // The whole defect in one pair: with `claims: ['src/api/**']` this wave is
    // correctly refused, and with the same claim written as a bare string it
    // was admitted — `for (const globA of taskA.claims)` iterates a string
    // by CHARACTER, and 's', 'r', 'c' overlap no path, so two tasks both
    // allowed to edit src/api/handler.ts went into parallel worktrees to
    // collide at merge instead of here.
    const err = refusal(() =>
      validateWave(
        [unreadable('src/api/**'), { task_id: 'b', claims: ['src/api/handler.ts'] }],
        policy,
        [],
      ),
    );
    expect(err.code).toBe('claims.unreadable-claims');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an object', { globs: ['src/api/**'] }],
  ])('refuses a claim set that is %s rather than dying on a TypeError', (_label, claims) => {
    const err = refusal(() =>
      validateWave([unreadable(claims), { task_id: 'b', claims: ['src/b.ts'] }], policy, []),
    );
    // Not a raw TypeError: the CLI prints SmithError as JSON on stdout and
    // exits 1, so an unnamed throw here leaves the operator a stack trace
    // where the contract says there is an error code.
    expect(err.code).toBe('claims.unreadable-claims');
  });

  it('refuses a claim list holding something that is not a glob', () => {
    const err = refusal(() =>
      validateWave(
        [unreadable(['src/api/**', 42]), { task_id: 'b', claims: ['src/api/handler.ts'] }],
        policy,
        [],
      ),
    );
    expect(err.code).toBe('claims.unreadable-claims');
  });

  it('refuses a task that claims nothing, which overlaps with nothing and so admits everything', () => {
    // Both registers wave check reads from substitute an empty list for a
    // claims value they cannot read, and an empty list is pairwise-disjoint
    // with every other task in the wave. taskEvents.ts says why that is not a
    // pass: a task admitted with no claims is "allowed to touch nothing, which
    // fails at the first edit rather than at admission, where the mistake
    // actually is".
    const err = refusal(() =>
      validateWave([unreadable([]), { task_id: 'b', claims: ['src/b.ts'] }], policy, []),
    );
    expect(err.code).toBe('claims.empty-claims');
  });

  it('names the task and the shape it got, never the value it could not read', () => {
    // D-198: this message is the operator's whole diagnosis, and quoting an
    // unvalidated plan or log field back into it puts file content into an
    // error string. The type is a closed vocabulary; the value is not.
    const err = refusal(() => validateWave([unreadable('src/secret-path/**')], policy, []));
    expect(err.message).toContain('a');
    expect(err.message).toContain('string');
    expect(err.message).not.toContain('src/secret-path/**');
  });

  /**
   * D-212. `factory/policies/worktree.yml` states the remedy this gate exists
   * to make stick: "tasks with overlapping claims are never scheduled
   * concurrently; they get a dependency edge (edge_type: claim-order) and run
   * serially instead." Cutting that edge is also what narrows the claims, so
   * the plan that took the advice is the plan whose claims this gate then has
   * nothing left to object to.
   */
  describe('declared dependencies (D-212)', () => {
    it('rejects a wave holding both ends of a dependency edge, disjoint claims and all', () => {
      const result = validateWave(
        [
          { task_id: 'a', claims: ['src/foo/index.ts'] },
          { task_id: 'b', claims: ['src/bar/index.ts'] },
        ],
        policy,
        [{ task: 'b', dependsOn: 'a' }],
      );
      const { dependencyViolations } = rejected(result);
      expect(dependencyViolations).toEqual([{ task: 'b', dependsOn: 'a', chain: ['b', 'a'] }]);
    });

    it('rejects a pair the plan orders through a task the wave leaves out', () => {
      // {a, c} under `c <- b <- a`: no edge joins the wave's own two members,
      // and b's absence from it is what makes them concurrent, not what makes
      // them safe -- c cannot start until b lands, and b cannot until a does.
      const result = validateWave(
        [
          { task_id: 'a', claims: ['src/foo/index.ts'] },
          { task_id: 'c', claims: ['src/baz/index.ts'] },
        ],
        policy,
        [
          { task: 'c', dependsOn: 'b' },
          { task: 'b', dependsOn: 'a' },
        ],
      );
      expect(rejected(result).dependencyViolations).toEqual([
        { task: 'c', dependsOn: 'a', chain: ['c', 'b', 'a'] },
      ]);
    });

    it('admits a wave the plan orders only against tasks outside it', () => {
      // The ordinary case, and the reason this is not `admit()`'s job: a
      // prerequisite the wave does not contain is one that already landed.
      const result = validateWave([{ task_id: 'b', claims: ['src/bar/index.ts'] }], policy, [
        { task: 'b', dependsOn: 'a' },
      ]);
      expect(result.valid).toBe(true);
    });

    it('refuses edges it cannot read rather than reading them as none declared', () => {
      // The door `claims` already comes through: `wave check` reads the plan
      // with a bare `JSON.parse(...) as PlanFile`, so `edges` holds whatever
      // JSON held. A value that is not a list must not iterate to zero pairs,
      // because zero pairs is the answer that admits the wave.
      const err = refusal(() =>
        validateWave([{ task_id: 'a', claims: ['src/foo/index.ts'] }], policy, 'b<-a'),
      );
      expect(err.code).toBe('claims.unreadable-edges');
      // D-198, same as the claims message above it.
      expect(err.message).not.toContain('b<-a');
    });

    it('refuses an edge whose endpoints are not task ids', () => {
      const err = refusal(() =>
        validateWave([{ task_id: 'a', claims: ['src/foo/index.ts'] }], policy, [
          { task: 'a', dependsOn: 7 },
        ]),
      );
      expect(err.code).toBe('claims.unreadable-edges');
    });
  });
});

describe('postRunCheck', () => {
  let repoDir: string;

  function git(args: string[], cwd = repoDir) {
    return runGitFixture(cwd, args);
  }

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), 'smith-claims-repo-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    await mkdir(path.join(repoDir, 'src', 'foo'), { recursive: true });
    await writeFile(path.join(repoDir, 'src', 'foo', 'a.ts'), 'export const a = 1;\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'init']);
    git(['branch', 'smith/epic-1/integration']);
    git(['checkout', '-q', '-b', 'smith/epic-1/task-1', 'smith/epic-1/integration']);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('returns all changed files as in-claim when they match the claims', async () => {
    await writeFile(path.join(repoDir, 'src', 'foo', 'a.ts'), 'export const a = 2;\n');
    git(['commit', '-q', '-am', 'edit a']);

    const result = postRunCheck(repoDir, ['src/foo/**']);
    expect(result.inClaim).toEqual(['src/foo/a.ts']);
    expect(result.outOfClaim).toEqual([]);
    expect(result.violation).toBeNull();
  });

  it('flags out-of-claim edits as a contract.claim-violation', async () => {
    await mkdir(path.join(repoDir, 'src', 'bar'), { recursive: true });
    await writeFile(path.join(repoDir, 'src', 'bar', 'b.ts'), 'export const b = 1;\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'add out-of-claim file']);

    const result = postRunCheck(repoDir, ['src/foo/**']);
    expect(result.outOfClaim).toEqual(['src/bar/b.ts']);
    expect(result.violation).toMatchObject({ error: 'contract.claim-violation' });
  });

  it('still derives the integration branch from the branch name (collector split kept this)', async () => {
    git(['checkout', '-q', '-b', 'not-a-smith-branch']);
    expect(() => collectCommittedChanges(repoDir)).toThrowError(
      /does not follow the smith\/<epic>\/<task-id> convention/,
    );
  });
});

describe('classifyChanges', () => {
  it('splits a changed-file set by pattern, with no violation when nothing falls outside', () => {
    const result = classifyChanges(['src/a.ts', 'src/nested/b.ts'], ['src/**']);
    expect(result.inClaim).toEqual(['src/a.ts', 'src/nested/b.ts']);
    expect(result.outOfClaim).toEqual([]);
    expect(result.violation).toBeNull();
  });

  it('names the violation with the code the caller asked for', () => {
    const claims = classifyChanges(['ui/x.tsx'], ['src/**']);
    expect(claims.violation).toEqual({ error: 'contract.claim-violation', files: ['ui/x.tsx'] });

    const roots = classifyChanges(['ui/x.tsx'], ['src/**'], 'contract.write-root-violation');
    expect(roots.violation).toEqual({
      error: 'contract.write-root-violation',
      files: ['ui/x.tsx'],
    });
  });

  it('an empty pattern list puts every change out of bounds (a role with no write root writes nothing)', () => {
    const result = classifyChanges(['anything.ts'], []);
    expect(result.inClaim).toEqual([]);
    expect(result.outOfClaim).toEqual(['anything.ts']);
  });
});

describe('collectWorkingTreeChanges', () => {
  let repoDir: string;

  function git(args: string[], cwd = repoDir) {
    return runGitFixture(cwd, args);
  }

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), 'smith-worktree-changes-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    await mkdir(path.join(repoDir, 'factory', 'specs', 'active', 'epic-1'), { recursive: true });
    await writeFile(
      path.join(repoDir, 'factory', 'specs', 'active', 'epic-1', 'plan.json'),
      '{}\n',
    );
    git(['add', '.']);
    git(['commit', '-q', '-m', 'init']);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('returns nothing on a clean tree, on an ordinary branch name', () => {
    expect(collectWorkingTreeChanges(repoDir)).toEqual([]);
  });

  it('reports staged, unstaged and untracked changes together', async () => {
    await writeFile(
      path.join(repoDir, 'factory', 'specs', 'active', 'epic-1', 'plan.json'),
      '{"a":1}\n',
    );
    await writeFile(path.join(repoDir, 'staged.md'), 'staged\n');
    git(['add', 'staged.md']);
    await writeFile(path.join(repoDir, 'untracked.md'), 'untracked\n');

    expect(collectWorkingTreeChanges(repoDir).sort()).toEqual([
      'factory/specs/active/epic-1/plan.json',
      'staged.md',
      'untracked.md',
    ]);
  });

  it('reports paths relative to the repo root even when handed a subdirectory', async () => {
    await writeFile(
      path.join(repoDir, 'factory', 'specs', 'active', 'epic-1', 'plan.json'),
      '{"a":1}\n',
    );
    expect(collectWorkingTreeChanges(path.join(repoDir, 'factory'))).toEqual([
      'factory/specs/active/epic-1/plan.json',
    ]);
  });

  it('reports BOTH sides of a rename — moving a file out of a write root touches two paths', async () => {
    git(['mv', 'factory/specs/active/epic-1/plan.json', 'plan-moved.json']);
    expect(collectWorkingTreeChanges(repoDir).sort()).toEqual([
      'factory/specs/active/epic-1/plan.json',
      'plan-moved.json',
    ]);
  });

  it('handles a path with a space in it (porcelain quoting would corrupt it)', async () => {
    await writeFile(path.join(repoDir, 'a file.md'), 'x\n');
    expect(collectWorkingTreeChanges(repoDir)).toEqual(['a file.md']);
  });

  it('with `since`, also reports what was committed after that ref, deduped', async () => {
    const base = git(['rev-parse', 'HEAD']).trim();
    await writeFile(path.join(repoDir, 'committed.md'), 'c\n');
    await writeFile(
      path.join(repoDir, 'factory', 'specs', 'active', 'epic-1', 'plan.json'),
      '{"a":1}\n',
    );
    git(['add', '.']);
    git(['commit', '-q', '-m', 'planner committed its own work']);
    // ...and then dirtied one of the same files again, uncommitted.
    await writeFile(
      path.join(repoDir, 'factory', 'specs', 'active', 'epic-1', 'plan.json'),
      '{"a":2}\n',
    );

    expect(collectWorkingTreeChanges(repoDir, { since: base }).sort()).toEqual([
      'committed.md',
      'factory/specs/active/epic-1/plan.json',
    ]);
    // Without `since`, the committed-only file is invisible — that is the
    // window this option exists to widen.
    expect(collectWorkingTreeChanges(repoDir)).toEqual(['factory/specs/active/epic-1/plan.json']);
  });

  it('refuses a `since` ref git cannot resolve, rather than reporting an empty diff', () => {
    expect(() => collectWorkingTreeChanges(repoDir, { since: 'no-such-ref' })).toThrowError(
      /no-such-ref/,
    );
  });
});

describe('writeRootCheck', () => {
  let repoDir: string;

  function git(args: string[], cwd = repoDir) {
    return runGitFixture(cwd, args);
  }

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), 'smith-write-roots-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    await writeFile(path.join(repoDir, 'README.md'), '# repo\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'init']);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  // The planner and scribe write outside any worktree, on an ordinary branch,
  // and their output is uncommitted when you want to look at it (P9-3).
  it('passes a planner that stayed inside factory/specs/active/<epic>/**', async () => {
    await mkdir(path.join(repoDir, 'factory', 'specs', 'active', 'epic-1'), { recursive: true });
    await writeFile(
      path.join(repoDir, 'factory', 'specs', 'active', 'epic-1', 'plan.json'),
      '{}\n',
    );

    const result = writeRootCheck(repoDir, ['factory/specs/active/epic-1/**']);
    expect(result.inClaim).toEqual(['factory/specs/active/epic-1/plan.json']);
    expect(result.violation).toBeNull();
  });

  it('flags a planner that edited a policy file as contract.write-root-violation', async () => {
    await mkdir(path.join(repoDir, 'factory', 'specs', 'active', 'epic-1'), { recursive: true });
    await writeFile(
      path.join(repoDir, 'factory', 'specs', 'active', 'epic-1', 'plan.json'),
      '{}\n',
    );
    await mkdir(path.join(repoDir, 'factory', 'policies'), { recursive: true });
    await writeFile(path.join(repoDir, 'factory', 'policies', 'severity.yml'), 'levels: {}\n');

    const result = writeRootCheck(repoDir, ['factory/specs/active/epic-1/**']);
    expect(result.outOfClaim).toEqual(['factory/policies/severity.yml']);
    expect(result.violation).toEqual({
      error: 'contract.write-root-violation',
      files: ['factory/policies/severity.yml'],
    });
  });

  it('covers the scribe, whose write root is state/lessons/**', async () => {
    await mkdir(path.join(repoDir, 'state', 'lessons'), { recursive: true });
    await writeFile(path.join(repoDir, 'state', 'lessons', 'epic-1.candidates.json'), '[]\n');
    await mkdir(path.join(repoDir, '.claude', 'agents'), { recursive: true });
    await writeFile(path.join(repoDir, '.claude', 'agents', 'coder.md'), 'rewritten\n');

    const result = writeRootCheck(repoDir, ['state/lessons/**']);
    expect(result.outOfClaim).toEqual(['.claude/agents/coder.md']);
    expect(result.violation?.error).toBe('contract.write-root-violation');
  });
});

describe('resolveFindingOwner', () => {
  // D-41/P9-24: the wave-4 security reviewer anchored a real S2 to
  // src/parse.ts, a file the task being gated was forbidden to touch. The
  // owner of a finding is whoever claims the file, not whoever happened to
  // be at the gate.
  const plan = [
    { task_id: 'epic-1/task-2-parse', claims: ['src/parse.ts', 'test/parse.test.ts'] },
    { task_id: 'epic-1/task-4-api', claims: ['src/index.ts', 'test/index.test.ts'] },
    { task_id: 'epic-1/task-5-docs', claims: ['docs/**'] },
  ];

  it('attributes a finding to the task whose claims cover the file', () => {
    expect(resolveFindingOwner('src/parse.ts', plan)).toEqual({
      owner: 'resolved',
      taskId: 'epic-1/task-2-parse',
      claim: 'src/parse.ts',
    });
  });

  it('resolves through a directory glob, not just a literal claim', () => {
    expect(resolveFindingOwner('docs/runbooks/providers.md', plan)).toMatchObject({
      owner: 'resolved',
      taskId: 'epic-1/task-5-docs',
    });
  });

  it('normalizes a ./-prefixed or backslash path before matching', () => {
    expect(resolveFindingOwner('./src/parse.ts', plan)).toMatchObject({
      owner: 'resolved',
      taskId: 'epic-1/task-2-parse',
    });
    expect(resolveFindingOwner('src\\parse.ts', plan)).toMatchObject({
      owner: 'resolved',
      taskId: 'epic-1/task-2-parse',
    });
  });

  it('reports unclaimed when no task in the plan claims the file', () => {
    expect(resolveFindingOwner('scripts/release.sh', plan)).toEqual({ owner: 'unclaimed' });
  });

  it('reports unclaimed for an empty claims map rather than throwing', () => {
    expect(resolveFindingOwner('src/parse.ts', [])).toEqual({ owner: 'unclaimed' });
  });

  it('prefers the more specific claim when two tasks both match', () => {
    // A literal claim beats a directory glob: task-2-parse owns exactly this
    // file, task-1-wide happens to sweep the whole tree.
    const overlapping = [
      { task_id: 'epic-1/task-1-wide', claims: ['src/**'] },
      { task_id: 'epic-1/task-2-parse', claims: ['src/parse.ts'] },
    ];
    expect(resolveFindingOwner('src/parse.ts', overlapping)).toMatchObject({
      owner: 'resolved',
      taskId: 'epic-1/task-2-parse',
    });
  });

  it('prefers the deeper static base when neither claim is literal', () => {
    const overlapping = [
      { task_id: 'epic-1/task-1-wide', claims: ['src/**'] },
      { task_id: 'epic-1/task-2-parse', claims: ['src/parser/**'] },
    ];
    expect(resolveFindingOwner('src/parser/lex.ts', overlapping)).toMatchObject({
      owner: 'resolved',
      taskId: 'epic-1/task-2-parse',
    });
  });

  it('refuses to guess between two equally specific claims', () => {
    // resolveTaskId's precedent (D-46/P9-29): an ambiguous id is reported,
    // never picked. Two tasks claiming the same file at the same specificity
    // is a planning bug, and silently picking one hides it.
    const tie = [
      { task_id: 'epic-1/task-a', claims: ['src/*.ts'] },
      { task_id: 'epic-1/task-b', claims: ['src/**'] },
    ];
    const result = resolveFindingOwner('src/parse.ts', tie);
    expect(result.owner).toBe('ambiguous');
    if (result.owner !== 'ambiguous') throw new Error('unreachable');
    expect(result.candidates.map((c) => c.taskId).sort()).toEqual([
      'epic-1/task-a',
      'epic-1/task-b',
    ]);
  });

  it('does not call a single task ambiguous with itself', () => {
    const selfOverlap = [{ task_id: 'epic-1/task-a', claims: ['src/*.ts', 'src/**'] }];
    expect(resolveFindingOwner('src/parse.ts', selfOverlap)).toMatchObject({
      owner: 'resolved',
      taskId: 'epic-1/task-a',
    });
  });
});

describe('decideFindingAttribution', () => {
  // The real envkit-config-loader plan splits src/parse.ts across two tasks:
  // task-1a-parse-core and task-1b-parse-quotes declare the SAME two claims,
  // serialized by a `claim-order` edge rather than made disjoint. That is the
  // planner working as designed — resolveFindingOwner's own contract says
  // "two tasks can legitimately match the same file across different waves",
  // and validateWave only enforces disjointness *within* a wave — and it
  // makes ownership of src/parse.ts a permanent tie for that whole epic.
  //
  // The tie is real; treating it as unbreakable is not. When the task at the
  // gate is one of the tied owners, the gate knows something the claims map
  // does not: which of them is holding the file right now, with the diff the
  // judge just read. Escalating there sends the finding to a follow-up task
  // that competes for the claims the gated task still holds, and — because
  // gate.ts admits nothing but `gated` into `blocking` — lets the diff land
  // un-blocked (D-173).
  const coClaimed = [
    {
      task_id: 'envkit-config-loader/task-1a-parse-core',
      claims: ['src/parse.ts', 'test/parse.test.ts'],
    },
    {
      task_id: 'envkit-config-loader/task-1b-parse-quotes',
      claims: ['src/parse.ts', 'test/parse.test.ts'],
    },
  ];
  /** No task status is known: everything the log has not heard of is open. */
  const openTask = () => undefined;

  it('gates a tied finding on the task at the gate when it is a tied owner (D-173)', () => {
    const owner = resolveFindingOwner('src/parse.ts', coClaimed);
    expect(owner.owner).toBe('ambiguous');
    expect(
      decideFindingAttribution(owner, 'envkit-config-loader/task-1b-parse-quotes', openTask),
    ).toEqual({ attribution: 'gated' });
  });

  it('gates on the other tied owner too — the gate breaks the tie, not the order (D-173)', () => {
    const owner = resolveFindingOwner('src/parse.ts', coClaimed);
    expect(
      decideFindingAttribution(owner, 'envkit-config-loader/task-1a-parse-core', openTask),
    ).toEqual({ attribution: 'gated' });
  });

  it('still escalates a tie the gated id is no part of (D-173)', () => {
    // The one instance in the real logs: dogfood-envkit-followup-1 raised a
    // finding against src/parse.ts with the EPIC id as the fallback owner, so
    // nothing at the gate could break the tie. That escalation was right and
    // stays right.
    const owner = resolveFindingOwner('src/parse.ts', coClaimed);
    const decided = decideFindingAttribution(owner, 'envkit-config-loader', openTask);
    expect(decided.attribution).toBe('follow-up');
    if (decided.attribution !== 'follow-up') throw new Error('unreachable');
    expect(decided.reason).toContain('equal specificity');
  });

  it('escalates an unclaimed file whoever is at the gate', () => {
    const owner = resolveFindingOwner('scripts/release.sh', coClaimed);
    expect(
      decideFindingAttribution(owner, 'envkit-config-loader/task-1b-parse-quotes', openTask),
    ).toMatchObject({ attribution: 'follow-up' });
  });

  it('reassigns to a single open owner that is not the gated task', () => {
    const owner = resolveFindingOwner('src/parse.ts', [
      { task_id: 'epic-1/task-2-parse', claims: ['src/parse.ts'] },
    ]);
    expect(decideFindingAttribution(owner, 'epic-1/task-1', openTask)).toMatchObject({
      attribution: 'reassigned',
      taskId: 'epic-1/task-2-parse',
    });
  });

  it('escalates when the single owner is already closed to further work', () => {
    const owner = resolveFindingOwner('src/parse.ts', [
      { task_id: 'epic-1/task-2-parse', claims: ['src/parse.ts'] },
    ]);
    expect(decideFindingAttribution(owner, 'epic-1/task-1', () => 'completed')).toMatchObject({
      attribution: 'follow-up',
    });
  });
});
