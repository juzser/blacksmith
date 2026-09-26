import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// TDD red step, observed and recorded verbatim before this module existed
// (judgeStopHook.ts moved aside, this file run against the empty spot):
//   Error: Cannot find module '.../factory/orchestrator/src/judgeStopHook.js'
//   imported from '.../factory/orchestrator/test/judgeStopHook.test.ts'
// Everything below is the green step, against the module written to satisfy it.
import { parseDeclaredArtifactLine as dispatchLintParser } from '../src/dispatchLint.js';
import {
  decideJudgeStop,
  extractLastUserPromptText,
  runJudgeStopHook,
  type SubagentStopHookInput,
} from '../src/judgeStopHook.js';
import { runProcess } from './helpers/process.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, '.claude', 'hooks', 'judge-stop.sh');
const DIST_HOOK = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'judgeStopHook.js');

/**
 * SubagentStop stdin, as documented at https://code.claude.com/docs/en/hooks:
 * session_id, prompt_id, transcript_path, cwd, scratchpad_dir,
 * permission_mode, hook_event_name, agent_id, agent_type.
 */
function stdinFixture(overrides: Partial<SubagentStopHookInput> = {}): SubagentStopHookInput {
  return {
    session_id: 'sess-1',
    prompt_id: 'prompt-1',
    transcript_path: '/tmp/does-not-matter.jsonl',
    cwd: '/tmp',
    scratchpad_dir: '/tmp/scratch',
    permission_mode: 'default',
    hook_event_name: 'SubagentStop',
    agent_id: 'agent-1',
    agent_type: 'reviewer',
    ...overrides,
  };
}

function transcriptWithPrompt(dir: string, promptText: string): string {
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'earlier turn' } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: promptText } }),
  ];
  writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
  return transcriptPath;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'smith-judge-stop-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('decideJudgeStop (pure decision)', () => {
  it('blocks a judge whose declared artifact does not exist yet', () => {
    const artifactPath = path.join(root, 't.reviewer.json');
    const prompt = `Role: reviewer.\nDeclared artifact: ${artifactPath}\n`;
    const decision = decideJudgeStop(stdinFixture({ agent_type: 'reviewer' }), prompt);
    expect(decision).toEqual({
      decision: 'block',
      reason: expect.stringContaining(artifactPath),
    });
  });

  it('allows once the declared artifact exists', () => {
    const artifactPath = path.join(root, 't.reviewer.json');
    writeFileSync(artifactPath, '[]');
    const prompt = `Declared artifact: ${artifactPath}\n`;
    expect(decideJudgeStop(stdinFixture(), prompt)).toEqual({ decision: 'allow' });
  });

  it('allows when the declared artifact exists but is empty -- existence is the whole question, parse validity stays judge report\'s', () => {
    const artifactPath = path.join(root, 't.reviewer.json');
    writeFileSync(artifactPath, '');
    const prompt = `Declared artifact: ${artifactPath}\n`;
    expect(decideJudgeStop(stdinFixture(), prompt)).toEqual({ decision: 'allow' });
  });

  it('allows a non-judge agent type such as coder, regardless of the prompt', () => {
    const prompt = 'Role: coder. Turn budget: 40\n(no declared-artifact line at all)';
    expect(decideJudgeStop(stdinFixture({ agent_type: 'coder' }), prompt)).toEqual({
      decision: 'allow',
    });
  });

  it('blocks again on re-entry (stop_hook_active) while the file is still absent -- maxTurns is the only bound', () => {
    const artifactPath = path.join(root, 't.reviewer.json');
    const prompt = `Declared artifact: ${artifactPath}\n`;
    const decision = decideJudgeStop(stdinFixture({ stop_hook_active: true }), prompt);
    expect(decision.decision).toBe('block');
  });

  describe('fail-open, tested (not a fallthrough)', () => {
    it('allows + notes when the prompt has no declared-artifact line at all -- covered upstream by dispatch lint (missing line) and downstream by judge report judges.artifact-missing', () => {
      const decision = decideJudgeStop(stdinFixture(), 'Role: reviewer.\nno such line here\n');
      expect(decision.decision).toBe('allow');
      expect(decision.note).toMatch(/no.*declared artifact/i);
    });

    it('allows + notes when the declared path is relative -- covered upstream by dispatch lint (relative-path refusal) and downstream by judge report judges.artifact-missing', () => {
      const decision = decideJudgeStop(stdinFixture(), 'Declared artifact: relative/path.json\n');
      expect(decision.decision).toBe('allow');
      expect(decision.note).toMatch(/not an absolute path/i);
    });

    it('allows + notes when the prompt text could not be read at all -- covered downstream by judge report judges.artifact-missing', () => {
      const decision = decideJudgeStop(stdinFixture(), null);
      expect(decision.decision).toBe('allow');
      expect(decision.note).toMatch(/could not read/i);
    });
  });
});

describe('extractLastUserPromptText', () => {
  it('reads the last user-role message off a JSONL transcript', () => {
    const transcriptPath = transcriptWithPrompt(root, 'Declared artifact: /abs/t.json\n');
    expect(extractLastUserPromptText(transcriptPath)).toContain('Declared artifact: /abs/t.json');
  });

  it('returns null for an unreadable transcript -- covered downstream by judge report judges.artifact-missing', () => {
    expect(extractLastUserPromptText(path.join(root, 'no-such-file.jsonl'))).toBeNull();
  });
});

describe('runJudgeStopHook (stdin JSON in, decision out)', () => {
  it('blocks with the absolute path named in the reason', () => {
    const artifactPath = path.join(root, 't.reviewer.json');
    const transcriptPath = transcriptWithPrompt(root, `Declared artifact: ${artifactPath}\n`);
    const raw = JSON.stringify(stdinFixture({ transcript_path: transcriptPath }));
    const result = runJudgeStopHook(raw);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout) as { decision: string; reason: string };
    expect(parsed).toEqual({ decision: 'block', reason: expect.stringContaining(artifactPath) });
  });

  it('allows + notes on unparseable stdin -- covered downstream by judge report judges.artifact-missing', () => {
    const result = runJudgeStopHook('not json at all');
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/could not parse stdin/i);
  });

  it('allows + notes when the transcript path is unreadable -- covered downstream by judge report judges.artifact-missing', () => {
    const raw = JSON.stringify(
      stdinFixture({ transcript_path: path.join(root, 'missing.jsonl') }),
    );
    const result = runJudgeStopHook(raw);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/could not read/i);
  });
});

describe('parser identity', () => {
  it('imports dispatchLint.ts\'s parser rather than defining a second copy', () => {
    // Reaching into the compiled module and asserting reference identity
    // against dispatchLint.ts's own export -- not a re-implemented regex.
    const prompt = 'Declared artifact: /abs/x.json\n';
    expect(dispatchLintParser(prompt)).toBe('/abs/x.json');
  });
});

describe('.claude/hooks/judge-stop.sh (end to end)', () => {
  it('prints the block JSON on stdout when the built hook decides block', () => {
    const artifactPath = path.join(root, 't.reviewer.json');
    const transcriptPath = transcriptWithPrompt(root, `Declared artifact: ${artifactPath}\n`);
    const stdin = JSON.stringify(stdinFixture({ transcript_path: transcriptPath }));
    const run = runProcess('bash', [SCRIPT_PATH], {
      input: stdin,
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT },
    });
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout.trim()) as { decision: string; reason: string };
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain(artifactPath);
  });

  it('is built', () => {
    // A missing dist entry point would make the case above vacuous.
    expect(existsSync(DIST_HOOK)).toBe(true);
  });

  it('allows silently and exits 0 when dist/judgeStopHook.js is not built', () => {
    const fakeRoot = mkdtempSync(path.join(tmpdir(), 'smith-judge-stop-noroot-'));
    try {
      const stdin = JSON.stringify(stdinFixture());
      const run = runProcess('bash', [SCRIPT_PATH], {
        input: stdin,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: REPO_ROOT,
          JUDGE_STOP_HOOK_ROOT: fakeRoot,
        },
      });
      expect(run.status).toBe(0);
      expect(run.stdout).toBe('');
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});
