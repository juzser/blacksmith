import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEvents } from '../src/events.js';
import { runGate, stageBoundCheckNames } from '../src/gate.js';
import type { CheckCommand } from '../src/testgate.js';
import { baseInput, createWorld, type World } from './helpers/paperworkFixtures.js';

describe('gate: runs the pre-merge tier only', () => {
  let w: World;

  beforeEach(async () => {
    w = await createWorld();
  });
  afterEach(async () => {
    await w.dispose();
  });

  const counter = () => path.join(w.elsewhereDir, 'counter');
  const ran = async (): Promise<string[]> =>
    (await readFile(counter(), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const check = (name: string, extra: Partial<CheckCommand> = {}): CheckCommand => ({
    name,
    cmd: `echo ${name} >> '${counter()}'`,
    heavy: false,
    ...extra,
  });

  async function events(type: string) {
    const all = await readEvents(w.sessionId, w.opts());
    return all.filter((e) => e.record.event_type === type);
  }

  it('names the stage-bound check', () => {
    expect(stageBoundCheckNames()).toEqual(['coverage']);
    expect(stageBoundCheckNames({ checkName: 'cov' })).toEqual(['cov']);
  });

  it('runs A then D only, and records tier, tree_sha and the deferred checks', async () => {
    const checks = [
      check('A'),
      check('B', { tier: 'post-merge', tierSource: 'declared' }),
      check('C', { tier: 'pre-release', tierSource: 'declared' }),
      check('D', { tier: 'pre-merge', tierSource: 'declared' }),
    ];
    const outcome = await runGate(baseInput(w, { checks }), w.ctx(), w.opts());
    expect(outcome.outcome).toBe('pass');
    expect(await ran()).toEqual(['A', 'D']);
    const [event] = await events('testgate-result');
    const payload = event?.record.payload as Record<string, unknown>;
    expect(payload.tier).toBe('pre-merge');
    expect(payload.tree_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(payload.tree_sha).toBe(w.git(['rev-parse', 'HEAD^{tree}']));
    expect(payload.deferred).toEqual([
      { name: 'B', tier: 'post-merge', tier_source: 'declared' },
      { name: 'C', tier: 'pre-release', tier_source: 'declared' },
    ]);
    expect((payload.results as { name: string }[]).map((r) => r.name)).toEqual(['A', 'D']);
  });

  it('refuses a non-empty file with no pre-merge check, before any event', async () => {
    const checks = [check('B', { tier: 'post-merge' }), check('C', { tier: 'pre-release' })];
    await expect(runGate(baseInput(w, { checks }), w.ctx(), w.opts())).rejects.toMatchObject({
      code: 'gate.no-pre-merge-checks',
    });
    expect(await ran()).toEqual([]);
    expect(await events('testgate-result')).toEqual([]);
    expect(await events('gate-outcome')).toEqual([]);
    expect(await events('schema-check-result')).toEqual([]);
  });

  it('refuses a deferred coverage check, before any event', async () => {
    const checks = [check('A'), check('coverage', { tier: 'post-merge' })];
    await expect(runGate(baseInput(w, { checks }), w.ctx(), w.opts())).rejects.toMatchObject({
      code: 'gate.stage-check-deferred',
      message: expect.stringContaining('coverage'),
    });
    expect(await events('gate-outcome')).toEqual([]);
    expect(await events('testgate-result')).toEqual([]);
  });

  it('honours a custom coverage check name', async () => {
    const checks = [check('A'), check('cov', { tier: 'post-merge' })];
    await expect(
      runGate(baseInput(w, { checks, coverage: { checkName: 'cov' } }), w.ctx(), w.opts()),
    ).rejects.toMatchObject({ code: 'gate.stage-check-deferred' });
  });

  it('lets a pre-merge coverage check run its stage as today', async () => {
    const checks = [check('coverage', { tier: 'pre-merge' })];
    await runGate(baseInput(w, { checks }), w.ctx(), w.opts());
    expect(await events('coverage-evidence')).toHaveLength(1);
  });

  it('passes an empty file as before, with deferred empty', async () => {
    const outcome = await runGate(baseInput(w, { checks: [] }), w.ctx(), w.opts());
    expect(outcome.outcome).toBe('pass');
    const [event] = await events('testgate-result');
    expect(event?.record.payload).toMatchObject({ pass: true, results: [], deferred: [] });
  });

  it('keeps an unlabelled file exactly as before apart from the new fields', async () => {
    await runGate(baseInput(w, { checks: [check('x'), check('y')] }), w.ctx(), w.opts());
    expect(await ran()).toEqual(['x', 'y']);
    const [event] = await events('testgate-result');
    const payload = event?.record.payload as { results: Record<string, unknown>[] };
    expect(payload).toMatchObject({ tier: 'pre-merge', deferred: [] });
    for (const r of payload.results) {
      expect(r.cmd_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.check_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
