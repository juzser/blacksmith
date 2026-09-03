/**
 * What `smith` can be asked to do, written down once (P9-21).
 *
 * Before this, `smith` and `smith --help` both answered
 * `{"error":{"message":"Unknown command: "}}`, so the only way to learn a
 * command's argument shape was to read cli.ts or SKILL.md — and the usage
 * strings that DID exist were literals typed at each call site of
 * requirePositionals, invisible until you had already made the mistake.
 *
 * This table is the single register. cli.ts reads its usage lines from here
 * instead of retyping them, prints it for `--help`, and refuses a command it
 * does not contain before dispatch — which makes "documented ⊇ reachable"
 * structural. test/usage.test.ts parses cli.ts's dispatcher and asserts the
 * reverse inclusion, so a new command cannot be dispatched without a line
 * describing it.
 *
 * It lives here, not in cli.ts, because cli.ts calls main() at import time:
 * anything declared there can only be tested by running the binary.
 */
import { SmithError } from './errors.js';

export interface CommandDoc {
  /** The dispatch key: `<namespace> <action>`, or a bare namespace for the action-less verbs. */
  command: string;
  /** Set only where one command has two argument shapes (`claims check`), to key them apart. */
  form?: string;
  /**
   * The positional placeholders, and nothing else. requirePositionals counts
   * the `<placeholders>` here and demands one argument each, so a flag's value
   * placeholder living in this field would make it demand a positional that
   * does not exist — which is why `worktree verify --before <fingerprint.json>`
   * used to need a `required: 1` override to stay honest.
   */
  positionals: string;
  /**
   * The flag shape, and since D-132 the parser's source of truth as well:
   * `flagsOf` reads a `<placeholder>` here as "this flag carries a value",
   * which is what keeps `smith mcp check --verbose envkit` from eating its
   * own positional. A value written any other way is one the parser cannot
   * see — `[--run-all false]` declared a flag that took nothing and a
   * positional nobody wanted (D-192), so a documented value belongs in
   * angle brackets even when the choices are as small as `<true|false>`.
   */
  flags: string;
  summary: string;
}

/** The event-writing flags shared by every command that appends to a session log. */
const EVENTS = '--session <id> --causal-parent <event-id> [--plan-version <n>] [--actor <name>]';
/** …plus the state-dir override, on the commands whose module accepts EventOpts. */
const EVENTS_DIR = `${EVENTS} [--state-dir <dir>]`;
/** Every `stats` page reads the same projection. */
const STATS = '[--db <file>] [--session <id>]';

export const COMMANDS: readonly CommandDoc[] = [
  {
    command: 'plan validate',
    positionals: '<plan.json>',
    flags: '',
    summary: 'Check a plan against the task schema, the taxonomy, and the edge DAG. Exit 1 on red.',
  },
  {
    command: 'plan diff',
    positionals: '<plan-a.json> <plan-b.json>',
    flags: '',
    summary: 'Report which tasks were added, removed, superseded, or carried between two versions.',
  },
  {
    command: 'plan quorum',
    positionals: '',
    flags:
      '--epic <id> --plan-version <n> --session <id> --causal-parent <event-id> [--confidence <0-1>] [--actor <name>] [--state-dir <dir>]',
    summary: 'Critique-only review of a drafted plan. Exit 1 means the operator must look first.',
  },
  {
    command: 'plan amend',
    positionals: '',
    flags: `--plan <plan.json> --findings <id[,id...]> --rationale <text> --sites <path[,path...]> [--changes <changes.json>] [--specs-dir <dir>] ${EVENTS_DIR}`,
    summary:
      'Cut a new plan version against the spec findings that forced it. No finding, no amendment. --sites is every place the shape occurs, not only where it was reported.',
  },
  {
    command: 'plan propose',
    positionals: '',
    flags: `--plan <plan.json> --task <task-id> --proposed-by <role> --request <request.json> [--proposed-by-provider <name>] [--specs-dir <dir>] ${EVENTS_DIR}`,
    summary:
      "Record a worker's spec_change_request: the criterion it found wrong and the plan diff it proposes. Validated against the plan's own validator now, so an unappliable proposal never reaches your queue. Writes no plan version.",
  },
  {
    command: 'plan proposals',
    positionals: '',
    flags:
      '--session <id> [--epic <id>] [--task <task-id>] [--status <status>] [--specs-dir <dir>] [--state-dir <dir>]',
    summary:
      'List spec change proposals with their diffs. --status is open, approved, rejected or stale; stale means a newer plan version has already overtaken the one the proposal was written against.',
  },
  {
    command: 'plan approve',
    positionals: '<proposal-id>',
    flags: `--plan <plan.json> --decided-by <role> [--rationale <text>] [--specs-dir <dir>] ${EVENTS_DIR}`,
    summary:
      "Approve a proposal and cut the version it asks for. Runs `plan amend` with the worker's own finding, sites and diff; --rationale overrides the argument it recorded.",
  },
  {
    command: 'plan reject',
    positionals: '<proposal-id>',
    flags: `--decided-by <role> --rationale <text> [--specs-dir <dir>] ${EVENTS_DIR}`,
    summary:
      'Reject a proposal and refute the finding it raised. --rationale is required: the log already holds the case for, and a rejection is the only place the case against is written down.',
  },
  {
    command: 'plan ingest',
    positionals: '<plan.json>',
    flags: EVENTS_DIR,
    summary: 'Record every task and dependency the plan declares, before any wave names them.',
  },
  {
    command: 'wave check',
    positionals: '<plan.json> <task-id>...',
    flags: `[--dry] [--budget-policy <file>] [--override-rationale <text>] [--repo <dir>] ${EVENTS_DIR}`,
    summary:
      'Admit a wave whose claims are disjoint, whose files share no import edge, and whose ' +
      'declared cost fits under the epic token cap. --dry asks without writing the admission; ' +
      '--override-rationale admits a cost-refused wave and records the machine verdict beside ' +
      'the human reason; --repo names the checkout the symbol graph is read from.',
  },
  {
    command: 'wave next',
    positionals: '<plan.json>',
    flags: `[--repo <dir>] ${EVENTS_DIR}`,
    summary:
      'Compute the widest wave this plan admits right now, and name a reason for every task ' +
      'left out. Reads, never writes: `wave check` stays the only command that admits a wave. ' +
      '--session reads live task status and follow-up tasks from the lineage log; --repo names ' +
      'the checkout the symbol graph is read from.',
  },
  {
    command: 'wave schedule',
    positionals: '<plan.json>',
    flags: `[--repo <dir>] ${EVENTS_DIR}`,
    summary:
      'Replay the wave loop against a plan to exhaustion and report how many rounds it needs, ' +
      'the widest round it ever gets, and which tasks were held back by claim geometry rather ' +
      'than by a dependency. Reads and simulates, never writes. Exit 1 when the plan stalls, ' +
      '2 when it runs but loses width to something a re-slice could fix.',
  },
  {
    command: 'wave audit',
    positionals: '',
    flags: '--session <id> [--epic <id>] [--state-dir <dir>]',
    summary:
      'Read the log back and say whether the waves that were admitted N wide actually ran N ' +
      'wide, or were dispatched one task at a time. Reads, never writes. Exit 1 on a wave that ' +
      'ran strictly serially, 2 when a wave was admitted and the log shows no work for it.',
  },
  {
    command: 'new',
    positionals: '<project>',
    flags: '[--ui] [--skip-toolchain] [--target-dir <dir>] [--roadmap-path <file>]',
    summary: 'Scaffold a project workspace and register it in the roadmap.',
  },
  {
    command: 'mcp init',
    positionals: '<project>',
    flags: '[--target-dir <dir>] [--roadmap-path <file>]',
    summary: 'Add the MCP surface and its end-of-project milestone to an existing project.',
  },
  {
    command: 'mcp check',
    positionals: '<project>',
    flags: '[--target-dir <dir>] [--roadmap-path <file>]',
    summary:
      'Render the MCP verdict the epic gate reads for the checkout you are in. Exit 1 on red.',
  },
  {
    command: 'research check',
    positionals: '',
    flags: '--brief <brief.json>',
    summary: 'Check a research brief cites what it claims. Exit 1 on an uncited claim.',
  },
  {
    command: 'daemon run',
    positionals: '',
    flags: `[--interval <seconds>] [--once] [--dir <dir>] [--project <dir>...] [--db <path>] [--no-db] [--state-dir <dir>]`,
    summary:
      'Watch the event log in the foreground: budgets, stale agents, work that is due. ' +
      'Never dispatches.',
  },
  {
    command: 'daemon start',
    positionals: '',
    flags: `[--interval <seconds>] [--dir <dir>] [--project <dir>...] [--db <path>] [--no-db] [--state-dir <dir>]`,
    summary: 'Spawn `daemon run` detached, logging to <dir>/daemon.log. Prints the spawned pid.',
  },
  {
    command: 'daemon status',
    positionals: '',
    flags: '[--dir <dir>]',
    summary:
      'Print whether a daemon holds the lock, whether it has gone quiet, and what its last tick found. Exit 1 unless one is watching and current.',
  },
  {
    command: 'daemon stop',
    positionals: '',
    flags: '[--dir <dir>]',
    summary: 'SIGTERM the daemon the lock names and clear the lock, live or already dead.',
  },
  {
    command: 'projects list',
    positionals: '',
    flags: '[--roadmap <file>] [--json]',
    summary:
      'List every repo this factory maintains -- itself and what it built -- with the ' +
      '--project flags that watch them.',
  },
  {
    command: 'scheduler run',
    positionals: '',
    flags: `[--dry] [--now <iso>] [--project <dir>...] ${EVENTS_DIR}`,
    summary: 'Propose and enact the next scheduler moves for a session. --dry proposes only.',
  },
  {
    command: 'scheduler admit',
    positionals: '',
    flags:
      '--session <id> [--state-dir <dir>] [--now <iso>] [--project <dir>...] ' +
      '[--policy <file>] [--crosscheck <file>]',
    summary:
      "Classify what's due into auto or operator per scheduler.yml autonomy. Enacts nothing.",
  },
  {
    command: 'worktree create',
    positionals: '<project-dir> <epic> <task-id>',
    flags: '',
    summary: 'Cut the isolated worktree and task branch one task is allowed to write in.',
  },
  {
    command: 'worktree rm',
    positionals: '<project-dir> <epic> <task-id>',
    flags: '',
    summary: 'Remove a task worktree once its branch has landed.',
  },
  {
    command: 'worktree fingerprint',
    positionals: '<worktree-dir>',
    flags: '',
    summary: 'Record the tree state before a read-only judge runs against it.',
  },
  {
    command: 'worktree verify',
    positionals: '<worktree-dir>',
    flags: '--before <fingerprint.json>',
    summary: 'Prove a judge changed nothing. Exit 1 on drift — the verdict is then untrustworthy.',
  },
  {
    command: 'worktree stale',
    positionals: '<project-dir> <epic>',
    flags: '',
    summary: 'List worktrees left behind by an epic.',
  },
  {
    command: 'queue run',
    positionals: '<epic>',
    flags:
      '--project <dir> --test-cmd <cmd> --tasks <tasks.json> [--select-test-cmd <cmd>] [--session <id> --causal-parent <event-id> --plan <plan.json> [--plan-version <n>] [--actor <name>]] [--state-dir <dir>]',
    summary: 'Serially rebase, test, and merge task branches into the integration branch.',
  },
  {
    command: 'queue adopt',
    positionals: '<task-id>',
    // The event flags come from the constant, not spelled out again: this entry
    // wrote them by hand and dropped the two optional ones its handler reads
    // through `eventContextFromFlags`, which is the drift D-136's guard exists
    // to catch. Every event-writing verb shares the group, so it shares the name.
    flags: `--project <dir> --merge-commit <sha> --plan <plan.json> ${EVENTS_DIR}`,
    summary: 'Log a merge that landed outside the queue, after verifying it landed.',
  },
  {
    command: 'session start',
    positionals: '<session-id>',
    flags: '[--continues <event-id>] [--actor <name>] [--state-dir <dir>]',
    summary:
      'Open a session log with the one root event it is allowed. Exit 1 if the session is already open.',
  },
  {
    command: 'event append',
    positionals: '<json>',
    flags: '[--state-dir <dir>]',
    summary:
      'Append one hash-chained record to a session log. The receipt says whether the timeline reads its type.',
  },
  {
    command: 'event tail',
    positionals: '<session-id>',
    flags: '[--n <count>] [--task <task-id>] [--lineage] [--state-dir <dir>]',
    summary: 'Print the last n records of a session that exists. Exit 1 if it does not.',
  },
  {
    command: 'event lineage',
    positionals: '<session-id>',
    flags: '[--state-dir <dir>]',
    summary: 'Print the causal chain of a session: what each record was written in answer to.',
  },
  {
    command: 'prompt wrap',
    positionals: '<file>',
    flags: '--kind <kind> --source <label> [--json]',
    summary:
      'Wrap ingested text in its provenance block, so a prompt never quotes an unlabelled source.',
  },
  {
    command: 'prompt record',
    positionals: '<file|->',
    flags: EVENTS_DIR,
    summary:
      "Put the operator's own words on the timeline verbatim, and print the event id a dispatch hangs off.",
  },
  {
    command: 'claims check',
    form: '--roots',
    positionals: '<root-dir>',
    flags: '--roots <glob> [--roots <glob>...] [--since <ref>]',
    summary:
      'Write-root mode, for a role with no worktree and no task branch. Exit 1 on violation.',
  },
  {
    command: 'claims check',
    form: 'spec',
    positionals: '<worktree-dir> <spec.json>',
    flags: '',
    summary:
      'Post-run mode: every file a task touched must fall inside its claims. Exit 1 on violation.',
  },
  {
    command: 'claims impact',
    form: '--plan',
    positionals: '<task-id>...',
    flags: '--plan <file> [--repo <dir>]',
    summary:
      'Pre-run: refuse a wave whose tasks sit on either end of an import edge. Exit 1 when coupled.',
  },
  {
    command: 'claims impact',
    form: 'spec',
    positionals: '<worktree-dir> <spec.json>',
    flags: '',
    summary:
      'Post-run: an export this task removed, still imported outside its claims. Exit 1 on a proven break.',
  },
  {
    command: 'dispatch check',
    positionals: '<session-id>',
    flags: '[--task <id>] [--policy <path>] [--state-dir <dir>]',
    summary:
      'Assert crosscheck.yml’s role asymmetry against the log. Exit 1 on a violation OR an unverifiable answer.',
  },
  {
    command: 'tester check',
    positionals: '<session-id>',
    flags: '[--task <id>] [--policy <path>] [--state-dir <dir>]',
    summary:
      'Assert crosscheck.yml’s role_isolation against the log: a tester of its own per test gate. Exit 1 on a violation OR an unverifiable answer.',
  },
  {
    command: 'escalation check',
    positionals: '<session-id>',
    flags: '[--task <id>] [--policy <path>] [--state-dir <dir>]',
    summary:
      'Assert budgets.yml’s escalation ladder against the log. Exit 1 on a violation OR an unverifiable answer.',
  },
  {
    command: 'effort show',
    positionals: '',
    flags: '[--plan <plan.json>] [--effort <tier>] [--policy <file>] [--crosscheck <file>]',
    summary:
      'Which tier an epic runs at and what it buys. A security-sensitive plan floors at medium.',
  },
  {
    command: 'security triggers',
    positionals: '',
    flags: '--task <task.json> [--policy <file>] [--case <case>] [--epic-tag <tag>...] [--recheck]',
    summary:
      'Compute whether the security reviewer must be dispatched. A fired trigger is not a red.',
  },
  {
    command: 'sandbox open',
    positionals: '<worktree-dir>',
    flags: '--role <role> --task <id> --session <id> [--at <iso>] [--lease-dir <dir>]',
    summary:
      'Open a judge sandbox over a worktree. While it is open the judge-* rules apply. Exit 1 if one is already open.',
  },
  {
    command: 'sandbox close',
    positionals: '<worktree-dir>',
    flags: '[--lease-dir <dir>]',
    summary: 'Release a judge sandbox. Closing one that is not open is not an error.',
  },
  {
    command: 'sandbox status',
    positionals: '',
    flags: '[--worktree <dir>] [--lease-dir <dir>]',
    summary: 'Open judge sandboxes — all of them, or the one binding commands run in --worktree.',
  },
  {
    command: 'stack show',
    positionals: '',
    flags: '[--policy <file>]',
    summary: "The operator's stack answers from factory/policies/stack.yml, parsed.",
  },
  {
    command: 'stack check',
    positionals: '',
    flags: '[--policy <file>]',
    summary:
      'Which stack answers the shipped templates honour, which they only record, and which make `smith new` refuse. Exit 1 on a refusal.',
  },
  {
    command: 'policy check',
    positionals: '',
    flags:
      '--command <cmd> [--tool <name>] [--file <path>] [--branch <branch>] [--sandbox <role>] [--lease-dir <dir>]',
    summary:
      'Would the guard hook deny this command? --tool Write --file <path> asks the same of a file write. Branch and sandbox auto-detect unless given. Exit 1 on deny.',
  },
  {
    command: 'policy hook',
    positionals: '',
    flags: '',
    summary:
      'The PreToolUse hook body: reads a hook payload from stdin. Prints a deny envelope, or nothing at all when no rule fires. Non-zero exit means it could not decide.',
  },
  {
    command: 'gate run',
    positionals: '<task-id>',
    flags: `--worktree <dir> --checks <checks.json> --result <result.json> [--base <ref>] [--grader <file>] [--agent <role> --provider <name> --model-tier <tier> --input-tokens <n> --output-tokens <n>] [--evidence <file> --found-by <role> [--found-by-provider <name>]] [--findings <file>] [--no-findings <role>] [--lessons <lessons.md>] [--plan <file>] [--run-all] [--artifacts-dir <dir>] ${EVENTS_DIR}`,
    summary: 'The per-task gate: schema, tests, coverage, findings. Exit 1 when blocked.',
  },
  {
    command: 'coverage check',
    positionals: '<worktree-dir>',
    flags: '[--plan <plan.json> --task <task-id>] [--summary <path>]',
    summary:
      "The gate's coverage evidence, without staging a gate run. Exit 1 when a claimed file has no number.",
  },
  {
    command: 'budget alarm',
    positionals: '<session-id>',
    flags: '[--epic <id>] [--policy <path>] [--state-dir <dir>]',
    summary:
      'Epic spend against budgets.yml’s epic.alarm_ratio. Exit 1 on a crossing OR on a record too holey to rule one out.',
  },
  {
    command: 'kpi same-mistake',
    positionals: '<session-id>',
    flags: '[--lessons <lessons.md>] [--state-dir <dir>]',
    summary:
      'Same-mistake rate per day against §9.7’s decreasing target. Exit 1 on a rise OR when the corpus could not have caught one.',
  },
  {
    command: 'integration check',
    positionals: '',
    flags: `--epic <id> --project <dir> --checks <checks.json> [--run-all <true|false>] ${EVENTS_DIR}`,
    summary:
      'Run the checks against the assembled integration branch, not a worktree. Exit 1 on red.',
  },
  {
    command: 'epic verdict',
    positionals: '',
    flags: `--epic <id> --project <dir> [--roadmap-path <file>] [--specs-dir <dir>] ${EVENTS_DIR}`,
    summary: 'Render the read-only epic verdict without writing a close. Exit 1 on hold.',
  },
  {
    command: 'epic spec-review',
    positionals: '',
    flags: `--epic <id> --project <dir> --plan <plan.json> --reviewed-by <role> [--reviewed-by-provider <name>] [--evidence <file>] ${EVENTS_DIR}`,
    summary: 'Record the closing spec review, pinned to the integration head it was read at.',
  },
  {
    command: 'epic goal',
    positionals: '',
    flags: '--epic <id> [--roadmap-path <file>]',
    summary: "The epic's roadmap goal, split into the clauses a coverage map has to answer.",
  },
  {
    command: 'epic goal-check',
    positionals: '',
    flags: `--epic <id> --plan <plan.json> --coverage <file> --checked-by <role> [--checked-by-provider <name>] [--roadmap-path <file>] ${EVENTS_DIR}`,
    summary:
      'Record the plan checked clause by clause against the roadmap goal — the one reference the planner did not write.',
  },
  {
    command: 'epic close',
    positionals: '',
    flags: `--epic <id> --project <dir> [--roadmap-path <file>] [--specs-dir <dir>] [--override-rationale <text>] ${EVENTS_DIR}`,
    summary: 'Write the close down. A hold closes only with an operator rationale, recorded.',
  },
  {
    command: 'epic width',
    positionals: '',
    flags: '[--session <id>] [--state-dir <dir>]',
    summary:
      'Read every epic close back and say whether this factory builds in parallel or one epic ' +
      'at a time. Reads, never writes. Without --session it folds every session in the state ' +
      'dir, because the question is about the workshop and not about where you are standing; ' +
      'with one it folds that lineage alone. Exit 1 on a closed epic whose record holds a wave ' +
      'admitted wide that ran narrow, 2 when nothing could be judged.',
  },
  {
    command: 'findings raise',
    positionals: '',
    flags: `[--task <task-id>] [--scope <diff|spec>] [--plan <file>] [--findings <file>] [--evidence <file> --found-by <role> [--found-by-provider <name>]] ${EVENTS_DIR}`,
    summary: 'Raise a finding outside any gate, routed to whoever claims the file it is about.',
  },
  {
    command: 'findings for-dispatch',
    positionals: '',
    flags: '--session <id> --plan <plan.json> --task <task-id> [--state-dir <dir>]',
    summary: "Print the open findings a dispatching task's own claims cover, as a prompt block.",
  },
  {
    command: 'findings list',
    positionals: '',
    flags:
      '--session <id> [--task <task-id>] [--epic <id>] [--status <status>] [--severity <severity>] [--category <category>] [--state-dir <dir>]',
    summary: 'List the findings of a session that exists.',
  },
  {
    command: 'findings transition',
    positionals: '<finding-id> <status>',
    flags: EVENTS_DIR,
    // Not "a status the transition table allows": the table allows two the
    // command line cannot carry evidence for, and promising them cost a full
    // disposition pass (D-136).
    summary:
      'Move one finding along the transition table. The amendment edges are not typeable: amend-pending is entered by "plan amend", amended by "epic close".',
  },
  {
    command: 'findings reverify',
    positionals: '<finding-id>',
    flags: `[--note <text>] ${EVENTS_DIR}`,
    summary: 'Re-open a finding for another look without claiming it was wrong.',
  },
  {
    command: 'findings repair-obligation',
    positionals: '<finding-id>',
    flags: `--replace-with <task-id[,task-id...]> --reason <text> ${EVENTS_DIR}`,
    summary:
      'Correct a malformed amends_task_ids entry on an amend-pending finding (D-21 Part 4). Repairs corruption only -- never renegotiates a well-formed obligation.',
  },
  {
    command: 'waivers pending',
    positionals: '<epic>',
    flags: '--session <id> [--state-dir <dir>]',
    summary: 'List the waiver decisions an epic is waiting on.',
  },
  {
    command: 'waivers apply',
    positionals: '<decisions.json>',
    flags: EVENTS_DIR,
    summary: 'Apply a batch of operator waiver decisions.',
  },
  {
    command: 'lessons candidates',
    positionals: '',
    flags: STATS,
    summary: 'List the lesson candidates awaiting an approve or a reject.',
  },
  {
    command: 'lessons raise',
    // `<0<n<=1>` and not `<0-1>`, which is what `plan quorum --confidence`
    // twenty entries up genuinely means. The two ranges differ by one value and
    // the handler enforces the difference: a novelty threshold of 0 rejects
    // every candidate as a duplicate, so scheduler.yml may not hold it and
    // (D-208) neither may the flag that overrides it. A usage line that admits
    // it advertises the one value guaranteed to be refused.
    positionals: '',
    flags: `--statement <text> --lesson-type <type> --lesson-scope <scope> --provenance <event-id[,...]> [--provenance-session <id>] [--evidence <text>] [--finding-category <cat>] [--claim-path <glob>] [--agent-role <role>] [--case-type <case>] [--lesson-id <id>] [--novelty-threshold <0<n<=1>] [--policy <path>] ${EVENTS_DIR}`,
    summary: 'Raise a hand-authored lesson through the novelty gate (exit 1 if rejected).',
  },
  {
    command: 'lessons approve',
    positionals: '<lesson-id>',
    flags: `[--note <text>] [--statement <text>] [--lesson-type <type>] [--lesson-scope <scope>] [--agent-role <role>] [--case-type <case>] [--accept-duplicate] [--novelty-threshold <0<n<=1>] [--policy <path>] ${EVENTS_DIR}`,
    summary:
      'Approve a candidate into memory, editing it on the way in through the same novelty gate (exit 1 if not novel).',
  },
  {
    command: 'lessons reject',
    positionals: '<lesson-id>',
    // approve and reject share one dispatcher branch, so reject reaches the same
    // edit flags whether or not it has any use for them. Documenting the shared
    // shape is the honest half of that; narrowing it belongs to the handler.
    flags: `[--note <text>] [--statement <text>] [--lesson-type <type>] [--lesson-scope <scope>] [--agent-role <role>] [--case-type <case>] [--accept-duplicate] [--novelty-threshold <0<n<=1>] [--policy <path>] ${EVENTS_DIR}`,
    summary: 'Invalidate a candidate, with the reason recorded.',
  },
  {
    command: 'lessons compile',
    positionals: '',
    flags: '[--db <file>] [--out <lessons.md>] [--session <id>]',
    summary: 'Render every approved lesson into the markdown dispatch reads.',
  },
  {
    command: 'lessons for-dispatch',
    positionals: '<role>',
    flags:
      '[--plan <file> --task <task-id>] [--case-type <case>] [--lessons <lessons.md>] [--agents-dir <dir>]',
    summary: 'Print the lesson block to splice into one role prompt.',
  },
  {
    command: 'lessons audit',
    positionals: '<session-id>',
    flags: '[--lessons <lessons.md>] [--state-dir <dir>]',
    summary:
      'Which entries fire, which are shadowed dead, which contradict. Recommends only. Exit 1 on anything but clean.',
  },
  {
    command: 'dream',
    positionals: '',
    flags: `[--since <iso>] [--policy <path>] ${EVENTS_DIR}`,
    summary: 'Distil a session log into lesson candidates.',
  },
  {
    command: 'judge dispatch',
    positionals: '',
    flags: `--task <task-id> --role <role> --artifact <file> --model <id> [--round <n>] [--provider <name>] [--model-tier <tier>] ${EVENTS_DIR}`,
    summary: 'Declare the file a judge owes, so a turn that never came back is visible.',
  },
  {
    command: 'judge report',
    positionals: '',
    flags: `--task <task-id> --role <role> [--round <n>] [--artifact <file>] [--no-findings] ${EVENTS_DIR}`,
    summary:
      'Close a judge turn against the artifact it declared. --no-findings attests the clean case.',
  },
  {
    command: 'judge outstanding',
    positionals: '',
    flags: '--session <id> --task <task-id> [--state-dir <dir>]',
    summary: 'List the judge turns still owed on a task. Exit 1 while the list is non-empty.',
  },
  {
    command: 'judge escalations',
    positionals: '',
    flags: '--session <id> [--state-dir <dir>]',
    summary:
      'List the cross-provider disagreements still owed an answer. Exit 1 on an open disagreement, 2 when nothing was gated at all.',
  },
  {
    command: 'judge preflight',
    positionals: '',
    flags: '[--policy <file>]',
    summary:
      'Can the enabled providers be called at all, and would a promotion decide anything? Exit 1 on a provider that costs a call it cannot make.',
  },
  {
    command: 'judge run',
    positionals: '',
    flags: '--provider <name> --request <request.json> [--shadow]',
    summary: 'Call one provider by hand for calibration. Touches neither the log nor quorum.',
  },
  {
    command: 'crossfind request',
    positionals: '',
    flags:
      '--task <id> --diff <file> --diff-ref <ref> [--criterion <text>...] [--timeout-ms <n>] [--max-output-bytes <n>] [--policy <file>]',
    summary:
      'Print the finder request without sending it — exactly what would leave the machine. Refuses when send_diff is false.',
  },
  {
    command: 'crossfind reconcile',
    positionals: '',
    flags: '--task <id> --native <findings.json> --independent <runs.json> [--policy <file>]',
    summary:
      'Reconcile two saved finding lists offline. No provider, no log. Exit 1 when the result would change a gate.',
  },
  {
    command: 'crossfind run',
    positionals: '',
    flags: `--task <id> --diff <file> --diff-ref <ref> [--criterion <text>...] [--status <status>] [--timeout-ms <n>] [--max-output-bytes <n>] [--policy <file>] ${EVENTS_DIR}`,
    summary:
      'Run the independent finder over a diff and reconcile it against the native findings. Exit 1 when the result would change a gate.',
  },
  {
    command: 'ui serve',
    positionals: '',
    flags:
      '[--port <n>] [--db <file>] [--state-dir <dir>] [--roadmap-path <file>] [--specs-dir <dir>]',
    summary: 'Serve the dashboard from the built ui/server.',
  },
  {
    command: 'db rebuild',
    positionals: '',
    flags:
      '[--db <file>] [--session <id>] [--state-dir <dir>] [--roadmap-path <file>] [--specs-dir <dir>]',
    summary: 'Rebuild the projection from the logs. Without --session, from all of them.',
  },
  {
    command: 'db apply',
    positionals: '',
    flags:
      '--session <id> [--db <file>] [--state-dir <dir>] [--roadmap-path <file>] [--specs-dir <dir>]',
    summary: 'Apply one session log onto the existing projection.',
  },
  {
    command: 'stats overview',
    positionals: '',
    flags: STATS,
    summary: 'Counts across tasks, findings, and lessons.',
  },
  {
    command: 'stats timeline',
    positionals: '',
    flags: `[--task <task-id>] [--epic <id>] [--causal-chain-for <event-id>] ${STATS}`,
    summary: 'The event timeline, optionally narrowed to one task, epic, or causal chain.',
  },
  {
    command: 'stats kanban',
    positionals: '',
    flags: `--epic <id> ${STATS}`,
    summary: 'One epic as columns of task status.',
  },
  {
    command: 'stats task',
    positionals: '',
    flags: `--task <task-id> ${STATS}`,
    summary: 'Everything the projection holds about one task. Exit 1 if it holds nothing.',
  },
  {
    command: 'stats lessons',
    positionals: '',
    flags: STATS,
    summary: 'Lesson candidates and approvals as the dashboard shows them.',
  },
  {
    command: 'stats errors',
    positionals: '',
    flags: STATS,
    summary: 'Errors grouped by taxonomy class.',
  },
  {
    command: 'stats analytics',
    positionals: '',
    flags: STATS,
    summary: 'Throughput, rework, and budget aggregates.',
  },
  {
    command: 'stats roadmap',
    positionals: '',
    flags: STATS,
    summary: 'Roadmap progress as the projection sees it.',
  },
  {
    command: 'stats providers',
    positionals: '',
    flags: `[--since <iso>] ${STATS}`,
    summary: 'Cross-provider judge agreement, for calibration.',
  },
];

/** The key a command is looked up by: the dispatch pair, plus the form where there are two. */
function keyOf(doc: CommandDoc): string {
  return doc.form ? `${doc.command} ${doc.form}` : doc.command;
}

function namespaceOf(doc: CommandDoc): string {
  return doc.command.split(' ')[0] as string;
}

const BY_KEY = new Map<string, CommandDoc>(COMMANDS.map((doc) => [keyOf(doc), doc]));
const COMMAND_NAMES = new Set<string>(COMMANDS.map((doc) => doc.command));
const NAMESPACES = new Set<string>(COMMANDS.map(namespaceOf));

/** The line that would have worked. Empty parts are dropped, never printed as a double space. */
export function usageLine(doc: CommandDoc): string {
  return ['smith', doc.command, doc.positionals, doc.flags].filter((part) => part !== '').join(' ');
}

/** The positional argument names, in order — what a missing-argument error names. */
export function positionalNames(doc: CommandDoc): string[] {
  return [...doc.positionals.matchAll(/<([^>]+)>/g)].map((m) => m[1] as string);
}

/**
 * Every command answers `--help`, and no command's flag string says so.
 * Declaring it here rather than in each entry keeps the help line out of 63
 * usage strings that would all have to repeat it.
 */
const UNIVERSAL_FLAGS: ReadonlyArray<readonly [string, boolean]> = [['help', false]];

/**
 * The flags one doc entry declares: name → whether it carries a value.
 *
 * `--session <id>` takes one; `[--run-all]` takes none. The brackets mark
 * optionality, which the parser does not care about — a missing required flag
 * is already `requireFlag`'s job, and it names the flag better than a parser
 * could.
 */
function flagsOf(doc: CommandDoc): Array<[string, boolean]> {
  return [...doc.flags.matchAll(/--([a-z0-9-]+)(\s+<[^>]*>)?/g)].map((m) => [
    m[1] as string,
    m[2] !== undefined,
  ]);
}

/**
 * What a command line is allowed to contain, derived from the same table the
 * help prints (D-132), or `undefined` when nothing here documents the command.
 *
 * The `undefined` matters: an empty map would read as "accepts no flags", so an
 * unknown command would answer with a pile of unknown-flag errors instead of
 * "unknown command". The caller distinguishes them.
 *
 * Both documented forms of a two-form command are unioned. `claims check` is
 * the case: the operator has not yet chosen a form at the moment the flags are
 * parsed, so neither form's flags can be treated as unknown.
 */
export function flagSpecFor(namespace?: string, action?: string): Map<string, boolean> | undefined {
  if (namespace === undefined) return undefined;
  const key = action === undefined ? namespace : `${namespace} ${action}`;
  // The second arm is what keeps the action-less verbs working: `smith new
  // my-project` spends its action slot on a positional. Same fallback as
  // isDocumented, deliberately — a command that dispatches must also parse.
  const docs = COMMANDS.filter((doc) => doc.command === key || doc.command === namespace).filter(
    (doc) => doc.command === key || !COMMAND_NAMES.has(key),
  );
  if (docs.length === 0) return undefined;

  const spec = new Map<string, boolean>(UNIVERSAL_FLAGS);
  for (const doc of docs) {
    for (const [name, takesValue] of flagsOf(doc)) {
      // A flag documented with a value in one form and bare in another takes a
      // value: the parser must be able to read the longer of the two shapes.
      spec.set(name, (spec.get(name) ?? false) || takesValue);
    }
  }
  return spec;
}

export function usageFor(key: string): CommandDoc {
  const doc = BY_KEY.get(key);
  if (!doc) {
    throw new SmithError('usage.unknown-command', `No usage entry for "${key}".`, { key });
  }
  return doc;
}

function renderCommands(docs: readonly CommandDoc[]): string {
  return docs.map((doc) => `  ${usageLine(doc)}\n      ${doc.summary}\n`).join('');
}

/**
 * The whole command list, or one namespace's slice of it. An unknown namespace
 * throws rather than printing an empty list: "smith has no such namespace" and
 * "that namespace has no commands" must not be the same observable answer.
 */
export function usageText(namespace?: string): string {
  if (namespace !== undefined && !NAMESPACES.has(namespace)) {
    throw new SmithError(
      'usage.unknown-namespace',
      `No such namespace: ${namespace}. Run "smith --help" for the list.`,
      { namespace },
    );
  }
  const docs =
    namespace === undefined ? COMMANDS : COMMANDS.filter((doc) => namespaceOf(doc) === namespace);

  const header =
    namespace === undefined
      ? [
          'Usage: smith <namespace> <action> [args] [--flags]',
          '',
          '  smith <namespace> --help   list one namespace',
          '  smith <command> --help     show one command',
          '',
        ].join('\n')
      : `Usage: smith ${namespace} <action> [args] [--flags]\n`;

  let out = `${header}\n`;
  let current = '';
  for (const doc of docs) {
    const ns = namespaceOf(doc);
    if (ns !== current) {
      if (current !== '') out += '\n';
      current = ns;
    }
    out += renderCommands([doc]);
  }
  return out;
}

/**
 * The help for a topic, or undefined when there is no such topic. Callers
 * distinguish the two: `--help` on a real topic prints and exits 0, while an
 * unknown one falls through to the unknown-command path.
 */
export function helpText(namespace?: string, action?: string): string | undefined {
  if (namespace === undefined) return usageText();

  const key = action === undefined ? namespace : `${namespace} ${action}`;
  const exact = COMMANDS.filter((doc) => doc.command === key);
  if (exact.length > 0) return renderCommands(exact);

  // `smith new my-project --help`: the action slot holds a positional, so the
  // namespace alone is the command.
  const bare = COMMANDS.filter((doc) => doc.command === namespace);
  if (bare.length > 0) return renderCommands(bare);

  if (NAMESPACES.has(namespace)) return usageText(namespace);
  return undefined;
}

/**
 * Whether cli.ts's dispatcher has a branch for this pair. Checked before
 * dispatch, so an undocumented command cannot run — which is the half of
 * "the table and the dispatcher agree" that a test cannot enforce at runtime.
 * The second arm is what keeps the action-less verbs working: `smith new
 * my-project` spends its action slot on a positional.
 */
export function isDocumented(namespace?: string, action?: string): boolean {
  if (namespace === undefined) return false;
  if (action !== undefined && COMMAND_NAMES.has(`${namespace} ${action}`)) return true;
  return COMMAND_NAMES.has(namespace);
}
