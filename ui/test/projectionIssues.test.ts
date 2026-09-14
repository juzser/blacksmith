import { describe, expect, it } from 'vitest';
import type { ProjectionIssue, PulseResult } from '../src/lib/api.js';
import { projectionNotice } from '../src/lib/projectionIssues.js';

function pulse(projectionIssues?: ProjectionIssue[]): PulseResult {
  return {
    lastEventAt: '2026-09-14T09:00:00.000Z',
    lastEventType: 'task-result-recorded',
    counts: { events: 12, errors: 0 },
    lessonsPending: 0,
    ...(projectionIssues ? { projectionIssues } : {}),
  };
}

const notProjected: ProjectionIssue = {
  sessionId: 'sess-broken',
  kind: 'session-not-projected',
  message: "could not project session 'sess-broken': Line 2 of sess-broken.jsonl is not JSON",
};
const artifactsSkipped: ProjectionIssue = {
  sessionId: 'sess-1',
  kind: 'artifacts-skipped',
  eventId: 'sess-1#7',
  message: "artifacts of 'task-2' (sess-1#7) are missing from the projection: not an array",
};

describe('lib/projectionIssues.ts — projectionNotice', () => {
  it('is silent before the first poll lands', () => {
    expect(projectionNotice(null)).toBeNull();
  });

  it('is silent when a server predates the field, not only when the list is empty', () => {
    // An older server omits `projectionIssues` altogether. "The server did not
    // say" must read as "nothing to report", never as a crash in the shell.
    expect(projectionNotice(pulse())).toBeNull();
    expect(projectionNotice(pulse([]))).toBeNull();
  });

  it('names every issue in the server’s own words, in the server’s order', () => {
    const notice = projectionNotice(pulse([notProjected, artifactsSkipped]));
    expect(notice?.lines).toEqual([notProjected.message, artifactsSkipped.message]);
  });

  it('counts sessions in the lead, not issues — one broken log is one problem', () => {
    const twice: ProjectionIssue = { ...artifactsSkipped, eventId: 'sess-1#9', message: 'second' };
    expect(projectionNotice(pulse([notProjected]))?.lead).toMatch(/^1 session /);
    expect(projectionNotice(pulse([artifactsSkipped, twice]))?.lead).toMatch(/^1 session /);
    expect(projectionNotice(pulse([notProjected, artifactsSkipped, twice]))?.lead).toMatch(
      /^2 sessions /,
    );
  });

  it('says what the gap costs: everything below is computed without those events', () => {
    expect(projectionNotice(pulse([notProjected]))?.lead).toContain('computed without');
  });
});
