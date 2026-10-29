import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTemplateMaxTurns } from '../src/agentsSync.js';
import { composeBrief } from '../src/briefCompose.js';
import { parseBriefMarker } from '../src/briefMarker.js';
import {
  GATE_CHECKS_HEADING,
  lintDispatchPrompt,
  parseDeclaredArtifactLine,
  parseStatedTurns,
} from '../src/dispatchLint.js';
import type { StoredEvent } from '../src/events.js';
import { appendEvent } from '../src/events.js';
import { recordJudgeDispatch } from '../src/judges.js';
import { REPO_ROOT } from '../src/paths.js';
import { sliceSection } from '../src/playbookSlice.js';
import { ORCHESTRATOR_OWNED_RESULT_FIELDS } from '../src/results.js';

// Epic bs-optimize criterion 5 (module half): composed briefs lint clean and
// carry the shared text sliced from the real dispatch.md.

const agentsDir = path.join(REPO_ROOT, '.claude', 'agents');
const realDispatch = path.join(REPO_ROOT, '.claude', 'skills', 'bs', 'dispatch.md');
const fixturePlan = path.join(__dirname, 'fixtures', 'brief-compose-plan.json');
const RETURN_HEADING = 'Return discipline (agent-interviews.md M-6)';
const NOW = new Date('2026-10-22T00:00:00.000Z');
const TASK = 'project-a/task-1-widget';
const sessionId = 'sess-brief-compose';

const LESSONS_MD = `## agent-role

### lesson-role: role

- lesson_id: lesson-role
- agent_role: grader
- error_class: execution.tool-failure
- statement: Role rule.

## claim-path

### lesson-claim: claim

- lesson_id: lesson-claim
- claim_path: src/**
- error_class: execution.tool-failure
- statement: Claim rule.

## stack-wide

### lesson-flaky: flaky

- lesson_id: lesson-flaky
- error_class: execution.flaky-test
- statement: Flaky rule.
`;

let dir: string;
let stateDir: string;
let specsDir: string;
let lessonsPath: string;
let worktree: string;
const events: StoredEvent[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'smith-brief-compose-'));
  stateDir = path.join(dir, 'state');
  specsDir = path.join(dir, 'specs');
  worktree = path.join(dir, 'wt', 'task-1-widget');
  lessonsPath = path.join(dir, 'lessons.md');
  await mkdir(path.join(specsDir, 'project-a'), { recursive: true });
  await writeFile(path.join(specsDir, 'project-a', 'epic-spec.md'), '# Epic\n');
  await writeFile(lessonsPath, LESSONS_MD);
  await appendEvent(
    {
      session_id: sessionId,
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
  await rm(dir, { recursive: true, force: true });
});

const base = () => ({
  taskId: TASK,
  planFile: fixturePlan,
  sessionId,
  worktree,
  specsDir,
  events,
  now: NOW,
  agentsDir,
  lessonsPath,
  eventOpts: { stateDir },
  provider: 'claude',
  modelTier: 'mid',
  base: 'bs/project-a/integration',
  workRoot: path.join(dir, 'work'),
  checks: [{ name: 'unit', cmd: 'run-the-suite' }],
});

const artifactFor = (role: string) => path.join(dir, 'artifacts', `${role}.json`);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? `other:${String(e)}`;
  }
  return 'no-throw';
}

describe('composeBrief (epic criterion 5, module half)', () => {
  it('composes coder, tester, grader and reviewer briefs that lint clean', async () => {
    const spec = JSON.parse(await readFile(fixturePlan, 'utf8')).tasks[0];
    const returnDiscipline = sliceSection(await readFile(realDispatch, 'utf8'), RETURN_HEADING);
    for (const role of ['coder', 'tester', 'grader', 'reviewer']) {
      const judge = role === 'grader' || role === 'reviewer';
      const artifactPath = artifactFor(role);
      if (judge) {
        await recordJudgeDispatch(
          { taskId: TASK, role, round: 1, artifactPath, model: 'claude-opus-5' },
          { sessionId, planVersion: 1, causalParent: `${sessionId}#0` },
          { stateDir },
        );
      }
      const { text, manifest } = await composeBrief({
        ...base(),
        role,
        ...(judge ? { artifactPath } : {}),
      });
      const report = await lintDispatchPrompt({
        prompt: text,
        role,
        taskId: TASK,
        sessionId,
        agentsDir,
        eventOpts: { stateDir },
      });
      expect(report.exitCode, role).toBe(0);
      expect(parseBriefMarker(text)).toEqual({ role, taskId: TASK, sessionId });
      expect(text.split('\n')[0]).toMatch(/^<!-- bs-brief /);
      expect(text).toContain(worktree);
      expect(text).toContain(`bs/${TASK}`);
      expect(text).toContain(JSON.stringify(spec, null, 2));
      expect(parseStatedTurns(text)).toBe(readTemplateMaxTurns(agentsDir, role));
      expect(text).toContain('Compiled lessons for this dispatch');
      expect(text).toContain(returnDiscipline);
      for (const field of ORCHESTRATOR_OWNED_RESULT_FIELDS) expect(text).toContain(field);
      expect(parseDeclaredArtifactLine(text)).toBe(judge ? artifactPath : null);
      expect(text).toContain('120000');
      expect(text).toContain('300');
      expect(manifest.sections.lessons).toBeGreaterThan(0);
      expect(manifest.sections.return_discipline).toBe(Buffer.byteLength(returnDiscipline));
    }
  });

  it('is deterministic for the same inputs', async () => {
    const a = await composeBrief({ ...base(), role: 'coder' });
    const b = await composeBrief({ ...base(), role: 'coder' });
    expect(a.text).toBe(b.text);
  });

  it('never declares an artifact for a coder, even when a path is passed', async () => {
    const { text } = await composeBrief({
      ...base(),
      role: 'coder',
      artifactPath: artifactFor('coder'),
    });
    expect(text).not.toContain('Declared artifact:');
  });

  it('lints "undeclared" when the grader has no ledger turn', async () => {
    const { text } = await composeBrief({
      ...base(),
      role: 'grader',
      artifactPath: artifactFor('grader'),
    });
    const report = await lintDispatchPrompt({
      prompt: text,
      role: 'grader',
      taskId: TASK,
      sessionId,
      agentsDir,
      eventOpts: { stateDir },
    });
    expect(report.artifact.status).toBe('undeclared');
    expect(report.exitCode).not.toBe(0);
  });

  it('refuses a turnBudget that differs from the template, and accepts the same one', async () => {
    const real = readTemplateMaxTurns(agentsDir, 'coder') as number;
    expect(await codeOf(composeBrief({ ...base(), role: 'coder', turnBudget: real + 1 }))).toBe(
      'brief.turns-mismatch',
    );
    const { text } = await composeBrief({ ...base(), role: 'coder', turnBudget: real });
    expect(parseStatedTurns(text)).toBe(real);
  });

  it('fails with a named error for a missing worktree, an unknown task and a judge with no artifact', async () => {
    const { worktree: _omit, ...noWorktree } = base();
    expect(await codeOf(composeBrief({ ...noWorktree, role: 'coder' }))).toBe(
      'brief.worktree-required',
    );
    expect(await codeOf(composeBrief({ ...base(), role: 'coder', worktree: 'rel/wt' }))).toBe(
      'brief.worktree-required',
    );
    expect(
      await codeOf(composeBrief({ ...base(), role: 'coder', taskId: 'project-a/task-9-none' })),
    ).toBe('brief.task-not-in-plan');
    expect(await codeOf(composeBrief({ ...base(), role: 'grader' }))).toBe(
      'brief.artifact-required',
    );
    expect(
      await codeOf(composeBrief({ ...base(), role: 'grader', artifactPath: 'rel/a.json' })),
    ).toBe('brief.artifact-required');
  });

  it('composes a spec entry that quotes the turn budget label mid-line, verbatim', async () => {
    const plan = JSON.parse(await readFile(fixturePlan, 'utf8'));
    const quote = 'State `Turn budget: N` and again `Turn budget: M` here.';
    plan.tasks[0].objective = quote;
    const planFile = path.join(dir, 'plan-v1.json');
    await writeFile(planFile, JSON.stringify(plan, null, 2));
    const { text } = await composeBrief({ ...base(), role: 'coder', planFile });
    expect(text).toContain(JSON.stringify(quote).slice(1, -1));
    const report = await lintDispatchPrompt({
      prompt: text,
      role: 'coder',
      taskId: TASK,
      sessionId,
      agentsDir,
      eventOpts: { stateDir },
    });
    expect(report.turns.status).toBe('ok');
    expect(report.turns.stated).toBe(readTemplateMaxTurns(agentsDir, 'coder'));
  });

  it('fails when spliced text adds a second standalone turn budget line', async () => {
    const doc = (await readFile(realDispatch, 'utf8')).replace(
      `## ${RETURN_HEADING}\n`,
      `## ${RETURN_HEADING}\n\nTurn budget: 3\n`,
    );
    const dispatchDoc = path.join(dir, 'extra-budget.md');
    await writeFile(dispatchDoc, doc);
    expect(await codeOf(composeBrief({ ...base(), role: 'coder', dispatchDoc }))).toBe(
      'brief.turn-budget-ambiguous',
    );
  });

  it('resolves the latest plan in specsDir and a bare task id when no planFile is given', async () => {
    await writeFile(path.join(specsDir, 'project-a', 'plan-v1.json'), await readFile(fixturePlan));
    const { planFile: _omit, ...rest } = base();
    const { text } = await composeBrief({
      ...rest,
      taskId: 'task-1-widget',
      epicId: 'project-a',
      role: 'coder',
    });
    expect(text).toContain('"task_id": "project-a/task-1-widget"');
    expect(text).toContain(path.join(specsDir, 'project-a', 'epic-spec.md'));
  });

  it('lists spliced and withheld lesson ids, finding ids and byte counts in the manifest', async () => {
    const { manifest, text } = await composeBrief({
      ...base(),
      role: 'grader',
      artifactPath: artifactFor('grader'),
    });
    expect(manifest.lessons_spliced).toEqual(['lesson-role']);
    expect(manifest.lessons_withheld).toEqual([
      { lesson_id: 'lesson-flaky', error_class: 'execution.flaky-test' },
    ]);
    expect(manifest.finding_ids).toEqual([]);
    for (const name of ['lessons', 'findings', 'spec', 'return_discipline', 'envelope']) {
      expect(manifest.sections[name], name).toBeGreaterThan(0);
    }
    expect(manifest.total_bytes).toBe(Buffer.byteLength(text));
  });

  it('writes the manifest only to the path the caller names', async () => {
    const manifestPath = path.join(dir, 'out', 'manifest.json');
    await mkdir(path.dirname(manifestPath));
    const { manifest } = await composeBrief({ ...base(), role: 'coder', manifestPath });
    expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual(manifest);
    const none = await composeBrief({ ...base(), role: 'coder' });
    expect(none.manifest.task_id).toBe(TASK);
  });

  it('composes a taskless epic-level brief without a spec entry or caps', async () => {
    const { taskId: _t, worktree: _w, planFile: _p, ...rest } = base();
    const { text } = await composeBrief({ ...rest, role: 'planner', epicId: 'project-a' });
    expect(parseBriefMarker(text)?.taskId).toBe('project-a');
    expect(text).not.toContain('Token cap');
    expect(text).toContain('Open findings across this epic');
  });
});

describe('composeBrief error codes and manifest depth', () => {
  it('fails brief.template-unreadable for a role with no template', async () => {
    expect(await codeOf(composeBrief({ ...base(), role: 'no-such-role' }))).toBe(
      'brief.template-unreadable',
    );
  });

  it('fails brief.epic-required for a bare task id or a taskless brief without an epicId', async () => {
    const { planFile: _p, ...rest } = base();
    expect(await codeOf(composeBrief({ ...rest, role: 'coder', taskId: 'task-1-widget' }))).toBe(
      'brief.epic-required',
    );
    const { taskId: _t, worktree: _w, ...noTask } = base();
    expect(await codeOf(composeBrief({ ...noTask, role: 'planner' }))).toBe('brief.epic-required');
  });

  it('fails brief.plan-not-found when specsDir holds no plan for the epic', async () => {
    const { planFile: _p, ...rest } = base();
    expect(await codeOf(composeBrief({ ...rest, role: 'coder' }))).toBe('brief.plan-not-found');
  });

  it('states the owned result fields in one envelope line', async () => {
    const { text } = await composeBrief({ ...base(), role: 'coder' });
    const lines = text.split('\n').filter((l) => l.startsWith('Result envelope:'));
    expect(lines).toHaveLength(1);
    for (const field of ORCHESTRATOR_OWNED_RESULT_FIELDS) {
      expect(lines[0], field).toContain(field);
    }
  });

  it('carries the return discipline as its own byte-exact section', async () => {
    const want = sliceSection(await readFile(realDispatch, 'utf8'), RETURN_HEADING);
    const { text, manifest } = await composeBrief({ ...base(), role: 'tester' });
    expect(text).toContain(`\n\n${want}\n\nResult envelope:`);
    expect(manifest.sections.return_discipline).toBe(Buffer.byteLength(want));
  });

  it('reports exact per-section bytes in text order, summing to the text', async () => {
    const { text, manifest } = await composeBrief({ ...base(), role: 'coder' });
    expect(Object.keys(manifest.sections)).toEqual([
      'header',
      'spec',
      'claims',
      'limits',
      'epic_spec',
      'lessons',
      'findings',
      'return_discipline',
      'envelope',
      'preflight',
      'gate_checks',
    ]);
    const sum = Object.values(manifest.sections).reduce((a, b) => a + b, 0);
    // sections are joined by a blank line and the text ends in one newline
    expect(manifest.total_bytes).toBe(sum + 2 * (Object.keys(manifest.sections).length - 1) + 1);
    expect(manifest.total_bytes).toBe(Buffer.byteLength(text));
    expect(manifest.sections.limits).toBe(
      Buffer.byteLength(
        `Token cap: 120000\nDiff cap: 300 lines\nTurn budget: ${readTemplateMaxTurns(agentsDir, 'coder')}`,
      ),
    );
  });

  it('declares the artifact for uiux and brackets a judge with the fingerprint commands', async () => {
    const artifactPath = artifactFor('uiux');
    const { text } = await composeBrief({ ...base(), role: 'uiux', artifactPath });
    expect(parseDeclaredArtifactLine(text)).toBe(artifactPath);
    expect(text).toContain(`bs worktree fingerprint ${worktree} > ${artifactPath}.before.json`);
    expect(text).toContain(`bs worktree verify ${worktree} --before ${artifactPath}.before.json`);
    const coder = await composeBrief({ ...base(), role: 'coder' });
    expect(coder.text).not.toContain('bs worktree fingerprint');
  });

  it('is deterministic for a judge brief and its manifest', async () => {
    const o = { ...base(), role: 'grader', artifactPath: artifactFor('grader') };
    const a = await composeBrief(o);
    const b = await composeBrief(o);
    expect(a).toEqual(b);
  });

  it('writes nothing but the manifest file into the tree it is given', async () => {
    const before = (await readdir(dir, { recursive: true })).sort();
    const manifestPath = path.join(dir, 'out', 'deep', 'manifest.json');
    await composeBrief({ ...base(), role: 'coder', manifestPath });
    const after = (await readdir(dir, { recursive: true })).sort();
    const added = after.filter((f) => !before.includes(f));
    expect(added).toEqual([
      'out',
      path.join('out', 'deep'),
      path.join('out', 'deep', 'manifest.json'),
    ]);
    const plain = (await readdir(dir, { recursive: true })).sort();
    await composeBrief({ ...base(), role: 'coder' });
    expect((await readdir(dir, { recursive: true })).sort()).toEqual(plain);
  });
});

describe('composeBrief shared text from dispatch.md (epic criterion 5)', () => {
  it('fails playbook.unknown-section when the heading is renamed', async () => {
    const doc = (await readFile(realDispatch, 'utf8')).replace(
      `## ${RETURN_HEADING}`,
      '## Return discipline renamed',
    );
    const dispatchDoc = path.join(dir, 'renamed.md');
    await writeFile(dispatchDoc, doc);
    expect(await codeOf(composeBrief({ ...base(), role: 'coder', dispatchDoc }))).toBe(
      'playbook.unknown-section',
    );
  });

  it('fails playbook.ambiguous-section when the heading appears twice', async () => {
    const doc = `${await readFile(realDispatch, 'utf8')}\n## ${RETURN_HEADING}\n\nAgain.\n`;
    const dispatchDoc = path.join(dir, 'twice.md');
    await writeFile(dispatchDoc, doc);
    expect(await codeOf(composeBrief({ ...base(), role: 'coder', dispatchDoc }))).toBe(
      'playbook.ambiguous-section',
    );
  });
});

// Task-8 close-review r2 (f-bs-gate-bounce/integration-fdeb317e and siblings):
// the composer writes each worker's filled preflight line and gate checks.
describe('composeBrief preflight and gate_checks sections', () => {
  const workRoot = () => path.join(dir, 'work');
  const lineOf = (text: string) =>
    text.split('\n').find((l) => l.startsWith('bs results check ')) as string;
  const flagNames = (line: string) => [...line.matchAll(/ --([a-z-]+)/g)].map((m) => m[1]);

  it('writes the coder line, Result file and gate_checks with absolute, filled values', async () => {
    const { text } = await composeBrief({ ...base(), role: 'coder' });
    const result = path.join(workRoot(), 'state', 'results', `${TASK}.json`);
    expect(text).toContain(`Result file: ${result}`);
    expect(text).toContain(
      'Hand-back preflight line (run it as your last step, exactly as written):',
    );
    expect(lineOf(text)).toBe(
      `bs results check ${TASK} --as coder --result ${result} --agent coder --provider claude --model-tier mid --worktree ${worktree} --base bs/project-a/integration --artifacts-dir ${path.join(workRoot(), 'state', 'artifacts')}`,
    );
    expect(text).toContain(`${GATE_CHECKS_HEADING}\n- unit (heavy):\n    run-the-suite\n`);
  });

  it('writes the tester its own result file and a --plan that is absolute even for a relative --plan', async () => {
    const rel = path.relative(process.cwd(), fixturePlan);
    const { text } = await composeBrief({ ...base(), role: 'tester', planFile: rel });
    const coderFile = path.join(workRoot(), 'state', 'results', `${TASK}.json`);
    const testerFile = path.join(workRoot(), 'state', 'results', `${TASK}.tester.json`);
    expect(testerFile).not.toBe(coderFile);
    expect(text).toContain(`Result file: ${testerFile}`);
    expect(lineOf(text)).toBe(
      `bs results check ${TASK} --as tester --result ${testerFile} --agent tester --provider claude --model-tier mid --plan ${fixturePlan} --artifacts-dir ${path.join(workRoot(), 'state', 'artifacts')}`,
    );
    expect(text).toContain(GATE_CHECKS_HEADING);
  });

  it('writes the grader line from its declared artifact with no Result file or gate_checks', async () => {
    const artifactPath = artifactFor('grader');
    const { text, manifest } = await composeBrief({ ...base(), role: 'grader', artifactPath });
    expect(lineOf(text)).toBe(
      `bs results check ${TASK} --as grader --grader ${artifactPath} --artifacts-dir ${path.join(workRoot(), 'state', 'artifacts')}`,
    );
    expect(text).not.toContain('Result file:');
    expect(manifest.sections).toHaveProperty('preflight');
    expect(manifest.sections).not.toHaveProperty('gate_checks');
  });

  it('keeps the flag names and order of the line in wave.md step 8 and in the role template', async () => {
    const wave = await readFile(path.join(REPO_ROOT, '.claude', 'skills', 'bs', 'wave.md'), 'utf8');
    for (const role of ['coder', 'tester', 'grader']) {
      const artifactPath = artifactFor(role);
      const { text } = await composeBrief({ ...base(), role, artifactPath });
      const documented = wave
        .split('\n')
        .find((l) => l.includes(`bs results check <task-id> --as ${role} `)) as string;
      expect(flagNames(lineOf(text))).toEqual(flagNames(documented));
      const template = await readFile(path.join(agentsDir, `bs-${role}.md`), 'utf8');
      const sample = template.split('\n').find((l) => l.includes(`--as ${role}`)) ?? documented;
      expect(flagNames(sample)).toEqual(flagNames(lineOf(text)));
    }
  });

  it('quotes a work root holding a space and a single quote as one word', async () => {
    const odd = path.join(dir, "it's a root");
    const { text } = await composeBrief({ ...base(), role: 'coder', workRoot: odd });
    const quoted = `'${path.join(odd, 'state', 'artifacts').replaceAll("'", "'\\''")}'`;
    expect(lineOf(text).endsWith(`--artifacts-dir ${quoted}`)).toBe(true);
    const report = await lintDispatchPrompt({
      prompt: text,
      role: 'coder',
      taskId: TASK,
      sessionId,
      agentsDir,
      eventOpts: { stateDir },
    });
    expect(report.preflight.status).toBe('ok');
  });

  it('marks a check heavy as isHeavyCheck says, lists commands verbatim and refuses none for their content', async () => {
    const checks = [
      { name: 'unit', cmd: 'a' },
      { name: 'lint', cmd: 'b' },
      { name: 'lint-heavy', cmd: 'c', heavy: true },
      { name: 'test', cmd: 'd', heavy: false },
      { name: 'odd', cmd: 'echo <x>\n\n  indented' },
    ];
    const { text } = await composeBrief({ ...base(), role: 'coder', checks });
    expect(text).toContain(
      `${GATE_CHECKS_HEADING}\n- unit (heavy):\n    a\n- lint:\n    b\n- lint-heavy (heavy):\n    c\n- test:\n    d\n- odd:\n    echo <x>\n    \n      indented\n`,
    );
  });

  it.each([
    ['missing', { name: 'x' }],
    ['numeric', { name: 'x', cmd: 7 }],
    ['empty', { name: 'x', cmd: '' }],
    ['blank', { name: 'x', cmd: '  \n ' }],
  ])('refuses a check whose cmd is %s, naming the check', async (_label, check) => {
    const err = await composeBrief({
      ...base(),
      role: 'coder',
      checks: [check as never],
    }).catch((e) => e as { code: string; message: string });
    expect((err as { code: string }).code).toBe('brief.invalid-value');
    expect((err as { message: string }).message).toContain('"x"');
    expect((err as { message: string }).message).toContain('cmd');
  });

  it('refuses missing values with brief.preflight-values-required naming each flag', async () => {
    const miss = async (role: string, drop: Record<string, undefined>) => {
      const err = (await composeBrief({
        ...base(),
        role,
        artifactPath: artifactFor(role),
        ...drop,
      }).catch((e) => e)) as { code: string; message: string };
      return err;
    };
    const coder = await miss('coder', {
      provider: undefined,
      modelTier: undefined,
      base: undefined,
      workRoot: undefined,
      checks: undefined,
    });
    expect(coder.code).toBe('brief.preflight-values-required');
    for (const f of ['--provider', '--model-tier', '--base', '--work-root', '--checks']) {
      expect(coder.message).toContain(f);
    }
    const noBase = await miss('tester', { base: undefined });
    expect(noBase).not.toBeInstanceOf(Error); // a tester takes no --base
    const tester = await miss('tester', { provider: undefined, workRoot: undefined });
    expect(tester.code).toBe('brief.preflight-values-required');
    expect(tester.message).not.toContain('--base');
    const grader = await miss('grader', { workRoot: undefined });
    expect(grader.code).toBe('brief.preflight-values-required');
    expect(grader.message).toContain('--work-root');
    const empty = await composeBrief({ ...base(), role: 'coder', checks: [] }).catch((e) => e);
    expect(empty.code).toBe('brief.preflight-values-required');
  });

  it('refuses a vocabulary miss, a relative work root and unsafe values as brief.invalid-value', async () => {
    const codeAndMessage = async (extra: Record<string, unknown>) => {
      const err = (await composeBrief({ ...base(), role: 'coder', ...extra }).catch((e) => e)) as {
        code: string;
        message: string;
      };
      return err;
    };
    const provider = await codeAndMessage({ provider: '<name>' });
    expect(provider.code).toBe('brief.invalid-value');
    expect(provider.message).toContain('--provider');
    expect(provider.message).toContain('claude, codex');
    const tier = await codeAndMessage({ modelTier: 'huge' });
    expect(tier.message).toContain('--model-tier');
    expect(tier.message).toContain('frontier, mid, small');
    const rel = await codeAndMessage({ workRoot: 'work' });
    expect(rel.code).toBe('brief.invalid-value');
    expect(rel.message).toContain('--work-root');
    for (const bad of ['a\nb', ' ', 'x\u0007y', '<ref>']) {
      const err = await codeAndMessage({ base: bad });
      expect(err.code).toBe('brief.invalid-value');
      expect(err.message).toContain('--base');
    }
    const badName = await codeAndMessage({ checks: [{ name: 'a\nb', cmd: 'x' }] });
    expect(badName.code).toBe('brief.invalid-value');
    const blankName = await codeAndMessage({ checks: [{ name: ' ', cmd: 'x' }] });
    expect(blankName.code).toBe('brief.invalid-value');
  });

  it('keeps every existing refusal first and the other roles unchanged', async () => {
    const noWorktree = await composeBrief({ ...base(), role: 'coder', worktree: undefined }).catch(
      (e) => e,
    );
    expect(noWorktree.code).toBe('brief.worktree-required');
    const noArtifact = await composeBrief({
      ...base(),
      role: 'grader',
      provider: undefined,
    }).catch((e) => e);
    expect(noArtifact.code).toBe('brief.artifact-required');
    const reviewer = await composeBrief({
      ...base(),
      role: 'reviewer',
      artifactPath: artifactFor('reviewer'),
      provider: undefined,
      workRoot: undefined,
      checks: undefined,
    });
    expect(Object.keys(reviewer.manifest.sections)).not.toContain('preflight');
    expect(reviewer.text).not.toContain('bs results check');
    const uiux = await composeBrief({ ...base(), role: 'uiux', artifactPath: artifactFor('uiux') });
    expect(Object.keys(uiux.manifest.sections)).not.toContain('preflight');
  });
});
