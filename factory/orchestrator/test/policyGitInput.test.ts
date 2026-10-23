import { describe, expect, it } from 'vitest';
import { evaluateCommand, loadGuardrailPolicy, type PolicyContext } from '../src/policy.js';

// The force-push rule reads a git command whose arguments come from `xargs`,
// and git output that a shell interpreter runs, the same way it reads the
// in-line form. The history-rewrite rule reads each top-level command on its
// own, so a read-only git search on a protected branch is allowed while a
// real rewrite elsewhere on the line is still refused.

const policy = loadGuardrailPolicy();

function decide(command: string, branch = 'feature') {
  const context: PolicyContext = {
    toolName: 'Bash',
    command,
    branch,
    repoRoot: '/repo',
    filePath: null,
  };
  return evaluateCommand(context, policy);
}

const forcePushRefused = (command: string) =>
  decide(command).violations.some((v) => v.ruleId === 'force-push');
const rewriteRefused = (command: string) =>
  decide(command, 'main').violations.some((v) => v.ruleId === 'history-rewrite-on-protected');

const XARGS_AND_PIPE_REFUSED: string[] = [
  'echo --force | xargs git push origin main',
  "printf 'push -f origin main' | xargs git",
  'xargs -I{} git {} < cmds.txt',
  'git log --format=%s | sh',
  'git show HEAD:run.sh | bash',
  "git log | xargs sh -c 'git push -f origin main'",
  'git log | env bash',
  'eval "$(git log -1 --format=%B)"',
  'source <(git show HEAD:x.sh)',
];

const XARGS_AND_PIPE_ALLOWED: string[] = [
  'git ls-files | xargs grep x',
  'git ls-files -z | xargs -0 git add',
  'git diff --name-only | xargs git log --oneline --',
  'git log | less',
  'git diff | cat',
  'git log | grep x',
  'xargs echo < list.txt',
];

describe('force-push rule reads git commands that xargs runs and git output a shell runs', () => {
  it.each(XARGS_AND_PIPE_REFUSED)('refuses %s', (command) => {
    expect(forcePushRefused(command)).toBe(true);
  });

  it.each(XARGS_AND_PIPE_ALLOWED)('allows %s', (command) => {
    expect(decide(command).violations.filter((v) => v.ruleId === 'force-push')).toEqual([]);
  });

  it('refuses a shell interpreter after a pipe whichever interpreter it is', () => {
    for (const shell of ['sh', 'bash', 'zsh', 'dash', 'ksh']) {
      expect(forcePushRefused(`git log | ${shell}`)).toBe(true);
      expect(forcePushRefused(`git log | xargs ${shell}`)).toBe(true);
    }
  });

  it('refuses sourcing a process substitution that runs git, with the dot form too', () => {
    expect(forcePushRefused('. <(git show HEAD:x.sh)')).toBe(true);
  });

  it('refuses xargs git with its own options before the git word', () => {
    expect(forcePushRefused('echo x | xargs -n 1 git push')).toBe(true);
    expect(forcePushRefused('echo x | xargs -0 -I{} git rebase {}')).toBe(true);
  });

  it('allows a non-git producer piped into a shell interpreter', () => {
    expect(forcePushRefused('echo ls | sh')).toBe(false);
  });

  it('refuses xargs git whose subcommand is force-gated, with env or a path in front', () => {
    expect(forcePushRefused('echo x | xargs git rebase main')).toBe(true);
    expect(forcePushRefused('echo x | xargs env git push')).toBe(true);
    expect(forcePushRefused('echo x | xargs /usr/bin/git push')).toBe(true);
    expect(forcePushRefused('echo x | xargs --max-args 1 git push')).toBe(true);
  });

  it('allows xargs git with a plain read-only or non-gated subcommand', () => {
    expect(forcePushRefused('git ls-files | xargs git status')).toBe(false);
    expect(forcePushRefused('git ls-files | xargs -n 1 git log --oneline')).toBe(false);
    expect(forcePushRefused('git ls-files | xargs -I{} git add {}')).toBe(false);
  });

  it('refuses a shell interpreter named by path or run through env after a git pipe', () => {
    expect(forcePushRefused('git log | /bin/bash')).toBe(true);
    expect(forcePushRefused('git log | env FOO=1 bash')).toBe(true);
    expect(forcePushRefused('git log | xargs -n 1 sh')).toBe(true);
    expect(forcePushRefused('git log | cat | sh')).toBe(true);
  });

  it('reads a shell interpreter only in the pipeline whose earlier command runs git', () => {
    expect(forcePushRefused('git log | cat; echo ls | sh')).toBe(false);
    expect(forcePushRefused('git log && sh')).toBe(false);
    expect(forcePushRefused('git log || sh')).toBe(false);
    expect(forcePushRefused('echo ls | cat | sh')).toBe(false);
  });

  it('refuses eval of a git substitution in either substitution form', () => {
    expect(forcePushRefused('eval "`git log -1 --format=%B`"')).toBe(true);
    expect(forcePushRefused('eval $(git show HEAD:x.sh)')).toBe(true);
  });

  it('allows eval of a substitution that does not run git', () => {
    expect(forcePushRefused('eval "$(echo hello)"')).toBe(false);
    expect(forcePushRefused('eval "$(ssh-agent -s)"')).toBe(false);
  });
});

describe('history-rewrite rule reads each top-level command on its own', () => {
  const READ_ONLY_ALLOWED = [
    'git grep rebase',
    'git grep -n filter-branch -- docs/',
    "git log --grep='commit --amend'",
  ];
  const STILL_REFUSED = [
    'git rebase -i HEAD~2',
    'git commit --amend',
    'git grep rebase && git rebase main',
    'git grep rebase; git rebase main',
    'git filter-repo --path x',
  ];

  it.each(READ_ONLY_ALLOWED)('allows %s on a protected branch', (command) => {
    expect(rewriteRefused(command)).toBe(false);
  });

  it.each(STILL_REFUSED)('refuses %s on a protected branch', (command) => {
    expect(rewriteRefused(command)).toBe(true);
  });

  it('reads a read-only search next to a real rewrite on the same line', () => {
    expect(rewriteRefused('git grep rebase || git commit --amend')).toBe(true);
    expect(rewriteRefused('git grep rebase\ngit rebase main')).toBe(true);
    expect(rewriteRefused('git log --grep=rebase | head -3; git filter-repo --path x')).toBe(true);
    expect(rewriteRefused('git rebase main && git grep rebase')).toBe(true);
  });

  it('allows several read-only searches on one line on a protected branch', () => {
    expect(rewriteRefused('git grep rebase && git log --grep=amend')).toBe(false);
    expect(rewriteRefused('git grep rebase | head -3')).toBe(false);
  });

  it('does not apply the history-rewrite rule on an unprotected branch', () => {
    const rules = decide('git rebase -i HEAD~2', 'feature').violations.map((v) => v.ruleId);
    expect(rules).not.toContain('history-rewrite-on-protected');
  });

  it('keeps the whole-command reading when the line cannot be split', () => {
    // An unbalanced quote makes the splitter return the whole line as one segment.
    expect(rewriteRefused("git grep rebase 'x")).toBe(true);
    expect(rewriteRefused('git log --grep=rebase; echo "x')).toBe(true);
  });
});
