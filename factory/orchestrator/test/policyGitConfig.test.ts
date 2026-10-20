import { describe, expect, it } from 'vitest';
import {
  evaluateCommand,
  type GuardrailPolicy,
  type PolicyContext,
  parseGuardrailPolicy,
} from '../src/policy.js';

// The force-push rule reads a command line carried by a git configuration
// value (`-c`, `--config-env`, `GIT_CONFIG_*`, `GIT_PAGER`,
// `GIT_EXTERNAL_DIFF`, `git grep -O`) the same way it reads that command line
// typed directly. A readable value is checked as a nested command line; a
// value the rule cannot read statically is refused whatever its key.

const POLICY_YAML = `
protected_branches:
  names: [main, master]
  patterns: ["smith/*/integration"]

destructive_removal:
  allowed_roots: [workspaces, state]

deploy_commands:
  - { command: wrangler, subcommands: [deploy, publish] }

rules:
  - id: push-to-protected
    severity: S1
    reason: push to main/master is never allowed from an agent session.
  - id: force-push
    severity: S1
    reason: force-push (--force/-f/--force-with-lease) is never allowed from an agent session.
  - id: merge-into-protected
    severity: S1
    reason: a merge lands on the branch you are standing on.
  - id: deploy-command
    severity: S1
    reason: deploy/publish commands require explicit operator approval.
  - id: history-rewrite-on-protected
    severity: S1
    reason: history rewrite on protected branch '{branch}' is never allowed.
  - id: unbounded-rm
    severity: S1
    reason: rm -rf is only allowed inside workspaces/ or state/.

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

const policy: GuardrailPolicy = parseGuardrailPolicy(POLICY_YAML);

function ctx(command: string): PolicyContext {
  return { toolName: 'Bash', command, branch: 'feature', repoRoot: '/repo', filePath: null };
}

function refused(command: string): boolean {
  const decision = evaluateCommand(ctx(command), policy);
  return decision.violations.some((v) => v.ruleId === 'force-push');
}

function allowed(command: string): boolean {
  return evaluateCommand(ctx(command), policy).allowed;
}

describe('force-push rule reads a command named in a git configuration value', () => {
  it('reads the value of -c key=value', () => {
    expect(refused("git -c core.pager='git push --force origin main' log")).toBe(true);
    expect(refused("git -c diff.external='git push -f origin main' diff")).toBe(true);
  });

  it('reads a value written with escaped spaces rather than quotes', () => {
    expect(refused('git -c core.pager=git\\ push\\ -f\\ origin\\ main log')).toBe(true);
  });

  it('reads GIT_PAGER set on the git command', () => {
    expect(refused("GIT_PAGER='git push -f origin main' git log")).toBe(true);
  });

  it('reads GIT_EXTERNAL_DIFF set through env', () => {
    expect(refused("env GIT_EXTERNAL_DIFF='git push --force origin main' git diff")).toBe(true);
  });

  it('reads GIT_PAGER set by an earlier export segment', () => {
    expect(refused("export GIT_PAGER='git push -f origin main'; git log")).toBe(true);
  });

  it('reads GIT_PAGER set by an earlier plain assignment segment', () => {
    expect(refused("GIT_PAGER='git push -f origin main'; git log")).toBe(true);
  });

  it('reads the value of a GIT_CONFIG_COUNT / KEY / VALUE triple', () => {
    expect(
      refused(
        "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0='git push -f origin main' git log",
      ),
    ).toBe(true);
  });

  it('reads a GIT_CONFIG_VALUE exported by an earlier segment', () => {
    expect(
      refused(
        "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0='git push -f origin main'; git log",
      ),
    ).toBe(true);
  });

  it('reads the -O option of git grep', () => {
    expect(refused("git grep -O'git push -f origin main' x")).toBe(true);
  });

  it('reads the long --open-files-in-pager option of git grep', () => {
    expect(refused("git grep --open-files-in-pager='git push --force origin main' x")).toBe(true);
  });

  it('reads the environment variable named by --config-env when the line sets it', () => {
    expect(refused("P='git push -f origin main' git --config-env=core.pager=P log")).toBe(true);
    expect(refused("export P='git push -f origin main'; git --config-env core.pager=P log")).toBe(
      true,
    );
  });

  // A backslash inside single quotes is literal to the shell that holds the
  // value, so only reading the value as a command line (dequoting it) shows
  // the forced push; a scan of the raw text does not.
  it('reads the dequoted form of a -c value', () => {
    expect(refused("git -c core.pager='git p\\ush -f origin main' log")).toBe(true);
  });

  it('reads the dequoted form of a git grep -O value', () => {
    expect(refused("git grep -O'git p\\ush -f origin main' x")).toBe(true);
  });

  it('reads an unreadable -c operand written in the attached form', () => {
    expect(refused('git -ccore.pager="$P" log')).toBe(true);
    expect(refused('git -c=core.pager="$P" log')).toBe(true);
  });

  it('reads a value that is itself a nested shell command', () => {
    expect(refused('git -c core.pager="sh -c \'git push -f origin main\'" log')).toBe(true);
  });
});

describe('force-push rule refuses a configuration value it cannot read, whatever the key', () => {
  it('refuses -c with an unexpanded parameter on a pager key', () => {
    expect(refused('git -c core.pager="$P" log')).toBe(true);
  });

  it('refuses -c with an unexpanded parameter on an unrelated key', () => {
    expect(refused('git -c user.name="$NAME" commit -m y')).toBe(true);
  });

  it('refuses -c with a command substitution', () => {
    expect(refused('git -c core.pager=$(cat f) log')).toBe(true);
  });

  it('refuses -c with a backtick value', () => {
    expect(refused('git -c core.pager=`cat f` log')).toBe(true);
  });

  it('refuses an exported GIT_PAGER holding a parameter', () => {
    expect(refused('export GIT_PAGER="$P"; git log')).toBe(true);
  });

  it('refuses GIT_EXTERNAL_DIFF holding a command substitution', () => {
    expect(refused('GIT_EXTERNAL_DIFF=$(cat f) git diff')).toBe(true);
  });

  it('refuses GIT_EXTERNAL_DIFF holding a backtick value', () => {
    expect(refused('GIT_EXTERNAL_DIFF=`cat f` git diff')).toBe(true);
  });

  it('refuses a GIT_CONFIG_VALUE holding a parameter', () => {
    expect(
      refused('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0="$N" git log'),
    ).toBe(true);
  });

  it('refuses a GIT_CONFIG_COUNT holding a parameter', () => {
    expect(refused('GIT_CONFIG_COUNT=$N git log')).toBe(true);
  });

  it('refuses a name-only export of a configuration variable', () => {
    expect(refused('export GIT_PAGER; git log')).toBe(true);
  });

  it('refuses a git grep -O value holding a parameter', () => {
    expect(refused('git grep -O"$P" x')).toBe(true);
  });

  it('refuses --config-env naming a variable whose value the line does not show', () => {
    expect(refused('git --config-env=core.pager=SOMEVAR log')).toBe(true);
    expect(refused('git --config-env=user.email=E commit -m y')).toBe(true);
  });

  it('refuses --config-env naming a variable the line sets to an unreadable value', () => {
    expect(refused('P="$Q" git --config-env=core.pager=P log')).toBe(true);
  });
});

describe('force-push rule allows readable configuration that runs nothing forced', () => {
  it.each([
    ['git -c color.ui=always log'],
    ['git -c core.pager=cat log'],
    ['GIT_PAGER=cat git log'],
    ['env GIT_PAGER=less git log'],
    ['git -c user.name=x commit -m y'],
    ['git log --oneline'],
    ['git grep -n foo'],
    ['export GIT_PAGER=cat; git log'],
    ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x git log'],
    ['git grep -Ocat foo'],
    ['P=cat git --config-env=core.pager=P log'],
    ['echo hello; git log'],
  ])('allows %s', (command) => {
    expect(allowed(command)).toBe(true);
  });
});

describe('GIT_CONFIG_PARAMETERS is read entry by entry', () => {
  it('refuses a single-quoted key=value entry that sets a forced push', () => {
    expect(refused(`GIT_CONFIG_PARAMETERS="'core.pager=git push -f origin main'" git log`)).toBe(
      true,
    );
  });

  it("refuses a 'key'='value' entry that sets a forced push", () => {
    expect(refused(`GIT_CONFIG_PARAMETERS="'core.pager'='git push -f origin main'" git log`)).toBe(
      true,
    );
  });

  it('allows a single-quoted key=value entry that sets nothing forced', () => {
    expect(allowed(`GIT_CONFIG_PARAMETERS="'color.ui=always'" git log`)).toBe(true);
  });

  it("allows a 'key'='value' entry that sets nothing forced", () => {
    expect(allowed(`GIT_CONFIG_PARAMETERS="'color.ui'='always'" git log`)).toBe(true);
  });

  it('refuses a two-entry value in which only the second entry sets a forced push', () => {
    expect(
      refused(
        `GIT_CONFIG_PARAMETERS="'color.ui'='always' 'core.pager=git push --force origin main'" git log`,
      ),
    ).toBe(true);
  });

  it('refuses a two-entry value of mixed spellings in which only the first sets a forced push', () => {
    expect(
      refused(
        `GIT_CONFIG_PARAMETERS="'core.pager'='git push -f origin main' 'color.ui=always'" git log`,
      ),
    ).toBe(true);
  });

  it('allows a two-entry value of mixed spellings that sets nothing forced', () => {
    expect(allowed(`GIT_CONFIG_PARAMETERS="'color.ui'='always' 'core.pager=cat'" git log`)).toBe(
      true,
    );
  });

  it('refuses an entry whose value carries an escaped single quote and a forced push', () => {
    expect(
      refused(
        `GIT_CONFIG_PARAMETERS="'user.name=a'\\\\''b' 'core.pager=git push -f origin main'" git log`,
      ),
    ).toBe(true);
  });

  it('reads the dequoted form of an entry value', () => {
    expect(
      refused(`GIT_CONFIG_PARAMETERS="'core.pager=git p\\\\ush -f origin main'" git log`),
    ).toBe(true);
  });

  it('keeps reading entries after an escaped single quote', () => {
    expect(
      refused(
        `GIT_CONFIG_PARAMETERS="'user.name=a'\\\\''b' 'core.pager=git p\\\\ush -f origin main'" git log`,
      ),
    ).toBe(true);
  });

  it('allows an entry that carries an escaped single quote and sets nothing forced', () => {
    expect(allowed(`GIT_CONFIG_PARAMETERS="'user.name=a'\\\\''b' 'color.ui=always'" git log`)).toBe(
      true,
    );
  });

  it('refuses an entry that defines an alias', () => {
    expect(refused(`GIT_CONFIG_PARAMETERS="'alias.p'='status'" git p`)).toBe(true);
  });

  it('refuses a value holding a parameter as unreadable', () => {
    expect(refused('GIT_CONFIG_PARAMETERS="$X" git log')).toBe(true);
  });

  it('refuses a value it cannot split into quoted entries', () => {
    expect(refused('GIT_CONFIG_PARAMETERS=color.ui=always git log')).toBe(true);
  });

  it('refuses a name-only export of the variable', () => {
    expect(refused('export GIT_CONFIG_PARAMETERS; git log')).toBe(true);
  });

  it('reads an exported value from an earlier segment', () => {
    expect(
      refused(`export GIT_CONFIG_PARAMETERS="'core.pager=git push -f origin main'"; git log`),
    ).toBe(true);
    expect(allowed(`export GIT_CONFIG_PARAMETERS="'color.ui=always'"; git log`)).toBe(true);
  });
});
