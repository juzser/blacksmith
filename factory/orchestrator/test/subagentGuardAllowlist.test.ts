import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideHookPayload } from '../src/hookDecision.js';
import { SUBAGENT_EVENT_ALLOW } from '../src/subagentGuard.js';

// The `bs` verbs a subagent runs are an allowlist: read-only verbs, plus the
// write verbs the templates hand to a subagent. Verbs that default `--actor`
// to the operator, and verbs added later, are refused from subagents until
// someone lists them on purpose.

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

function decide(tool: string, input: Record<string, unknown>, sub: boolean) {
  const payload: Record<string, unknown> = { tool_name: tool, tool_input: input, cwd: ROOT };
  if (sub) payload.agent_id = 'agent-1';
  return decideHookPayload(JSON.stringify(payload), ROOT);
}
const bash = (command: string, sub = true) => decide('Bash', { command }, sub);
const text = (command: string) => bash(command)?.hookSpecificOutput.permissionDecisionReason ?? '';

const REFUSED: Array<[string, string]> = [
  // verbs that default --actor to the operator, with no flag at all
  ['bs lessons approve L1', 'subagent-operator-verb'],
  ['bs lessons reject L1', 'subagent-operator-verb'],
  ['bs feedback record "x"', 'subagent-operator-verb'],
  ['bs feedback resolve f1', 'subagent-operator-verb'],
  ['bs audit decide --id a', 'subagent-operator-verb'],
  ['bs task reinstate t1', 'subagent-operator-verb'],
  ['bs findings repair-obligation --task t', 'subagent-operator-verb'],
  ['bs plan approve --plan p.json --decided-by operator', 'subagent-operator-actor'],
  ['bs plan approve --plan p.json --decided-by=user', 'subagent-operator-actor'],
  // a verb nobody has listed
  ['bs brand-new verb', 'subagent-operator-verb'],
  ['bs epic close --epic e', 'subagent-operator-verb'],
  // unreadable event JSON
  [`bs event append ' {"event_type":"wave-merged"}'`, 'subagent-owned-event'],
  [`bs event append '  {"event_type":"wave-merged"}'`, 'subagent-owned-event'],
  ['xargs -0 bs event append', 'subagent-owned-event'],
  ['cat e.json | xargs bs event append', 'subagent-owned-event'],
  [`bs event append '{"session_id":"s"}'`, 'subagent-owned-event'],
  [`bs event append '{"event_type":"some-new-type"}'`, 'subagent-owned-event'],
  [`bs event append '{"event_type":"lesson-status-changed"}'`, 'subagent-owned-event'],
  // ref moves
  ['git update-ref refs/heads/main abc', 'subagent-git-ref'],
  ['git update-ref -m why refs/heads/master abc', 'subagent-git-ref'],
  ['git update-ref refs/heads/bs/e/integration abc', 'subagent-git-ref'],
  ['git update-ref --stdin', 'subagent-git-ref'],
  ['git branch --move feat main', 'subagent-git-ref'],
  ['git branch --delete --force main', 'subagent-git-ref'],
  ['git branch -C feat main', 'subagent-git-ref'],
  ['git branch --copy feat master', 'subagent-git-ref'],
  ['git branch -f "$B" HEAD', 'subagent-git-ref'],
  ['git checkout -B main origin/main', 'subagent-git-ref'],
  ['git switch -C main', 'subagent-git-ref'],
  ['git switch --force-create bs/e/integration', 'subagent-git-ref'],
  ['git worktree add -B main /tmp/w', 'subagent-git-ref'],
  ['git fetch . x:bs/e/integration', 'subagent-git-ref'],
  ['git fetch . +x:refs/heads/main', 'subagent-git-ref'],
  ['git fetch origin x:refs/bs/e/t', 'subagent-git-ref'],
  ['git push . --delete main', 'subagent-git-ref'],
  ['git push . :master', 'subagent-git-ref'],
  ['git "$S" -f main', 'subagent-git-ref'],
  // shell forms
  ['{ bs waivers apply; }', 'subagent-operator-verb'],
  ['if true; then bs waivers apply; fi', 'subagent-operator-verb'],
  ['! bs waivers apply', 'subagent-operator-verb'],
  ['f() { bs waivers apply; }; f', 'subagent-operator-verb'],
  ['for x in 1; do bs queue adopt; done', 'subagent-operator-verb'],
  ['find . -name x -exec bs waivers apply {} \\;', 'subagent-operator-verb'],
  ['echo apply | xargs bs waivers', 'subagent-operator-verb'],
  ['b=bs; $b waivers apply', 'subagent-operator-verb'],
  ['b=bs; "$b" waivers apply', 'subagent-operator-verb'],
  ['bs gate run --actor "$A"', 'subagent-operator-actor'],
  ['bs gate run --actor "$(echo operator)"', 'subagent-operator-actor'],
  ['pnpm bs waivers apply', 'subagent-operator-verb'],
  ['yarn bs waivers apply', 'subagent-operator-verb'],
  ['pnpm run bs waivers apply', 'subagent-operator-verb'],
  ['node /abs/factory/orchestrator/dist/cli waivers apply', 'subagent-operator-verb'],
  ['cd factory/orchestrator/dist && node cli.js waivers apply', 'subagent-operator-verb'],
  // operator-owned config
  ['echo x > /p/.blacksmith/crosscheck.yml', 'subagent-config-write'],
  ['cp a /p/.blacksmith/stack.yml', 'subagent-config-write'],
  ['tee /p/.blacksmith/check-tiers.json < a', 'subagent-config-write'],
  ['echo x >> /i/.blacksmith/factory/policies/stack.yml', 'subagent-config-write'],
  ['sed -i s/a/b/ /r/factory/policies/guardrails.yml', 'subagent-config-write'],
  // ref files
  ['echo x > /r/.git/packed-refs', 'subagent-git-ref'],
  ['echo x > /r/.git/refs/heads/main', 'subagent-git-ref'],
  ['echo x > /r/.git/refs/heads/bs/e/integration', 'subagent-git-ref'],
];

const ALLOWED: string[] = [
  'bs plan validate p.json',
  'bs stats overview',
  'bs doctor',
  'bs --help',
  'bs gate run --task t --actor coder',
  `bs event append '{"event_type":"dispatch_decision","actor":"wave-runner"}'`,
  `bs event append --state-dir x '  {"event_type":"error-logged"}'`,
  `bs event append '{"event_type":"task-result-recorded","payload":{"run_status":"dead"}}'`,
  'git branch -f feature main',
  'git branch -d feature',
  'git branch -dr origin/main',
  'git branch --move feat feat2',
  'git checkout -b feat main',
  'git checkout main',
  'git switch -c feat',
  'git switch main',
  'git update-ref refs/heads/feature HEAD',
  'git fetch origin',
  'git fetch . main',
  'git push . HEAD:feature',
  'git worktree add -b feat /tmp/w main',
  'echo x > /r/.git/refs/heads/feature',
  'echo x > /p/src/store/state/events/reducer.ts',
  'cat /p/.blacksmith/crosscheck.yml',
  'echo x > /p/.blacksmith/state/results/t.json',
  'cp a /r/.claude/worktrees/w1/factory/policies/stack.yml',
  'echo x > /p/factory/specs/active/e/plan.json',
];

describe('bs verbs are an allowlist from a subagent', () => {
  it.each(REFUSED)('refuses: %s', (command, rule) => {
    const out = bash(command);
    expect(out, command).not.toBeNull();
    expect(out?.hookSpecificOutput.permissionDecisionReason).toContain(rule);
    expect(out?.hookSpecificOutput.permissionDecisionReason).toMatch(/main session/);
  });

  it.each(REFUSED)('does not refuse in the main session: %s', (command) => {
    const out = bash(command, false);
    expect(out?.hookSpecificOutput.permissionDecisionReason ?? '').not.toMatch(/subagent-/);
  });

  it.each(ALLOWED)('allows: %s', (command) => {
    expect(bash(command), text(command)).toBeNull();
  });

  it('names the verb it refuses', () => {
    expect(text('bs lessons approve L1')).toContain('bs lessons approve');
  });
});

describe('writes to operator config and ref files', () => {
  const refusedPaths: Array<[string, string]> = [
    ['/p/.blacksmith/crosscheck.yml', 'subagent-config-write'],
    ['/p/.blacksmith/check-tiers.json', 'subagent-config-write'],
    ['/i/.blacksmith/factory/policies/lessons.md', 'subagent-config-write'],
    ['/i/.blacksmith/factory/specs/roadmap.md', 'subagent-config-write'],
    ['/r/factory/policies/guardrails.yml', 'subagent-config-write'],
    ['/r/.git/packed-refs', 'subagent-git-ref'],
    ['/r/.git/refs/heads/main', 'subagent-git-ref'],
    ['/r/.git/refs/heads/master', 'subagent-git-ref'],
    ['/r/.git/refs/bs/e/t', 'subagent-git-ref'],
    ['/w/state/events/s.jsonl', 'subagent-state-write'],
    ['/w/state/events/s.jsonl.lock', 'subagent-state-write'],
    ['/w/state/sandboxes/k.json', 'subagent-state-write'],
  ];
  it.each(['Write', 'Edit', 'MultiEdit'])('refuses %s of each operator-owned path', (tool) => {
    for (const [file, rule] of refusedPaths) {
      const out = decide(tool, { file_path: file }, true);
      expect(out?.hookSpecificOutput.permissionDecisionReason, file).toContain(rule);
      expect(decide(tool, { file_path: file }, false), file).toBeNull();
    }
  });
  it('allows test fixtures, project files and results', () => {
    for (const file of [
      '/r/factory/orchestrator/test/fixtures/.blacksmith/crosscheck.yml',
      '/r/factory/orchestrator/test/fixtures/factory/policies/x.yml',
      '/p/src/store/state/events/reducer.ts',
      '/p/src/state/events/log.ts',
      '/w/state/results/t.json',
      '/r/.git/refs/heads/feature',
      '/r/.claude/worktrees/w1/factory/policies/stack.yml',
      '/p/factory/specs/active/e/plan.json',
    ]) {
      expect(decide('Write', { file_path: file }, true), file).toBeNull();
    }
  });
});

describe('the allowlists are what the templates tell a subagent to run', () => {
  const files = [
    ...[
      'bs-wave-runner',
      'bs-coder',
      'bs-tester',
      'bs-reviewer',
      'bs-grader',
      'bs-merger',
      'bs-verifier',
      'bs-spec-reviewer',
      'bs-planner',
      'bs-researcher',
      'bs-security-reviewer',
      'bs-uiux',
      'bs-scribe',
      'bs-auditor',
    ].map((n) => `.claude/agents/${n}.md`),
    '.claude/skills/bs/wave.md',
    '.claude/skills/bs/dispatch.md',
  ];
  const allText = files.map((f) => readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

  it('names no operator-attributed command in what a subagent reads', () => {
    expect(allText).not.toMatch(/`(?:bs|smith) [^`\n]*--actor operator/);
    expect(allText).not.toMatch(/`(?:bs|smith) mcp override/);
  });

  it('lists the event types the templates have a subagent write by hand', () => {
    for (const type of SUBAGENT_EVENT_ALLOW) expect(allText).toContain(type);
    for (const refused of ['wave-merged', 'subagent-started', 'mcp-approval-override']) {
      expect(SUBAGENT_EVENT_ALLOW).not.toContain(refused);
    }
  });
});
