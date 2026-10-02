import { describe, expect, it } from 'vitest';
import type { MilestoneProgress } from '../src/lib/api.js';
import { defaultSelection } from '../src/lib/roadmapSelection.js';

function milestone(overrides: Partial<MilestoneProgress>): MilestoneProgress {
  return {
    milestoneId: 'phase-1',
    name: 'Phase 1',
    status: 'in-progress',
    sequence: 1,
    goal: null,
    epicIds: [],
    tasksTotal: 0,
    tasksCompleted: 0,
    tokensSpent: 0,
    tokensBudget: null,
    unmeasured: 0,
    project: 'demo',
    kind: 'product',
    startedAt: null,
    finishedAt: null,
    epics: [],
    statusCounts: { done: 0, review: 0, inProgress: 0, todo: 0 },
    ...overrides,
  };
}

describe('defaultSelection', () => {
  it('picks the phase holding an actively running epic', () => {
    const milestones = [
      milestone({ milestoneId: 'phase-1', sequence: 1, epicIds: ['epic-a'] }),
      milestone({ milestoneId: 'phase-2', sequence: 2, epicIds: ['epic-b'] }),
    ];
    const result = defaultSelection(milestones, ['epic-b'], ['epic-b'], {});
    expect(result).toEqual({ phaseId: 'phase-2', epicId: null });
  });

  it('falls back to the most recent phase by startedAt when nothing is running', () => {
    const milestones = [
      milestone({ milestoneId: 'phase-1', sequence: 1, startedAt: '2026-01-01T00:00:00.000Z' }),
      milestone({ milestoneId: 'phase-2', sequence: 2, startedAt: '2026-02-01T00:00:00.000Z' }),
    ];
    const result = defaultSelection(milestones, [], [], {});
    expect(result).toEqual({ phaseId: 'phase-2', epicId: null });
  });

  it('breaks startedAt ties by sequence', () => {
    const milestones = [
      milestone({ milestoneId: 'phase-1', sequence: 1, startedAt: null }),
      milestone({ milestoneId: 'phase-2', sequence: 2, startedAt: null }),
    ];
    const result = defaultSelection(milestones, [], [], {});
    expect(result).toEqual({ phaseId: 'phase-2', epicId: null });
  });

  it('defaults to the first selectable epic when the project has no phases', () => {
    const result = defaultSelection([], [], ['epic-a', 'epic-b'], {});
    expect(result).toEqual({ phaseId: null, epicId: 'epic-a' });
  });

  it('returns nulls when a no-phase project has no selectable epics either', () => {
    const result = defaultSelection([], [], [], {});
    expect(result).toEqual({ phaseId: null, epicId: null });
  });

  it('lets a `?phase=` URL param win over the computed default', () => {
    const milestones = [milestone({ milestoneId: 'phase-1', epicIds: ['epic-a'] })];
    const result = defaultSelection(milestones, ['epic-a'], ['epic-a'], { phase: 'phase-9' });
    expect(result).toEqual({ phaseId: 'phase-9', epicId: null });
  });

  it('lets a `?epic=` URL param win over the computed default', () => {
    const milestones = [milestone({ milestoneId: 'phase-1', epicIds: ['epic-a'] })];
    const result = defaultSelection(milestones, ['epic-a'], ['epic-a'], { epic: 'epic-z' });
    expect(result).toEqual({ phaseId: null, epicId: 'epic-z' });
  });
});
