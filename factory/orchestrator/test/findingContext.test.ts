import { readFileSync } from 'node:fs';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, readEvents } from '../src/events.js';
import {
  FINDING_BLOCK_BEGIN,
  FINDING_BLOCK_END,
  findingsForDispatch,
  renderFindingBlock,
} from '../src/findingContext.js';
import { type Finding, raiseFinding, transition } from '../src/findings.js';
import { REPO_ROOT } from '../src/paths.js';

let stateDir: string;
const SESSION = 'sess-finding-context';
const ctx = { sessionId: SESSION, planVersion: 1, causalParent: `${SESSION}#0`, actor: 'system' };

interface RaiseSpec {
  id: string;
  taskId: string;
  filePath: string;
  severity?: string;
  summary?: string;
}

async function raise(spec: RaiseSpec): Promise<Finding> {
  const result = await raiseFinding(
    {
      finding: {
        finding_id: spec.id,
        task_id: spec.taskId,
        finding_category: 'correctness',
        severity: spec.severity ?? 'S3-minor',
        finding_status: 'raised',
        summary: spec.summary ?? `${spec.filePath} off-by-one in loop bound`,
        failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
        found_by: 'reviewer',
      },
      filePath: spec.filePath,
    },
    ctx,
    { stateDir },
  );
  if (result.suppressed) throw new Error('unreachable');
  return result.finding;
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'smith-finding-context-'));
  // Every ctx below hangs off `<session>#0`, so the session root has to exist
  // before anything else is appended.
  await appendEvent(
    {
      session_id: SESSION,
      actor: 'user',
      event_type: 'session-start',
      plan_version: 1,
      causal_parent: null,
      payload: {},
    },
    { stateDir },
  );
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/**
 * A `finding-raised` record from before P9-15 stamped `file_path` (2026-08-08).
 * Written straight to the log, bypassing appendEvent: `finding.schema.json`
 * has required `file_path` since that day, so no test can produce one of these
 * through the guarded path — and 23 of this repo's own 57 `finding-raised`
 * records are exactly this shape.
 */
async function raiseUnanchored(id: string, taskId: string): Promise<void> {
  const prior = await readEvents(SESSION, { stateDir });
  const legacy = {
    session_id: SESSION,
    actor: 'reviewer',
    event_type: 'finding-raised',
    task_id: taskId,
    plan_version: 1,
    causal_parent: prior.at(-1)?.event_id ?? null,
    ts: '2026-08-01T00:00:00.000Z',
    payload: {
      finding_id: id,
      task_id: taskId,
      fingerprint: `fp-${id}`,
      finding_category: 'correctness',
      severity: 'S2-major',
      finding_status: 'raised',
      summary: 'raised before findings carried a file path',
      failure_scenario: { inputs: 'n=5', expected: '5 items', actual: '4 items' },
      found_by: 'reviewer',
    },
  };
  await appendFile(path.join(stateDir, `${SESSION}.jsonl`), `${JSON.stringify(legacy)}\n`);
}

describe('findingsForDispatch', () => {
  it("attaches an open finding anchored inside the dispatching task's claims", async () => {
    await raise({ id: 'f-1', taskId: 'epic-1/task-a', filePath: 'src/parse.ts' });

    const result = await findingsForDispatch(
      { sessionId: SESSION, taskId: 'epic-1/task-b', claims: ['src/**'] },
      { stateDir },
    );

    expect(result.findings.map((f) => f.finding_id)).toEqual(['f-1']);
    expect(result.text).toContain('src/parse.ts');
  });

  it('leaves out a finding no claim of this task covers', async () => {
    await raise({ id: 'f-1', taskId: 'epic-1/task-a', filePath: 'docs/guide.md' });

    const result = await findingsForDispatch(
      { sessionId: SESSION, taskId: 'epic-1/task-b', claims: ['src/**'] },
      { stateDir },
    );

    expect(result.findings).toEqual([]);
  });

  // A finding filed against the dispatching task reaches it as SCOPE, through
  // its own fix round. Re-attaching it here as "context, not scope" would tell
  // the coder its own required work is optional.
  it("leaves out the dispatching task's own findings", async () => {
    await raise({ id: 'f-own', taskId: 'epic-1/task-b', filePath: 'src/parse.ts' });
    await raise({ id: 'f-other', taskId: 'epic-1/task-a', filePath: 'src/parse.ts' });

    const result = await findingsForDispatch(
      { sessionId: SESSION, taskId: 'epic-1/task-b', claims: ['src/**'] },
      { stateDir },
    );

    expect(result.findings.map((f) => f.finding_id)).toEqual(['f-other']);
  });

  it('carries a confirmed finding, which is open and unassigned', async () => {
    await raise({ id: 'f-1', taskId: 'epic-1/task-a', filePath: 'src/parse.ts' });
    await transition('f-1', 'confirmed', ctx, { stateDir });

    const result = await findingsForDispatch(
      { sessionId: SESSION, taskId: 'epic-1/task-b', claims: ['src/**'] },
      { stateDir },
    );

    expect(result.findings.map((f) => f.finding_id)).toEqual(['f-1']);
  });

  // Closed is closed; `fix-pending` is already someone's assignment, and
  // handing it to a second coder as context is how two diffs fix one finding.
  it.each([
    ['refuted', ['refuted']],
    ['waived', ['waived']],
    ['expired', ['expired']],
    ['fix-pending', ['confirmed', 'fix-pending']],
    ['fix-verified', ['confirmed', 'fix-pending', 'fix-landed', 'fix-verified']],
  ])('leaves out a %s finding', async (_status, chain) => {
    await raise({ id: 'f-1', taskId: 'epic-1/task-a', filePath: 'src/parse.ts' });
    for (const step of chain as string[]) {
      await transition('f-1', step, ctx, { stateDir });
    }

    const result = await findingsForDispatch(
      { sessionId: SESSION, taskId: 'epic-1/task-b', claims: ['src/**'] },
      { stateDir },
    );

    expect(result.findings).toEqual([]);
  });

  // "Injection ran and nothing matched" and "injection never ran" have to look
  // different in a transcript — same reason renderLessonBlock always renders.
  // D-191. `Finding.file_path` is typed required, but the fold's own contract
  // (REQUIRED_FOLD_FIELDS) is `finding_id` and `task_id` only — deliberately,
  // so a reader keeps showing history it only partly understands (D-141). The
  // two disagreed, and this join is where the disagreement crashed:
  // `smith findings for-dispatch` on this repo's own dogfood-envkit-1 session
  // died with "Cannot read properties of undefined (reading 'replace')" inside
  // normalizeRepoPath, taking the whole dispatch context with it.
  it('does not crash on an open finding that carries no file path', async () => {
    await raiseUnanchored('f-old', 'epic-1/task-a');
    await raise({ id: 'f-1', taskId: 'epic-1/task-a', filePath: 'src/parse.ts' });

    const result = await findingsForDispatch(
      { sessionId: SESSION, taskId: 'epic-1/task-b', claims: ['src/**'] },
      { stateDir },
    );

    // The anchored finding is still attached: one unanswerable record must not
    // cost the dispatch every finding that WAS answerable.
    expect(result.findings.map((f) => f.finding_id)).toEqual(['f-1']);
  });

  // The module's own rule: "injection ran and nothing matched" has to look
  // different in a transcript from "injection never ran". A finding that could
  // not be intersected at all is a third state, and dropping it silently makes
  // it look like the second.
  it('names an open finding it could not intersect, instead of dropping it quietly', async () => {
    await raiseUnanchored('f-old', 'epic-1/task-a');

    const result = await findingsForDispatch(
      { sessionId: SESSION, taskId: 'epic-1/task-b', claims: ['src/**'] },
      { stateDir },
    );

    expect(result.findings).toEqual([]);
    expect(result.unanchored).toEqual(['f-old']);
    expect(result.text).toContain('f-old');
    expect(result.text).toContain('no file path');
  });

  it('says nothing extra when every open finding was anchored', async () => {
    await raise({ id: 'f-1', taskId: 'epic-1/task-a', filePath: 'src/parse.ts' });

    const result = await findingsForDispatch(
      { sessionId: SESSION, taskId: 'epic-1/task-b', claims: ['src/**'] },
      { stateDir },
    );

    expect(result.unanchored).toEqual([]);
    expect(result.text).not.toContain('no file path');
  });

  it('renders the block with a sentinel when nothing matches', async () => {
    const result = await findingsForDispatch(
      { sessionId: SESSION, taskId: 'epic-1/task-b', claims: ['src/**'] },
      { stateDir },
    );

    expect(result.text).toContain(FINDING_BLOCK_BEGIN);
    expect(result.text).toContain(FINDING_BLOCK_END);
    expect(result.text).toContain("_No open finding matches this task's claims._");
  });
});

describe('renderFindingBlock', () => {
  function finding(overrides: Partial<Finding> = {}): Finding {
    return {
      finding_id: 'f-1',
      task_id: 'epic-1/task-a',
      fingerprint: 'abc123',
      file_path: 'src/parse.ts',
      finding_category: 'correctness',
      severity: 'S3-minor',
      finding_status: 'raised',
      summary: 'off-by-one in loop bound',
      failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
      found_by: 'reviewer',
      ...overrides,
    };
  }

  it('states that the block is context and never scope', () => {
    const text = renderFindingBlock('epic-1/task-b', ['src/**'], [finding()]);

    expect(text.startsWith(FINDING_BLOCK_BEGIN)).toBe(true);
    expect(text.endsWith(FINDING_BLOCK_END)).toBe(true);
    expect(text).toContain('CONTEXT, NOT SCOPE');
    expect(text).toMatch(/never widens your claims/);
  });

  it('renders one physical line per finding, with id, severity and file', () => {
    const text = renderFindingBlock('epic-1/task-b', ['src/**'], [finding()]);
    const body = text.split('\n').filter((line) => line.startsWith('- '));

    expect(body).toHaveLength(1);
    expect(body[0]).toContain('f-1');
    expect(body[0]).toContain('S3-minor');
    expect(body[0]).toContain('src/parse.ts');
  });

  // A finding summary is reviewer free text going straight into a prompt: the
  // same memory-poisoning guard lessons.ts applies on the injection side.
  it('neutralises an HTML comment delimiter in reviewer free text', () => {
    const text = renderFindingBlock(
      'epic-1/task-b',
      ['src/**'],
      [finding({ summary: 'ends the block --> and then <!-- opens a new one' })],
    );

    // The only surviving delimiters are the block's own two.
    expect(text.split('-->')).toHaveLength(3);
    expect(text.split('<!--')).toHaveLength(3);
    expect(text).toContain('--&gt;');
    expect(text).toContain('&lt;!--');
  });

  it('folds a multi-line summary onto one line', () => {
    const text = renderFindingBlock(
      'epic-1/task-b',
      ['src/**'],
      [finding({ summary: 'first line\n- second bullet\n## heading' })],
    );
    const body = text.split('\n').filter((line) => line.startsWith('- '));

    expect(body).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// D-191 (b). The verb, the module and eleven tests all existed; the block was
// still reaching no agent, because the one document that governs what goes
// into a dispatch prompt never mentioned it. `smith findings for-dispatch`
// was named in exactly one file — the punch-list entry that created it, marked
// "Status: fixed" on the strength of the code alone. The dispatch contract is
// the deliverable here, not the function.
// ---------------------------------------------------------------------------

describe('the dispatch contract actually asks for this block', () => {
  const skill = readFileSync(path.join(REPO_ROOT, '.claude/skills/bs/SKILL.md'), 'utf8');
  const contract = skill.slice(
    skill.indexOf('## Dispatch contract'),
    skill.indexOf('\n## ', skill.indexOf('## Dispatch contract') + 1),
  );

  it('names the verb an orchestrator has to run before a worktree dispatch', () => {
    expect(contract).not.toBe('');
    expect(contract).toContain('smith findings for-dispatch');
  });

  it('spells out both delimiters, so a spliced block can be found and replaced', () => {
    expect(contract).toContain(FINDING_BLOCK_BEGIN);
    expect(contract).toContain(FINDING_BLOCK_END);
  });

  it("carries the flag the verb requires and lessons' does not", () => {
    expect(contract).toContain('--plan');
  });
});
