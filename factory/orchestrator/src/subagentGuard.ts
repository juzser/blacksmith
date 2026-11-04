// What a subagent may run.
//
// Some `bs` verbs and git operations stand for the operator's own decision, or
// for bookkeeping the dispatching session owns. The CLI attributes them by a
// free-text `--actor` (and some verbs default it to the operator), and the
// hand-back sandbox leaves a dispatched agent free to run them, so the policy
// hook decides them by who is calling. Claude Code puts `agent_id` in the hook
// input only for calls made inside a subagent (bindingReminder.ts reads it the
// same way), so the main session, where the operator types, is never in scope:
// this module is not called for it.
//
// For `bs` it is an allowlist, not a denylist: a read-only verb is allowed, a
// write verb is allowed only when a template tells a subagent to run it, and a
// verb added later is refused from subagents until someone lists it here on
// purpose. `event append` has the same shape over event types.
//
// The command is read with policy.ts's own shell reader, not matched as text:
// segments, quotes, `env`/`timeout`/`xargs` prefixes, `sh -c`, `eval`,
// substitutions, `{ }` groups, `if`/`then` bodies, `find -exec` are walked the
// way the force-push rule walks them. A word in command or flag position that
// the reader cannot resolve, on a line that names `bs`, `cli` or a protected
// ref, is refused: the reader cannot say what the line runs.
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isOperatorActor } from './actors.js';
import {
  baseName,
  commandStart,
  type DequotedWord,
  gitSubcommandWord,
  isShellCommandFlag,
  isShellWord,
  joinLineContinuations,
  ROUGH_SEPARATOR_RE,
  readShellWords,
  redirectTargets,
  type SplitWords,
  splitEnvCommand,
  splitTopLevelCommands,
  splitValueWords,
  walkPrefixWords,
  XARGS_VALUE_OPTIONS,
} from './policy.js';

export interface SubagentRefusal {
  readonly ruleId: string;
  readonly reason: string;
}

export interface SubagentContext {
  /** Where the tool call runs; relative paths in a command resolve against it. */
  readonly cwd?: string;
  /** True when `file` lies inside the linked git worktree the subagent works in. */
  readonly inOwnWorktree?: (file: string) => boolean;
  /** Real paths of directories that hold the code the hook runs from; writes into them are refused. */
  readonly protectedDirs?: readonly string[];
  /** The branch checked out in `dir`, or `''` when it cannot be read. */
  readonly branchAt?: (dir: string) => string;
}

const MAIN_SESSION = 'The operator runs this from the main session.';

const refuse = (ruleId: string, what: string): SubagentRefusal => ({
  ruleId,
  reason: `${ruleId}: ${what} ${MAIN_SESSION}`,
});

/**
 * Read-only `bs` verbs (`<namespace> <action>`, or a bare namespace), allowed
 * from a subagent. A trailing ` *` allows every action of the namespace.
 */
export const SUBAGENT_BS_READ_ONLY: readonly string[] = [
  'doctor',
  'init',
  'stats *',
  'plan validate',
  'plan diff',
  'plan proposals',
  'wave check',
  'wave schedule',
  'wave audit',
  'mcp check',
  'research check',
  'daemon status',
  'projects list',
  'worktree fingerprint',
  'worktree verify',
  'worktree stale',
  'event tail',
  'event lineage',
  'prompt wrap',
  'claims check',
  'claims impact',
  'dispatch check',
  'dispatch lint',
  'tester check',
  'delegation check',
  'escalation check',
  'effort show',
  'security triggers',
  'issues preview',
  'harness list',
  'harness plan',
  'sandbox status',
  'stack show',
  'stack check',
  'policy check',
  'results check',
  'uiux check',
  'coverage check',
  'budget alarm',
  'kpi same-mistake',
  'checks ledger',
  'checks proposals',
  'epic verdict',
  'epic width',
  'epic goal',
  'findings for-dispatch',
  'findings list',
  'waivers pending',
  'lessons candidates',
  'lessons for-dispatch',
  'lessons audit',
  'brief compose',
  'playbook slice',
  'heavy status',
  'heavy wait',
  'judge outstanding',
  'judge escalations',
  'judge preflight',
  'feedback pending',
  'report export',
];

/**
 * Write verbs a template tells a subagent to run, each backed by the line that
 * instructs it (subagentGuardAllowlist.test.ts names the file and the line).
 * A verb a template only mentions, or hands to the operator or the epic
 * session (`plan approve`, `plan amend`, `epic goal-check`, `epic
 * spec-review`, `agents sync`, `wave next`, `lessons compile`, `audit
 * record`, `integration check`), is not here. The flags that make a run
 * operator-attributed (`--actor`, `--decided-by`) are refused for every one of
 * them.
 */
export const SUBAGENT_BS_WRITE_ALLOW: readonly string[] = [
  'event append',
  'findings transition',
  'gate run',
  'heavy run',
  'issues report',
  'judge dispatch',
  'judge report',
  'plan propose',
  'queue run',
  'results record',
  'session start',
  'worktree create',
];

/**
 * Event types a subagent may append by hand. Everything else (the operator's
 * decisions and answers, `wave-merged`, `subagent-started`, `subagent-stopped`,
 * `advisory-finding-reproduced`, and any type added later) is refused. These
 * are the types `wave.md`, `dispatch.md` and the agent templates have a
 * subagent write with `event append`.
 */
export const SUBAGENT_EVENT_ALLOW: readonly string[] = [
  'dispatch_decision',
  'error-logged',
  'task-added',
  'task-result-recorded',
];

/** Flags whose value names who decided; an operator value is refused. */
const ATTRIBUTION_FLAGS = ['actor', 'decided-by'];
const HELP_WORDS = new Set(['help', '--help', '-h', '--version', '-V']);

const MAX_DEPTH = 16;
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'fixtures', '__fixtures__', 'testdata']);

/** The path of a CLI script that is the `bs` entry point. */
const CLI_SCRIPT_RE =
  /(?:^|\/)dist\/cli(?:\.[cm]?js)?$|(?:^|\/)orchestrator\/(?:src|dist)\/cli(?:\.[cm]?[jt]s)?$/;
const BS_NAMES = new Set(['bs', 'smith']);
const PACKAGE_RE = /^@juzser\/blacksmith(?:@.*)?$/;
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const PACKAGE_RUNNER_SUBCOMMANDS = new Set(['exec', 'dlx', 'x', 'run']);
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
/** Options of node and package runners that take the next word as their value. */
const VALUE_OPTIONS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '-p',
  '--package',
  '-C',
  '--prefix',
]);

/** Words on a line that make a word the reader cannot resolve worth refusing. */
const MENTION_RE =
  /(?:^|[^A-Za-z0-9_-])(?:bs|smith|cli)(?:\.[cm]?[jt]s)?(?![A-Za-z0-9_-])|update-ref|refs\/bs|\bmain\b|\bmaster\b|integration/;

/** Names of operator-owned paths: a line that holds one is one a computed command word is refused on. */
const PATH_MENTION_RE =
  /\.blacksmith|state\/(?:events|sandboxes)|crosscheck|factory\/(?:policies|orchestrator)|\.claude\/|hooks\/|\.git\/|packed-refs|@juzser/;
/** A command word that is a bare variable, which a line with nothing protected in it may use (`"$PYTHON" -m …`). */
const BARE_VARIABLE_RE = /^\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})$/;

/** Shell syntax words after which a new command starts. */
const SYNTAX_WORDS = new Set(['{', '}', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until']);
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);
/** Commands that run a command given among their own words: every suffix of the call is read as a command. */
const WRAPPERS = new Set(['script', 'watch', 'parallel', 'coproc', 'case', 'select', 'xargs']);

/** Words that make an unreadable line worth refusing: `bs` itself or the factory's own refs. */
const BS_RE =
  /(?:^|[^A-Za-z0-9_-])(?:bs|smith|cli)(?:\.[cm]?[jt]s)?(?![A-Za-z0-9_-])|update-ref|refs\/bs/;

const unresolved = (text: string): boolean => /[$`]/.test(text);

interface Scan {
  readonly calls: Array<readonly DequotedWord[]>;
  readonly unreadable: string[];
}

function collect(command: string, depth: number, out: Scan): void {
  if (depth > MAX_DEPTH) {
    out.unreadable.push(command);
    return;
  }
  const joined = joinLineContinuations(command);
  const top = splitTopLevelCommands(joined);
  // A line the top-level split cannot read is also split at every separator, so
  // a command after a heredoc or comment is still looked at.
  const segments = top === null ? [joined, ...joined.split(ROUGH_SEPARATOR_RE)] : top;
  for (const segment of segments) {
    const words = readShellWords(segment, (body) => {
      collect(body, depth + 1, out);
      return true;
    });
    if (words === null) {
      out.unreadable.push(segment);
      continue;
    }
    const starts = [0];
    words.forEach((word, i) => {
      if (SYNTAX_WORDS.has(word.text)) starts.push(i + 1);
    });
    for (const start of starts) consider(words.slice(start), depth, out);
  }
}

function consider(words: readonly DequotedWord[], depth: number, out: Scan): void {
  const call = resolveCommand(words);
  if (call.length === 0) return;
  out.calls.push(call);
  const name = baseName(call[0]?.text);
  if (isShellWord(name)) {
    const flag = call.findIndex((w, i) => i > 0 && isShellCommandFlag(w.text));
    const payload = flag === -1 ? undefined : call[flag + 1];
    if (payload) collect(payload.text, depth + 1, out);
  } else if (name === 'eval') {
    collect(
      call
        .slice(1)
        .map((w) => w.text)
        .join(' '),
      depth + 1,
      out,
    );
  } else if (WRAPPERS.has(name)) {
    for (let i = 1; i < call.length; i += 1) {
      const word = (call[i] as DequotedWord).text;
      // A word with blanks may be a whole command line (`script -c "..."`).
      if (/\s/.test(word)) collect(word, depth + 1, out);
      if (!unresolved(word) && !word.startsWith('-')) consider(call.slice(i), depth + 1, out);
    }
  } else if (name === 'find') {
    call.forEach((word, i) => {
      if (!FIND_EXEC.has(word.text)) return;
      const rest = call.slice(i + 1);
      const end = rest.findIndex((w) => w.text === ';' || w.text === '+');
      consider(end === -1 ? rest : rest.slice(0, end), depth, out);
    });
  }
}

/** The words of the command a segment runs, past assignments, `env`, prefix words and `xargs`. */
/** Calls whose arguments xargs completes from input the guard cannot read. */
const viaXargs = new WeakSet<readonly DequotedWord[]>();

function resolveCommand(start: readonly DequotedWord[]): readonly DequotedWord[] {
  let sawXargs = false;
  const budget = { left: 64, exceeded: false };
  const split: SplitWords = (all, from) => splitEnvCommand(all, from, budget, splitValueWords);
  let words = split(start, 0);
  let index = commandStart(words);
  for (let guard = 0; guard < 16; guard += 1) {
    const walked = walkPrefixWords(words, index, split, false);
    words = walked.words;
    index = walked.index;
    if (baseName(words[index]?.text) !== 'xargs') break;
    sawXargs = true;
    index += 1;
    while (index < words.length && (words[index]?.text ?? '').startsWith('-')) {
      index += XARGS_VALUE_OPTIONS.has(words[index]?.text ?? '') ? 2 : 1;
    }
    words = split(words, index);
    index = commandStart(words, index);
  }
  const call = words.slice(index);
  if (sawXargs) viaXargs.add(call);
  return call;
}

/** Skips option words (and the values of the ones that take one); returns the index of the first operand. */
function skipOptions(texts: readonly string[], from: number): number {
  let i = from;
  while (i < texts.length && (texts[i] as string).startsWith('-')) {
    i += VALUE_OPTIONS.has(texts[i] as string) ? 2 : 1;
  }
  return i;
}

/** The arguments a `bs` invocation carries, or `null` when the command is not one. */
function bsArguments(call: readonly DequotedWord[], line: string): string[] | null {
  const texts = call.map((w) => w.text);
  const first = texts[0] ?? '';
  const name = baseName(first);
  if (BS_NAMES.has(name) || CLI_SCRIPT_RE.test(first)) return texts.slice(1);
  if (name === 'node' || name === 'tsx' || name === 'bun') {
    const i = skipOptions(texts, 1);
    const script = texts[i] ?? '';
    // A bare `cli.js` counts only on a line that also names the factory's build.
    const bare = /^cli(?:\.[cm]?[jt]s)?$/.test(script) && /orchestrator|dist|blacksmith/.test(line);
    return CLI_SCRIPT_RE.test(script) || bare ? texts.slice(i + 1) : null;
  }
  let i: number;
  if (PACKAGE_RUNNERS.has(name)) i = skipOptions(texts, 1);
  else if (PACKAGE_MANAGERS.has(name)) {
    i = skipOptions(texts, 1);
    if (PACKAGE_RUNNER_SUBCOMMANDS.has(texts[i] ?? '')) i = skipOptions(texts, i + 1);
  } else return null;
  const target = texts[i] ?? '';
  if (BS_NAMES.has(baseName(target))) return texts.slice(i + 1);
  if (PACKAGE_RE.test(target)) {
    const next = texts[i + 1] ?? '';
    return texts.slice(i + (BS_NAMES.has(next) ? 2 : 1));
  }
  return null;
}

/** Every value given to `--name` or `--name=value` in `args`. */
function flagValues(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  args.forEach((arg, i) => {
    if (arg === `--${name}`) values.push(args[i + 1] ?? '');
    else if (arg.startsWith(`--${name}=`)) values.push(arg.slice(name.length + 3));
  });
  return values;
}

function inList(list: readonly string[], namespace: string, key: string): boolean {
  return list.includes(key) || list.includes(`${namespace} *`);
}

function checkBs(args: readonly string[]): SubagentRefusal | null {
  const namespace = args[0] ?? '';
  if (namespace === '' || HELP_WORDS.has(namespace)) return null;
  const second = args[1];
  const action = second !== undefined && !second.startsWith('--') ? second : undefined;
  const key = action === undefined ? namespace : `${namespace} ${action}`;
  const verb = `bs ${key}`;
  for (const flag of ATTRIBUTION_FLAGS) {
    const values = flagValues(args, flag);
    if (values.some((v) => unresolved(v))) {
      return refuse(
        'subagent-operator-actor',
        `the value of --${flag} is computed here, so the guard cannot tell whether it names the operator; write it out plainly.`,
      );
    }
    if (values.some((v) => isOperatorActor(v))) {
      return refuse(
        'subagent-operator-actor',
        `this command is attributed to the operator (--${flag} operator/user), which is refused inside a subagent.`,
      );
    }
  }
  if (unresolved(namespace) || (action !== undefined && unresolved(action))) {
    return refuse(
      'subagent-operator-verb',
      'the `bs` verb here is computed, so the guard cannot tell which verb runs; write it out plainly.',
    );
  }
  if (args.some((a) => a.startsWith('-') && unresolved(a))) {
    return refuse(
      'subagent-operator-verb',
      `a flag of \`${verb}\` is computed here, so the guard cannot read it; write it out plainly.`,
    );
  }
  if (key === 'event append') return checkEventAppend(args.slice(2));
  if (key === 'session start' && flagValues(args, 'actor').length === 0) {
    return refuse(
      'subagent-operator-actor',
      '`bs session start` without --actor records the operator as the actor; pass an explicit --actor naming your role.',
    );
  }
  if (inList(SUBAGENT_BS_READ_ONLY, namespace, key)) return null;
  if (SUBAGENT_BS_WRITE_ALLOW.includes(key)) return null;
  return refuse(
    'subagent-operator-verb',
    `\`${verb}\` is not a verb a subagent runs: it stands for the operator's own decision, or for bookkeeping the dispatching session owns, or no template hands it to a subagent.`,
  );
}

function checkEventAppend(rest: readonly string[]): SubagentRefusal | null {
  let json: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i] as string;
    if (word.startsWith('--')) {
      if (!word.includes('=')) i += 1;
      continue;
    }
    json = word.trim();
    break;
  }
  const unreadable = (why: string) =>
    refuse(
      'subagent-owned-event',
      `\`bs event append\` ${why}, so the guard cannot tell which event type it writes; write the JSON out plainly as the argument.`,
    );
  if (json === undefined) return unreadable('takes its JSON from elsewhere (stdin or a pipe)');
  if (!json.startsWith('{')) return unreadable('has an argument that is not a literal JSON object');
  let type: unknown;
  let actor: unknown;
  let payload: unknown;
  let parsedOk = false;
  try {
    const parsed = JSON.parse(json) as { event_type?: unknown; actor?: unknown; payload?: unknown };
    type = parsed.event_type;
    actor = parsed.actor;
    payload = parsed.payload;
    parsedOk = true;
  } catch {
    type = /"event_type"\s*:\s*"([^"]*)"/.exec(json)?.[1];
    actor = /"actor"\s*:\s*"([^"]*)"/.exec(json)?.[1];
  }
  if (isOperatorActor(actor as string | undefined)) {
    return refuse(
      'subagent-operator-actor',
      'this event is attributed to the operator ("actor":"operator"/"user"), which is refused inside a subagent.',
    );
  }
  if (typeof type !== 'string' || type === '')
    return unreadable('has JSON without a readable event_type');
  if (!SUBAGENT_EVENT_ALLOW.includes(type)) {
    return refuse(
      'subagent-owned-event',
      `\`bs event append\` of a "${type}" event is not one a subagent writes by hand: it stands for the operator's decision or the dispatching session's bookkeeping.`,
    );
  }
  const shape = checkEventPayload(type, payload, parsedOk);
  if (shape !== null) {
    return refuse(
      'subagent-owned-event',
      `\`bs event append\` of a "${type}" event ${shape}; the projector reads that field as the task's status or attribution.`,
    );
  }
  return null;
}

/** Payload fields the projector reads as `task-added` identity and wording; `claims`, budget, branch and origin are not among them. */
const TASK_ADDED_KEYS = new Set([
  'task_status',
  'epic_id',
  'plan_version',
  'title',
  'objective',
  'summary',
]);

/**
 * The shapes of the allowed event types that do not move a task's status or
 * attribution. `task-added` is the shape `wave.md` uses to mark a failed task
 * (`task_status: failed`, no claims); `error-logged` never escalates (a
 * `coordination.*` class is terminal); `task-result-recorded` only reports a
 * dead dispatch (a `done` result closes an audit turn as completed).
 * Returns what is wrong, or `null`.
 */
function checkEventPayload(type: unknown, payload: unknown, parsedOk: boolean): string | null {
  const restricted =
    type === 'task-added' || type === 'error-logged' || type === 'task-result-recorded';
  if (!restricted) return null;
  if (!parsedOk) return 'has JSON the guard cannot parse, so it cannot read the payload';
  const p = (payload !== null && typeof payload === 'object' ? payload : {}) as Record<
    string,
    unknown
  >;
  if (type === 'task-added') {
    const extra = Object.keys(p).filter((k) => !TASK_ADDED_KEYS.has(k));
    if (p.task_status !== 'failed') return 'does not carry task_status "failed"';
    if (extra.length > 0) return `carries ${extra.join(', ')}`;
    return null;
  }
  if (type === 'error-logged') {
    const cls = typeof p.error === 'string' ? p.error : '';
    return cls.startsWith('coordination.')
      ? 'names a coordination.* error, which escalates the task'
      : null;
  }
  return p.run_status === 'dead' ? null : 'does not report run_status "dead"';
}

const refName = (operand: string): string =>
  operand.replace(/^\+/, '').replace(/^refs\/heads\//, '');
const isBsRef = (operand: string): boolean => /^\+?refs\/bs\//.test(operand);
/** A ref the factory owns: main, master, an integration branch, or refs/bs/*. */
const isProtectedRef = (operand: string): boolean => {
  const name = refName(operand);
  return (
    isBsRef(operand) ||
    name === 'main' ||
    name === 'master' ||
    name === 'integration' ||
    name.endsWith('/integration')
  );
};
const destOf = (spec: string): string | null => {
  const colon = spec.lastIndexOf(':');
  return colon === -1 ? null : spec.slice(colon + 1);
};

const refRefusal = (what: string) =>
  refuse(
    'subagent-git-ref',
    `${what} changes a ref the factory owns (main, master, an integration branch or refs/bs/*), and is refused inside a subagent.`,
  );

function checkGit(
  call: readonly DequotedWord[],
  mentioned: boolean,
  cwd?: string,
  branchAt?: (dir: string) => string,
): SubagentRefusal | null {
  const sub = gitSubcommandWord(call, 0);
  if (sub === -1) return null;
  const subcommand = call[sub]?.text ?? '';
  if (unresolved(subcommand)) {
    if (!mentioned) return null;
    return refuse(
      'subagent-git-ref',
      'the git subcommand here is computed, so the guard cannot tell whether it changes a ref the factory owns; write it out plainly.',
    );
  }
  const args = call.slice(sub + 1).map((w) => w.text);
  const flags = args.filter((a) => a.startsWith('-'));
  const operands = args.filter((a) => !a.startsWith('-'));
  const shorts = flags.filter((a) => /^-[A-Za-z]+$/.test(a)).join('');
  const long = (name: string) => flags.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  const check = (targets: readonly string[], what: string): SubagentRefusal | null => {
    if (targets.some((t) => unresolved(t))) {
      return refuse(
        'subagent-git-ref',
        `${what} names a ref that is computed here, so the guard cannot tell whether it is one the factory owns; write it out plainly.`,
      );
    }
    return targets.some(isProtectedRef) ? refRefusal(what) : null;
  };
  switch (subcommand) {
    case 'update-ref': {
      if (flags.includes('--stdin')) return refRefusal('`git update-ref --stdin`');
      const at = args.findIndex((a, i) => !a.startsWith('-') && args[i - 1] !== '-m');
      return check(at === -1 ? [] : [args[at] as string], '`git update-ref`');
    }
    case 'branch': {
      if (/r/.test(shorts) || long('remotes')) return null;
      const del = /[dD]/.test(shorts) || long('delete');
      const move = /[mM]/.test(shorts) || long('move');
      const copy = /[cC]/.test(shorts) || long('copy');
      const force = /f/.test(shorts) || long('force');
      const targets = del
        ? operands
        : move
          ? operands.slice(0, 2)
          : copy
            ? operands.slice(-1)
            : force
              ? operands.slice(0, 1)
              : [];
      return check(targets, '`git branch` with force, delete, move or copy');
    }
    case 'checkout':
      return /B/.test(shorts) ? check(operands.slice(0, 1), '`git checkout -B`') : null;
    case 'switch':
      return /C/.test(shorts) || long('force-create')
        ? check(operands.slice(0, 1), '`git switch -C`')
        : null;
    case 'worktree': {
      if (operands[0] !== 'add' || !/B/.test(shorts)) return null;
      const at = args.findIndex((a) => /^-[A-Za-z]*B$/.test(a));
      return check(at === -1 ? [] : [args[at + 1] ?? ''], '`git worktree add -B`');
    }
    case 'commit':
    case 'merge':
    case 'reset':
    case 'rebase':
    case 'cherry-pick':
    case 'revert':
    case 'pull':
    case 'am': {
      const dash = call.findIndex((w) => w.text === '-C');
      const dir = dash === -1 ? cwd : path.resolve(cwd ?? '/', call[dash + 1]?.text ?? '');
      const branch = dir === undefined ? '' : (branchAt?.(dir) ?? '');
      return branch !== '' && isProtectedRef(branch)
        ? refRefusal(`\`git ${subcommand}\` inside the worktree of ${branch}`)
        : null;
    }
    case 'symbolic-ref':
      return check(operands.slice(1, 2), '`git symbolic-ref`');
    case 'fetch':
    case 'push': {
      const remote = operands[0] ?? '';
      const local = subcommand === 'push' ? remote === '.' || /[/:\\]/.test(remote) : true;
      if (!local) return null;
      const specs = operands.slice(1);
      const dests =
        subcommand === 'push' && long('delete')
          ? specs
          : specs.map(destOf).filter((d): d is string => d !== null);
      return check(dests, `\`git ${subcommand}\` into a local ref`);
    }
    default:
      return null;
  }
}

const normalize = (p: string): string => path.posix.normalize(p.replace(/\\/g, '/'));
const REF_PATH_RE =
  /(?:^|\/)\.git\/(?:packed-refs$|refs\/bs(?:\/|$)|refs\/heads\/(?:main|master)$|refs\/heads\/(?:.*\/)?integration$)/;
const STATE_PATH_RE = /(?:^|\/)state\/(?:events\/[^/]+\.jsonl(?:\.lock)?|sandboxes\/[^/]+\.json)$/;
/**
 * The operator's configuration under a work root. In a plugin install the
 * specs a planner writes live under `.blacksmith/factory/specs/active/`, so
 * only the policies and the roadmap are protected there.
 */
const OVERLAY_PATH_RE =
  /(?:^|\/)\.blacksmith\/(?:[^/]+\.(?:ya?ml|json)|factory\/policies\/.+|factory\/specs\/roadmap\.md)$/;
const POLICY_PATH_RE = /(?:^|\/)factory\/policies\/[^/]+\.(?:ya?ml|md)$/;
/** The guard's own files: hook scripts and registrations, settings, agent and skill templates. */
const GUARD_PATH_RE =
  /(?:^|\/)(?:\.claude\/(?:hooks\/.+|settings[^/]*\.json|agents\/[^/]+\.md|skills\/.+)|hooks\/(?:hooks\.json|[^/]+\.sh)|factory\/orchestrator\/dist\/.+)$/;
/** An installed copy of the package: the hook a plugin install runs lives in it. */
const INSTALLED_PACKAGE_RE = /(?:^|\/)node_modules\/@juzser\/blacksmith\/.+/;
/**
 * A test or fixtures directory below the repository the path is in. The repo
 * is the nearest ancestor holding a `.git`; a segment above it does not count,
 * so a project kept under `~/tests/` is not exempt. Outside any repo there is
 * nothing to anchor on and any such segment counts.
 */
function isTestPath(p: string): boolean {
  let dir = path.posix.dirname(p);
  while (!existsSync(dir) && dir !== path.posix.dirname(dir)) dir = path.posix.dirname(dir);
  let top: string | null = null;
  for (let d = dir; ; d = path.posix.dirname(d)) {
    if (existsSync(path.posix.join(d, '.git'))) {
      top = d;
      break;
    }
    if (d === path.posix.dirname(d)) break;
  }
  const below = top === null ? p : p.slice(top.length);
  return below.split('/').some((seg) => TEST_DIRS.has(seg));
}
const isWorktreePath = (p: string): boolean => /\/(?:\.claude\/worktrees|\.wt)\//.test(p);

/** `file` made absolute against `cwd`, with symlinks resolved as far up as the path exists. */
function realPath(file: string, cwd?: string): string {
  const abs = path.resolve(cwd ?? '/', file);
  const rest: string[] = [];
  let dir = abs;
  for (;;) {
    try {
      return path.join(realpathSync(dir), ...[...rest].reverse());
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return abs;
      rest.push(path.basename(dir));
      dir = parent;
    }
  }
}

type Owned = { ruleId: string; what: string };

function classify(p: string, worktreeExempt: boolean, testExempt: boolean): Owned | null {
  if (REF_PATH_RE.test(p)) {
    return { ruleId: 'subagent-git-ref', what: 'changes a ref file the factory owns' };
  }
  if (testExempt) return null;
  if (STATE_PATH_RE.test(p)) {
    return { ruleId: 'subagent-state-write', what: 'edits an event log or lease the CLI owns' };
  }
  if (INSTALLED_PACKAGE_RE.test(p)) {
    return {
      ruleId: 'subagent-config-write',
      what: 'edits an installed copy of the package the hook runs from',
    };
  }
  if (OVERLAY_PATH_RE.test(p)) {
    return { ruleId: 'subagent-config-write', what: "edits the operator's configuration" };
  }
  if (worktreeExempt) return null;
  if (POLICY_PATH_RE.test(p)) {
    return { ruleId: 'subagent-config-write', what: "edits the operator's policy files" };
  }
  if (GUARD_PATH_RE.test(p)) {
    return {
      ruleId: 'subagent-config-write',
      what: "edits the guard's own files, templates or settings",
    };
  }
  return null;
}

/**
 * A path the CLI or the operator owns: a protected ref file, an event log or
 * lease, an operator config file, the guard's own files. Judged on the path as
 * written and on the path with its symlinks resolved, so a link into a
 * protected directory does not hide it.
 */
function checkOwnedPath(file: string, ctx: SubagentContext): SubagentRefusal | null {
  const raw = normalize(ctx.cwd === undefined ? file : path.resolve(ctx.cwd, file));
  const real = normalize(realPath(file, ctx.cwd));
  const worktreeExempt = isWorktreePath(real) || (ctx.inOwnWorktree?.(real) ?? false);
  const testExempt = isTestPath(raw) && isTestPath(real);
  const inBuild = (ctx.protectedDirs ?? []).some((d) => real === d || real.startsWith(`${d}/`));
  const hit = inBuild
    ? { ruleId: 'subagent-config-write', what: 'edits the build the hook runs from' }
    : (classify(raw, worktreeExempt, testExempt) ?? classify(real, worktreeExempt, testExempt));
  if (hit === null) return null;
  return refuse(hit.ruleId, `a write to "${file}" ${hit.what}, and is refused inside a subagent.`);
}

/** Commands that write to a path they are given; `writeTargets` names which words are written. */
export const SUBAGENT_WRITE_COMMANDS: readonly string[] = [
  'cp',
  'mv',
  'ln',
  'install',
  'rsync',
  'tee',
  'rm',
  'touch',
  'truncate',
  'dd',
  'tar',
  'unzip',
  'curl',
  'wget',
  'patch',
  'sed',
  'perl',
  'awk',
  'gawk',
  'git',
];
const TARGET_DIR_FLAGS = new Set(['-t', '--target-directory', '-C', '--directory', '-d']);
const OUTPUT_FLAGS = new Set([
  '-o',
  '-O',
  '--output',
  '-P',
  '--directory-prefix',
  '--output-document',
]);

/** The words of a write-capable command that name a path it writes. */
function writeTargets(call: readonly DequotedWord[]): string[] {
  const name = baseName(call[0]?.text);
  const words = call.slice(1).map((w) => w.text);
  const operands = words.filter((w) => !w.startsWith('-'));
  const flagValue = (names: ReadonlySet<string>): string[] =>
    words.flatMap((w, i) => {
      if (names.has(w)) return [words[i + 1] ?? ''];
      const eq = w.indexOf('=');
      return w.startsWith('--') && eq !== -1 && names.has(w.slice(0, eq)) ? [w.slice(eq + 1)] : [];
    });
  switch (name) {
    case 'cp':
    case 'ln':
    case 'install':
    case 'rsync':
    case 'mv': {
      const dirs = flagValue(TARGET_DIR_FLAGS);
      const target = dirs[0] ?? operands.at(-1);
      const sources = dirs.length > 0 ? operands : operands.slice(0, -1);
      // When the target is a directory the file lands at <dir>/<name of the source>.
      const into =
        target === undefined
          ? []
          : sources.map((o) => path.posix.join(target, path.posix.basename(o)));
      return [...dirs, ...(name === 'mv' ? operands : operands.slice(-1)), ...into];
    }
    case 'tee':
    case 'rm':
    case 'touch':
    case 'truncate':
      return operands;
    case 'dd':
      return words.filter((w) => w.startsWith('of=')).map((w) => w.slice(3));
    case 'tar':
      return flagValue(TARGET_DIR_FLAGS);
    case 'unzip':
      return flagValue(TARGET_DIR_FLAGS);
    case 'curl':
    case 'wget':
      return flagValue(OUTPUT_FLAGS);
    case 'patch':
      return operands;
    case 'sed':
    case 'perl':
    case 'awk':
    case 'gawk':
      return words.some((w) => /^-[A-Za-z]*i|^-i|inplace/.test(w)) ? operands : [];
    case 'git': {
      const at = words.findIndex((w) => w === 'checkout' || w === 'restore');
      if (at === -1) return [];
      const rest = words.slice(at + 1);
      const dashdash = rest.indexOf('--');
      return dashdash !== -1
        ? rest.slice(dashdash + 1)
        : words[at] === 'restore'
          ? rest.filter((w) => !w.startsWith('-'))
          : [];
    }
    default:
      return [];
  }
}

/**
 * The refusal for a tool call made inside a subagent, or `null` to leave the
 * call to the other rules. The caller invokes this only when the hook input
 * carries `agent_id`.
 */
export function subagentRefusal(
  toolName: string,
  command: string,
  filePath: string | null,
  ctx: SubagentContext = {},
): SubagentRefusal | null {
  if (toolName !== 'Bash') {
    return filePath === null || filePath.trim() === '' ? null : checkOwnedPath(filePath, ctx);
  }
  if (command.trim() === '') return null;
  const scan: Scan = { calls: [], unreadable: [] };
  collect(command, 0, scan);
  // `cd <dir>` moves where later relative paths and branch reads point.
  let cwd = ctx.cwd;
  const cwds = new Set<string | undefined>([cwd]);
  for (const call of scan.calls) {
    const first = call[0]?.text ?? '';
    const name = baseName(first);
    // A bare variable (`"$PYTHON" -m …`) passes on a line that names nothing protected.
    if (
      unresolved(name) &&
      (!BARE_VARIABLE_RE.test(first) || MENTION_RE.test(command) || PATH_MENTION_RE.test(command))
    ) {
      return refuse(
        'subagent-operator-verb',
        'the command word here is computed, so the guard cannot tell what it runs; write the command out plainly.',
      );
    }
    if (name === 'cd' && call[1] !== undefined && !unresolved(call[1].text) && cwd !== undefined) {
      cwd = path.resolve(cwd, call[1].text);
      cwds.add(cwd);
    }
    const args = bsArguments(call, command);
    const found =
      args !== null
        ? checkBs(args)
        : name.toLowerCase() === 'git'
          ? checkGit(call, MENTION_RE.test(command), cwd, ctx.branchAt)
          : null;
    if (found) return found;
    if (args !== null && viaXargs.has(call)) {
      return refuse(
        'subagent-operator-verb',
        'this `bs` command is completed by xargs from input the guard cannot read, so it cannot tell which verb runs; write the command out plainly.',
      );
    }
    if (SUBAGENT_WRITE_COMMANDS.includes(name)) {
      for (const target of writeTargets(call)) {
        // A target may be a directory the command writes into, so a file in it is judged too.
        const owned =
          checkOwnedPath(target, { ...ctx, cwd }) ??
          checkOwnedPath(path.posix.join(target, '_'), { ...ctx, cwd });
        if (owned) return owned;
      }
    }
  }
  for (const target of redirectTargets(command)) {
    for (const dir of cwds) {
      const owned = checkOwnedPath(target, { ...ctx, cwd: dir });
      if (owned) return owned;
    }
  }
  if (scan.unreadable.some((text) => BS_RE.test(text))) {
    return refuse(
      'subagent-operator-verb',
      "this line uses shell syntax the guard does not read and names `bs`, `cli` or a protected ref, so it cannot tell whether it is one of the operator's verbs; write the command out plainly.",
    );
  }
  return null;
}
