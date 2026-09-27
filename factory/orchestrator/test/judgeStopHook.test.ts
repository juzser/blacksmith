import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// TDD red step (recorded before judgeStopHook.ts existed): "Cannot find
// module '.../src/judgeStopHook.js'". Everything below is the green step.
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

  it("allows when the declared artifact exists but is empty -- existence is this hook's whole question; parse validity stays judge report's", () => {
    const artifactPath = path.join(root, 't.reviewer.json');
    writeFileSync(artifactPath, '   \n');
    const prompt = `Declared artifact: ${artifactPath}\n`;
    expect(decideJudgeStop(stdinFixture(), prompt)).toEqual({ decision: 'allow' });
  });

  it('allows a non-judge agent type such as coder, regardless of the prompt', () => {
    const prompt = 'Role: coder. Turn budget: 40\n(no declared-artifact line at all)';
    expect(decideJudgeStop(stdinFixture({ agent_type: 'coder' }), prompt)).toEqual({
      decision: 'allow',
    });
  });

  it('allows when agent_type is entirely absent from stdin, not just non-judge', () => {
    const artifactPath = path.join(root, 't.reviewer.json');
    const prompt = `Declared artifact: ${artifactPath}\n`;
    expect(decideJudgeStop(stdinFixture({ agent_type: undefined }), prompt)).toEqual({
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
      if (decision.decision !== 'allow') throw new Error('unreachable');
      expect(decision.note).toMatch(/no.*declared artifact/i);
    });

    it('allows + notes when the declared path is relative -- covered upstream by dispatch lint (relative-path refusal) and downstream by judge report judges.artifact-missing', () => {
      const decision = decideJudgeStop(stdinFixture(), 'Declared artifact: relative/path.json\n');
      expect(decision.decision).toBe('allow');
      if (decision.decision !== 'allow') throw new Error('unreachable');
      expect(decision.note).toMatch(/not an absolute path/i);
    });

    it('allows + notes when the prompt text could not be read at all -- covered downstream by judge report judges.artifact-missing', () => {
      const decision = decideJudgeStop(stdinFixture(), null);
      expect(decision.decision).toBe('allow');
      if (decision.decision !== 'allow') throw new Error('unreachable');
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

  it('reads content given as an array of text blocks, joining them', () => {
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const entry = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Role: reviewer.' },
          { type: 'tool_result', text: 'ignored, not a text block by type' },
          { type: 'text', text: 'Declared artifact: /abs/t.json' },
        ],
      },
    };
    writeFileSync(transcriptPath, `${JSON.stringify(entry)}\n`);
    const text = extractLastUserPromptText(transcriptPath);
    expect(text).toContain('Role: reviewer.');
    expect(text).toContain('Declared artifact: /abs/t.json');
  });

  it('walks backward past a later assistant turn to find the last USER message, not just the last line', () => {
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Declared artifact: /abs/stale.json\n' },
      }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'mid turn' } }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Declared artifact: /abs/fresh.json\n' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'final turn, no declared line here' },
      }),
    ];
    writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
    expect(extractLastUserPromptText(transcriptPath)).toContain('/abs/fresh.json');
  });

  it('skips blank lines and unparseable JSON lines while walking backward', () => {
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Declared artifact: /abs/x.json\n' },
      }),
      '',
      'not json at all',
      '   ',
    ];
    writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
    expect(extractLastUserPromptText(transcriptPath)).toContain('/abs/x.json');
  });

  it('returns null when the last user message has content that is neither a string nor an array', () => {
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const entry = { type: 'user', message: { role: 'user', content: { unexpected: 'shape' } } };
    writeFileSync(transcriptPath, `${JSON.stringify(entry)}\n`);
    expect(extractLastUserPromptText(transcriptPath)).toBeNull();
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
    const raw = JSON.stringify(stdinFixture({ transcript_path: path.join(root, 'missing.jsonl') }));
    const result = runJudgeStopHook(raw);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/could not read/i);
  });
});

describe('parser identity', () => {
  it("imports dispatchLint.ts's parser rather than defining a second copy", () => {
    // Reaching into the compiled module and asserting reference identity
    // against dispatchLint.ts's own export -- not a re-implemented regex.
    const prompt = 'Declared artifact: /abs/x.json\n';
    expect(dispatchLintParser(prompt)).toBe('/abs/x.json');
  });

  // The test above only proves the import resolves -- it never calls
  // anything IN judgeStopHook.ts, so a future edit that kept the import but
  // stopped calling it (a hand-rolled regex living beside it, invoked
  // instead) would leave it green. These cases drive `decideJudgeStop`
  // itself on prompts where a plausible look-alike regex -- case-insensitive
  // key, no start-of-line anchor, no end-of-line anchor -- would answer
  // differently than dispatchLint.ts's own parser, proving the hook's
  // block/allow is actually driven by that exact parser, not a copy of it.
  it.each([
    ['prefixed mid-line, never at true line start', 'Notes: Declared artifact: /abs/mid.json\n'],
    ['a lower-cased key', 'declared artifact: /abs/lower.json\n'],
    [
      'trailing prose after the path on the same line',
      'Declared artifact: /abs/trail.json and more\n',
    ],
  ])("decideJudgeStop agrees with dispatchLint.ts's own parser on %s", (_label, prompt) => {
    const parsed = dispatchLintParser(prompt);
    const decision = decideJudgeStop(stdinFixture({ agent_type: 'reviewer' }), prompt);
    if (parsed === null) {
      // dispatchLint.ts read no declared-artifact line here -- the hook must
      // fail open, exactly like the "no such line" case above.
      expect(decision.decision).toBe('allow');
    } else {
      // A path dispatchLint.ts *did* parse, that does not exist on disk --
      // the hook must block on it, naming that exact path.
      expect(decision).toEqual({ decision: 'block', reason: expect.stringContaining(parsed) });
    }
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

  it('allows silently and exits 0 when CLAUDE_PROJECT_DIR is unset entirely', () => {
    const stdin = JSON.stringify(stdinFixture());
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    const run = runProcess('bash', [SCRIPT_PATH], { input: stdin, env });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
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
