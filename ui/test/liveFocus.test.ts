import { describe, expect, it } from 'vitest';
import {
  afterRead,
  groupMark,
  liveMarks,
  markFor,
  matchNow,
  nextMark,
  nowText,
  orderGroupRows,
  orderLive,
  orderLiveItems,
  taskMarkKey,
} from '../src/lib/liveFocus.js';
import type { LiveCard, LiveLinkedEpic } from '../src/lib/liveSessions.js';

const A = { id: 'store-a', label: 'project-a' };
const B = { id: 'store-b', label: 'project-b' };

function epic(over: Partial<LiveLinkedEpic> = {}): LiveLinkedEpic {
  return {
    store: A,
    epicId: 'epic-a',
    closed: false,
    workingAgents: [],
    focusParts: { nextTask: null },
    ...over,
  };
}

function card(epics: LiveLinkedEpic[], focus: LiveCard['focus'] = null, id = 'cli-1'): LiveCard {
  return {
    cliSessionId: id,
    name: null,
    cwdLabel: 'x',
    status: 'working',
    statusSince: null,
    focus,
    linked: { epics },
  };
}

const agent = (role: string, taskId: string | null) => ({
  role,
  taskId,
  since: '2026-10-09T10:00:00Z',
});
const task = (taskId: string, store = A, over: Record<string, unknown> = {}) => ({
  store,
  taskId,
  taskStatus: 'todo',
  agentActivity: null,
  ...over,
});

describe('matchNow', () => {
  it('names the card by store, epic and task id', () => {
    const m = matchNow([card([epic({ workingAgents: [agent('coder', 'epic-a/t1')] })])]);
    expect(m.get(taskMarkKey(task('epic-a/t1')))).toEqual(['coder']);
    expect(m.get(taskMarkKey(task('epic-a/t2')))).toBeUndefined();
  });

  it('marks only the right store when two stores reuse a task id', () => {
    const m = matchNow([card([epic({ workingAgents: [agent('coder', 'epic-a/t1')] })])]);
    expect(m.has(taskMarkKey(task('epic-a/t1', B)))).toBe(false);
    expect(m.has(taskMarkKey(task('epic-a/t1', A)))).toBe(true);
  });

  it('marks nothing for a null task id', () => {
    const m = matchNow([card([epic({ workingAgents: [agent('coder', null)] })])]);
    expect(m.size).toBe(0);
  });

  it('reads a bare task id against its epic', () => {
    const m = matchNow([card([epic({ workingAgents: [agent('coder', 't1')] })])]);
    expect(m.has(taskMarkKey(task('epic-a/t1')))).toBe(true);
  });

  it('collects two agents on one card and spreads two cards', () => {
    const m = matchNow([
      card([
        epic({
          workingAgents: [
            agent('coder', 'epic-a/t1'),
            agent('tester', 'epic-a/t1'),
            agent('coder', 'epic-a/t2'),
          ],
        }),
      ]),
    ]);
    expect(m.get(taskMarkKey(task('epic-a/t1')))).toEqual(['coder', 'tester']);
    expect(m.get(taskMarkKey(task('epic-a/t2')))).toEqual(['coder']);
  });

  it('skips closed epics and epics without an id', () => {
    const m = matchNow([
      card([
        epic({ closed: true, workingAgents: [agent('coder', 'epic-a/t1')] }),
        epic({ epicId: null, workingAgents: [agent('coder', 'epic-a/t2')] }),
      ]),
    ]);
    expect(m.size).toBe(0);
  });
});

describe('nowText', () => {
  it('names one role, two roles, three or more', () => {
    expect(nowText(['coder'], null)).toBe('Now · Builder');
    expect(nowText(['coder', 'tester'], null)).toBe('Now · Builder + Tester');
    expect(nowText(['coder', 'tester', 'reviewer'], null)).toBe('Now · Builder +2');
    expect(nowText(['coder', 'tester', 'reviewer', 'grader'], null)).toBe('Now · Builder +3');
  });

  it('adds the stalled suffix only from the card activity', () => {
    expect(nowText(['coder'], 'stalled')).toBe('Now · Builder · stalled');
    expect(nowText(['coder'], 'working')).toBe('Now · Builder');
  });
});

describe('nextMark', () => {
  const focus = (next: NonNullable<LiveCard['focus']>['next']): LiveCard['focus'] => ({
    store: A,
    project: 'project-a',
    epicId: 'epic-a',
    epicTitle: null,
    wave: 1,
    now: [],
    next,
  });

  it('marks the focus task', () => {
    const n = nextMark([
      card([epic()], focus({ kind: 'task', taskId: 'epic-a/t3', taskTitle: 'x' })),
    ]);
    expect(n.tasks.has(taskMarkKey(task('epic-a/t3')))).toBe(true);
    expect(n.tasks.has(taskMarkKey(task('epic-a/t3', B)))).toBe(false);
    expect(n.waiting).toEqual([]);
  });

  it('reports waiting_on_you as a line, not a card', () => {
    const n = nextMark([card([epic()], focus({ kind: 'waiting_on_you' }))]);
    expect(n.tasks.size).toBe(0);
    expect(n.waiting).toEqual(['project-a · epic-a']);
  });

  it('shows nothing for none and null', () => {
    for (const next of [{ kind: 'none' } as const, null]) {
      const n = nextMark([card([epic()], focus(next))]);
      expect(n.tasks.size).toBe(0);
      expect(n.waiting).toEqual([]);
    }
  });

  it('reads the other live epics through focusParts.nextTask', () => {
    const other = epic({
      store: B,
      epicId: 'epic-b',
      focusParts: { nextTask: { taskId: 'epic-b/t9', taskTitle: 'x' } },
    });
    const n = nextMark([card([epic(), other], focus({ kind: 'none' }))]);
    expect(n.tasks.has(taskMarkKey(task('epic-b/t9', B)))).toBe(true);
    expect(n.tasks.size).toBe(1);
  });

  it('does not let focusParts override a focus that is waiting', () => {
    const e = epic({ focusParts: { nextTask: { taskId: 'epic-a/t3', taskTitle: 'x' } } });
    const n = nextMark([card([e], focus({ kind: 'waiting_on_you' }))]);
    expect(n.tasks.size).toBe(0);
  });
});

describe('markFor', () => {
  const marks = liveMarks([
    card([
      epic({
        workingAgents: [agent('coder', 'epic-a/t1')],
        focusParts: { nextTask: { taskId: 'epic-a/t1', taskTitle: 'x' } },
      }),
      epic({
        epicId: 'epic-c',
        focusParts: { nextTask: { taskId: 'epic-c/t2', taskTitle: 'x' } },
      }),
    ]),
  ]);

  it('lets Now win over Next', () => {
    expect(markFor(marks, task('epic-a/t1'))).toEqual({ kind: 'now', roles: ['coder'] });
  });

  it('marks Next, and nothing otherwise', () => {
    expect(markFor(marks, task('epic-c/t2'))).toEqual({ kind: 'next' });
    expect(markFor(marks, task('epic-a/t9'))).toBeNull();
    expect(markFor(null, task('epic-a/t1'))).toBeNull();
  });
});

describe('orderLive', () => {
  const marks = liveMarks([
    card([
      epic({
        workingAgents: [agent('coder', 'epic-a/n1'), agent('tester', 'epic-a/n2')],
        focusParts: { nextTask: { taskId: 'epic-a/x', taskTitle: 'x' } },
      }),
    ]),
  ]);
  const ids = (ts: { taskId: string }[]) => ts.map((t) => t.taskId);

  it('puts Now cards first, then Next, then the rest in their order', () => {
    const col = ['epic-a/p', 'epic-a/x', 'epic-a/n2', 'epic-a/q', 'epic-a/n1'].map((i) => task(i));
    expect(ids(orderLive(col, marks))).toEqual([
      'epic-a/n2',
      'epic-a/n1',
      'epic-a/x',
      'epic-a/p',
      'epic-a/q',
    ]);
  });

  it('leaves finished tasks where they are', () => {
    const col = [
      task('epic-a/d', A, { taskStatus: 'completed' }),
      task('epic-a/n1', A, { taskStatus: 'completed' }),
      task('epic-a/p'),
    ];
    expect(ids(orderLive(col, marks))).toEqual(['epic-a/d', 'epic-a/n1', 'epic-a/p']);
  });

  it('returns the input untouched without marks', () => {
    const col = [task('epic-a/p'), task('epic-a/x')];
    expect(orderLive(col, null)).toBe(col);
  });
});

describe('afterRead', () => {
  const s = [card([epic()])];

  it('takes a good read and clears the miss count', () => {
    expect(afterRead(null, 1, s)).toEqual({ sessions: s, misses: 0 });
  });

  it('keeps the last good sessions for one failed read, then clears them', () => {
    const first = afterRead(s, 0, 'failed');
    expect(first).toEqual({ sessions: s, misses: 1 });
    expect(afterRead(first.sessions, first.misses, 'failed')).toEqual({
      sessions: null,
      misses: 2,
    });
  });
});

describe('group ordering', () => {
  const marks = liveMarks([
    card([
      epic({
        workingAgents: [agent('coder', 'epic-a/n1')],
        focusParts: { nextTask: { taskId: 'epic-a/x', taskTitle: 'x' } },
      }),
    ]),
  ]);
  const plain = (t: ReturnType<typeof task>) => ({ kind: 'task' as const, key: t.taskId, task: t });
  const group = (key: string, ...members: ReturnType<typeof task>[]) => ({
    kind: 'group' as const,
    key,
    members,
  });
  const keys = (items: { key: string }[]) => items.map((i) => i.key);

  it('ranks a group by its best-marked member', () => {
    const items = [
      plain(task('epic-a/p')),
      group('g-next', task('epic-a/q'), task('epic-a/x')),
      plain(task('epic-a/r')),
      group('g-now', task('epic-a/s'), task('epic-a/n1')),
    ];
    expect(keys(orderLiveItems(items, marks))).toEqual(['g-now', 'g-next', 'epic-a/p', 'epic-a/r']);
  });

  it('keeps the input order for ties and when nothing is marked', () => {
    const items = [group('g1', task('epic-a/a'), task('epic-a/b')), plain(task('epic-a/c'))];
    expect(orderLiveItems(items, marks)).toEqual(items);
    expect(orderLiveItems(items, null)).toBe(items);
    const two = [plain(task('epic-a/y')), group('g2', task('epic-a/x'), task('epic-a/z'))];
    const twoNext = [group('g2', task('epic-a/x'), task('epic-a/z')), plain(task('epic-a/x'))];
    expect(keys(orderLiveItems(twoNext, marks))).toEqual(['g2', 'epic-a/x']);
    expect(keys(orderLiveItems(two, marks))).toEqual(['g2', 'epic-a/y']);
  });

  it('groupMark takes the best member mark, Now over Next', () => {
    const m = groupMark(marks, [task('epic-a/x'), task('epic-a/n1')]);
    expect(m?.mark).toEqual({ kind: 'now', roles: ['coder'] });
    expect(m?.task.taskId).toBe('epic-a/n1');
    expect(groupMark(marks, [task('epic-a/x')])?.mark).toEqual({ kind: 'next' });
    expect(groupMark(marks, [task('epic-a/a')])).toBeNull();
    expect(groupMark(null, [task('epic-a/x')])).toBeNull();
  });

  it('orderGroupRows leads with Now, then Next, then the given order', () => {
    const rows = [task('epic-a/a'), task('epic-a/x'), task('epic-a/b'), task('epic-a/n1')];
    expect(orderGroupRows(rows, marks).map((t) => t.taskId)).toEqual([
      'epic-a/n1',
      'epic-a/x',
      'epic-a/a',
      'epic-a/b',
    ]);
    expect(orderGroupRows(rows, null)).toBe(rows);
  });
});
