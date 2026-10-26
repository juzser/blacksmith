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

  it('reads the xargs replacement options the same way as -I', () => {
    expect(forcePushRefused('echo x | xargs -I % git push')).toBe(true);
    expect(forcePushRefused('echo x | xargs -J % git push')).toBe(true);
    expect(forcePushRefused('echo x | xargs -S 100 -I % git push')).toBe(true);
    expect(forcePushRefused('echo x | xargs -R 2 -I % git push')).toBe(true);
    expect(forcePushRefused('git log | xargs -J % bash -c')).toBe(true);
    expect(forcePushRefused('git ls-files | xargs -J % grep x %')).toBe(false);
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

describe('force-push rule reads a shell run with -c, behind prefix words, through env and xargs', () => {
  const REFUSED: string[] = [
    // a shell run with -c on a substitution of git, with each flag spelling
    'sh -c "$(git show HEAD:x.sh)"',
    'bash -c "`git log -1 --format=%B`"',
    'bash -ec "$(git show HEAD:x.sh)"',
    'bash -ce "$(git show HEAD:x.sh)"',
    '/usr/bin/zsh -c "$(git show HEAD:x.sh)"',
    'bash --norc -c "$(git show HEAD:x.sh)" extra-arg',
    'FOO=1 bash -c "$(git show HEAD:x.sh)"',
    // each prefix word, with operands, flags, durations and chains
    'git log | timeout 5 bash',
    'git log | command bash',
    'git log | sudo -u example-user bash',
    'git log | nice -n 5 sh',
    'git log | nohup sh',
    'git log | exec bash',
    'git log | stdbuf -oL sh',
    'git log | time bash',
    'git log | timeout -s KILL 5 bash',
    'git log | timeout 1.5 bash',
    'git log | timeout 5m bash',
    'git log | timeout --signal=KILL 5 bash',
    'git log | /usr/bin/timeout 5 /bin/bash',
    'git log | nice -n 5 timeout 5 sudo bash',
    'git log | FOO=1 timeout 5 bash',
    'git log | nice FOO=1 timeout 5 bash',
    'timeout 5 bash -c "$(git show HEAD:x.sh)"',
    // a word the walk cannot classify after a prefix word: the later shell runs
    'git log | timeout 5 foo bash',
    'git log | timeout 5 grep bash',
    'git log | sudo foo -x sh',
    'git log | sudo timeout 5 foo bash',
    'timeout 5 foo bash -c "$(git show HEAD:x.sh)"',
    // env as a prefix word and env -S given a command line
    'git log | env -S "bash -x"',
    'git log | env -S"bash -x"',
    'git log | env --split-string "sh -e"',
    'git log | env -S "timeout 5 bash"',
    'env --split-string="sh -c \'$(git show HEAD:x.sh)\'"',
    'git log | sudo env bash',
    'git log | timeout 5 env FOO=1 bash',
    'git log | sudo env -u FOO bash',
    'git log | sudo env -S "bash -x"',
    'sudo env bash -c "$(git show HEAD:x.sh)"',
    'timeout 5 env -S "bash -c \'$(git show HEAD:x.sh)\'"',
    'FOO=1 env -u BAR bash -c "$(git show HEAD:x.sh)"',
    'git log | xargs env -S"bash -x"',
    'git log | xargs -n 1 env FOO=1 bash',
    // xargs and eval after env -S and after prefix words
    'echo push | env -S foo xargs git',
    'echo push | env -S foo xargs -n 1 git',
    'env -S foo eval "$(git show HEAD:x.sh)"',
    'echo push | timeout 5 xargs git',
    'echo push | sudo timeout 5 xargs -I{} git {}',
    'echo push | nice -n 5 env FOO=1 xargs git',
    'echo push | xargs timeout 5 git',
    'echo push | timeout 5 xargs nice -n 5 git',
    'timeout 5 eval "$(git show HEAD:x.sh)"',
    'command eval "$(git log -1 --format=%B)"',
    'nohup sudo eval "$(git show HEAD:x.sh)"',
    'env FOO=1 timeout 5 eval "$(git show HEAD:x.sh)"',
    'timeout 5 eval "$(git show HEAD:x.sh)" bash',
    'echo push | timeout 5 xargs -I{} git {} bash',
    // xargs -S stays an xargs option
    'echo x | xargs -S 100 env git rebase main',
    'git log | xargs -S 100 env bash',
  ];

  const ALLOWED: string[] = [
    'bash -c "$(date)"',
    'bash -c "git status"',
    'bash script.sh',
    'bash -x "$(git show HEAD:x.sh)"',
    'git log | xargs -S env -S "bash -x"',
    'bash script.sh "$(git show HEAD:x.sh)"',
    'env -u BAR bash script.sh "$(git log -1 --format=%B)"',
    'zsh -c "echo $(pwd)"',
    'echo ls | timeout 5 bash',
    'echo hi | sudo env bash',
    'echo hi | sudo timeout 5 foo bash',
    'echo ls | env -S "bash -x"',
    'echo hi | xargs -n 1 env FOO=1 bash',
    'git log | command grep x',
    'git log | nice -n 5 grep x',
    'git log | grep bash',
    'git log | grep -n sh file.txt',
    'git log | printf bash',
    'grep bash script.txt',
    'git status && timeout 5 make test',
    'timeout 5 bash -c "$(date)"',
    'timeout 5 foo bash',
    'sudo timeout 5 foo bash -c "echo hello"',
    'env -S "echo hello"',
    'git log | env -S "cat -n"',
    'git ls-files | xargs -n 1 env FOO=1 cat',
    'git ls-files | xargs -S 100 env git status',
    'git ls-files | sudo xargs git status',
    'echo x | env -S foo xargs grep y',
    'echo x | timeout 5 xargs nice -n 5 grep y',
    'env -S foo eval "$(echo hi)"',
    'timeout 5 eval "$(echo hi)"',
    'nohup sudo eval "$(echo hi)"',
  ];

  it.each(REFUSED)('refuses %s', (command) => {
    expect(forcePushRefused(command)).toBe(true);
  });

  it.each(ALLOWED)('allows %s', (command) => {
    expect(forcePushRefused(command)).toBe(false);
  });

  it('reads xargs git behind a prefix word even when a shell word follows later in the segment', () => {
    expect(forcePushRefused('echo x | timeout 5 xargs git push bash')).toBe(true);
    expect(forcePushRefused('echo x | sudo xargs git rebase main sh')).toBe(true);
    expect(forcePushRefused('echo x | nice -n 5 xargs -n 1 git push zsh')).toBe(true);
    expect(forcePushRefused('echo x | timeout 5 xargs git status bash')).toBe(false);
  });

  it('answers quickly on a shell option word of 200000 letters and still refuses a later segment', () => {
    const started = Date.now();
    const refused = forcePushRefused(`bash -${'c'.repeat(200000)}1; git push --force origin main`);
    expect(refused).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('refuses a segment after an env split-string value of 200000 words without throwing', () => {
    const line = `env -S "${'a '.repeat(200000)}"; git push --force origin main`;
    expect(() => forcePushRefused(line)).not.toThrow();
    expect(forcePushRefused(line)).toBe(true);
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

describe('force-push rule reads a command word it cannot spell out as possibly running git', () => {
  const REFUSED = [
    'G=git; $G show HEAD:run.sh | sh',
    'G=git; $G log --format=%B | bash',
    '$(echo git) show HEAD:run.sh | sh',
    'G=git; echo x | $G show HEAD:run.sh | sh',
    'G=git; echo "push --force origin main" | xargs $G',
    'G=git; echo x | xargs -n 1 $G',
    'echo x | xargs $(echo git) push',
  ];
  const ALLOWED = [
    'G=git; $G log | head -3',
    'G=git; $G log | grep fix',
    'G=git; $G show HEAD:run.sh',
    'cat script.txt | sh',
    'echo hi | bash',
    'echo x | xargs echo',
    'echo x | xargs -n 1 grep y',
    'G=git; $G log | xargs grep x',
  ];

  it.each(REFUSED)('refuses %s', (command) => {
    expect(forcePushRefused(command)).toBe(true);
  });

  it.each(ALLOWED)('allows %s', (command) => {
    expect(forcePushRefused(command)).toBe(false);
  });

  it('gives the unreadable-command-word reason after xargs and the shell-input reason for a pipe into a shell', () => {
    const reasons = (command: string) =>
      decide(command)
        .violations.filter((v) => v.ruleId === 'force-push')
        .map((v) => v.reason);
    expect(reasons('G=git; echo x | xargs $G')[0]).toContain(
      'the command word here is an unexpanded',
    );
    expect(reasons('G=git; $G show HEAD:run.sh | sh')[0]).toContain('git output is run by a shell');
  });
});

describe('force-push rule reads xargs, eval and a shell behind prefix words and their options', () => {
  const PREFIX_WORDS = ['timeout', 'command', 'sudo', 'nice', 'nohup', 'exec', 'stdbuf', 'time'];
  const reasonsOf = (command: string) =>
    decide(command)
      .violations.filter((v) => v.ruleId === 'force-push')
      .map((v) => v.reason);

  it.each(PREFIX_WORDS)('refuses xargs git and eval of a git substitution behind %s', (word) => {
    expect(forcePushRefused(`echo push | ${word} xargs git`)).toBe(true);
    expect(forcePushRefused(`${word} eval "$(git show HEAD:x.sh)"`)).toBe(true);
  });

  const REFUSED = [
    // a flag with no value, or with its value attached, does not take the next word
    'echo push | sudo -E xargs git',
    'echo push | time -p xargs git',
    'echo push | sudo -- xargs git',
    'echo push | nice -- xargs git',
    'echo push | timeout -- 5 xargs git',
    'echo push | stdbuf -oL xargs git',
    'sudo -E eval "$(git show HEAD:x.sh)"',
    'time -p eval "$(git show HEAD:x.sh)"',
    'nice -- eval "$(git show HEAD:x.sh)"',
    'stdbuf -oL eval "$(git show HEAD:x.sh)"',
    'git log | sudo -E bash',
    'git log | time -p sh',
    // a flag the walk cannot classify: a later xargs or eval is still read
    'echo push | sudo -E foo bar xargs git',
    'sudo -E foo bar eval "$(git show HEAD:x.sh)"',
    'echo push | sudo -u example-user xargs git',
    // a nested env split-string value holding a quoted command
    'echo push | env -S "env -S \'xargs git\'"',
    'echo push | env -S \'env -S "xargs git push"\'',
    'git log | env -S "env -S \'bash -x\'"',
    'env -S "env -S \'eval \\"\\$(git show HEAD:x.sh)\\"\'"',
    // a split-string value is also read word by word as written
    "git log | env -S 'nice \" bash'",
    "git log | env -S 'sudo \\ bash'",
    'git log | env -S "nice \'x bash"',
    // a split-string value of 200000 pieces holding a refused segment
    `echo push | env -S "xargs git push ${'a '.repeat(200000)}"`,
  ];

  const ALLOWED = [
    'echo push | sudo -E xargs grep y',
    'git ls-files | sudo -E xargs git status',
    'echo x | stdbuf -o L xargs grep y',
    'echo x | time -p xargs grep y',
    'sudo -E eval "$(echo hi)"',
    'sudo -u example-user ls',
    'git log | sudo -E grep x',
    'echo x | env -S "env -S \'xargs grep y\'"',
  ];

  it.each(REFUSED)('refuses %s', (command) => {
    expect(() => forcePushRefused(command)).not.toThrow();
    expect(forcePushRefused(command)).toBe(true);
  });

  it.each(ALLOWED)('allows %s', (command) => {
    expect(forcePushRefused(command)).toBe(false);
  });

  it('gives the xargs reason and the shell-input reason for the lines it refuses', () => {
    expect(reasonsOf('echo push | sudo -E xargs git')[0]).toContain('git run by xargs');
    expect(reasonsOf('sudo -E eval "$(git show HEAD:x.sh)"')[0]).toContain(
      'git output is run by a shell',
    );
  });

  // The guard reads this many split-string options in one segment.
  const SPLIT_LIMIT = 64;
  const chain = (levels: number) => `echo x | env -S "${'-S'.repeat(levels - 1)}xargs grep y"`;

  it('reads a chain of split-string options at the limit and refuses one past it with its reason', () => {
    expect(decide(chain(SPLIT_LIMIT)).violations).toEqual([]);
    const past = reasonsOf(chain(SPLIT_LIMIT + 1));
    expect(past).toHaveLength(1);
    expect(past[0]).toContain('nests more options than the guard reads');
  });

  // A later shell word is read even when an xargs word comes first.
  const SUBST = '"$(git show HEAD:x.sh)"';
  const shellLines = [
    `sudo -p xargs -p ls bash -c ${SUBST}`,
    'git log | nice foo xargs ls sh',
    ...['nice', 'sudo', 'nohup', 'nice -n 5'].flatMap((prefix) =>
      ['xargs ls', 'xargs ls xargs ls'].flatMap((runner) =>
        ['sh', 'bash'].map((shell) => `echo x | ${prefix} foo ${runner} ${shell} -c ${SUBST}`),
      ),
    ),
  ];

  it.each(shellLines)('refuses a shell run on git output after an xargs word: %s', (command) => {
    expect(reasonsOf(command)[0]).toContain('git output is run by a shell');
  });
});

describe('force-push rule reads the pipe structure, prefix words and xargs names of longer lines', () => {
  const reasonsOf = (command: string) =>
    decide(command)
      .violations.filter((v) => v.ruleId === 'force-push')
      .map((v) => v.reason);
  const SHELL = 'git output is run by a shell';
  const UNEXPANDED = 'the command word here is an unexpanded';
  const XARGS = 'git run by xargs';
  const expectReason = (command: string, reason: string) => {
    expect(reasonsOf(command)[0]).toContain(reason);
  };

  // The guard reads the pipe structure of lines that hold expansions, comments, here-documents or ANSI-C quoting.
  const STRUCTURE_SHELL = [
    'G=git; $G show HEAD:run.sh | sh # note',
    'G=git; ${G} show HEAD:run.sh | sh',
    'G=git; ${G} show HEAD:run.sh | sh # note',
    'X=1; echo ${X}; G=git; $G show HEAD:run.sh | sh',
    'echo ${X} && G=git; $G show HEAD:run.sh | sh',
    "echo $'a'; G=git; $G show HEAD:run.sh | sh",
    'cat <<EOF > /dev/null\nbody\nEOF\nG=git; $G show HEAD:run.sh | sh',
    'git log --format=%s | sh # note',
    'echo ${X}; git log --format=%s | bash',
  ];
  const STRUCTURE_UNEXPANDED = [
    'G=git; echo x | xargs ${G}',
    'G=git; echo x | xargs $G # note',
    'echo ${X}; G=git; echo x | xargs $G',
    "echo $'a'; G=git; echo x | xargs $G",
    'cat <<EOF > /dev/null\nbody\nEOF\nG=git; echo x | xargs $G',
  ];
  const STRUCTURE_ALLOWED = [
    'echo ${X} # note',
    'echo ls | sh # note',
    'G=git; $G log | head -3 # note',
    'echo ${X}; git log | grep fix',
    'echo ${X} | xargs echo',
    "echo $'a' | sh",
    'git log | grep ${X}',
    'cat <<EOF > /dev/null\nbody\nEOF\necho ls | sh',
  ];

  it.each(STRUCTURE_SHELL)('gives the shell-input reason for %j', (command) => {
    expectReason(command, SHELL);
  });
  it.each(STRUCTURE_UNEXPANDED)('gives the unreadable-command-word reason for %j', (command) => {
    expectReason(command, UNEXPANDED);
  });
  it.each(STRUCTURE_ALLOWED)('keeps allowing %j', (command) => {
    expect(forcePushRefused(command)).toBe(false);
  });

  // An unreadable command word behind a prefix word, or inside an env split-string, in a producer.
  const PRODUCER_PREFIXES = ['command', 'exec', 'time', 'nice', 'nohup', 'sudo', 'timeout 5', '!'];
  it.each(PRODUCER_PREFIXES)(
    'counts an unreadable command word behind %s as a producer',
    (word) => {
      expectReason(`G=git; ${word} $G show HEAD:run.sh | sh`, SHELL);
      expectReason(`G=git; echo x | ${word} $G show HEAD:run.sh | sh`, SHELL);
      expect(forcePushRefused(`G=git; ${word} $G log | head -3`)).toBe(false);
      expect(forcePushRefused(`${word} echo hi | sh`)).toBe(false);
    },
  );
  it('counts an env split-string that starts with a variable as a producer', () => {
    expectReason('G=git; env -S "$G show HEAD:run.sh" | sh', SHELL);
    expect(forcePushRefused('G=git; env -S "$G log" | head -3')).toBe(false);
  });

  // A prefix option with its value attached does not take the next word as a value.
  it('gives the unreadable-command-word reason for an unexpanded word after xargs and stdbuf -oL', () => {
    expectReason('G=git; echo x | xargs stdbuf -oL $G', UNEXPANDED);
  });
  it('gives the xargs reason for the tool name after xargs and stdbuf -oL', () => {
    expectReason('echo x | xargs stdbuf -oL git', XARGS);
  });
  it('keeps allowing a plain command after xargs and stdbuf with its option value', () => {
    expect(forcePushRefused('echo x | xargs stdbuf -oL grep y')).toBe(false);
    expect(forcePushRefused('echo x | xargs stdbuf -o L grep y')).toBe(false);
  });

  // The env split-string reader treats a backslash-underscore outside quotes as a word break.
  it.each(["'sh\\_-s'", "'bash\\_-s'", "'nice\\_bash'", "'timeout\\_5\\_sh'"])(
    'reads the env -S value %s as separate words',
    (value) => {
      expectReason(`git log --format=%s | env -S ${value}`, SHELL);
    },
  );
  it('keeps a backslash-underscore inside single quotes as written', () => {
    expect(forcePushRefused("git log --format=%s | env -S 'a\\_b'")).toBe(false);
  });

  // xargs is read by its base name.
  it.each(['/usr/bin/xargs', './xargs'])('refuses %s running the tool', (runner) => {
    expectReason(`cat args.txt | ${runner} git`, XARGS);
    expectReason(`cat args.txt | timeout 5 ${runner} git`, XARGS);
    expect(forcePushRefused(`git ls-files | ${runner} git status`)).toBe(false);
    expect(forcePushRefused(`echo x | ${runner} grep y`)).toBe(false);
  });

  // builtin is read as a prefix word.
  it('reads eval behind builtin like eval alone', () => {
    expectReason('builtin eval "$(git log -1 --format=%B)"', SHELL);
    expectReason('builtin command eval "$(git log -1 --format=%B)"', SHELL);
    expect(forcePushRefused('builtin eval "$(echo hi)"')).toBe(false);
    expect(forcePushRefused('builtin echo hi')).toBe(false);
  });

  // The env split-string reader and the prefix-word walk read long lines in one pass.
  it('decides a long chain of env split-strings with the limit reason', () => {
    const past = reasonsOf(`echo x | ${'env -S nice '.repeat(4000)}true`);
    expect(past).toHaveLength(1);
    expect(past[0]).toContain('nests more options than the guard reads');
  });
  it.each(['time', 'nice', 'nice -n 1', 'sudo'])(
    'decides many xargs words behind %s without a refusal',
    (prefix) => {
      expect(forcePushRefused(`git log | ${'xargs '.concat(prefix, ' a ').repeat(5000)}ls`)).toBe(
        false,
      );
    },
  );
});
