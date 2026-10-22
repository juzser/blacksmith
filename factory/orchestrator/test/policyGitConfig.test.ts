import { describe, expect, it } from 'vitest';
import { evaluateCommand, loadGuardrailPolicy, type PolicyContext } from '../src/policy.js';

// The force-push rule reads a command line carried by a git configuration
// value (`-c`, `--config-env`, `GIT_CONFIG_*`, `GIT_PAGER`, `GIT_EXTERNAL_DIFF`,
// `git grep -O`) like one typed directly; a value it cannot read statically
// is refused whatever its key. One shell-word reader serves every check.

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

const FORCED = 'git push -f origin main';
const FORCED_ESCAPED = 'git pu\\sh -f origin main';
const TRIPLE = 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0';

// Every command below is judged by `refused` (a force-push violation) or by
// `allowed` (no violation at all). The matrices further down add to them.
const REFUSED: string[] = [
  // carriers read as nested command lines
  `git -c core.pager='git push --force origin main' log`,
  `git -c diff.external='${FORCED}' diff`,
  'git -c core.pager=git\\ push\\ -f\\ origin\\ main log',
  `git -c core.pager='git p\\ush -f origin main' log`,
  'git -c core.pager="sh -c \'git push -f origin main\'" log',
  `GIT_PAGER='${FORCED}' git log`,
  `env GIT_EXTERNAL_DIFF='git push --force origin main' git diff`,
  `GIT_PAGER='${FORCED}'; git log`,
  `${TRIPLE}='${FORCED}' git log`,
  `export ${TRIPLE}='${FORCED}'; git log`,
  `GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x GIT_CONFIG_KEY_1=core.pager GIT_CONFIG_VALUE_1='${FORCED}' git log`,
  `GIT_CONFIG_VALUE_0='${FORCED}' GIT_CONFIG_COUNT=1 git log`,
  `GIT_CONFIG_VALUE_10='${FORCED}' git log`,
  `git grep -O'${FORCED}' x`,
  `git grep x -O'${FORCED}'`,
  `git grep -O'git p\\ush -f origin main' x`,
  `git grep --open-files-in-pager='git push --force origin main' x`,
  `git grep --open-files-in-pager '${FORCED}' x`,
  `P='${FORCED}' git --config-env=core.pager=P log`,
  `export P='${FORCED}'; git --config-env core.pager=P log`,
  `P='${FORCED}'; export P; git --config-env=core.pager=P log`,
  `git -c core.pager='git push origin +main' log`,
  `GIT_PAGER='git push origin +feat:main' git log`,
  `env GIT_EXTERNAL_DIFF='git push --force-with-lease origin main' git diff`,
  // a value the rule cannot read, whatever its key
  'git -ccore.pager="$P" log',
  'git -c=core.pager="$P" log',
  'git -c core.pager="$P" log',
  'git -c user.name="$NAME" commit -m y',
  'git -c core.pager=$(cat f) log',
  'git -c core.pager=`cat f` log',
  'git -c core.pager=$P log',
  'git -c core.pager=a*b log',
  'git -c core.pager=$((1)) log',
  'git -c core.pager=${P} log',
  'export GIT_PAGER="$P"; git log',
  'GIT_EXTERNAL_DIFF=$(cat f) git diff',
  'GIT_EXTERNAL_DIFF=`cat f` git diff',
  'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0="$N" git log',
  'export GIT_PAGER; git log',
  'git grep -O"$P" x',
  'git --config-env=core.pager=SOMEVAR log',
  'git --config-env=user.email=E commit -m y',
  'git --config-env core.pager=P log',
  'P="$Q" git --config-env=core.pager=P log',
  // GIT_CONFIG_PARAMETERS is refused by name
  `GIT_CONFIG_PARAMETERS="'core.pager=${FORCED}'" git log`,
  `GIT_CONFIG_PARAMETERS="'core.pager'='${FORCED}'" git log`,
  `GIT_CONFIG_PARAMETERS="'color.ui=always'" git log`,
  `GIT_CONFIG_PARAMETERS="'color.ui'='always'" git log`,
  `GIT_CONFIG_PARAMETERS="'color.ui'='always' 'core.pager=git push --force origin main'" git log`,
  'GIT_CONFIG_PARAMETERS="$X" git log',
  `export GIT_CONFIG_PARAMETERS="'color.ui=always'"; git log`,
  'export GIT_CONFIG_PARAMETERS; git log',
  // a mention that was not recorded as an assignment
  `export GIT_PA''GER='${FORCED}'; git log`,
  `export GIT_PA\\GER='${FORCED}'; git log`,
  `read GIT_PAGER <<< '${FORCED}'; git log`,
  `printf -v GIT_PAGER %s '${FORCED}'; git log`,
  'echo "$GIT_PAGER"; git log',
  '{ export GIT_PAGER=cat; }; git log',
  'if true; then export GIT_PAGER=cat; fi; git log',
  'for i in 1; do export GIT_PAGER=cat; done; git log',
  'builtin export GIT_PAGER=cat; git log',
  'command export GIT_PAGER=cat; git log',
  'export GIT_PAGER+=cat; git log',
  'GIT_PAGER+=cat git log',
  'set -a; read -r GIT_PAGER < file; git log',
  'set -a; printf -v GIT_PAGER %s cat; git log',
  'f(){ export GIT_PAGER=cat; }; f; git log',
  'declare -n R=GIT_PAGER; export R=cat; git log',
  'git log GIT_PAGER=cat',
  'git log GIT_CONFIG_VALUE_0',
  '$CMD "$GIT_PAGER"',
  '`which tool` "$GIT_PAGER"',
  'GIT_EXTERNAL_DIFF=cat $CMD "$GIT_PAGER"',
  "echo GIT_PA''GER; git log",
  'echo GIT_PA\\GER; git log',
  `export GIT_PA''GER=cat; echo "$GIT_PAGER"; git log`,
  'export GIT_PA\\GER=cat; echo "$GIT_PAGER"; git log',
  // a path-form git, a separate-value global option, compound positions
  'env GIT_EXTERNAL_DIFF="$(cat f)" /usr/bin/git diff',
  `env GIT_PAGER='${FORCED}' ./git log`,
  './git -c core.pager="$X" log',
  'git --attr-source HEAD -c core.pager="$X" log',
  'git --attr-source HEAD grep -O"$X" x',
  'git --super-prefix sub/ -c core.pager="$X" log',
  'git -C /tmp/project-a -c core.pager="$X" log',
  `git -C /tmp/project-a grep -O'${FORCED}' x`,
  `cd /tmp/project-a && GIT_PAGER='${FORCED}' git log`,
  'cd /tmp/project-a && git -c core.pager="$P" log',
  `export GIT_PAGER='${FORCED}'; echo hi; git log`,
  // other quoting and carriers
  `GIT_PAGER="git pu"'sh -f' origin main git log`,
  `GIT_PAGER='${FORCED}'\ngit log`,
  `GIT_PAGER='${FORCED}' \\\n git log`,
  `export GIT_PAGER='${FORCED}' && git log`,
  `(export GIT_PAGER='${FORCED}'); git log`,
  `git -c core.pager='${FORCED}' log # note`,
  `git -c "core.pager=${FORCED}" log`,
  `env -u X GIT_PAGER='${FORCED}' git log`,
  `env GIT_PAGER='${FORCED}' command git log`,
  // a redirection target spelled with ANSI-C quoting hides nothing
  `GIT_PAGER=$'${FORCED_ESCAPED} >x' git log`,
  `GIT_PAGER='git pu\\\nsh -f origin main >x' git log`,
  // a substitution or here-document that runs a guarded command is caught
  `git log $(${FORCED})`,
  `git log "$(${FORCED})"`,
  `git log \`${FORCED}\``,
  `git log "\`${FORCED}\`"`,
  `git log $(echo $(${FORCED}))`,
  `git commit -F - <<EOF\n$(${FORCED})\nEOF`,
  `git commit -F - <<EOF\nrelease \`${FORCED}\`\nEOF`,
  'git log $(git -c core.pager="$X" log)',
  `echo "$(git log; ${FORCED})"`,
  // syntax the reader does not model is asked about
  'git log $"msg"',
  'git log ${x',
  'git log ${',
  'git log `',
  'git log $(',
  'git log "$(date"',
  'git log <(date)',
  'git log >(cat)',
  // an expansion with an operator is still not a configuration value the rule can read
  'git -c core.pager=${P:-cat} log',
  'GIT_PAGER="${P:-cat}" git log',
  // a guarded command inside an expansion operand or an unquoted body is caught
  `git log \${P:-$(${FORCED})}`,
  `git commit -F - <<EOF\nit's $(${FORCED})\nEOF`,
  `git commit -m "$(cat <<EOF\n$(${FORCED})\nEOF\n)"`,
  `git log "$(cat <<'EOF'\nit's\nEOF\n${FORCED})"`,
  "git log 'abc",
  'git log "abc',
  "git log $'abc",
  'git log abc\\',
  'git log >',
  'git log <<EOF\nbody',
  "git commit -F - <<'EOF'\nbody",
  `git log ${'$('.repeat(20)}date${')'.repeat(20)}`,
  // a comment or a here-document ends where the shell ends it, continuations aside
  `echo hi #x\\\n${FORCED}`,
  `cat <<'E\\'\nE\\\n${FORCED}\nE\\`,
  `cat <<"E\\\\"\nE\\\\\n${FORCED}\nE\\\\`,
  // every git word of a one-segment line has its configuration values read
  `git status; git -c core.pager='${FORCED_ESCAPED}' log # n`,
  `cat <<EOF\nx\nEOF\ngit status; git -c core.pager='${FORCED_ESCAPED}' log`,
];

const ALLOWED: string[] = [
  // readable configuration that runs nothing forced
  'git -c color.ui=always log',
  'git -c user.name=x commit -m y',
  'git log --oneline',
  'git grep -n foo',
  'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x git log',
  'P=cat git --config-env=core.pager=P log',
  "GIT_PAGER='git push origin feat' git log",
  "export GIT_PA''GER=cat; git log",
  'export GIT_PA\\GER=cat; git log',
  'git l -f origin main',
  'git log 2>&1 | GIT_PAGER=cat git log',
  'git -c core.pager=\\$P log',
  "git -c core.pager='$P' log",
  'git -c core.pager="\\$P" log',
  'git grep -e -O',
  // a mention on a line that does not run git
  'echo "$GIT_PAGER"',
  'printenv GIT_PAGER',
  'echo "$GIT_CONFIG_COUNT" "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_VALUE_0"',
  'GIT_PAGER="$X" echo hi',
  'export GIT_PAGER="$X"; echo hi',
  // a path-form git and a separate-value global option, readable
  'env GIT_PAGER=less ./git log',
  'git --attr-source HEAD -c core.pager=cat log',
  'git -C /tmp/project-a -c core.pager=cat log',
  // plain quoting and operators
  `git commit -m "don't"`,
  "git commit -m 'don'\\''t'",
  'git commit -m "fix: a (b) c"',
  'git commit -m "feat: ${scope}"',
  'git commit -m "cost \\$5"',
  'git log --format="%an <%ae>"',
  "git log --format='%an <%ae>'",
  'git log --format=%an\\ \\<%ae\\>',
  "git log --grep='a;b'",
  "git log -S'foo bar'",
  `git log 'a'"b"c`,
  'git log $HOME/x',
  'git log ${BRANCH}',
  'git log $1 $@ $? $$',
  'git log 3<&0',
  'git status\ngit log',
  'git log \\\n--oneline',
  'for f in a b; do git add $f; done',
  'if git diff --quiet; then echo ok; fi',
  `echo "it's"; git log`,
  'git log | xargs -I{} echo {}',
  'git log --format=%H | while read h; do git show $h; done',
  '(git log)',
  '{ git log; }',
  "git log -1 --date=format:'%Y-%m-%d'",
  // redirections
  'git log 2>&1',
  'git log >&2',
  'git log 2>/dev/null | head -n 3',
  "git log >'out file'",
  'git log >"out file" --oneline',
  'git log &>out',
  'git log <in',
  'git log >>out 2>&1',
  // a substitution, here-document or ANSI-C quote that runs nothing guarded
  'git commit -m "release $(date +%F), never push origin main"',
  'git commit -m "release $(date +%F)"',
  'git log $(date)',
  'git log `date`',
  'git log "$(date)"',
  'git log "`date`"',
  'git log $((1 + 1))',
  'git log -- "$(pwd)"',
  "git log $'a b'",
  'git log > $(date)',
  'GIT_PAGER=cat git log $(date)',
  '(cd /tmp/project-a && git log $(date))',
  "git commit -F - <<'EOF'\nrelease notes\nEOF",
  'git commit -F - <<EOF\nrelease $(date +%F)\nEOF',
  'git commit -F - <<-EOF\n\trelease\n\tEOF',
  "git commit -F - <<'A' -m x\nbody\nA",
  'git log <<-EOF\nx\nEOF',
  // a here-document body is literal text, in a substitution or given to git
  `git commit -m "$(cat <<'EOF'\nfix: it's done\nEOF\n)"`,
  "git log `cat <<'EOF'\nit's\nEOF\n`",
  "git commit -F- <<EOF\nit's done\nEOF",
  "git commit -F - <<'EOF'\nit's a \"test\nEOF",
  // parameter expansions with operators or subscripts, a here-string, a comment
  'git log ${x:-y}',
  'git log ${x:-a b} ${HOME:-x} ${x[0]}',
  'git log "${x%.c}" ${x%.*} ${x/a/b} "${arr[0]}" "${arr[@]}" "${x:-y}"',
  'git log ${P:-$(date)}',
  "git status # it's",
  "git log <<<'x'",
  'echo "abc',
  'echo hi #x\\\ngit log',
  'git commit -m "abc \\\ndef #3"',
  'git log --format="%h \\\n%s" # x',
];

// The shapes a git word can take, run against each carrier of a configuration value.
const GIT_SHAPES: ReadonlyArray<(args: string) => string> = [
  (args) => `git ${args}`,
  (args) => `/usr/bin/git ${args}`,
  (args) => `GIT_DIR=/repo/git git ${args}`,
  (args) => `x=/a/git git ${args}`,
  (args) => `env FOO=/a/git git ${args}`,
  (args) => `env -u /a/git git ${args}`,
  (args) => `GIT_DIR=/r/git env FOO=/a/git /usr/bin/git ${args}`,
  (args) => `cd /tmp/project-a && git ${args}`,
];

const CARRIERS: ReadonlyArray<readonly [bad: string, good: string]> = [
  ['-c core.pager="$X" log', '-c core.pager=cat log'],
  [`-c core.pager='${FORCED}' log`, '-c core.pager=less log'],
  ['--config-env=core.pager=SOMEVAR log', '-c color.ui=always log'],
  ['grep -O"$X" x', 'grep -Oless x'],
  [`grep -O'${FORCED}' x`, 'grep -n foo'],
];

for (const shape of GIT_SHAPES) {
  for (const [bad, good] of CARRIERS) {
    REFUSED.push(shape(bad));
    ALLOWED.push(shape(good));
  }
}

// The ways a value gets recorded, run against each way a line runs git; a `local` is always refused.
const RECORDING_FORMS: ReadonlyArray<
  readonly [name: string, build: (v: string, run: string) => string]
> = [
  ['leading assignment', (v, run) => `GIT_PAGER=${v} ${run}`],
  ['env prefix', (v, run) => `env GIT_PAGER=${v} ${run}`],
  ['export', (v, run) => `export GIT_PAGER=${v}; ${run}`],
  ['declare -x', (v, run) => `declare -x GIT_PAGER=${v}; ${run}`],
  ['typeset -x', (v, run) => `typeset -x GIT_PAGER=${v}; ${run}`],
  ['local', (v, run) => `f() { local GIT_PAGER=${v}; ${run}; }; f`],
  ['readonly', (v, run) => `readonly GIT_PAGER=${v}; ${run}`],
];

const RUN_SHAPES = [
  'git log',
  '/usr/bin/git log',
  'GIT_DIR=/repo/git git log',
  'env FOO=/a/git git log',
  '$G log',
  '"$G" log',
  '$(which git) log',
  "bash -c 'git log'",
  "sh -c 'git log'",
];

for (const [name, build] of RECORDING_FORMS) {
  for (const run of RUN_SHAPES) {
    REFUSED.push(build('"$X"', run), build(`'${FORCED}'`, run));
    (name === 'local' ? REFUSED : ALLOWED).push(build('cat', run));
  }
}

// A redirection next to a quote holding a configuration value: the value is still read.
const REDIRECTIONS = ['>x', '2>x', '>>x', '<x'];

const REDIRECTION_CARRIERS: ReadonlyArray<(value: string) => string> = [
  (v) => `GIT_PAGER=${v} git log`,
  (v) => `env GIT_EXTERNAL_DIFF=${v} git diff`,
  (v) => `git -c core.pager=${v} log`,
  (v) => `${TRIPLE}=${v} git log`,
  (v) => `git grep -O${v} x`,
];

const REDIRECTION_PLACES: ReadonlyArray<
  (quote: string, text: string, redirection: string) => string
> = [
  (q, text, r) => `${q}${text}${r}${q}`,
  (q, text, r) => `${q}${text} ${r}${q}`,
  (q, text, r) => `${q}${text}${q} ${r}`,
];

for (const carrier of REDIRECTION_CARRIERS) {
  for (const r of REDIRECTIONS) {
    for (const place of REDIRECTION_PLACES) {
      REFUSED.push(
        carrier(place("'", FORCED_ESCAPED, r)),
        carrier(place('"', FORCED_ESCAPED, r)),
        carrier(place('"', '$X', r)),
      );
      ALLOWED.push(carrier(place("'", 'cat', r)), carrier(place('"', 'cat', r)));
    }
    REFUSED.push(
      `${carrier(`'${FORCED_ESCAPED}'`)} ${r}`,
      `${carrier(`"${FORCED_ESCAPED}"`)} ${r}`,
      `${carrier('"$X"')} ${r}`,
    );
    ALLOWED.push(`${carrier('cat')} ${r}`);
  }
}

// A redirection target is one shell word whatever its shape.
const TARGET_SHAPES = [
  '/tmp/x',
  "'/tmp/x'",
  "/tmp/'x'/y",
  '"$T"/x',
  "out'a b'",
  `'a'"b c"'d'`,
  '$T/x',
  '"$T"',
  '$(date)',
  '`date`',
  "$'x y'",
];

const TARGET_CARRIERS: ReadonlyArray<
  readonly [forced: (r: string) => string, readable: (r: string) => string]
> = [
  [(r) => `git ${r} p\\ush -f origin main`, (r) => `git ${r} log --oneline`],
  [(r) => `git ${r} p\\ush --mirror origin`, (r) => `git ${r} log --oneline`],
  [
    (r) => `git ${r} -c core.pager='${FORCED_ESCAPED}' log`,
    (r) => `git ${r} -c core.pager=cat log`,
  ],
  [(r) => `git ${r} grep -O'${FORCED_ESCAPED}' x`, (r) => `git ${r} grep -Ocat x`],
  [(r) => `${r} GIT_PAGER="$X" $G log`, (r) => `${r} GIT_PAGER=cat git log`],
];

for (const [forced, readable] of TARGET_CARRIERS) {
  for (const target of TARGET_SHAPES) {
    for (const operator of ['>', '2>', '>>', '<']) {
      REFUSED.push(forced(`${operator}${target}`), forced(`${operator} ${target}`));
      ALLOWED.push(readable(`${operator}${target}`), readable(`${operator} ${target}`));
    }
  }
}

describe('force-push rule reads a command named in a git configuration value', () => {
  it.each(REFUSED)('refuses %s', (command) => {
    expect(refused(command)).toBe(true);
  });

  it.each(ALLOWED)('allows %s', (command) => {
    expect(allowed(command)).toBe(true);
  });
});

describe('local and readonly set a variable the rule reads', () => {
  it('refuses a local declaration inside a function', () => {
    expect(refused(`f() { local GIT_PAGER='${FORCED}'; git log; }; f`)).toBe(true);
  });

  it('refuses a readonly declaration', () => {
    expect(refused(`readonly GIT_PAGER='${FORCED}'; git log`)).toBe(true);
  });

  it('allows a readonly declaration of a readable value', () => {
    expect(allowed('readonly GIT_PAGER=cat; git log')).toBe(true);
  });

  it('refuses a local declaration of a readable value, which the rule cannot place', () => {
    expect(refused('f() { local GIT_PAGER=cat; git log; }; f')).toBe(true);
  });
});
