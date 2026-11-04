import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideHookPayload } from '../src/hookDecision.js';

// Verbs that stand for the operator's own decision, or for bookkeeping the
// dispatching session owns, are refused when the tool call comes from a
// subagent (Claude Code puts `agent_id` in the hook input only there). The
// main session keeps its behaviour unchanged.

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CWD = ROOT;

function decide(tool: string, input: Record<string, unknown>, sub: boolean) {
  const payload: Record<string, unknown> = { tool_name: tool, tool_input: input, cwd: CWD };
  if (sub) {
    payload.agent_id = 'agent-1';
    payload.agent_type = 'bs-coder';
  }
  return decideHookPayload(JSON.stringify(payload), CWD);
}
const bash = (command: string, sub: boolean) => decide('Bash', { command }, sub);
const reason = (command: string) =>
  bash(command, true)?.hookSpecificOutput.permissionDecisionReason ?? '';

const REFUSED: Array<[string, string]> = [
  ['bs gate run --task t --actor operator', 'subagent-operator-actor'],
  ['bs gate run --task t --actor=user', 'subagent-operator-actor'],
  ['smith waivers list --actor operator', 'subagent-operator-actor'],
  ['bs gate run --actor operator-skill', 'subagent-operator-actor'],
  ['bs waivers apply --epic e', 'subagent-operator-verb'],
  ['bs waivers approve-task --epic e', 'subagent-operator-verb'],
  ['bs waivers approve-all', 'subagent-operator-verb'],
  ['bs mcp override --task t', 'subagent-operator-verb'],
  ['bs epic close --epic e --override-rationale "x"', 'subagent-operator-verb'],
  ['bs epic close --epic e --override-rationale=x', 'subagent-operator-verb'],
  ['bs prompt record "hello"', 'subagent-operator-verb'],
  ['bs queue adopt --epic e', 'subagent-operator-verb'],
  ['bs subagent stop --agent-id a1', 'subagent-operator-verb'],
  ['env X=1 bs waivers apply', 'subagent-operator-verb'],
  ['FOO=1 bs prompt record x', 'subagent-operator-verb'],
  ['sh -c "bs gate run --actor operator"', 'subagent-operator-actor'],
  ["bash -c 'cd x && bs waivers apply'", 'subagent-operator-verb'],
  ['eval "bs queue adopt"', 'subagent-operator-verb'],
  ['echo $(bs prompt record x)', 'subagent-operator-verb'],
  ['cd /tmp && bs mcp override', 'subagent-operator-verb'],
  ['true; bs mcp override', 'subagent-operator-verb'],
  ['timeout 5 bs mcp override', 'subagent-operator-verb'],
  ['echo x | xargs bs prompt record', 'subagent-operator-verb'],
  ['env -S "bs mcp override"', 'subagent-operator-verb'],
  ['node factory/orchestrator/dist/cli.js waivers apply', 'subagent-operator-verb'],
  [
    'node /abs/blacksmith/factory/orchestrator/dist/cli.js gate run --actor operator',
    'subagent-operator-actor',
  ],
  ['node --no-warnings ./dist/cli.js queue adopt', 'subagent-operator-verb'],
  ['./factory/orchestrator/dist/cli.js queue adopt', 'subagent-operator-verb'],
  ['npx bs waivers apply', 'subagent-operator-verb'],
  ['npx -y @juzser/blacksmith bs waivers apply', 'subagent-operator-verb'],
  ['pnpm exec bs queue adopt', 'subagent-operator-verb'],
  ['/usr/local/bin/bs waivers apply', 'subagent-operator-verb'],
  [`bs event append '{"event_type":"wave-merged","session_id":"s"}'`, 'subagent-owned-event'],
  [
    `bs event append '{"session_id":"s","event_type":"mcp-approval-override"}'`,
    'subagent-owned-event',
  ],
  [`bs event append '{"event_type":"subagent-started"}'`, 'subagent-owned-event'],
  [`bs event append '{"event_type":"subagent-stopped"}'`, 'subagent-owned-event'],
  [`bs event append '{"event_type":"advisory-finding-reproduced"}'`, 'subagent-owned-event'],
  [`bs event append '{"event_type":"waiver-granted"}'`, 'subagent-owned-event'],
  [`bs event append '{"event_type":"user_prompt"}'`, 'subagent-owned-event'],
  [`bs event append --state-dir x '{"event_type":"spec-change-decided"}'`, 'subagent-owned-event'],
  [`env A=1 bs event append '{"event_type":"wave-merged"}'`, 'subagent-owned-event'],
  [`sh -c "bs event append '{\\"event_type\\":\\"wave-merged\\"}'"`, 'subagent-owned-event'],
  [
    `bs event append '{"event_type":"dispatch_decision","actor":"operator"}'`,
    'subagent-operator-actor',
  ],
  ['bs event append "$(cat /tmp/e.json)"', 'subagent-owned-event'],
  ['git update-ref refs/bs/e/t abc123', 'subagent-git-ref'],
  ['git update-ref -d refs/bs/e/t', 'subagent-git-ref'],
  ['git -C /x update-ref refs/bs/e/t HEAD', 'subagent-git-ref'],
  ['env GIT_DIR=x git update-ref refs/bs/a HEAD', 'subagent-git-ref'],
  ['git branch -f main HEAD', 'subagent-git-ref'],
  ['git branch -D master', 'subagent-git-ref'],
  ['git branch -M feat main', 'subagent-git-ref'],
  ['git branch -f bs/e/integration abc', 'subagent-git-ref'],
  ['git branch -D bs/e/integration', 'subagent-git-ref'],
  ['git push . HEAD:main', 'subagent-git-ref'],
  ['git push . abc:refs/heads/master', 'subagent-git-ref'],
  ['git push . +x:bs/e/integration', 'subagent-git-ref'],
  ['sh -c "git branch -f main HEAD"', 'subagent-git-ref'],
  ['echo x > /r/.git/refs/bs/e/t', 'subagent-git-ref'],
  ['tee /r/.git/refs/bs/e/t < f', 'subagent-git-ref'],
  ['echo x >> /w/state/events/sess.jsonl', 'subagent-state-write'],
  ['cp /tmp/a /w/.blacksmith/state/events/sess.jsonl', 'subagent-state-write'],
];

const ALLOWED: string[] = [
  'bs gate run --task t --actor coder',
  'bs gate run --task t',
  'bs waivers pending',
  'bs event tail s',
  'bs queue run --epic e',
  'bs results record --worktree /w',
  'bs session start w1 --continues e#3 --actor wave-runner',
  `bs event append '{"event_type":"dispatch_decision","actor":"wave-runner"}'`,
  `bs event append --state-dir x '{"event_type":"error-logged","actor":"wave-runner"}'`,
  'bs event append --session "$SID" \'{"event_type":"task-result-recorded","payload":{"run_status":"dead"}}\'',
  'node factory/orchestrator/dist/cli.js gate run --actor wave-runner',
  'echo bs waivers apply',
  'grep -n "waivers apply" docs/x.md',
  'git branch -f feature main',
  'git branch -D feature',
  'git branch --list',
  'git push . HEAD:feature',
  'git push origin feature',
  'git update-ref refs/heads/feature HEAD',
  'git log refs/bs/e/t',
  'git show-ref refs/bs/e/t',
  'cat /r/.git/refs/bs/e/t',
  'cat /w/state/events/sess.jsonl',
  'ls /w/state/events',
  'git commit -m "bs waivers apply --actor operator"',
];

describe('subagent refusals', () => {
  it.each(REFUSED)('refuses from a subagent: %s', (command, rule) => {
    const out = bash(command, true);
    expect(out, command).not.toBeNull();
    expect(out?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out?.hookSpecificOutput.permissionDecisionReason).toContain(rule);
    expect(out?.hookSpecificOutput.permissionDecisionReason).toMatch(/main session/);
  });

  it.each(REFUSED)('does not refuse the same command in the main session: %s', (command) => {
    const out = bash(command, false);
    // Another guard rule may refuse some of these (a branch force on main);
    // none of them may be a subagent rule.
    expect(out?.hookSpecificOutput.permissionDecisionReason ?? '').not.toMatch(/subagent-/);
  });

  it.each(ALLOWED)('allows from a subagent: %s', (command) => {
    expect(bash(command, true), command).toBeNull();
  });

  it('names the rule and where the operator runs it', () => {
    const text = reason('bs waivers apply');
    expect(text).toMatch(/^BLOCKED: /);
    expect(text).toContain('subagent-operator-verb');
    expect(text).toContain('main session');
  });

  it('refuses an unreadable line that holds a bs invocation', () => {
    expect(reason('bs waivers apply <(echo x)')).toContain('subagent-');
  });
});

describe('subagent writes to state the CLI owns', () => {
  const log = '/w/state/events/sess.jsonl';
  it.each(['Write', 'Edit', 'MultiEdit'])('refuses %s to an event log from a subagent', (tool) => {
    const out = decide(tool, { file_path: log }, true);
    expect(out?.hookSpecificOutput.permissionDecisionReason).toContain('subagent-state-write');
  });
  it('allows the same write from the main session', () => {
    expect(decide('Write', { file_path: log }, false)).toBeNull();
  });
  it('refuses a write under .git/refs/bs from a subagent', () => {
    const out = decide('Write', { file_path: '/r/.git/refs/bs/e/t' }, true);
    expect(out?.hookSpecificOutput.permissionDecisionReason).toContain('subagent-git-ref');
  });
  it('allows a fixture log under a test directory', () => {
    const f = '/r/factory/orchestrator/test/fixtures/state/events/s.jsonl';
    expect(decide('Write', { file_path: f }, true)).toBeNull();
  });
  it('allows other state a subagent owns', () => {
    expect(decide('Write', { file_path: '/w/state/results/t.json' }, true)).toBeNull();
    expect(decide('Write', { file_path: '/w/state/artifacts/t/x.md' }, true)).toBeNull();
  });
});

describe('the templates a subagent reads', () => {
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
  // The commands the templates tell a subagent to run: inline code spans and
  // fenced lines that start with `bs` or `smith`.
  const spans = files.flatMap((file) => {
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    const inline = [...text.matchAll(/`((?:bs|smith) [^`\n]+)`/g)].map((m) => m[1] as string);
    // A fenced command may continue over lines that end in a backslash.
    const joined = text.replace(/\\\n\s*/g, ' ').split('\n');
    const fenced = joined
      .map((line) => line.trim().replace(/^\$ /, ''))
      .filter((line) => /^(?:bs|smith) [a-z]/.test(line));
    // `bs event append` alone is the verb's name in prose, not a command.
    return [...inline, ...fenced]
      .filter((raw) => raw !== 'bs event append')
      .map((raw) => ({
        file,
        command: raw.replace(/<[^>]*>/g, 'x').replace(/\[[^\]]*\]/g, ''),
      }));
  });

  it('reads a useful number of commands', () => {
    expect(spans.length).toBeGreaterThan(70);
  });

  it('refuses none of them from a subagent', () => {
    // The verbs the templates hand to the operator or the epic session are not
    // a subagent's work: they are refused, and the allowlist test says which.
    const epicOnly =
      /^bs (?:plan (?:approve|amend)|epic (?:goal-check|spec-review)|agents sync|wave next|lessons compile|audit record|integration check)\b/;
    const refused = spans
      .filter(({ command }) => !epicOnly.test(command))
      .filter(({ command }) => bash(command, true) !== null)
      .map(({ file, command }) => `${file}: ${command}`);
    expect(refused).toEqual([]);
  });
});
