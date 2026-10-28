import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceWaveStep } from '../src/playbookSlice.js';

// Finding f-bs-optimize/integration-a2f0a33f, playbook half: run.md names who
// admits and drops "one wave at a time"; wave.md step 10 says how the merge
// queue takes turns and splits merge-queue admission from admitting work.

const root = path.resolve(__dirname, '../../..');
const skill = (name: string): string =>
  readFileSync(path.join(root, '.claude/skills/bs', name), 'utf8');

const run = skill('run.md');
const wave = skill('wave.md');

/** Collapse whitespace so a rule is matched across a hard-wrapped line break. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('run.md: rolling admission and who admits', () => {
  const rolling = (): string => {
    const start = run.indexOf('**Rolling admission.**');
    const end = run.indexOf('**Then check that it did.**');
    expect(start, 'no Rolling admission paragraph').toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return flat(run.slice(start, end));
  };

  it('no longer says one wave at a time, and says waves overlap', () => {
    expect(flat(run)).not.toMatch(/one wave at a time/i);
    expect(rolling()).toMatch(/waves overlap/i);
  });

  it('keeps "after every merge, run `bs wave next` and admit"', () => {
    expect(rolling()).toMatch(/after every merge, run `bs wave next`[^.]{0,80}admit/i);
  });

  it('names the epic session as the only session that admits, right after each landing', () => {
    const text = rolling();
    expect(text).toMatch(/epic session is the only session that admits/i);
    expect(text).toMatch(/right after each landing/i);
  });

  it('covers the inline shape: a bs queue run it ran returned merged', () => {
    expect(rolling()).toMatch(/inline[^.]{0,80}`bs queue run`[^.]{0,60}returns `merged`/i);
  });

  it('covers the dispatched runner: background agent, event tail watched with Monitor', () => {
    const text = rolling();
    expect(text).toContain('`bs-wave-runner`');
    expect(text).toContain('`run_in_background: true`');
    expect(text).toContain('`bs event tail <session-id> --lineage --follow`');
    expect(text).toContain('Monitor tool');
    expect(text).toMatch(/on each `wave-merged`[^.]{0,200}`bs wave next`[^.]{0,100}at once/i);
    expect(text).toMatch(/as a wave of its own/i);
  });

  it('says a runner never admits tasks to work and only queues its own passed tasks', () => {
    expect(rolling()).toMatch(
      /runner never admits tasks to work[^.]{0,120}only queues its own passed tasks with `bs queue run`/i,
    );
  });

  it('runs the wave inline or in a driven session when the Agent call cannot run in the background', () => {
    expect(rolling()).toMatch(
      /cannot run in the background[^.]{0,200}inline or in a session[^.]{0,60}drives[^.]{0,80}never as a blocking runner/i,
    );
  });
});

describe('wave.md step 10: the merge queue takes turns', () => {
  const step = (): string => flat(sliceWaveStep(wave, 10));

  it('holds the heavy lock per task from the rebase through the merge, so queue runs take turns', () => {
    const text = step();
    expect(text).toMatch(
      /`bs queue run` holds the heavy lock for each task from its rebase through its merge/,
    );
    expect(text).toMatch(/queue runs of one epic take turns/i);
    expect(text).toMatch(/cumulative suite runs on the head it lands on/i);
  });

  it('says what integration-moved means and to re-run bs queue run for those tasks', () => {
    expect(step()).toMatch(
      /`integration-moved`[^.]{0,160}outside the queue[^.]{0,120}nothing landed[^.]{0,120}re-run `bs queue run`/i,
    );
  });

  it('splits merge-queue admission (the runner) from admitting tasks to work (the epic session)', () => {
    const text = step();
    expect(text).toMatch(
      /admitting the wave's own passed tasks into the merge queue \(`bs queue run`\) is the runner's job/i,
    );
    expect(text).toMatch(
      /admitting tasks to work \(`bs wave next`, `bs wave check`\) is the epic session's/i,
    );
    expect(text).toMatch(/runner never runs `bs wave next` to admit/i);
  });

  it('keeps the three merge-queue admission phrases and qualifies them as merge-queue admission', () => {
    const text = step();
    expect(text).toContain('before admitting to the merge queue');
    expect(text).toContain('keep going to merge-queue admission');
    expect(text).toContain('Then admit into the merge queue');
    expect(text).not.toMatch(/before admitting,/);
    expect(text).not.toMatch(/keep going to admission/);
  });
});
