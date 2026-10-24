import { describe, expect, it } from 'vitest';
import { evaluateCommand, loadGuardrailPolicy, type PolicyContext } from '../src/policy.js';

// The guard reads the other variables git runs as commands (PAGER, the editor,
// ssh and askpass variables) the way it reads the git-specific pager variable:
// a readable value is checked as a nested command line, an unreadable value is
// refused, and on a line that runs git a mention that was not read is refused.

const policy = loadGuardrailPolicy();

function decide(command: string) {
  const context: PolicyContext = {
    toolName: 'Bash',
    command,
    branch: 'feature',
    repoRoot: '/repo',
    filePath: null,
  };
  return evaluateCommand(context, policy);
}

const refused = (command: string) =>
  decide(command).violations.some((v) => v.ruleId === 'force-push');
const allowed = (command: string) => decide(command).allowed;

const NAMES = [
  'PAGER',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'EDITOR',
  'VISUAL',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
];
const FORCED = 'git push -f origin main';
const FORCED_ESCAPED = 'git pu\\sh -f origin main';

describe('variables git runs as commands', () => {
  for (const name of NAMES) {
    describe(name, () => {
      it('checks a readable value as a nested command line', () => {
        expect(refused(`${name}='${FORCED}' git log`)).toBe(true);
        expect(refused(`${name}='${FORCED_ESCAPED}' git log`)).toBe(true);
        expect(refused(`env ${name}='${FORCED}' git log`)).toBe(true);
        expect(refused(`export ${name}='${FORCED}'; git log`)).toBe(true);
      });

      it('refuses a value that cannot be read statically', () => {
        expect(refused(`${name}="$(cat x)" git log`)).toBe(true);
        expect(refused(`${name}=$X git log`)).toBe(true);
        expect(refused(`export ${name}; git log`)).toBe(true);
      });

      it('refuses a mention that was not read, on a line that runs git', () => {
        expect(refused(`declare -x ${name}='${FORCED}'; git log`)).toBe(true);
        expect(refused(`read ${name} <<< '${FORCED}'; git log`)).toBe(true);
        expect(refused(`printf -v ${name} %s '${FORCED}'; git log`)).toBe(true);
        expect(refused(`echo "$${name}"; git log`)).toBe(true);
      });

      it('allows a plain value and a line that does not run git', () => {
        expect(allowed(`${name}=less git log`)).toBe(true);
        expect(allowed(`echo "$${name}"`)).toBe(true);
        expect(allowed(`printenv ${name}`)).toBe(true);
      });
    });
  }

  it('keeps ordinary uses allowed', () => {
    for (const command of [
      'PAGER=less git log',
      `GIT_SSH_COMMAND='ssh -i key' git fetch`,
      'EDITOR=true git commit',
      'git -c color.ui=always log',
      'git -c core.pager=cat log',
      'GIT_PAGER=cat git log',
      'env GIT_PAGER=less git log',
      'git -c user.name=x commit -m y',
      'git log --oneline',
      'git grep -n foo',
    ]) {
      expect(allowed(command), command).toBe(true);
    }
  });
});
