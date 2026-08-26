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
`;

/**
 * The smallest `judge_sandbox` block the schema accepts. The skeleton fixtures
 * below are each about one missing field somewhere else, and without this they
 * would all trip on the missing sandbox block first and pass for the wrong
 * reason.
 */
const MINI_JUDGE_SANDBOX = `
judge_sandbox:
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
`;

/** A lease over the same `/repo` root `ctx()` reports, so relative paths in a command resolve there. */
const LEASE: SandboxLease = {
  worktreeDir: '/repo',
  role: 'reviewer',
  taskId: 'task-1',
  sessionId: 'sess-1',
  openedAt: '2026-08-26T00:00:00.000Z',
};

const policy: GuardrailPolicy = parseGuardrailPolicy(MINI_POLICY_YAML);

/** Builds a PolicyContext, defaulting to a Bash call from an unrelated repo root so path-bounds tests are deterministic. */
function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return { toolName: 'Bash', command: '', branch: '', repoRoot: '/repo', ...overrides };
}

function ruleIds(decision: PolicyDecision): string[] {
  return decision.violations.map((v) => v.ruleId);
}

describe('parseGuardrailPolicy', () => {
  it('parses protected branch names/patterns, allowed removal roots, deploy commands, and all nine rules', () => {
    expect(policy.protectedBranchNames).toEqual(['main', 'master']);
    expect(policy.protectedBranchPatterns).toEqual(['smith/*/integration']);
    expect(policy.allowedRemovalRoots).toEqual(['workspaces', 'state']);
    expect(policy.deployCommands).toEqual([
      { command: 'wrangler', subcommands: ['deploy', 'publish'] },
      { command: 'pages', subcommands: ['publish'] },
    ]);
    expect(policy.rules.size).toBe(9);
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

  it('denies a bare relative token when the repo root is unknown (fails closed, mirroring guard.sh)', () => {
    const d = evaluateCommand(ctx({ command: 'rm -rf workspaces/foo', repoRoot: null }), policy);
    expect(ruleIds(d)).toContain('unbounded-rm');
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
