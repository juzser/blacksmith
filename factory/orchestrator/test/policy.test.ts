import { describe, expect, it } from 'vitest';
import {
  detectCurrentBranch,
  detectRepoRoot,
  evaluateCommand,
  type GuardrailPolicy,
  loadGuardrailPolicy,
  type PolicyContext,
  type PolicyDecision,
  PolicyError,
  parseGuardrailPolicy,
} from '../src/policy.js';
import type { SandboxLease } from '../src/sandbox.js';

const MINI_POLICY_YAML = `
protected_branches:
  names: [main, master]
  patterns: ["smith/*/integration"]

destructive_removal:
  allowed_roots: [workspaces, state]

deploy_commands:
  - { command: wrangler, subcommands: [deploy, publish] }
  - { command: pages, subcommands: [publish] }

rules:
  - id: push-to-protected
    severity: S1
    reason: push to main/master is never allowed from an agent session. Push a side branch and open a PR.
    reason_on_current_branch: push to main/master is never allowed from an agent session (checked out on {branch}).
  - id: force-push
    severity: S1
    reason: force-push (--force/-f/--force-with-lease) is never allowed from an agent session.
  - id: merge-into-protected
    severity: S1
    reason: merging into main/master is never allowed from an agent session; the operator merges integration PRs.
    reason_on_current_branch: git merge while checked out on {branch} is never allowed from an agent session.
  - id: deploy-command
    severity: S1
    reason: deploy/publish commands require explicit operator approval; never autonomous.
  - id: history-rewrite-on-protected
    severity: S1
    reason: history rewrite (rebase/amend/filter-branch) on protected branch '{branch}' is never allowed.
  - id: unbounded-rm
    severity: S1
    reason: rm -rf is only allowed inside workspaces/ or state/.

judge_sandbox:
  roles: [reviewer, verifier, spec-reviewer]
  write_roots: [state/results, state/artifacts]
  network_commands: [curl, wget, nc, gh, npx]
  network_subcommands:
    - { command: git, subcommands: [push, pull, fetch, clone, remote] }
    - { command: npm, subcommands: [install, ci, publish] }
  target_write_commands: [tee, mkdir, touch]
  refused_write_commands: [rm, mv, cp, ln, chmod, patch, vim]
  git_write_subcommands: [add, commit, checkout, stash, restore, reset, config]
  rules:
    - id: judge-network
      severity: S1
      reason: a {role} judge session has no outbound access.
    - id: judge-write
      severity: S1
      reason: a {role} judge session writes nothing but its own verdict, into {write_roots}.
    - id: judge-sandbox-escape
      severity: S1
      reason: a {role} judge cannot touch its own sandbox lease.

role_write_scopes:
  scopes:
    - role: tester
      write_globs:
        - "**/*.test.ts"
        - "**/test/**"
        - "state/results/**"
        - "state/artifacts/**"
      refused_commands: [cp, mv, ln, patch, chmod]
      refused_git_subcommands: [apply, checkout, restore, reset]
  rules:
    - id: role-write-scope
      severity: S1
      reason: a {role} session writes only {write_globs}.
`;

/**
 * The smallest `judge_sandbox` block the schema accepts. The skeleton fixtures
 * below are each about one missing field somewhere else, and without this they
 * would all trip on the missing sandbox block first and pass for the wrong
 * reason.
 */
const MINI_JUDGE_SANDBOX = `
judge_sandbox:
  roles: [reviewer]
  write_roots: [state/results]
  network_commands: [curl]
  network_subcommands: []
  target_write_commands: [tee]
  refused_write_commands: [rm]
  git_write_subcommands: [add]
  rules:
    - { id: judge-network, severity: S1, reason: no outbound access. }
    - { id: judge-write, severity: S1, reason: verdicts only. }
    - { id: judge-sandbox-escape, severity: S1, reason: not your lease. }

role_write_scopes:
  scopes:
    - role: tester
      write_globs: ["**/*.test.ts"]
      refused_commands: [cp]
      refused_git_subcommands: [apply]
  rules:
    - { id: role-write-scope, severity: S1, reason: tests only. }
`;

/** A lease over the same `/repo` root `ctx()` reports, so relative paths in a command resolve there. */
const LEASE: SandboxLease = {
  worktreeDir: '/repo',
  role: 'reviewer',
  taskId: 'task-1',
  sessionId: 'sess-1',
  openedAt: '2026-08-26T00:00:00.000Z',
};

/** The same lease held by a role that has a write scope rather than a judge's read-only one. */
const TESTER_LEASE: SandboxLease = { ...LEASE, role: 'tester' };

const policy: GuardrailPolicy = parseGuardrailPolicy(MINI_POLICY_YAML);

/** Builds a PolicyContext, defaulting to a Bash call from an unrelated repo root so path-bounds tests are deterministic. */
function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    toolName: 'Bash',
    command: '',
    branch: '',
    repoRoot: '/repo',
    filePath: null,
    ...overrides,
  };
}

function ruleIds(decision: PolicyDecision): string[] {
  return decision.violations.map((v) => v.ruleId);
}

describe('parseGuardrailPolicy', () => {
  it('parses protected branch names/patterns, allowed removal roots, deploy commands, and all ten rules', () => {
    expect(policy.protectedBranchNames).toEqual(['main', 'master']);
    expect(policy.protectedBranchPatterns).toEqual(['smith/*/integration']);
    expect(policy.allowedRemovalRoots).toEqual(['workspaces', 'state']);
    expect(policy.deployCommands).toEqual([
      { command: 'wrangler', subcommands: ['deploy', 'publish'] },
      { command: 'pages', subcommands: ['publish'] },
    ]);
    expect(policy.rules.size).toBe(10);
    expect(policy.rules.get('push-to-protected')?.severity).toBe('S1');
    expect(policy.rules.get('unbounded-rm')?.reason).toBe(
      'rm -rf is only allowed inside workspaces/ or state/.',
    );
  });

  it('rejects a document missing protected_branches.names', () => {
    expect(() => parseGuardrailPolicy('rules: []')).toThrow(PolicyError);
  });

  it('rejects a rule missing a reason, rather than loading a rule that can never explain itself', () => {
    const broken = `
protected_branches: { names: [main, master], patterns: [] }
destructive_removal: { allowed_roots: [workspaces, state] }
deploy_commands: []
rules:
  - id: push-to-protected
    severity: S1
${MINI_JUDGE_SANDBOX}`;
    expect(() => parseGuardrailPolicy(broken)).toThrow(PolicyError);
  });

  it('rejects a document missing a required rule id, rather than silently loading fewer rules than guard.sh has always enforced', () => {
    const missingRules = `
protected_branches: { names: [main, master], patterns: [] }
destructive_removal: { allowed_roots: [workspaces, state] }
deploy_commands: []
rules:
  - id: push-to-protected
    severity: S1
    reason: push denied
${MINI_JUDGE_SANDBOX}`;
    expect(() => parseGuardrailPolicy(missingRules)).toThrow(/force-push/);
  });

  it('folds judge_sandbox.rules into the same id-keyed map as the top-level rules', () => {
    // One map, not two, so a duplicate id between the blocks is caught by the
    // same collision check and `requireRule` has one place to look.
    expect(policy.rules.get('judge-network')?.severity).toBe('S1');
    expect(policy.judgeSandbox.writeRoots).toEqual(['state/results', 'state/artifacts']);
    expect(policy.judgeSandbox.networkSubcommands[0]).toEqual({
      command: 'git',
      subcommands: ['push', 'pull', 'fetch', 'clone', 'remote'],
    });
  });

  it('rejects a document with no judge_sandbox block at all', () => {
    // The judge rules are required on the same terms as the other six: a
    // guardrails.yml that quietly dropped this block would leave every judge
    // running unsandboxed with nothing on stdout to say so.
    const noSandbox = MINI_POLICY_YAML.slice(0, MINI_POLICY_YAML.indexOf('judge_sandbox:'));
    expect(() => parseGuardrailPolicy(noSandbox)).toThrow(/judge_sandbox/);
  });

  it('the real repo guardrails.yml loads and satisfies the schema', () => {
    const real = loadGuardrailPolicy();
    expect(real.rules.size).toBeGreaterThanOrEqual(9);
    expect(real.judgeSandbox.writeRoots).toContain('state/results');
    expect(real.protectedBranchNames).toContain('main');
    expect([...real.allowedRemovalRoots].sort()).toEqual(['state', 'workspaces']);
  });
});

describe('evaluateCommand — rule 1: push-to-protected', () => {
  it('denies a push whose destination ref is main', () => {
    const d = evaluateCommand(
      ctx({ command: 'git push origin main', branch: 'feature-x' }),
      policy,
    );
    expect(d.allowed).toBe(false);
    expect(ruleIds(d)).toEqual(['push-to-protected']);
  });

  it('denies a push whose destination ref is master', () => {
    const d = evaluateCommand(
      ctx({ command: 'git push origin master', branch: 'feature-x' }),
      policy,
    );
    expect(ruleIds(d)).toContain('push-to-protected');
  });

  it('denies a refspec whose remote side is main (local:main)', () => {
    const d = evaluateCommand(
      ctx({ command: 'git push origin foo:main', branch: 'feature-x' }),
      policy,
    );
    expect(ruleIds(d)).toContain('push-to-protected');
  });

  it('denies a refspec targeting refs/heads/main explicitly', () => {
    const d = evaluateCommand(
      ctx({ command: 'git push origin foo:refs/heads/main', branch: 'feature-x' }),
      policy,
    );
    expect(ruleIds(d)).toContain('push-to-protected');
  });

  it('allows pushing a branch merely named like main (near-miss substring)', () => {
    const d = evaluateCommand(
      ctx({ command: 'git push origin fix-main-config', branch: 'feature-x' }),
      policy,
    );
    expect(d.allowed).toBe(true);
  });

  it('denies a bare git push while checked out on main', () => {
    const d = evaluateCommand(ctx({ command: 'git push', branch: 'main' }), policy);
    expect(ruleIds(d)).toContain('push-to-protected');
    expect(d.violations[0]?.reason).toContain('checked out on main');
  });

  it('denies git push origin (no branch arg) while checked out on main', () => {
    const d = evaluateCommand(ctx({ command: 'git push origin', branch: 'main' }), policy);
    expect(ruleIds(d)).toContain('push-to-protected');
  });

  // Same bypass class as the chained `rm` below, in the rule that matters
  // most. guard.sh's `git_segment_for` returned the FIRST chain segment
  // holding a `git ... push` and stopped, so the destination it inspected was
  // `feat/x` and the push to main in the same tool call was never seen. A
  // chain is one tool call and every command in it runs.
  it('denies a later push segment even when the first push segment is allowed (`;` separator)', () => {
    const d = evaluateCommand(
      ctx({ command: 'git push origin feat/x; git push origin main', branch: 'feat/x' }),
      policy,
    );
    expect(ruleIds(d)).toContain('push-to-protected');
  });

  it('denies a later push segment even when the first push segment is allowed (`&&` separator)', () => {
    const d = evaluateCommand(
      ctx({ command: 'git push origin feat/x && git push origin master', branch: 'feat/x' }),
      policy,
    );
    expect(ruleIds(d)).toContain('push-to-protected');
  });

  it('denies a bare push in a later chain segment while checked out on main', () => {
    const d = evaluateCommand(
      ctx({ command: 'git push origin some-branch; git push', branch: 'main' }),
      policy,
    );
    expect(ruleIds(d)).toContain('push-to-protected');
  });

  it('allows a chain where every push segment targets a side branch', () => {
    const d = evaluateCommand(
      ctx({ command: 'git push origin feat/x && git push upstream feat/y', branch: 'feat/x' }),
      policy,
    );
    expect(d.allowed).toBe(true);
  });

  it('allows git push origin <branch> while checked out on main (not a bare push)', () => {
    const d = evaluateCommand(
      ctx({ command: 'git push origin some-branch', branch: 'main' }),
      policy,
    );
    expect(d.allowed).toBe(true);
  });
});

describe('evaluateCommand — rule 2: force-push', () => {
  it('denies --force', () => {
    const d = evaluateCommand(
      ctx({ command: 'git push --force origin feature', branch: 'feature' }),
      policy,
    );
    expect(ruleIds(d)).toContain('force-push');
  });

  it('denies --force-with-lease', () => {
    const d = evaluateCommand(
      ctx({ command: 'git push --force-with-lease origin feature', branch: 'feature' }),
      policy,
    );
    expect(ruleIds(d)).toContain('force-push');
  });

  it('denies the short flag -f', () => {
    const d = evaluateCommand(
      ctx({ command: 'git push -f origin feature', branch: 'feature' }),
      policy,
    );
    expect(ruleIds(d)).toContain('force-push');
  });

  it('allows a push with no force flag', () => {
    const d = evaluateCommand(
      ctx({ command: 'git push origin feature', branch: 'feature' }),
      policy,
    );
    expect(d.allowed).toBe(true);
  });

  it('allows a branch name that merely contains "force" as a substring, not a flag', () => {
    const d = evaluateCommand(
      ctx({ command: 'git push origin feature-force', branch: 'feature-force' }),
      policy,
    );
    expect(d.allowed).toBe(true);
  });
});

describe('evaluateCommand — rule 3: merge-into-protected', () => {
  it('denies merging into main by name', () => {
    const d = evaluateCommand(
      ctx({ command: 'git merge origin/main', branch: 'feature-x' }),
      policy,
    );
    expect(ruleIds(d)).toEqual(['merge-into-protected']);
  });

  it('denies merging into master by name', () => {
    const d = evaluateCommand(ctx({ command: 'git merge master', branch: 'feature-x' }), policy);
    expect(ruleIds(d)).toContain('merge-into-protected');
  });

  it('allows merging a branch not named main/master', () => {
    const d = evaluateCommand(
      ctx({ command: 'git merge origin/feature', branch: 'feature-x' }),
      policy,
    );
    expect(d.allowed).toBe(true);
  });

  it('denies any git merge while checked out on main, regardless of its argument (guard.sh has no exception here)', () => {
    const d = evaluateCommand(ctx({ command: 'git merge some-feature', branch: 'main' }), policy);
    expect(ruleIds(d)).toContain('merge-into-protected');
    expect(d.violations[0]?.reason).toContain('checked out on main');
  });

  it('allows a git merge on a non-protected branch merging a non-protected target', () => {
    const d = evaluateCommand(
      ctx({ command: 'git merge some-feature', branch: 'feature-x' }),
      policy,
    );
    expect(d.allowed).toBe(true);
  });

  it('allows read-only merge-* plumbing naming a protected branch', () => {
    const d = evaluateCommand(
      ctx({ command: 'git merge-base HEAD origin/main', branch: 'feature-x' }),
      policy,
    );
    expect(d.allowed).toBe(true);
  });

  it('allows merge-* plumbing while checked out on a protected branch', () => {
    const d = evaluateCommand(ctx({ command: 'git merge-tree main HEAD', branch: 'main' }), policy);
    expect(d.allowed).toBe(true);
  });

  it('does not read a chained merge-base argument as the destination of a real merge', () => {
    const d = evaluateCommand(
      ctx({
        command: 'git merge-base HEAD origin/main; git merge some-feature',
        branch: 'feature-x',
      }),
      policy,
    );
    expect(d.allowed).toBe(true);
  });
});

describe('evaluateCommand — rule 4: deploy-command', () => {
  it('denies wrangler deploy', () => {
    const d = evaluateCommand(ctx({ command: 'wrangler deploy' }), policy);
    expect(ruleIds(d)).toEqual(['deploy-command']);
  });

  it('denies wrangler publish', () => {
    const d = evaluateCommand(ctx({ command: 'wrangler publish --env prod' }), policy);
    expect(ruleIds(d)).toContain('deploy-command');
  });

  it('denies pages publish', () => {
    const d = evaluateCommand(ctx({ command: 'npx wrangler pages publish dist' }), policy);
    expect(ruleIds(d)).toContain('deploy-command');
  });

  it('allows wrangler dev', () => {
    const d = evaluateCommand(ctx({ command: 'wrangler dev' }), policy);
    expect(d.allowed).toBe(true);
  });

  it('allows a word that merely contains "deploy" as a substring (deployment-status)', () => {
    const d = evaluateCommand(ctx({ command: 'wrangler deployment-status' }), policy);
    expect(d.allowed).toBe(true);
  });
});

describe('evaluateCommand — rule 5: history-rewrite-on-protected', () => {
  it('denies rebase on main', () => {
    const d = evaluateCommand(ctx({ command: 'git rebase -i HEAD~3', branch: 'main' }), policy);
    expect(ruleIds(d)).toEqual(['history-rewrite-on-protected']);
    expect(d.violations[0]?.reason).toContain("'main'");
  });

  it('denies commit --amend on a shared smith/<epic>/integration branch', () => {
    const d = evaluateCommand(
      ctx({ command: 'git commit --amend', branch: 'smith/epic1/integration' }),
      policy,
    );
    expect(ruleIds(d)).toContain('history-rewrite-on-protected');
  });

  it('denies filter-branch on main', () => {
    const d = evaluateCommand(
      ctx({ command: 'git filter-branch --tree-filter true HEAD', branch: 'main' }),
      policy,
    );
    expect(ruleIds(d)).toContain('history-rewrite-on-protected');
  });

  it('denies filter-repo on an integration branch', () => {
    const d = evaluateCommand(
      ctx({ command: 'git filter-repo --invert-paths', branch: 'smith/epic1/integration' }),
      policy,
    );
    expect(ruleIds(d)).toContain('history-rewrite-on-protected');
  });

  it('allows rebase on a task branch, which is not the shared integration branch', () => {
    const d = evaluateCommand(
      ctx({ command: 'git rebase -i HEAD~3', branch: 'smith/epic1/task-7' }),
      policy,
    );
    expect(d.allowed).toBe(true);
  });

  it('allows a plain commit on main (no --amend)', () => {
    const d = evaluateCommand(ctx({ command: 'git commit -m "message"', branch: 'main' }), policy);
    expect(d.allowed).toBe(true);
  });

  it('allows commit --amend on an unprotected branch', () => {
    const d = evaluateCommand(ctx({ command: 'git commit --amend', branch: 'feature-x' }), policy);
    expect(d.allowed).toBe(true);
  });
});

describe('evaluateCommand — rule 6: unbounded-rm', () => {
  it('allows rm -rf under workspaces/', () => {
    const d = evaluateCommand(ctx({ command: 'rm -rf workspaces/foo', repoRoot: '/repo' }), policy);
    expect(d.allowed).toBe(true);
  });

  it('allows rm -rf on the bare allowed root itself', () => {
    const d = evaluateCommand(ctx({ command: 'rm -rf state', repoRoot: '/repo' }), policy);
    expect(d.allowed).toBe(true);
  });

  it('denies rm -rf outside both allowed roots', () => {
    const d = evaluateCommand(ctx({ command: 'rm -rf src', repoRoot: '/repo' }), policy);
    expect(ruleIds(d)).toEqual(['unbounded-rm']);
  });

  it('denies rm -rf that climbs above the repo root', () => {
    const d = evaluateCommand(ctx({ command: 'rm -rf ../outside', repoRoot: '/repo' }), policy);
    expect(ruleIds(d)).toContain('unbounded-rm');
  });

  it('denies rm -rf on an absolute path outside the repo', () => {
    const d = evaluateCommand(ctx({ command: 'rm -rf /etc/passwd', repoRoot: '/repo' }), policy);
    expect(ruleIds(d)).toContain('unbounded-rm');
  });

  it('denies when any one of several targets is out of bounds, even if another is allowed', () => {
    const d = evaluateCommand(
      ctx({ command: 'rm -rf workspaces/a src/b', repoRoot: '/repo' }),
      policy,
    );
    expect(ruleIds(d)).toContain('unbounded-rm');
  });

  it('recognizes the order-swapped short flag -fr and denies it out of bounds', () => {
    // Targeting an allowed root here would pass even if `-fr` were not
    // recognized as "recursive + force" at all — the assertion that
    // actually exercises flag recognition is a denial on an out-of-bounds
    // path.
    const d = evaluateCommand(ctx({ command: 'rm -fr src/b', repoRoot: '/repo' }), policy);
    expect(ruleIds(d)).toContain('unbounded-rm');
  });

  it('allows the order-swapped short flag -fr under an allowed root', () => {
    const d = evaluateCommand(ctx({ command: 'rm -fr workspaces/foo', repoRoot: '/repo' }), policy);
    expect(d.allowed).toBe(true);
  });

  // `-R` is POSIX's recursive flag and does exactly what `-r` does, so a rule
  // that reads one spelling and not the other is a rule with a doorway in it.
  it('recognizes the capital recursive flag -Rf and denies it out of bounds', () => {
    const d = evaluateCommand(ctx({ command: 'rm -Rf src/b', repoRoot: '/repo' }), policy);
    expect(ruleIds(d)).toContain('unbounded-rm');
  });

  it('allows -Rf under an allowed root', () => {
    const d = evaluateCommand(ctx({ command: 'rm -Rf workspaces/foo', repoRoot: '/repo' }), policy);
    expect(d.allowed).toBe(true);
  });

  // Bundling is a convenience, not part of what makes the removal dangerous:
  // `rm -r -f x` and `rm -rf x` delete the same tree the same way.
  it('recognizes short flags passed separately and denies them out of bounds', () => {
    const d = evaluateCommand(ctx({ command: 'rm -r -f src/b', repoRoot: '/repo' }), policy);
    expect(ruleIds(d)).toContain('unbounded-rm');
  });

  it('recognizes separate short flags in either order', () => {
    const d = evaluateCommand(ctx({ command: 'rm -f -r src/b', repoRoot: '/repo' }), policy);
    expect(ruleIds(d)).toContain('unbounded-rm');
  });

  it('allows separately-passed short flags under an allowed root', () => {
    const d = evaluateCommand(
      ctx({ command: 'rm -r -f workspaces/foo', repoRoot: '/repo' }),
      policy,
    );
    expect(d.allowed).toBe(true);
  });

  it('recognizes a long recursive flag paired with a short force flag', () => {
    const d = evaluateCommand(
      ctx({ command: 'rm --recursive -f src/b', repoRoot: '/repo' }),
      policy,
    );
    expect(ruleIds(d)).toContain('unbounded-rm');
  });

  it('recognizes a short recursive flag paired with a long force flag', () => {
    const d = evaluateCommand(ctx({ command: 'rm -R --force src/b', repoRoot: '/repo' }), policy);
    expect(ruleIds(d)).toContain('unbounded-rm');
  });

  it('does not trip the rule on -R without a force flag', () => {
    const d = evaluateCommand(
      ctx({ command: 'rm -R workspaces-sibling', repoRoot: '/repo' }),
      policy,
    );
    expect(d.allowed).toBe(true);
  });

  it('does not trip the rule on -f without a recursive flag', () => {
    const d = evaluateCommand(
      ctx({ command: 'rm -f workspaces-sibling/file', repoRoot: '/repo' }),
      policy,
    );
    expect(d.allowed).toBe(true);
  });

  it('recognizes --recursive --force spelled out in full and denies it out of bounds', () => {
    const d = evaluateCommand(
      ctx({ command: 'rm --recursive --force src/b', repoRoot: '/repo' }),
      policy,
    );
    expect(ruleIds(d)).toContain('unbounded-rm');
  });

  it('allows --recursive --force spelled out in full under an allowed root', () => {
    const d = evaluateCommand(
      ctx({ command: 'rm --recursive --force workspaces/foo', repoRoot: '/repo' }),
      policy,
    );
    expect(d.allowed).toBe(true);
  });

  it('denies a later chain segment even when the first rm segment is allowed (`;` separator)', () => {
    const d = evaluateCommand(
      ctx({ command: 'rm -rf workspaces/a; rm -rf src/important', repoRoot: '/repo' }),
      policy,
    );
    expect(ruleIds(d)).toContain('unbounded-rm');
  });

  it('denies a later chain segment even when the first rm segment is allowed (`&&` separator)', () => {
    const d = evaluateCommand(
      ctx({ command: 'rm -rf workspaces/a && rm -rf src/important', repoRoot: '/repo' }),
      policy,
    );
    expect(ruleIds(d)).toContain('unbounded-rm');
  });

  it('denies a later chain segment even when the first rm segment is allowed (`|` separator)', () => {
    const d = evaluateCommand(
      ctx({ command: 'rm -rf workspaces/a | rm -rf src/important', repoRoot: '/repo' }),
      policy,
    );
    expect(ruleIds(d)).toContain('unbounded-rm');
  });

  it('allows a chain where every rm segment stays within allowed roots', () => {
    const d = evaluateCommand(
      ctx({ command: 'rm -rf workspaces/a; rm -rf state/b', repoRoot: '/repo' }),
      policy,
    );
    expect(d.allowed).toBe(true);
  });

  it('does not trip the rule at all on rm -r without -f (recursive but not forced)', () => {
    const d = evaluateCommand(
      ctx({ command: 'rm -r workspaces-sibling', repoRoot: '/repo' }),
      policy,
    );
    expect(d.allowed).toBe(true);
  });

  // Reading the flags across the invocation rather than out of the token
  // right after `rm` means they are also read where a shell would accept
  // them: after the path. A gate that stopped at the first token would be
  // reading a different command than the one that runs.
  it('recognizes flags written after the path and denies them out of bounds', () => {
    const d = evaluateCommand(ctx({ command: 'rm src/b -rf', repoRoot: '/repo' }), policy);
    expect(ruleIds(d)).toContain('unbounded-rm');
  });

  // What keeps that scan from reading an unrelated command's flags is that
  // the segment has to invoke `rm` as a word, not merely contain the letters.
  it('does not trip the rule on a command whose name merely ends in rm', () => {
    const d = evaluateCommand(
      ctx({ command: 'charm --recursive --force src/b', repoRoot: '/repo' }),
      policy,
    );
    expect(d.allowed).toBe(true);
  });

  it('denies a bare relative token when the repo root is unknown (fails closed, mirroring guard.sh)', () => {
    const d = evaluateCommand(ctx({ command: 'rm -rf workspaces/foo', repoRoot: null }), policy);
    expect(ruleIds(d)).toContain('unbounded-rm');
  });
});

// A commit or merge message is git's own free-text field. Every case in the
// first half is an agent doing exactly what its output contract asks — writing
// down what it did — and every one of them was refused before this block
// existed, because the matchers scanned the message as if its words were refs
// and command words. The second half is the other half of the property:
// blanking the payload must not buy a way past any rule, so a quoted *ref* is
// still read.
describe('evaluateCommand — a message payload is prose, not a command', () => {
  it('allows a commit whose message describes the push rule it is obeying', () => {
    const d = evaluateCommand(
      ctx({ command: 'git commit -m "docs: never push origin main"', branch: 'feature-x' }),
      policy,
    );
    expect(ruleIds(d)).toEqual([]);
  });

  it('allows a commit whose message mentions a force push', () => {
    const d = evaluateCommand(
      ctx({
        command: 'git commit -m "docs: explain why push --force is refused"',
        branch: 'feature-x',
      }),
      policy,
    );
    expect(ruleIds(d)).toEqual([]);
  });

  it('allows a merge of a side branch whose message happens to name main', () => {
    const d = evaluateCommand(
      ctx({
        command: 'git merge origin/feature -m "reconciled onto main after #21"',
        branch: 'feature-x',
      }),
      policy,
    );
    expect(ruleIds(d)).toEqual([]);
  });

  it('allows a commit whose message merely contains the word merge and a branch name', () => {
    const d = evaluateCommand(
      ctx({ command: 'git commit -m "fix: the merge queue picks up main"', branch: 'feature-x' }),
      policy,
    );
    expect(ruleIds(d)).toEqual([]);
  });

  it('allows a commit whose message documents a deploy command', () => {
    const d = evaluateCommand(
      ctx({
        command: 'git commit -m "chore: document wrangler deploy steps"',
        branch: 'feature-x',
      }),
      policy,
    );
    expect(ruleIds(d)).toEqual([]);
  });

  it('allows a commit on a protected branch whose message merely says rebase', () => {
    const d = evaluateCommand(
      ctx({ command: 'git commit -m "docs: note about rebase"', branch: 'main' }),
      policy,
    );
    expect(ruleIds(d)).toEqual([]);
  });

  it('allows a commit whose message quotes an unbounded rm', () => {
    const d = evaluateCommand(
      ctx({ command: 'git commit -m "docs: never run rm -rf / by hand"', branch: 'feature-x' }),
      policy,
    );
    expect(ruleIds(d)).toEqual([]);
  });

  it('reads --message= the same way as -m', () => {
    const d = evaluateCommand(
      ctx({ command: 'git commit --message="docs: never push origin main"', branch: 'feature-x' }),
      policy,
    );
    expect(ruleIds(d)).toEqual([]);
  });

  it('blanks every message when a commit carries more than one', () => {
    const d = evaluateCommand(
      ctx({
        command: 'git commit -m "docs: never push origin main" -m "and never wrangler deploy"',
        branch: 'feature-x',
      }),
      policy,
    );
    expect(ruleIds(d)).toEqual([]);
  });

  // --- the payload buys nothing: a real target is still read ---

  it('still denies a merge whose destination ref is merely quoted', () => {
    const d = evaluateCommand(ctx({ command: 'git merge "main"', branch: 'feature-x' }), policy);
    expect(ruleIds(d)).toEqual(['merge-into-protected']);
  });

  it('still denies a deploy whose subcommand is merely quoted', () => {
    const d = evaluateCommand(ctx({ command: 'wrangler "deploy"', branch: 'feature-x' }), policy);
    expect(ruleIds(d)).toEqual(['deploy-command']);
  });

  it('still denies a real push to main chained after a commit that talks about one', () => {
    const d = evaluateCommand(
      ctx({
        command: 'git commit -m "docs: never push origin main" && git push origin main',
        branch: 'feature-x',
      }),
      policy,
    );
    expect(ruleIds(d)).toEqual(['push-to-protected']);
  });

  it('still denies a merge naming main outside the message it also carries', () => {
    const d = evaluateCommand(
      ctx({ command: 'git merge origin/main -m "routine update"', branch: 'feature-x' }),
      policy,
    );
    expect(ruleIds(d)).toEqual(['merge-into-protected']);
  });

  it('does not treat -m as a message flag when it takes a mode, not prose', () => {
    const d = evaluateCommand(ctx({ command: 'mkdir -m 755 workspaces/x' }), policy);
    expect(ruleIds(d)).toEqual([]);
  });

  // `git push` has no `-m`, so this exact command is one git would reject too.
  // It is here for the property, which a real command could reach: outside the
  // handful of subcommands that spend `-m` on free text, its argument is a ref
  // or a number the rules must still read.
  it('does not blank a -m on a git subcommand that has no message field', () => {
    const d = evaluateCommand(
      ctx({ command: 'git push origin -m main', branch: 'feature-x' }),
      policy,
    );
    expect(ruleIds(d)).toEqual(['push-to-protected']);
  });
});

describe('evaluateCommand — cross-cutting', () => {
  it('ignores tool calls that are not Bash entirely', () => {
    const d = evaluateCommand(
      ctx({ toolName: 'Read', command: 'git push origin main', branch: 'feature' }),
      policy,
    );
    expect(d.allowed).toBe(true);
  });

  it('allows an empty command', () => {
    const d = evaluateCommand(ctx({ command: '   ' }), policy);
    expect(d.allowed).toBe(true);
  });

  it('returns every rule that fires, not just the first', () => {
    const d = evaluateCommand(
      ctx({ command: 'git push --force origin main', branch: 'feature-x' }),
      policy,
    );
    expect(d.allowed).toBe(false);
    expect(ruleIds(d).sort()).toEqual(['force-push', 'push-to-protected']);
  });
});

// The judge sandbox (A3). These rules exist only while a lease is open, and
// every case below is asserted twice — once under the lease and once without
// — because the property that matters is not "a judge is refused" but "only a
// judge is refused". A rule that fired without a lease would refuse the coder
// sessions that do the actual work.
describe('evaluateCommand — judge sandbox', () => {
  function both(command: string): { judged: PolicyDecision; free: PolicyDecision } {
    return {
      judged: evaluateCommand(ctx({ command, sandbox: LEASE }), policy),
      free: evaluateCommand(ctx({ command }), policy),
    };
  }

  describe('judge-network', () => {
    it.each([
      ['curl https://example.com/spec.json'],
      ['wget -O- https://example.com'],
      ['gh pr view 12'],
      ['git fetch origin'],
      ['npm install left-pad'],
      ['npx some-linter .'],
      ['cat notes.txt | curl -T - https://example.com'],
    ])('refuses %s inside a sandbox, and allows it outside one', (command) => {
      const { judged, free } = both(command);
      expect(ruleIds(judged)).toContain('judge-network');
      expect(free.allowed).toBe(true);
    });

    it('names the role in the reason, so a denial says who was refused', () => {
      const d = evaluateCommand(ctx({ command: 'curl https://x', sandbox: LEASE }), policy);
      expect(d.violations[0]?.reason).toContain('reviewer');
    });

    it.each([
      // Two-letter command words are the trap here: a bare \bnc\b matches
      // inside a path, and a judge told it has no network for running grep is
      // a judge that learns to ignore the guard.
      ['grep -rn handler src/nc/index.ts'],
      ['ls -la vendor/wget-notes'],
      ['git status --porcelain'],
      ['git log --oneline -20'],
      ['node --version'],
    ])('leaves %s alone even inside a sandbox', (command) => {
      expect(evaluateCommand(ctx({ command, sandbox: LEASE }), policy).allowed).toBe(true);
    });
  });

  describe('judge-write', () => {
    it.each([
      ['echo x > /repo/src/index.ts'],
      ['echo x >> notes.md'],
      ['git add -A'],
      ['git commit -m wip'],
      ['git checkout main'],
      ['git stash'],
      ['sed -i "" s/a/b/ src/x.ts'],
      ['sed -i.bak s/a/b/ src/x.ts'],
      ['mv src/a.ts src/b.ts'],
      ['cp src/a.ts /tmp/a.ts'],
      ['chmod +x scripts/run.sh'],
      ['vim src/index.ts'],
      ['mkdir -p src/newthing'],
      ['tee src/x.ts'],
      ['touch src/x.ts'],
    ])('refuses %s inside a sandbox, and allows it outside one', (command) => {
      const { judged, free } = both(command);
      expect(ruleIds(judged)).toContain('judge-write');
      expect(free.allowed).toBe(true);
    });

    it.each([
      ['echo {} > state/results/task-1.reviewer.json'],
      ['echo {} > /repo/state/results/task-1.reviewer.json'],
      ['mkdir -p state/results'],
      ['git diff main...HEAD > state/artifacts/task-1.diff'],
      ['pnpm vitest run 2>&1 | tail -20'],
      ['cat state/results/task-1.reviewer.json'],
    ])('lets a judge write its own verdict: %s', (command) => {
      expect(evaluateCommand(ctx({ command, sandbox: LEASE }), policy).allowed).toBe(true);
    });

    it('does not read a heredoc body as a redirection', () => {
      // The one over-refusal that would actually hurt: a judge with no Write
      // tool files its verdict with `cat > … <<'JSON'`, and a finding that
      // says "expected > 0" would otherwise parse as a second redirect to a
      // file named `0` — denying the judge the one write it is there to make.
      const command =
        "cat > state/results/task-1.reviewer.json <<'JSON'\n" +
        '{"findings": [{"detail": "expected > 0 rows, saw none"}]}\n' +
        'JSON';
      expect(evaluateCommand(ctx({ command, sandbox: LEASE }), policy).allowed).toBe(true);
    });

    it('is not fooled by a write root that is only a string prefix', () => {
      const d = evaluateCommand(
        ctx({ command: 'echo x > state/results-elsewhere/x.json', sandbox: LEASE }),
        policy,
      );
      expect(ruleIds(d)).toContain('judge-write');
    });

    it('substitutes the write roots into the reason, so the denial says where writing is legal', () => {
      const d = evaluateCommand(ctx({ command: 'git add -A', sandbox: LEASE }), policy);
      expect(d.violations[0]?.reason).toContain('state/results or state/artifacts');
    });
  });

  describe('judge-sandbox-escape', () => {
    it.each([
      ['smith sandbox close /repo'],
      ['node factory/orchestrator/dist/cli.js sandbox status'],
      ['rm state/sandboxes/abcdef.json'],
      ['cat state/sandboxes/abcdef.json'],
      ['ls state/sandboxes'],
    ])('refuses %s, because a lease a judge can lift is not a lease', (command) => {
      expect(ruleIds(evaluateCommand(ctx({ command, sandbox: LEASE }), policy))).toContain(
        'judge-sandbox-escape',
      );
    });

    it('does not fire on the word sandbox in ordinary reading', () => {
      const d = evaluateCommand(
        ctx({ command: 'grep -rn sandbox docs/standards/guardrails.md', sandbox: LEASE }),
        policy,
      );
      expect(d.allowed).toBe(true);
    });
  });

  it('adds the judge rules to the six, rather than replacing them', () => {
    // A lease must never make a command *more* permissible than it was
    // without one, so the base rules have to still be in the array.
    const d = evaluateCommand(
      ctx({ command: 'git push origin main', branch: 'feature', sandbox: LEASE }),
      policy,
    );
    expect(ruleIds(d)).toContain('push-to-protected');
  });

  it('treats an explicit null lease exactly like an absent one', () => {
    expect(evaluateCommand(ctx({ command: 'curl https://x', sandbox: null }), policy).allowed).toBe(
      true,
    );
  });
});

describe('detectCurrentBranch / detectRepoRoot', () => {
  it('resolve a branch name and a repo root inside this real git checkout', () => {
    expect(detectCurrentBranch()).not.toBe('');
    expect(detectRepoRoot()).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Role write scopes (B2a). The judge sandbox answers "this role writes
// nothing". A tester writes plenty — it just must not write the thing it is
// grading. Same lease machinery, a different rule set selected by role.
// ---------------------------------------------------------------------------

describe('role write scopes', () => {
  describe('parsing', () => {
    it('parses the declared judge roles and the per-role write scopes', () => {
      expect(policy.judgeSandbox.roles).toEqual(['reviewer', 'verifier', 'spec-reviewer']);
      expect(policy.roleWriteScopes).toHaveLength(1);
      const tester = policy.roleWriteScopes[0];
      expect(tester?.role).toBe('tester');
      expect(tester?.writeGlobs).toContain('**/*.test.ts');
      expect(tester?.refusedCommands).toContain('cp');
      expect(tester?.refusedGitSubcommands).toContain('apply');
      expect(policy.rules.get('role-write-scope')?.severity).toBe('S1');
    });

    it('rejects a document with no role_write_scopes block', () => {
      // Required on the same terms as judge_sandbox. A policy that cannot
      // name the tester's scope is a policy under which the tester either
      // writes nothing at all or writes the code it is grading — and neither
      // failure announces itself.
      const stripped = MINI_POLICY_YAML.slice(0, MINI_POLICY_YAML.indexOf('role_write_scopes:'));
      expect(() => parseGuardrailPolicy(stripped)).toThrow(/role_write_scopes/);
    });

    it('rejects a judge_sandbox block that does not name its roles', () => {
      const noRoles = MINI_POLICY_YAML.replace(
        '  roles: [reviewer, verifier, spec-reviewer]\n',
        '',
      );
      expect(() => parseGuardrailPolicy(noRoles)).toThrow(/judge_sandbox.roles/);
    });

    it('rejects a scope whose role collides with a declared judge role', () => {
      // A role cannot be both read-only and write-scoped; the two rule sets
      // are selected by role, so an overlap is an unanswerable question.
      const collide = MINI_POLICY_YAML.replace('    - role: tester', '    - role: reviewer');
      expect(() => parseGuardrailPolicy(collide)).toThrow(/reviewer/);
    });

    it('the real repo guardrails.yml declares a tester scope', () => {
      const real = loadGuardrailPolicy();
      const tester = real.roleWriteScopes.find((s) => s.role === 'tester');
      expect(tester).toBeDefined();
      expect(tester?.writeGlobs.length).toBeGreaterThan(0);
      expect(real.judgeSandbox.roles).toContain('reviewer');
    });
  });

  describe('a tester lease', () => {
    const write = (filePath: string, toolName = 'Write'): PolicyDecision =>
      evaluateCommand(ctx({ toolName, command: '', filePath, sandbox: TESTER_LEASE }), policy);
    const run = (command: string): PolicyDecision =>
      evaluateCommand(ctx({ command, sandbox: TESTER_LEASE }), policy);

    it.each([
      ['factory/orchestrator/test/gate.test.ts'],
      ['/repo/factory/orchestrator/test/gate.test.ts'],
      ['ui/test/fixtures/plan.json'],
      ['state/results/task-1.json'],
      ['state/artifacts/task-1/home.png'],
    ])('allows a Write to %s', (filePath) => {
      expect(write(filePath).allowed).toBe(true);
    });

    it.each([
      ['factory/orchestrator/src/gate.ts'],
      ['/repo/factory/orchestrator/src/gate.ts'],
      ['README.md'],
      ['factory/policies/guardrails.yml'],
    ])('refuses a Write to %s — the coder owns the implementation', (filePath) => {
      expect(ruleIds(write(filePath))).toEqual(['role-write-scope']);
    });

    it('refuses an Edit to the implementation the same way it refuses a Write', () => {
      expect(ruleIds(write('factory/orchestrator/src/gate.ts', 'Edit'))).toContain(
        'role-write-scope',
      );
      expect(write('factory/orchestrator/test/gate.test.ts', 'Edit').allowed).toBe(true);
    });

    it('names the role and the scope in the refusal, so the agent can see what it may write', () => {
      const reason = write('src/gate.ts').violations[0]?.reason ?? '';
      expect(reason).toContain('tester');
      expect(reason).toContain('**/*.test.ts');
    });

    it.each([
      ['echo x > factory/orchestrator/src/gate.ts'],
      ['cat fixture >> src/index.ts'],
      ['tee src/index.ts < /dev/null'],
      ['mkdir -p src/generated'],
      ['touch src/new.ts'],
      ['rm factory/orchestrator/src/gate.ts'],
      ['sed -i "" s/a/b/ src/gate.ts'],
      ['cp src/a.ts src/b.ts'],
      ['patch -p1 < fix.diff'],
      ['git checkout -- src/gate.ts'],
      ['git apply /tmp/fix.diff'],
      ['git reset --hard HEAD~1'],
    ])('refuses %s through Bash as well, so the tool choice is not the loophole', (command) => {
      expect(ruleIds(run(command))).toContain('role-write-scope');
    });

    it.each([
      ['echo x > state/results/task-1.json'],
      ['mkdir -p factory/orchestrator/test/fixtures'],
      ['mkdir -p state/results'],
      ['touch ui/test/new.test.ts'],
      ['rm factory/orchestrator/test/stale.test.ts'],
      ['pnpm vitest run'],
      ['cat factory/orchestrator/src/gate.ts'],
      ['grep -rn recordResult factory/orchestrator/src'],
      ['git add -A'],
      ['git commit -m "test: cover the merge queue"'],
      ['git status --porcelain'],
      ['git diff --stat'],
    ])('allows %s', (command) => {
      expect(run(command).allowed).toBe(true);
    });

    it('lets the tester commit, because its output contract requires a commit on the task branch', () => {
      expect(run('git add -A && git commit -m "test: add coverage"').allowed).toBe(true);
    });

    it.each([
      ['git commit -m "test: cover the restore path"'],
      ['git commit -m "test: cover cp and patch handling"'],
      ["git commit -m 'test: reset the fixture between cases'"],
    ])('reads %s as a message, not as the verbs it names', (command) => {
      expect(run(command).allowed).toBe(true);
    });

    it('does not apply the judge rules — a tester runs the suite, and suites reach the network', () => {
      expect(run('pnpm install --frozen-lockfile').allowed).toBe(true);
      expect(run('npx playwright install chromium').allowed).toBe(true);
    });

    it('still refuses to let the tester lift its own lease', () => {
      // The one judge rule that is not about being read-only: it is about a
      // lease being a lease. It applies to every role that holds one.
      expect(ruleIds(run('smith sandbox close'))).toContain('judge-sandbox-escape');
      expect(ruleIds(run('rm state/sandboxes/abc.json'))).toContain('judge-sandbox-escape');
    });

    it('keeps the base six, so a lease is never a way to become more permissible', () => {
      expect(ruleIds(run('git push origin main'))).toContain('push-to-protected');
    });
  });

  describe('role resolution', () => {
    it('gives an undeclared role the judge rules, not the tester scope', () => {
      // Fail closed: `sandbox open --role coder` is either a typo or an
      // attempt to pick a rule set, and the strictest one is the safe answer
      // to both.
      const rogue: SandboxLease = { ...LEASE, role: 'coder' };
      const d = evaluateCommand(ctx({ command: 'curl https://x', sandbox: rogue }), policy);
      expect(ruleIds(d)).toContain('judge-network');
    });

    it('checks a judge Write against the judge write roots, not only its Bash', () => {
      // Judges hold no Edit/Write today. If one ever does, the lease answers
      // for it — the rule is about the role, not about which tool it reached
      // for.
      const denied = evaluateCommand(
        ctx({ toolName: 'Write', command: '', filePath: 'src/gate.ts', sandbox: LEASE }),
        policy,
      );
      expect(ruleIds(denied)).toContain('judge-write');
      const allowed = evaluateCommand(
        ctx({
          toolName: 'Write',
          command: '',
          filePath: 'state/results/task-1.json',
          sandbox: LEASE,
        }),
        policy,
      );
      expect(allowed.allowed).toBe(true);
    });
  });

  describe('outside a lease', () => {
    it('leaves an ordinary session free to write anything', () => {
      // The coder's own session holds no lease, and nothing here narrows it.
      expect(
        evaluateCommand(ctx({ toolName: 'Write', command: '', filePath: 'src/gate.ts' }), policy)
          .allowed,
      ).toBe(true);
    });

    it('allows a file tool with no path at all rather than guessing', () => {
      expect(
        evaluateCommand(ctx({ toolName: 'Write', command: '', filePath: '' }), policy).allowed,
      ).toBe(true);
    });

    it('ignores a tool it does not inspect', () => {
      expect(
        evaluateCommand(
          ctx({ toolName: 'Read', command: '', filePath: 'src/gate.ts', sandbox: TESTER_LEASE }),
          policy,
        ).allowed,
      ).toBe(true);
    });
  });
});
