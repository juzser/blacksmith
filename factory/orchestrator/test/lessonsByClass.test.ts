import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { templateFileFor } from '../src/agentNames.js';
import type { StoredEvent } from '../src/events.js';
import { lessonsForDispatch } from '../src/lessons.js';

const NOW = new Date('2026-10-22T00:00:00.000Z');
const RECENT = '2026-10-20T00:00:00.000Z';

const LESSONS_MD = `## agent-role

### lesson-role: role

- lesson_id: lesson-role
- agent_role: coder
- error_class: execution.tool-failure
- statement: Role rule.

## claim-path

### lesson-claim: claim

- lesson_id: lesson-claim
- claim_path: src/**
- error_class: execution.tool-failure
- statement: Claim rule.

## case-type

### lesson-case: case

- lesson_id: lesson-case
- case_type: feature
- error_class: execution.flaky-test
- statement: Case rule.

## stack-wide

### lesson-flaky: flaky

- lesson_id: lesson-flaky
- error_class: execution.flaky-test
- statement: Flaky rule.

### lesson-unclassified: other

- lesson_id: lesson-unclassified
- error_class: other.unclassified
- statement: Unclassified rule.

### lesson-none: none

- lesson_id: lesson-none
- statement: No class rule.

### lesson-stale: stale

- lesson_id: lesson-stale
- error_class: execution.no-such-class
- statement: Stale class rule.

## security

### lesson-sec: sec

- lesson_id: lesson-sec
- error_class: memory.poisoning-suspected
- statement: Security rule.
`;

let n = 0;
function logged(
  error: string,
  opts: { task?: string; ref?: string; epic?: string; ts?: string } = {},
): StoredEvent {
  n += 1;
  return {
    event_id: `s:${n}`,
    record: {
      session_id: 's',
      actor: 'orchestrator',
      event_type: 'error-logged',
      plan_version: 1,
      causal_parent: null,
      ts: opts.ts ?? RECENT,
      ...(opts.task ? { task_id: opts.task } : {}),
      payload: {
        error,
        severity: 'S3-minor',
        ...(opts.ref ? { task_ref: opts.ref } : {}),
        ...(opts.epic ? { epic_id: opts.epic } : {}),
      },
    },
  };
}

const flaky = (ref: string, extra: { epic?: string; ts?: string } = {}) =>
  logged('execution.flaky-test', { ref, ...extra });

describe('lessonsForDispatch by recurring class (epic criteria 3 and 4)', () => {
  let dir: string;
  let agentsDir: string;
  let lessonsPath: string;

  function run(
    role: string,
    opts: { events?: StoredEvent[]; epicId?: string; full?: boolean; class?: string } = {},
  ) {
    return lessonsForDispatch(role, ['src/a.ts'], {
      agentsDir,
      lessonsPath,
      caseType: 'feature',
      now: NOW,
      events: [],
      ...opts,
    });
  }
  const ids = (r: ReturnType<typeof run>) => (r.lessons ?? []).map((l) => l.lessonId);

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'smith-by-class-'));
    agentsDir = path.join(dir, 'agents');
    mkdirSync(agentsDir);
    lessonsPath = path.join(dir, 'lessons.md');
    writeFileSync(lessonsPath, LESSONS_MD);
    const all =
      '<!-- LESSONS:agent-role -->\n<!-- LESSONS:claim-path -->\n<!-- LESSONS:case-type -->\n' +
      '<!-- LESSONS:stack-wide -->\n<!-- LESSONS:security -->\n';
    writeFileSync(path.join(agentsDir, templateFileFor('coder')), all);
    writeFileSync(path.join(agentsDir, templateFileFor('security-reviewer')), all);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('splices a class logged on 3 distinct tasks in 30 days', () => {
    const r = run('coder', { full: true, events: [flaky('e1/a'), flaky('e1/b'), flaky('e2/c')] });
    expect(ids(r)).toEqual(['lesson-role', 'lesson-claim', 'lesson-case', 'lesson-flaky']);
    expect(r.text).not.toContain('Withheld lessons (class not recurring): execution.flaky-test');
  });

  it('splices every approved lesson for the role when no events option is passed, with no withheld line', () => {
    const r = lessonsForDispatch('coder', ['src/a.ts'], {
      agentsDir,
      lessonsPath,
      caseType: 'feature',
      now: NOW,
    });
    expect(ids(r)).toEqual(
      expect.arrayContaining(['lesson-role', 'lesson-claim', 'lesson-case', 'lesson-flaky']),
    );
    expect(r.withheld).toEqual([]);
    expect(r.text).not.toContain('Withheld lessons');
  });

  it('withholds class lessons and prints the withheld line when events is an empty array', () => {
    const r = run('coder', { full: true, events: [] });
    expect(ids(r)).not.toContain('lesson-flaky');
    expect(r.withheld.length).toBeGreaterThan(0);
    expect(r.text).toContain('Withheld lessons (class not recurring)');
  });

  it('withholds a class with 2 tasks and names it, its count and the read command', () => {
    const r = run('coder', { full: true, events: [flaky('e1/a'), flaky('e1/b')] });
    expect(ids(r)).not.toContain('lesson-flaky');
    expect(r.withheld).toContainEqual({
      lesson_id: 'lesson-flaky',
      error_class: 'execution.flaky-test',
    });
    const lines = r.text.split('\n');
    const trailer = lines[lines.length - 2] as string;
    expect(trailer).toContain('execution.flaky-test (2 tasks');
    expect(trailer).toContain('bs lessons for-dispatch --class execution.flaky-test');
  });

  it('does not count an event older than 30 days', () => {
    const old = '2026-09-01T00:00:00.000Z';
    const r = run('coder', {
      full: true,
      events: [flaky('e1/a'), flaky('e1/b'), flaky('e2/c', { ts: old })],
    });
    expect(ids(r)).not.toContain('lesson-flaky');
  });

  it('splices a class repeated once in the dispatch epic, and only for that epic', () => {
    const events = [flaky('e1/a')];
    expect(ids(run('coder', { full: true, events, epicId: 'e1' }))).toContain('lesson-flaky');
    expect(ids(run('coder', { full: true, events, epicId: 'e2' }))).not.toContain('lesson-flaky');
    expect(ids(run('coder', { full: true, events }))).not.toContain('lesson-flaky');
  });

  it('withholds other.unclassified without recurrence and splices it on a repeat', () => {
    expect(run('coder', { full: true }).withheld.map((w) => w.lesson_id)).toContain(
      'lesson-unclassified',
    );
    const r = run('coder', {
      full: true,
      epicId: 'e1',
      events: [logged('other.unclassified', { ref: 'e1/a' })],
    });
    expect(ids(r)).toContain('lesson-unclassified');
  });

  it('reads a class-less or stale-class lesson as other.unclassified, with a warning', () => {
    const r = run('coder', { full: true });
    expect(r.withheld).toContainEqual({
      lesson_id: 'lesson-none',
      error_class: 'other.unclassified',
    });
    expect(r.withheld).toContainEqual({
      lesson_id: 'lesson-stale',
      error_class: 'other.unclassified',
    });
    const warnings = r.warnings.join('\n');
    expect(warnings).toContain('lesson-none');
    expect(warnings).toContain('lesson-stale');
    expect(warnings).toContain('execution.no-such-class');
    const spliced = run('coder', {
      full: true,
      epicId: 'e1',
      events: [logged('other.unclassified', { ref: 'e1/a' })],
    });
    expect(ids(spliced)).toEqual(expect.arrayContaining(['lesson-none', 'lesson-stale']));
  });

  it('never withholds agent-role or claim-path lessons', () => {
    const r = run('coder', { full: true });
    expect(ids(r)).toEqual(['lesson-role', 'lesson-claim']);
    expect(r.withheld.map((w) => w.lesson_id)).not.toContain('lesson-role');
  });

  it('withholds a non-recurring security lesson from other roles but nothing from a security-reviewer', () => {
    expect(run('coder', { full: true }).withheld.map((w) => w.lesson_id)).toContain('lesson-sec');
    expect(run('coder', { full: true }).withheld).toContainEqual({
      lesson_id: 'lesson-sec',
      error_class: 'memory.poisoning-suspected',
    });
    const r = run('security-reviewer', { full: true });
    expect(r.withheld).toEqual([]);
    expect(ids(r)).toContain('lesson-sec');
  });

  it('omits the lessons array unless full, and class returns exactly that class', () => {
    expect(run('coder').lessons).toBeUndefined();
    const r = run('coder', { class: 'execution.flaky-test' });
    expect(ids(r)).toEqual(['lesson-case', 'lesson-flaky']);
    expect(r.text).toContain('Flaky rule.');
    expect(r.text).not.toContain('Role rule.');
  });

  it('refuses events without a clock', () => {
    expect(() =>
      lessonsForDispatch('coder', [], { agentsDir, lessonsPath, events: [flaky('e1/a')] }),
    ).toThrow(expect.objectContaining({ code: 'lessons.events-need-now' }));
  });

  describe('event identity', () => {
    const flakyIds = (events: StoredEvent[], epicId?: string) =>
      ids(run('coder', { full: true, events, ...(epicId ? { epicId } : {}) }));

    it('(a) counts an event carrying only the envelope task_id, under that task epic', () => {
      const e = logged('execution.flaky-test', { task: 'e1/a' });
      expect(flakyIds([e], 'e1')).toContain('lesson-flaky');
      expect(flakyIds([e], 'e2')).not.toContain('lesson-flaky');
    });

    it('(b) three events of one class on one task are one task, not a recurrence', () => {
      expect(flakyIds([flaky('e1/a'), flaky('e1/a'), flaky('e1/a')])).not.toContain('lesson-flaky');
    });

    it('(c) payload.epic_id wins over the task id epic', () => {
      const events = [flaky('e1/a', { epic: 'e9' })];
      expect(flakyIds(events, 'e9')).toContain('lesson-flaky');
      expect(flakyIds(events, 'e1')).not.toContain('lesson-flaky');
    });

    it('(d) skips an event with no task identity; an unqualified task counts store-wide only', () => {
      const none = logged('execution.flaky-test');
      expect(flakyIds([none, flaky('e1/b'), flaky('e1/c')])).not.toContain('lesson-flaky');
      const loose = [flaky('loose-1'), flaky('loose-2'), flaky('loose-3')];
      expect(flakyIds(loose)).toContain('lesson-flaky');
      expect(flakyIds([loose[0] as StoredEvent], 'loose-1')).not.toContain('lesson-flaky');
    });
  });
});
