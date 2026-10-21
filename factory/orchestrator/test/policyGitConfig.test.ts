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

describe('a readable configuration value goes through the same checks as a nested command line', () => {
  it('reads a +refspec inside a -c value', () => {
    expect(refused("git -c core.pager='git push origin +main' log")).toBe(true);
  });

  it('reads a +refspec inside GIT_PAGER', () => {
    expect(refused("GIT_PAGER='git push origin +feat:main' git log")).toBe(true);
  });

  it('reads a --force-with-lease inside GIT_EXTERNAL_DIFF set through env', () => {
    expect(
      refused("env GIT_EXTERNAL_DIFF='git push --force-with-lease origin main' git diff"),
    ).toBe(true);
  });

  it('allows a value that runs a plain push of a feature branch', () => {
    expect(allowed("GIT_PAGER='git push origin feat' git log")).toBe(true);
  });
});

describe('GIT_CONFIG_PARAMETERS is refused whenever a command line names it', () => {
  it('refuses GIT_CONFIG_PARAMETERS="\'core.pager=git push -f origin main\'" git log', () => {
    expect(refused(`GIT_CONFIG_PARAMETERS="'core.pager=git push -f origin main'" git log`)).toBe(
      true,
    );
  });

  it("refuses GIT_CONFIG_PARAMETERS=\"'core.pager'='git push -f origin main'\" git log", () => {
    expect(refused(`GIT_CONFIG_PARAMETERS="'core.pager'='git push -f origin main'" git log`)).toBe(
      true,
    );
  });

  it('refuses GIT_CONFIG_PARAMETERS="\'color.ui=always\'" git log', () => {
    expect(refused(`GIT_CONFIG_PARAMETERS="'color.ui=always'" git log`)).toBe(true);
  });

  it("refuses GIT_CONFIG_PARAMETERS=\"'color.ui'='always'\" git log", () => {
    expect(refused(`GIT_CONFIG_PARAMETERS="'color.ui'='always'" git log`)).toBe(true);
  });

  it('refuses a two-entry GIT_CONFIG_PARAMETERS value holding a forced push in the second entry', () => {
    expect(
      refused(
        `GIT_CONFIG_PARAMETERS="'color.ui'='always' 'core.pager=git push --force origin main'" git log`,
      ),
    ).toBe(true);
  });

  it('refuses GIT_CONFIG_PARAMETERS="$X" git log', () => {
    expect(refused('GIT_CONFIG_PARAMETERS="$X" git log')).toBe(true);
  });

  it('refuses the variable exported by an earlier segment', () => {
    expect(refused(`export GIT_CONFIG_PARAMETERS="'color.ui=always'"; git log`)).toBe(true);
  });

  it('refuses the variable set by declare -x and by typeset -x', () => {
    expect(refused(`declare -x GIT_CONFIG_PARAMETERS="'color.ui=always'"; git log`)).toBe(true);
    expect(refused(`typeset -x GIT_CONFIG_PARAMETERS="'color.ui=always'"; git log`)).toBe(true);
  });

  it('refuses a name-only export of the variable', () => {
    expect(refused('export GIT_CONFIG_PARAMETERS; git log')).toBe(true);
  });
});

describe('a mention of a configuration variable the rule did not record as an assignment', () => {
  it.each([
    ["declare -x GIT_PAGER='git push -f origin main'; git log"],
    ["typeset -x GIT_PAGER='git push -f origin main'; git log"],
    ["export GIT_PA''GER='git push -f origin main'; git log"],
    ["export GIT_PA\\GER='git push -f origin main'; git log"],
    ["read GIT_PAGER <<< 'git push -f origin main'; git log"],
    ["printf -v GIT_PAGER %s 'git push -f origin main'; git log"],
    ['echo "$GIT_PAGER"; git log'],
  ])('is refused on a line that runs git: %s', (command) => {
    expect(refused(command)).toBe(true);
  });

  it.each([
    ['{ export GIT_PAGER=cat; }; git log'],
    ['if true; then export GIT_PAGER=cat; fi; git log'],
    ['for i in 1; do export GIT_PAGER=cat; done; git log'],
    ['builtin export GIT_PAGER=cat; git log'],
    ['command export GIT_PAGER=cat; git log'],
    ['export GIT_PAGER+=cat; git log'],
    ['GIT_PAGER+=cat git log'],
    ['set -a; read -r GIT_PAGER < file; git log'],
    ['set -a; printf -v GIT_PAGER %s cat; git log'],
    ['f(){ export GIT_PAGER=cat; }; f; git log'],
    ['declare -n R=GIT_PAGER; export R=cat; git log'],
    ['git log GIT_PAGER=cat'],
    ['git log GIT_EXTERNAL_DIFF'],
    ['git log GIT_CONFIG_COUNT'],
    ['git log GIT_CONFIG_KEY_0'],
    ['git log GIT_CONFIG_VALUE_0'],
  ])('is refused when it is not an assignment read by the rule: %s', (command) => {
    expect(refused(command)).toBe(true);
  });

  it('is counted on a line whose command word cannot be read statically', () => {
    expect(refused('$CMD "$GIT_PAGER"')).toBe(true);
    expect(refused('`which tool` "$GIT_PAGER"')).toBe(true);
  });

  it('is counted after leading assignments when the command word cannot be read statically', () => {
    expect(refused('GIT_EXTERNAL_DIFF=cat $CMD "$GIT_PAGER"')).toBe(true);
  });

  it('is counted on the dequoted text, so a quote pair or a backslash inside the name counts', () => {
    expect(refused("echo GIT_PA''GER; git log")).toBe(true);
    expect(refused('echo GIT_PA\\GER; git log')).toBe(true);
    expect(refused('export GIT_PA\'\'GER=cat; echo "$GIT_PAGER"; git log')).toBe(true);
    expect(refused('export GIT_PA\\GER=cat; echo "$GIT_PAGER"; git log')).toBe(true);
  });

  it('does not refuse readable declare -x and typeset -x assignments', () => {
    expect(allowed('declare -x GIT_PAGER=cat; git log')).toBe(true);
    expect(allowed('typeset -x GIT_PAGER=cat; git log')).toBe(true);
  });

  it('is counted on a line that runs git through a path ending in /git', () => {
    expect(refused('echo "$GIT_PAGER"; /usr/bin/git log')).toBe(true);
  });

  it('refuses nothing on a line that does not run git', () => {
    expect(allowed('echo "$GIT_PAGER"')).toBe(true);
    expect(allowed('printenv GIT_PAGER')).toBe(true);
  });

  it('does not refuse a recorded assignment spelled with a quote pair or a backslash', () => {
    expect(allowed("export GIT_PA''GER=cat; git log")).toBe(true);
    expect(allowed('export GIT_PA\\GER=cat; git log')).toBe(true);
  });

  it('does not refuse a git line that names no configuration variable', () => {
    expect(allowed('git l -f origin main')).toBe(true);
  });
});

describe('local and readonly set a variable the rule reads', () => {
  it('refuses a local declaration inside a function', () => {
    expect(refused("f() { local GIT_PAGER='git push -f origin main'; git log; }; f")).toBe(true);
  });

  it('refuses a readonly declaration', () => {
    expect(refused("readonly GIT_PAGER='git push -f origin main'; git log")).toBe(true);
  });

  it('allows a readonly declaration of a readable value', () => {
    expect(allowed('readonly GIT_PAGER=cat; git log')).toBe(true);
  });

  it('allows a local declaration of a readable value', () => {
    expect(allowed('local GIT_PAGER=cat; git log')).toBe(true);
  });
});

describe('a git run by path is read the same way as a bare git word', () => {
  it('reads a leading assignment and an export before a path-form git', () => {
    expect(refused('GIT_PAGER="$X" /usr/bin/git log')).toBe(true);
    expect(refused('export GIT_PAGER="$X"; /usr/bin/git log')).toBe(true);
    expect(refused('GIT_EXTERNAL_DIFF=$(cat f) /usr/bin/git diff')).toBe(true);
    expect(refused("GIT_PAGER='git push -f origin main' /usr/bin/git log")).toBe(true);
  });

  it('reads an env prefix before a path-form git', () => {
    expect(refused('env GIT_EXTERNAL_DIFF="$(cat f)" /usr/bin/git diff')).toBe(true);
    expect(refused("env GIT_PAGER='git push -f origin main' ./git log")).toBe(true);
  });

  it('reads -c, --config-env and grep -O after a path-form git', () => {
    expect(refused('/usr/bin/git -c core.pager="$X" log')).toBe(true);
    expect(refused('./git -c core.pager="$X" log')).toBe(true);
    expect(refused("/usr/bin/git -c core.pager='git push -f origin main' log")).toBe(true);
    expect(refused('/usr/bin/git --config-env=core.pager=SOMEVAR log')).toBe(true);
    expect(refused('/usr/bin/git grep -O"$X" x')).toBe(true);
    expect(refused("/usr/bin/git grep -O'git push -f origin main' x")).toBe(true);
  });

  it('allows the readable and unrelated counterparts of a path-form git', () => {
    expect(allowed('/usr/bin/git -c core.pager=cat log')).toBe(true);
    expect(allowed('GIT_PAGER=cat /usr/bin/git log')).toBe(true);
    expect(allowed('env GIT_PAGER=less ./git log')).toBe(true);
    expect(allowed('/usr/bin/git -c user.name=x commit -m y')).toBe(true);
    expect(allowed('/usr/bin/git grep -n foo')).toBe(true);
  });
});

describe('a separate-value global option is walked past', () => {
  it('reads -c, --config-env and grep -O after --attr-source <tree-ish>', () => {
    expect(refused('git --attr-source HEAD -c core.pager="$X" log')).toBe(true);
    expect(refused('git --attr-source HEAD grep -O"$X" x')).toBe(true);
    expect(refused('git --attr-source HEAD --config-env=core.pager=SOMEVAR log')).toBe(true);
    expect(refused("git --attr-source HEAD -c core.pager='git push -f origin main' log")).toBe(
      true,
    );
  });

  it('reads the same options with the = spelling and with no such option', () => {
    expect(refused('git --attr-source=HEAD -c core.pager="$X" log')).toBe(true);
    expect(refused('git -c core.pager="$X" log')).toBe(true);
  });

  it('allows readable values after --attr-source', () => {
    expect(allowed('git --attr-source HEAD -c core.pager=cat log')).toBe(true);
    expect(allowed('git --attr-source HEAD grep -n foo')).toBe(true);
  });

  it('reads -c and grep -O after --super-prefix <path> and after -C <dir>', () => {
    expect(refused('git --super-prefix sub/ -c core.pager="$X" log')).toBe(true);
    expect(refused('git -C /tmp/project-a -c core.pager="$X" log')).toBe(true);
    expect(refused("git -C /tmp/project-a grep -O'git push -f origin main' x")).toBe(true);
    expect(allowed('git -C /tmp/project-a -c core.pager=cat log')).toBe(true);
  });
});

describe('a configuration value is read in each compound-command position', () => {
  it('reads a leading assignment after && and inside a subshell', () => {
    expect(refused("cd /tmp/project-a && GIT_PAGER='git push -f origin main' git log")).toBe(true);
    expect(refused("(export GIT_PAGER='git push -f origin main'; git log)")).toBe(true);
    expect(refused('cd /tmp/project-a && git -c core.pager="$P" log')).toBe(true);
  });

  it('carries an export across more than one segment to a later git', () => {
    expect(refused("export GIT_PAGER='git push -f origin main'; echo hi; git log")).toBe(true);
  });

  it('reads the second of two git segments', () => {
    expect(refused("git log; GIT_PAGER='git push -f origin main' git log")).toBe(true);
    expect(allowed('git log; GIT_PAGER=cat git log')).toBe(true);
  });

  it('reads the last of several GIT_CONFIG_VALUE entries', () => {
    expect(
      refused(
        "GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x GIT_CONFIG_KEY_1=core.pager GIT_CONFIG_VALUE_1='git push -f origin main' git log",
      ),
    ).toBe(true);
  });
});
