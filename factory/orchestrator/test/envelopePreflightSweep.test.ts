import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The static guard behind envelopePreflight.test.ts. Which verbs write outside
// the log (a worktree, a plan version, a branch, an overlay file, an external
// process) before they append was swept by hand; this keeps the sweep honest.
// A handler that still builds its context with the plain
// `eventContextFromFlags(flags)` is, by this list, append-only: its first act
// is the append, so the guard under the log lock is enough. Add a verb that
// writes first and it must use `pinnedEventContext`, or be added here with the
// reason it does not need to.

const APPEND_ONLY = new Set([
  "namespace === 'audit' && action === 'record'",
  "namespace === 'audit' && action === 'decide'",
  "namespace === 'audit' && action === 'cut'",
  "namespace === 'audit' && action === 'resolve'",
  "namespace === 'plan' && action === 'ingest'",
  "namespace === 'plan' && action === 'propose'",
  "namespace === 'plan' && action === 'reject'",
  "namespace === 'wave' && action === 'check'",
  "namespace === 'scheduler' && action === 'run'", // plain form only on --dry, which appends nothing
  "namespace === 'prompt' && action === 'record'",
  "namespace === 'feedback' && action === 'record'",
  "namespace === 'feedback' && action === 'resolve'",
  "namespace === 'queue' && action === 'adopt'",
  "namespace === 'results' && action === 'record'",
  "namespace === 'uiux' && action === 'check'",
  "namespace === 'epic' && action === 'spec-review'",
  "namespace === 'epic' && action === 'goal-check'",
  "namespace === 'findings' && action === 'raise'",
  "namespace === 'findings' && action === 'transition'",
  "namespace === 'findings' && action === 'reverify'",
  "namespace === 'findings' && action === 'repair-obligation'",
  "namespace === 'task' && action === 'reinstate'",
  "namespace === 'waivers' && action === 'approve-task'",
  "namespace === 'waivers' && action === 'apply'",
  "namespace === 'lessons' && action === 'raise'",
  "namespace === 'lessons' && (action === 'approve' || action === 'reject')",
  "namespace === 'dream'",
  "namespace === 'judge' && action === 'dispatch'",
  "namespace === 'judge' && action === 'report'",
]);

const PINNED = [
  "namespace === 'audit' && action === 'open'",
  "namespace === 'audit' && action === 'close'",
  "namespace === 'plan' && action === 'quorum'",
  "namespace === 'plan' && action === 'amend'",
  "namespace === 'plan' && action === 'approve'",
  "namespace === 'scheduler' && action === 'run'",
  "namespace === 'queue' && action === 'run'",
  "namespace === 'gate' && action === 'run'",
  "namespace === 'integration' && action === 'check'",
  "namespace === 'epic' && action === 'verdict'",
  "namespace === 'epic' && action === 'close'",
  "namespace === 'checks' && action === 'post-merge'",
  "namespace === 'crossfind'",
];

describe('the pre-flight sweep stays complete', () => {
  const source = readFileSync(path.join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');
  const chunks = source.split(/\n {2}if \((?=namespace === )/).slice(1);
  const keyOf = (chunk: string) => chunk.slice(0, chunk.indexOf(') {'));

  it('every verb that writes outside the log pins its parent at pre-flight', () => {
    for (const key of PINNED) {
      const chunk = chunks.find((c) => keyOf(c) === key);
      expect(chunk, key).toBeDefined();
      expect(chunk, key).toMatch(/pinnedEventContext\(|checksEnvelope\(/);
    }
  });

  it('every other handler that builds a plain context is on the append-only list', () => {
    const offenders = chunks
      .filter((c) => /(?<!await pinnedEventContext\()eventContextFromFlags\(flags\)/.test(c))
      .map(keyOf)
      .filter((key) => !APPEND_ONLY.has(key));
    expect(offenders).toEqual([]);
  });
});
