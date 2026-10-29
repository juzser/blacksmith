import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventTaskId, readEvents } from '../src/events.js';
import { type GateOutcome, runGate } from '../src/gate.js';
import { readRecurrenceEvents } from '../src/lessonEvents.js';
import { errorClassCounts } from '../src/lessonRecurrence.js';
import { SLEEP_GAP_MS } from '../src/testgate.js';
import { baseInput, createWorld, stampedResult, type World } from './helpers/paperworkFixtures.js';

/** Hands out `values` in order, one per read. */
function sequence(values: number[]): () => number {
  const rest = [...values];
  return () => {
    const next = rest.shift();
    if (next === undefined) throw new Error('source read more often than the test planned');
    return next;
  };
}

/** One wall/monotonic pair per check: the gap of check n is `gaps[n]`. */
function sources(gaps: number[], load = 0.1) {
  return {
    wallMs: sequence(gaps.flatMap((gap) => [0, gap])),
    monotonicMs: sequence(gaps.flatMap(() => [0, 0])),
    load1m: () => load,
    cpus: () => 1,
  };
}

describe('gate: environment evidence on a failed test run', () => {
  let w: World;

  beforeEach(async () => {
    w = await createWorld();
  });
  afterEach(async () => {
    await w.dispose();
  });

  const counter = () => path.join(w.elsewhereDir, 'counter');
  const lines = async (): Promise<number> =>
    (await readFile(counter(), 'utf8')).split('\n').filter(Boolean).length;
  const passing = (name: string) => ({
    name,
    cmd: `echo ${name} >> '${counter()}'`,
    heavy: false,
  });
  const failing = (name: string) => ({
    name,
    cmd: `echo ${name} >> '${counter()}'; exit 1`,
    heavy: false,
  });

  async function payloadOf(type: string): Promise<Record<string, unknown>> {
    const events = await readEvents(w.sessionId, w.opts());
    const found = events.filter((e) => e.record.event_type === type).at(-1);
    if (!found) throw new Error(`no ${type} event`);
    return found.record.payload as Record<string, unknown>;
  }

  function blocked(outcome: GateOutcome) {
    if (outcome.outcome !== 'blocked') throw new Error(`expected blocked, got ${outcome.outcome}`);
    return outcome;
  }

  it('classifies a failed check whose own clock gap shows the machine slept, and runs it once', async () => {
    const outcome = blocked(
      await runGate(
        baseInput(w, {
          checks: [failing('slept')],
          environmentSources: sources([SLEEP_GAP_MS]),
        }),
        w.ctx(),
        w.opts(),
      ),
    );
    expect(outcome).toMatchObject({
      outcome: 'blocked',
      reason: 'tests-failed',
      error_class: 'execution.env-failure',
    });
    expect(outcome.environmentEvidence).toEqual([
      expect.objectContaining({ name: 'slept', window: 'command', clock_gap_ms: SLEEP_GAP_MS }),
    ]);
    for (const type of ['testgate-result', 'gate-outcome']) {
      const payload = await payloadOf(type);
      expect(payload.error_class).toBe('execution.env-failure');
      expect(payload.environment_evidence).toEqual(outcome.environmentEvidence);
    }
    expect(await payloadOf('gate-outcome')).toMatchObject({
      outcome: 'blocked',
      reason: 'tests-failed',
    });
    expect(await payloadOf('testgate-result')).toMatchObject({
      environment: [expect.objectContaining({ name: 'slept' })],
    });
    expect(await lines()).toBe(1);
  });

  it('leaves a failure under very high load but no gap as a plain tests-failed block', async () => {
    const outcome = blocked(
      await runGate(
        baseInput(w, { checks: [failing('loaded')], environmentSources: sources([0], 100) }),
        w.ctx(),
        w.opts(),
      ),
    );
    expect(outcome.reason).toBe('tests-failed');
    expect(outcome.error_class).toBeUndefined();
    expect(outcome.environmentEvidence).toBeUndefined();
    expect((await payloadOf('gate-outcome')).error_class).toBeUndefined();
    expect((await payloadOf('testgate-result')).error_class).toBeUndefined();
  });

  it('never classifies a run that passes, whatever its gap', async () => {
    const outcome = await runGate(
      baseInput(w, {
        checks: [passing('slept-but-green')],
        environmentSources: sources([SLEEP_GAP_MS * 4]),
      }),
      w.ctx(),
      w.opts(),
    );
    expect(outcome.outcome).toBe('pass');
    expect((await payloadOf('testgate-result')).error_class).toBeUndefined();
    expect((await payloadOf('gate-outcome')).error_class).toBeUndefined();
  });

  it("does not let a passed check's gap classify another check's failure", async () => {
    const outcome = blocked(
      await runGate(
        baseInput(w, {
          checks: [passing('a'), failing('b')],
          environmentSources: sources([SLEEP_GAP_MS * 2, 0]),
        }),
        w.ctx(),
        w.opts(),
      ),
    );
    expect(outcome.reason).toBe('tests-failed');
    expect(outcome.error_class).toBeUndefined();
    expect(await lines()).toBe(2);
  });

  it('runs each check once in the classified case', async () => {
    await runGate(
      baseInput(w, {
        checks: [passing('a'), failing('b')],
        environmentSources: sources([0, SLEEP_GAP_MS]),
      }),
      w.ctx(),
      w.opts(),
    );
    expect(await lines()).toBe(2);
  });

  it('counts a classified block as env-failure and an unclassified one as test-failure', async () => {
    const second = 'epic-1/task-2';
    await runGate(
      baseInput(w, { checks: [failing('slept')], environmentSources: sources([SLEEP_GAP_MS]) }),
      w.ctx(),
      w.opts(),
    );
    await runGate(
      baseInput(w, {
        taskId: second,
        result: stampedResult({ task_id: second }),
        checks: [failing('plain')],
        environmentSources: sources([0]),
      }),
      w.ctx(),
      w.opts(),
    );
    const window = { now: new Date(), windowDays: 30 };
    const events = await readRecurrenceEvents(w.stateDir, window);
    const counts = errorClassCounts(events, window);
    expect(counts.get('execution.env-failure')?.tasks).toBe(1);
    expect(counts.get('execution.test-failure')?.tasks).toBe(1);
    const classified = events.filter(
      (e) => (e.record.payload as Record<string, unknown>).error_class === 'execution.env-failure',
    );
    expect(classified.map((e) => eventTaskId(e.record))).toEqual([w.taskId]);
  });
});
