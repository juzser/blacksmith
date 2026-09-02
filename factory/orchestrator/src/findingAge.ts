/**
 * How long each of the daemon's findings has been standing.
 *
 * `daemon.ts` recomputes every finding from the event log on every tick, and
 * `writeStatus` overwrites the previous report with the new one. The result is
 * a watcher that says what is wrong with perfect accuracy and cannot say the
 * one thing an operator triages on: whether it started thirty seconds ago or
 * six days ago. That is the same distinction `FindingSeverity` already draws
 * one level up — `attention` means something is wrong NOW — carried down to
 * the individual finding, because a list where every line is equally urgent is
 * a list nobody reads twice.
 *
 * It is a fold over ticks rather than over events, which is why it lives here
 * and not in a projector. Nothing else in this repo has that shape: every
 * other fact the factory holds is derived from an append-only log and can be
 * recomputed from scratch, and this one cannot, because the log records what
 * happened and not what the watcher noticed. So the memory is deliberately
 * small, disposable and never load-bearing — losing the file costs one tick of
 * ages and nothing else, which is why the daemon reads it back defensively
 * rather than failing a tick over it.
 *
 * Pure. The disk work is the daemon loop's, next to `writeStatus`, so this
 * file can be read as "what counts as the same finding" and nothing else.
 */

import type { DaemonFinding } from './daemon.js';

/** A finding, plus how long the watcher has been looking at it. */
export interface AgedFinding extends DaemonFinding {
  /** When this finding was first seen standing, ISO-8601. */
  firstSeen: string;
  /** True when this tick is the first that saw it — the ones worth waking for. */
  isNew: boolean;
}

/** Finding identity -> when it was first seen. What a tick hands the next one. */
export type FindingMemory = Record<string, string>;

/**
 * What counts as the same finding across ticks: kind, session and subject.
 *
 * `detail` is excluded on purpose, and the exclusion is the whole design. A
 * detail carries the moving parts — a `recheck` says how many days have
 * elapsed, and that number moves every day the finding stands — so including
 * it would restart the clock on the longest-standing problems most often,
 * which is precisely backwards.
 *
 * `subject` IS included, and the consequence is worth stating rather than
 * hiding: two kinds put a count in their subject (`unattributed-spend`'s
 * "4 dispatch(es)", `maintenance`'s "/repo: 3 package(s)"), so a growing count
 * reads as a new finding. That is the more useful of the two readings. The
 * count moved because something new went unattributed or another package fell
 * behind, and an operator wants to be told that happened now — not shown a
 * six-day-old timestamp that quietly absorbed today's drift.
 *
 * The repo in front of `maintenance`'s count is load-bearing for the same
 * reason. That finding carries a null `sessionId` because it is about a
 * directory rather than a session, so the subject is the ONLY field left to
 * tell two repos apart — and a factory watching itself and two children would
 * otherwise file three repos that are each one package behind under one
 * identity, with two of them inheriting the first one's clock.
 *
 * `severity` is excluded because a finding that changes severity has not
 * changed what it is about, and the current severity is reported either way.
 *
 * JSON rather than a joined string: a subject is free text (filenames, counts,
 * ids), so any separator character could appear inside one, and two different
 * findings sharing an identity would silently merge their clocks. `null` also
 * encodes natively, so a repo-scoped finding can never collide with a session
 * whose id happens to be spelled like the placeholder.
 */
export function findingIdentity(finding: DaemonFinding): string {
  return JSON.stringify([finding.kind, finding.sessionId, finding.subject]);
}

/**
 * Date this tick's findings against what the last one remembered.
 *
 * Order is preserved: the caller's findings already arrive in the order the
 * daemon reports them, and re-sorting here would silently change the output of
 * `smith daemon status`.
 */
export function ageFindings(
  memory: FindingMemory,
  findings: readonly DaemonFinding[],
  now: Date,
): AgedFinding[] {
  const at = now.toISOString();
  return findings.map((finding) => {
    const seen = memory[findingIdentity(finding)];
    return seen === undefined
      ? { ...finding, firstSeen: at, isNew: true }
      : { ...finding, firstSeen: seen, isNew: false };
  });
}

/**
 * The memory to hand the next tick — built from THIS tick's findings alone.
 *
 * Nothing is carried forward for a finding that no longer stands, so a problem
 * that cleared and returned is new again. Dating it from the first occurrence
 * would report the factory as continuously broken since March when in fact it
 * was fixed and then broken a second time, and the second break is the one
 * that just happened.
 */
export function memoryOf(findings: readonly AgedFinding[]): FindingMemory {
  const memory: FindingMemory = {};
  for (const finding of findings) memory[findingIdentity(finding)] = finding.firstSeen;
  return memory;
}
