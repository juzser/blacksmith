import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from './helpers/cliHarness.js';

// A lesson's error class lives in the store (`lessons raise --error-class`),
// and `lessons compile` is what writes it to the markdown dispatch reads. A
// compile that drops it files every new lesson under other.unclassified.
describe('lessons compile keeps a store-only error class', () => {
  let scratch: string;
  let eventsDir: string;
  let dbPath: string;
  let outPath: string;
  const sessionId = `cli-compile-class-${Date.now()}`;

  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'smith-lessons-compile-'));
    eventsDir = path.join(scratch, 'events');
    dbPath = path.join(scratch, 'state.db');
    outPath = path.join(scratch, 'out', 'lessons.md');
    await mkdir(path.dirname(outPath), { recursive: true });

    const json = (r: { stdout: string; status: number }) => {
      expect(r.status, r.stdout).toBe(0);
      return JSON.parse(r.stdout);
    };
    const root = json(
      runCli([
        'event',
        'append',
        JSON.stringify({
          session_id: sessionId,
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: null,
          payload: {},
        }),
        '--state-dir',
        eventsDir,
      ]),
    ).event_id as string;
    const base = ['--session', sessionId, '--plan-version', '1', '--state-dir', eventsDir];
    const raised = json(
      runCli([
        'lessons',
        'raise',
        '--statement',
        'Name the gap in the spec before the code starts.',
        '--lesson-type',
        'rule',
        '--lesson-scope',
        'stack-wide',
        '--lesson-id',
        'lesson-store-class',
        '--provenance',
        root,
        '--error-class',
        'spec.spec-gap',
        '--causal-parent',
        root,
        ...base,
      ]),
    );
    json(
      runCli([
        'lessons',
        'approve',
        'lesson-store-class',
        '--causal-parent',
        raised.event_id as string,
        ...base,
      ]),
    );
    json(runCli(['db', 'apply', '--db', dbPath, '--session', sessionId, '--state-dir', eventsDir]));
  });

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  const compile = () => {
    const r = runCli(['lessons', 'compile', '--db', dbPath, '--out', outPath]);
    expect(r.status, r.stdout).toBe(0);
  };

  it('writes the error_class bullet for a lesson whose class is only in the store', () => {
    compile();
    expect(readFileSync(outPath, 'utf8')).toMatch(/^- error_class: spec\.spec-gap$/m);
  });

  it('lets for-dispatch read the class, with no unclassified warning', () => {
    compile();
    const r = runCli(['lessons', 'for-dispatch', 'coder', '--lessons', outPath, '--full']);
    expect(r.status, r.stdout).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.warnings.join('\n')).not.toContain('other.unclassified');
    expect(out.withheld).toContainEqual({
      lesson_id: 'lesson-store-class',
      error_class: 'spec.spec-gap',
    });
  });

  it('the store class beats a different class the file already carries', () => {
    compile();
    const md = readFileSync(outPath, 'utf8').replace(
      '- error_class: spec.spec-gap',
      '- error_class: execution.flaky-test',
    );
    writeFileSync(outPath, md, 'utf8');
    compile();
    expect(readFileSync(outPath, 'utf8')).toMatch(/^- error_class: spec\.spec-gap$/m);
    expect(readFileSync(outPath, 'utf8')).not.toContain('execution.flaky-test');
  });

  it('the withheld trailer quotes a command that runs', () => {
    compile();
    const r = runCli(['lessons', 'for-dispatch', 'coder', '--lessons', outPath]);
    expect(r.status, r.stdout).toBe(0);
    const text = JSON.parse(r.stdout).text as string;
    const quoted = /read with "bs (lessons for-dispatch [^"]+)"/.exec(text);
    expect(quoted, text).not.toBeNull();
    const args = (quoted as RegExpExecArray)[1]?.split(' ') as string[];
    expect(args.slice(0, 3)).toEqual(['lessons', 'for-dispatch', 'coder']);
    const run = runCli([...args, '--lessons', outPath]);
    expect(run.status, run.stdout).toBe(0);
  });
});
