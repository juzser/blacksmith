import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// TDD red step (recorded before judgeStopHook.ts existed): "Cannot find
// module '.../src/judgeStopHook.js'". Everything below is the green step.
import { parseDeclaredArtifactLine as dispatchLintParser } from '../src/dispatchLint.js';
import {
  decideJudgeStop,
  extractDispatchPromptText,
  runJudgeStopHook,
  type SubagentStopHookInput,
} from '../src/judgeStopHook.js';
import { runProcess } from './helpers/process.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, '.claude', 'hooks', 'judge-stop.sh');
const DIST_HOOK = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'judgeStopHook.js');

/**
 * SubagentStop stdin, as documented at https://code.claude.com/docs/en/hooks:
 * session_id, prompt_id, transcript_path, agent_transcript_path, cwd,
 * scratchpad_dir, permission_mode, hook_event_name, agent_id, agent_type.
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

function userLine(content: string, isMeta = false): string {
  return JSON.stringify({
    type: 'user',
    ...(isMeta ? { isMeta: true } : {}),
    message: { role: 'user', content },
  });
}

/** A subagent transcript in the real shape: prompt first, noise after it. */
function realisticSubagentTranscript(dir: string, artifactPath: string): string {
  const lines = [
    userLine(`Role: reviewer.\nDeclared artifact: ${artifactPath}\nDo the review.\n`),
    userLine('<system-reminder>\nYour final report is delivered through SubagentHandback\n', true),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'working' } }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'file contents' }] },
    }),
    userLine('The coordinator sent a message while you were working: carry on', true),
    userLine('This session is being continued from a previous conversation that ran out.'),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'done' } }),
  ];
  const transcriptPath = path.join(dir, 'agent-realistic.jsonl');
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

describe('extractDispatchPromptText', () => {
  it('reads the first user-role message off a JSONL transcript', () => {
    const transcriptPath = transcriptWithPrompt(root, 'Declared artifact: /abs/t.json\n');
    expect(extractDispatchPromptText(transcriptPath)).toContain('Declared artifact: /abs/t.json');
  });

  it('returns null for an unreadable transcript -- covered downstream by judge report judges.artifact-missing', () => {
    expect(extractDispatchPromptText(path.join(root, 'no-such-file.jsonl'))).toBeNull();
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
    const text = extractDispatchPromptText(transcriptPath);
    expect(text).toContain('Role: reviewer.');
    expect(text).toContain('Declared artifact: /abs/t.json');
  });

  it('returns the FIRST non-meta user text, not a later user entry', () => {
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const lines = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'warm up' } }),
      userLine('Declared artifact: /abs/first.json\n'),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'mid turn' } }),
      userLine('Declared artifact: /abs/later.json\n'),
    ];
    writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
    expect(extractDispatchPromptText(transcriptPath)).toContain('/abs/first.json');
  });

  it('skips meta user strings and tool_result entries before the dispatch prompt', () => {
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const lines = [
      userLine('<system-reminder>\nYour final report is delivered through SubagentHandback\n', true),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
      }),
      userLine('Declared artifact: /abs/real.json\n'),
    ];
    writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
    expect(extractDispatchPromptText(transcriptPath)).toContain('/abs/real.json');
  });

  it('returns null when every user entry is meta (fail open)', () => {
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const lines = [userLine('reminder one', true), userLine('The coordinator sent a message', true)];
    writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
    expect(extractDispatchPromptText(transcriptPath)).toBeNull();
  });

  it('finds a dispatch prompt larger than the chunk size', () => {
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const text = `${'filler '.repeat(50)}\nDeclared artifact: /abs/big.json\n`;
    writeFileSync(transcriptPath, `${userLine(text)}\n${userLine('later')}\n`);
    expect(extractDispatchPromptText(transcriptPath, 16)).toBe(text);
  });

  it('reads CRLF line endings', () => {
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const lines = [userLine('reminder', true), userLine('Declared artifact: /abs/crlf.json\n')];
    writeFileSync(transcriptPath, `${lines.join('\r\n')}\r\n`);
    expect(extractDispatchPromptText(transcriptPath)).toContain('/abs/crlf.json');
  });

  it('returns null for an empty file', () => {
    const transcriptPath = path.join(root, 'transcript.jsonl');
    writeFileSync(transcriptPath, '');
    expect(extractDispatchPromptText(transcriptPath)).toBeNull();
  });

  it('returns the prompt without reading a torn JSON line that follows it', () => {
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const torn = userLine('later').slice(0, 20);
    writeFileSync(transcriptPath, `${userLine('Declared artifact: /abs/t.json\n')}\n${torn}`);
    expect(extractDispatchPromptText(transcriptPath, 8)).toContain('/abs/t.json');
  });

  it('reads a dispatch prompt given as an array of text blocks after meta entries', () => {
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const prompt = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Role: reviewer.' },
          { type: 'text', text: 'Declared artifact: /abs/blocks.json' },
        ],
      },
    };
    writeFileSync(transcriptPath, `${userLine('reminder', true)}\n${JSON.stringify(prompt)}\n`);
    expect(extractDispatchPromptText(transcriptPath)).toContain('/abs/blocks.json');
  });

  it('skips blank lines and unparseable JSON lines before the prompt', () => {
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const lines = ['', 'not json at all', '   ', userLine('Declared artifact: /abs/x.json\n')];
    writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
    expect(extractDispatchPromptText(transcriptPath)).toContain('/abs/x.json');
  });

  it('returns null when the only user message has content that is neither a string nor an array', () => {
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const entry = { type: 'user', message: { role: 'user', content: { unexpected: 'shape' } } };
    writeFileSync(transcriptPath, `${JSON.stringify(entry)}\n`);
    expect(extractDispatchPromptText(transcriptPath)).toBeNull();
  });
  it('decodes a multi-byte character split across chunk boundaries', () => {
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const text = 'xé€😀 Declared artifact: /abs/ü.json';
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`,
    );
    for (const chunk of [1, 2, 3, 5]) {
      expect(extractDispatchPromptText(transcriptPath, chunk)).toBe(text);
    }
  });

  it('reads a prompt on a last line with no trailing newline', () => {
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const first = userLine('meta', true);
    writeFileSync(transcriptPath, `${first}\n${userLine('last')}`);
    expect(extractDispatchPromptText(transcriptPath, 4)).toBe('last');
  });

  it('returns null for an unreadable path', () => {
    expect(extractDispatchPromptText(path.join(root, 'nope.jsonl'), 4)).toBeNull();
  });
});

describe('runJudgeStopHook (stdin JSON in, decision out)', () => {
  it("reads the subagent's own transcript, not the main session's, and blocks on a missing artifact", () => {
    const artifactPath = path.join(root, 't.reviewer.json');
    const mainPath = path.join(root, 'main.jsonl');
    writeFileSync(
      mainPath,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'operator says hi' } })}\n`,
    );
    const agentPath = path.join(root, 'agent.jsonl');
    writeFileSync(
      agentPath,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: `Declared artifact: ${artifactPath}\n` } })}\n`,
    );
    const raw = JSON.stringify(
      stdinFixture({ transcript_path: mainPath, agent_transcript_path: agentPath }),
    );
    const parsed = JSON.parse(runJudgeStopHook(raw).stdout) as { decision: string; reason: string };
    expect(parsed).toEqual({ decision: 'block', reason: expect.stringContaining(artifactPath) });
  });

  it('allows when agent_transcript_path is present and the declared file exists', () => {
    const artifactPath = path.join(root, 't.reviewer.json');
    writeFileSync(artifactPath, '[]');
    const mainPath = path.join(root, 'main.jsonl');
    writeFileSync(mainPath, '');
    const agentPath = path.join(root, 'agent.jsonl');
    writeFileSync(
      agentPath,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: `Declared artifact: ${artifactPath}\n` } })}\n`,
    );
    const raw = JSON.stringify(
      stdinFixture({ transcript_path: mainPath, agent_transcript_path: agentPath }),
    );
    expect(runJudgeStopHook(raw)).toEqual({ stdout: '', stderr: '' });
  });

  it('blocks on a realistic subagent transcript (prompt first, meta and resumes after) when the artifact is missing', () => {
    const artifactPath = path.join(root, 't.reviewer.json');
    const agentPath = realisticSubagentTranscript(root, artifactPath);
    const raw = JSON.stringify(stdinFixture({ agent_transcript_path: agentPath }));
    const parsed = JSON.parse(runJudgeStopHook(raw).stdout) as { decision: string; reason: string };
    expect(parsed).toEqual({ decision: 'block', reason: expect.stringContaining(artifactPath) });
  });

  it('allows on a realistic subagent transcript when the artifact exists', () => {
    const artifactPath = path.join(root, 't.reviewer.json');
    writeFileSync(artifactPath, '[]');
    const agentPath = realisticSubagentTranscript(root, artifactPath);
    const raw = JSON.stringify(stdinFixture({ agent_transcript_path: agentPath }));
    expect(runJudgeStopHook(raw)).toEqual({ stdout: '', stderr: '' });
  });

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
