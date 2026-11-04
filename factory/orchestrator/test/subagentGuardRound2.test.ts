import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideHookPayload } from '../src/hookDecision.js';
import { SUBAGENT_BS_WRITE_ALLOW, SUBAGENT_EVENT_ALLOW } from '../src/subagentGuard.js';
import { runOrThrow } from './helpers/process.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

function decide(tool: string, input: Record<string, unknown>, cwd = ROOT, sub = true) {
  const payload: Record<string, unknown> = { tool_name: tool, tool_input: input, cwd };
  if (sub) payload.agent_id = 'agent-1';
  return decideHookPayload(JSON.stringify(payload), cwd);
}
const bash = (command: string, cwd = ROOT, sub = true) => decide('Bash', { command }, cwd, sub);
const why = (out: ReturnType<typeof decide>) =>
  out?.hookSpecificOutput.permissionDecisionReason ?? '';

const REFUSED: Array<[string, string]> = [
  // verbs no template tells a subagent to run
  ['bs plan approve --plan p.json --decided-by wave-runner', 'subagent-operator-verb'],
  ['bs plan amend --epic e', 'subagent-operator-verb'],
  ['bs epic goal-check --epic e', 'subagent-operator-verb'],
  ['bs epic spec-review --epic e', 'subagent-operator-verb'],
  ['bs agents sync', 'subagent-operator-verb'],
  ['bs wave next e', 'subagent-operator-verb'],
  ['bs lessons compile', 'subagent-operator-verb'],
  ['bs audit record --axis x', 'subagent-operator-verb'],
  ['bs integration check --epic e', 'subagent-operator-verb'],
  // session start records the operator when no actor is given
  ['bs session start w1 --continues e#1', 'subagent-operator-actor'],
  ['bs session start w1 --actor operator', 'subagent-operator-actor'],
  // computed command words and wrappers
  ['X=b; $' + '{X}s waivers apply', 'subagent-operator-verb'],
  ['B=bs; "$B" waivers apply', 'subagent-operator-verb'],
  ['$X$Y waivers apply', 'subagent-operator-verb'],
  ["echo 'waivers apply' | xargs bs", 'subagent-operator-verb'],
  ['echo gate run | xargs bs', 'subagent-operator-verb'],
  // into a directory, and the build the hook runs from
  ['cp x.jsonl /w/state/events', 'subagent-state-write'],
  ['mv x.yml /p/.blacksmith/', 'subagent-config-write'],
  ['cp x /r/factory/orchestrator/dist/policyHook.js', 'subagent-config-write'],
  [
    'cp x /usr/lib/node_modules/@juzser/blacksmith/factory/orchestrator/dist/policyHook.js',
    'subagent-config-write',
  ],
  ['cp x /p/node_modules/@juzser/blacksmith/package.json', 'subagent-config-write'],
  ['$(which bs) waivers apply', 'subagent-operator-verb'],
  ['watch -n1 bs waivers apply', 'subagent-operator-verb'],
  ['script -qc "bs waivers apply" /dev/null', 'subagent-operator-verb'],
  ['parallel bs waivers apply ::: a b', 'subagent-operator-verb'],
  ['coproc bs waivers apply', 'subagent-operator-verb'],
  ['case x in a) bs waivers apply;; esac', 'subagent-operator-verb'],
  // protected writes through other commands
  ['cp x /p/.blacksmith/crosscheck.yml', 'subagent-config-write'],
  ['mv x /p/.blacksmith/stack.yml', 'subagent-config-write'],
  ['cd /p/.blacksmith && echo x > crosscheck.yml', 'subagent-config-write'],
  ['perl -pi -e s/a/b/ /p/.blacksmith/crosscheck.yml', 'subagent-config-write'],
  ['rsync -a x /p/.blacksmith/crosscheck.yml', 'subagent-config-write'],
  ['tar -xf a.tar -C /p/.blacksmith/factory/policies', 'subagent-config-write'],
  ['curl -o /p/.blacksmith/crosscheck.yml http://example.test/x', 'subagent-config-write'],
  ['git checkout HEAD~1 -- /r/factory/policies/guardrails.yml', 'subagent-config-write'],
  ['git restore /r/.claude/hooks/guard.sh', 'subagent-config-write'],
  ['cp x /w/state/events/s.jsonl', 'subagent-state-write'],
  ['cd /w/state/events && echo x > s.jsonl', 'subagent-state-write'],
  ['cp x /r/.claude/settings.json', 'subagent-config-write'],
  // git
  ['git symbolic-ref HEAD refs/heads/main', 'subagent-git-ref'],
  ['git push /some/path x:main', 'subagent-git-ref'],
  ['git push ssh://h.example/r x:bs/e/integration', 'subagent-git-ref'],
  ['git push file:///r x:master', 'subagent-git-ref'],
];

const ALLOWED: string[] = [
  '"$PYTHON" -m pytest tests/',
  '$PYTHON -m pytest',
  'cp x.jsonl /tmp/out',
  'cp x /p/factory/orchestrator/dist-copy',
  `bs event append '{"event_type":"error-logged","payload":{"error":"execution.flaky-test","severity":"S3"}}'`,
  `bs event append '{"event_type":"task-result-recorded","payload":{"run_status":"dead"}}'`,
  `bs event append '{"event_type":"task-added","payload":{"task_status":"failed"}}'`,
  'bs session start w1 --continues e#1 --actor wave-runner',
  'cp /p/.blacksmith/crosscheck.yml /tmp/copy.yml',
  'cat /p/.blacksmith/crosscheck.yml > /tmp/copy.yml',
  'cp a /r/.claude/worktrees/w1/.claude/hooks/x.sh',
  'cp a /p/src/store/state/events/reducer.ts',
  'echo x > /i/.blacksmith/factory/specs/active/e/plan.json',
  'tar -xf a.tar -C /tmp/out',
  'curl -o /tmp/x http://example.test/x',
  'git symbolic-ref HEAD refs/heads/feature',
  'git checkout main',
  'git checkout -- src/a.ts',
  'git push origin feature',
  'node_modules/.bin/vitest run',
  '$HOME/bin/tool --flag',
  'ls $(pwd)',
];

describe('round two: refusals', () => {
  it.each(REFUSED)('refuses: %s', (command, rule) => {
    const out = bash(command);
    expect(out, command).not.toBeNull();
    expect(why(out)).toContain(rule);
    expect(why(out)).toMatch(/main session/);
  });
  it.each(REFUSED)('does not refuse in the main session: %s', (command) => {
    expect(why(bash(command, ROOT, false))).not.toMatch(/subagent-/);
  });
  it.each(ALLOWED)('allows: %s', (command) => {
    expect(bash(command), why(bash(command))).toBeNull();
  });
});

describe('round two: files', () => {
  const refusedPaths: Array<[string, string]> = [
    ['/r/.claude/hooks/guard.sh', 'subagent-config-write'],
    ['/r/.claude/hooks/hooks.json', 'subagent-config-write'],
    ['/r/.claude/settings.json', 'subagent-config-write'],
    ['/r/.claude/settings.local.json', 'subagent-config-write'],
    ['/r/.claude/agents/bs-coder.md', 'subagent-config-write'],
    ['/r/.claude/skills/bs/wave.md', 'subagent-config-write'],
    ['/p/hooks/hooks.json', 'subagent-config-write'],
    ['/p/hooks/plugin-policy.sh', 'subagent-config-write'],
    ['/i/.blacksmith/factory/specs/roadmap.md', 'subagent-config-write'],
    ['/i/.blacksmith/factory/policies/lessons.md', 'subagent-config-write'],
  ];
  it.each(['Write', 'Edit', 'MultiEdit'])(
    '%s refuses the guard files and operator policy',
    (tool) => {
      for (const [file, rule] of refusedPaths) {
        expect(why(decide(tool, { file_path: file })), file).toContain(rule);
        expect(decide(tool, { file_path: file }, ROOT, false), file).toBeNull();
      }
    },
  );
  it('allows a planner to write specs in a plugin install, and a linked worktree its own templates', () => {
    for (const file of [
      '/i/.blacksmith/factory/specs/active/e/plan.json',
      '/i/.blacksmith/factory/specs/active/e/plan-v2.json',
      '/i/.blacksmith/state/results/e.spec-review.json',
      '/r/.claude/worktrees/w1/.claude/agents/bs-coder.md',
      path.join(ROOT, '.claude/skills/bs/wave.md'),
      path.join(ROOT, 'factory/policies/stack.yml'),
    ]) {
      expect(decide('Write', { file_path: file }), file).toBeNull();
    }
  });
});

describe('round two: real repositories', () => {
  let scratch: string;
  let main: string;
  let linked: string;
  let integration: string;

  beforeAll(() => {
    scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'bs-subagent-')));
    main = path.join(scratch, 'main');
    mkdirSync(path.join(main, 'factory/policies'), { recursive: true });
    writeFileSync(path.join(main, 'factory/policies/stack.yml'), 'a: 1\n');
    runOrThrow('git', ['init', '-q', '-b', 'main', main]);
    runOrThrow('git', ['config', 'user.email', 't@example.com'], { cwd: main });
    runOrThrow('git', ['config', 'user.name', 'T'], { cwd: main });
    runOrThrow('git', ['add', '.'], { cwd: main });
    runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: main });
    linked = path.join(scratch, 'linked');
    runOrThrow('git', ['worktree', 'add', '-q', '-b', 'bs/e/task', linked], { cwd: main });
    integration = path.join(scratch, 'integration');
    runOrThrow('git', ['worktree', 'add', '-q', '-b', 'bs/e/integration', integration], {
      cwd: main,
    });
  });
  afterAll(() => {
    // The scratch directory lives under the system temp dir and is left for it to clear.
  });

  it('allows a linked worktree to write its own policy files', () => {
    expect(
      decide('Write', { file_path: path.join(linked, 'factory/policies/stack.yml') }, linked),
    ).toBeNull();
  });

  it('refuses the main checkout from a linked worktree', () => {
    const out = decide(
      'Write',
      { file_path: path.join(main, 'factory/policies/stack.yml') },
      linked,
    );
    expect(why(out)).toContain('subagent-config-write');
  });

  it('refuses a write through a symlink into the main checkout', () => {
    const link = path.join(linked, 'factory/linked-policies');
    symlinkSync(path.join(main, 'factory/policies'), link);
    const out = decide('Write', { file_path: path.join(link, 'stack.yml') }, linked);
    expect(why(out)).toContain('subagent-config-write');
    const viaShell = bash(`cp x ${path.join(link, 'stack.yml')}`, linked);
    expect(why(viaShell)).toContain('subagent-config-write');
  });

  it('refuses a write through a symlink onto an event log directory', () => {
    const events = path.join(scratch, 'work/state/events');
    mkdirSync(events, { recursive: true });
    const link = path.join(linked, 'evlink');
    symlinkSync(events, link);
    expect(why(decide('Write', { file_path: path.join(link, 's.jsonl') }, linked))).toContain(
      'subagent-state-write',
    );
  });

  it.each([
    'commit --allow-empty -m x',
    'merge bs/e/task',
    'reset --hard',
    'rebase main',
    'pull --ff-only',
  ])('refuses git %s inside the integration worktree, and allows it in a task worktree', (args) => {
    expect(why(bash(`git ${args}`, integration))).toContain('subagent-git-ref');
    expect(why(bash(`git -C ${integration} ${args}`, linked))).toContain('subagent-git-ref');
    expect(why(bash(`git ${args}`, linked))).not.toMatch(/subagent-/);
    expect(why(bash(`git ${args}`, integration, false))).not.toMatch(/subagent-/);
  });
});

describe('round three: event payload shapes', () => {
  const append = (event: Record<string, unknown>) =>
    why(bash(`bs event append '${JSON.stringify(event)}'`));
  it('allows task-added only as a failed task without claims', () => {
    expect(append({ event_type: 'task-added', payload: { task_status: 'failed' } })).toBe('');
    for (const payload of [
      { task_status: 'completed' },
      { task_status: 'waived' },
      { task_status: 'failed', claims: ['src/**'] },
      { task_status: 'failed', claims: [] },
      { task_status: 'failed', budget_tokens: 1 },
      {},
    ]) {
      expect(append({ event_type: 'task-added', payload }), JSON.stringify(payload)).toContain(
        'subagent-owned-event',
      );
    }
  });
  it('refuses an error-logged that escalates, and a task-result-recorded that is not dead', () => {
    expect(
      append({ event_type: 'error-logged', payload: { error: 'coordination.deadlock' } }),
    ).toContain('subagent-owned-event');
    expect(
      append({ event_type: 'task-result-recorded', payload: { run_status: 'done' } }),
    ).toContain('subagent-owned-event');
    expect(append({ event_type: 'task-result-recorded' })).toContain('subagent-owned-event');
  });
  it('refuses an allowed type whose JSON cannot be parsed', () => {
    expect(why(bash(`bs event append '{"event_type":"task-added",}'`))).toContain(
      'subagent-owned-event',
    );
  });
});

describe('round three: test directories are anchored inside the repository', () => {
  it('exempts a fixtures directory below the repo and not one above it', () => {
    const top = realpathSync(mkdtempSync(path.join(tmpdir(), 'bs-anchor-')));
    const proj = path.join(top, 'tests', 'proj');
    mkdirSync(path.join(proj, '.git'), { recursive: true });
    mkdirSync(path.join(proj, '.blacksmith/state/events'), { recursive: true });
    const real = path.join(proj, '.blacksmith/state/events/s.jsonl');
    const crosscheck = path.join(proj, '.blacksmith/crosscheck.yml');
    expect(why(decide('Write', { file_path: real }))).toContain('subagent-state-write');
    expect(why(decide('Write', { file_path: crosscheck }))).toContain('subagent-config-write');
    const fixture = path.join(proj, 'test/fixtures/.blacksmith/state/events/s.jsonl');
    expect(decide('Write', { file_path: fixture })).toBeNull();
  });
});

describe('round three: the build the hook runs from', () => {
  it("allows a build in the subagent's own worktree", () => {
    expect(
      decide('Write', { file_path: path.join(ROOT, 'factory/orchestrator/dist/cli.js') }),
    ).toBeNull();
    expect(bash(`cp x ${path.join(ROOT, 'factory/orchestrator/dist')}`)).toBeNull();
  });
});

describe('the allowlist is what a template instructs', () => {
  const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
  // For each write verb, the file and the text of the line that tells a
  // subagent (the wave-runner or a worker) to run it. A line that only names the
  // verb, or hands it to the operator or the epic session, does not count.
  const INSTRUCTED: Record<string, [file: string, line: RegExp]> = {
    'event append': [
      '.claude/agents/bs-wave-runner.md',
      /or `"actor":"wave-runner"` in `event append` JSON/,
    ],
    'findings transition': [
      '.claude/agents/bs-verifier.md',
      /The dispatcher applies your verdicts with\s+`bs findings transition <finding-id> <status>`/,
    ],
    'gate run': ['.claude/skills/bs/wave.md', /^ {3}bs gate run <task-id> \\$/m],
    'heavy run': ['.claude/agents/bs-coder.md', /^bs heavy run --label <task-id>-<role> -- <cmd>/m],
    'issues report': ['.claude/skills/bs/dispatch.md', /^Run `bs issues report --session/m],
    'judge dispatch': [
      '.claude/skills/bs/dispatch.md',
      /^bs judge dispatch --task <task-id> --role reviewer/m,
    ],
    'judge report': [
      '.claude/skills/bs/dispatch.md',
      /^bs judge report --task <task-id> --role reviewer/m,
    ],
    'plan propose': ['.claude/agents/bs-coder.md', /dispatcher records it with `bs plan propose`/],
    'queue run': ['.claude/skills/bs/wave.md', /`bs queue run <epic> --project/],
    'results record': [
      '.claude/agents/bs-tester.md',
      /projects your result with `bs results record --worktree/,
    ],
    'session start': [
      '.claude/agents/bs-wave-runner.md',
      /Your first command is\s+`bs session start/,
    ],
    'worktree create': [
      '.claude/skills/bs/wave.md',
      /Per admitted task, and for all of them together: `bs worktree create/,
    ],
  };

  it('has an instructing line for every write verb on the allowlist, and no other', () => {
    expect(Object.keys(INSTRUCTED).sort()).toEqual([...SUBAGENT_BS_WRITE_ALLOW].sort());
    for (const [verb, [file, line]] of Object.entries(INSTRUCTED)) {
      expect(read(file), `${verb} in ${file}`).toMatch(line);
    }
  });

  it('keeps the verbs the templates give to the operator or the epic session off the list', () => {
    for (const verb of [
      'plan approve',
      'plan amend',
      'epic goal-check',
      'epic spec-review',
      'agents sync',
      'wave next',
      'lessons compile',
      'audit record',
      'integration check',
    ]) {
      expect(SUBAGENT_BS_WRITE_ALLOW).not.toContain(verb);
    }
    expect(read('.claude/skills/bs/wave.md')).toMatch(/the runner never runs `bs wave next`/);
  });

  it('has a template line for every event type, task-added included', () => {
    expect([...SUBAGENT_EVENT_ALLOW].sort()).toEqual([
      'dispatch_decision',
      'error-logged',
      'task-added',
      'task-result-recorded',
    ]);
    expect(read('.claude/skills/bs/wave.md')).toMatch(/its `task-added` event with payload/);
  });
});
