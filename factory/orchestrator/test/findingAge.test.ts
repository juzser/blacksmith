import { describe, expect, it } from 'vitest';
import type { DaemonFinding } from '../src/daemon.js';
import { ageFindings, findingIdentity, memoryOf } from '../src/findingAge.js';

// ---------------------------------------------------------------------------
// How long a finding has been standing.
//
// `daemon.ts` recomputes every finding from the log on every tick, and
// `writeStatus` overwrites the last report with the new one. So the watcher
// reports what is wrong with perfect accuracy and cannot say one thing about
// it: whether it started thirty seconds ago or six days ago. Those are not
// the same fact, and an operator triaging a list of them is asking for
// exactly the one the daemon throws away every 300 seconds.
//
// The rule the tests below pin is that memory is built from what THIS tick
// saw and nothing else. A finding that cleared and came back is new again —
// dating it from the first occurrence would say the factory has been broken
// continuously when it was in fact fixed and broken a second time.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-02T12:00:00.000Z');
const EARLIER = '2026-08-30T09:00:00.000Z';

function finding(over: Partial<DaemonFinding> = {}): DaemonFinding {
  return {
    kind: 'budget',
    severity: 'attention',
    sessionId: 'sess-1',
    subject: 'epic-1',
    detail: 'spend is over the cap',
    ...over,
  };
}

describe('what makes two findings the same finding', () => {
  it('separates a repo-scoped finding from a session-scoped one that agrees on everything else', () => {
    // `sessionId: null` means "this is about the workshop". Collapsing it into
    // a session's finding of the same kind and subject would let one clear the
    // other's clock.
    const repo = finding({ sessionId: null, kind: 'maintenance', subject: '3 package(s)' });
    const session = finding({ sessionId: 'sess-1', kind: 'maintenance', subject: '3 package(s)' });
    expect(findingIdentity(repo)).not.toBe(findingIdentity(session));
  });

  it('does not restart the clock when only the wording of the detail moves', () => {
    // The load-bearing exclusion. A `recheck` detail carries "N day(s)
    // elapsed", which moves every single day the finding stands. If detail
    // were part of identity, the longest-standing findings in the repo would
    // report themselves as new most often — exactly backwards.
    const before = ageFindings({}, [finding({ detail: '3 day(s) elapsed' })], NOW);
    const memory = memoryOf(before);
    const after = ageFindings(memory, [finding({ detail: '4 day(s) elapsed' })], NOW);

    expect(after[0]?.firstSeen).toBe(NOW.toISOString());
    expect(after[0]?.isNew).toBe(false);
  });

  it('does start a new clock when the subject moves', () => {
    // The other side of the same choice, and a consequence worth stating
    // rather than hiding: two kinds put a count in their subject
    // (`unattributed-spend`, `maintenance`), so "4 dispatch(es)" becoming "5
    // dispatch(es)" reads as a new finding. That is the more useful of the two
    // readings — the count moved because something new went unattributed, and
    // an operator wants to know that happened now.
    const before = ageFindings({}, [finding({ subject: '4 dispatch(es)' })], NOW);
    const later = new Date('2026-09-02T13:00:00.000Z');
    const after = ageFindings(memoryOf(before), [finding({ subject: '5 dispatch(es)' })], later);

    expect(after[0]?.isNew).toBe(true);
    expect(after[0]?.firstSeen).toBe(later.toISOString());
  });
});

describe('what a tick remembers', () => {
  it('dates a finding nothing has seen before to now, and calls it new', () => {
    const aged = ageFindings({}, [finding()], NOW);
    expect(aged).toHaveLength(1);
    expect(aged[0]?.firstSeen).toBe(NOW.toISOString());
    expect(aged[0]?.isNew).toBe(true);
    // The finding itself must survive intact: aging annotates, it never edits.
    expect(aged[0]?.detail).toBe('spend is over the cap');
  });

  it('keeps the original date for a finding that is still standing', () => {
    const aged = ageFindings({ [findingIdentity(finding())]: EARLIER }, [finding()], NOW);
    expect(aged[0]?.firstSeen).toBe(EARLIER);
    expect(aged[0]?.isNew).toBe(false);
  });

  it('forgets a finding that has cleared', () => {
    const memory = { [findingIdentity(finding())]: EARLIER };
    const aged = ageFindings(memory, [], NOW);
    expect(aged).toEqual([]);
    expect(memoryOf(aged)).toEqual({});
  });

  it('calls a finding that cleared and came back new again', () => {
    // Deliberate. Dating it from the first occurrence would report the factory
    // as continuously broken since March when it was fixed in between — and
    // the second break is the one that just happened.
    const first = ageFindings({}, [finding()], new Date(EARLIER));
    const cleared = memoryOf(ageFindings(memoryOf(first), [], NOW));
    const again = ageFindings(cleared, [finding()], NOW);

    expect(again[0]?.isNew).toBe(true);
    expect(again[0]?.firstSeen).toBe(NOW.toISOString());
  });

  it('carries several findings independently in one tick', () => {
    const old = finding({ subject: 'epic-1' });
    const fresh = finding({ subject: 'epic-2' });
    const aged = ageFindings({ [findingIdentity(old)]: EARLIER }, [old, fresh], NOW);

    expect(aged.map((f) => f.isNew)).toEqual([false, true]);
    expect(memoryOf(aged)).toEqual({
      [findingIdentity(old)]: EARLIER,
      [findingIdentity(fresh)]: NOW.toISOString(),
    });
  });

  it('leaves the memory it was given untouched', () => {
    // ageFindings is asked for the next memory, not to mutate the last one:
    // the caller writes the result to disk and a silent in-place edit would
    // make the write and the report disagree about what happened.
    const memory = { [findingIdentity(finding())]: EARLIER };
    ageFindings(memory, [finding({ subject: 'epic-2' })], NOW);
    expect(memory).toEqual({ [findingIdentity(finding())]: EARLIER });
  });
});
