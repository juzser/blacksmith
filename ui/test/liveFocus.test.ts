import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  afterRead,
  groupMark,
  liveMarks,
  markFor,
  matchNow,
  nextMark,
  nowText,
  orderLive,
  orderLiveItems,
  readOf,
  taskMarkKey,
  waitingLines,
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
    expect(n.waiting).toEqual([{ label: 'project-a · epic-a', store: A, epicId: 'epic-a' }]);
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

  it('never tags a finished task, Now or Next', () => {
    const done = { taskStatus: 'completed' };
    expect(markFor(marks, task('epic-a/t1', A, done))).toBeNull();
    expect(markFor(marks, task('epic-c/t2', A, done))).toBeNull();
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
  const GRACE = 15000;

  it('takes a good read and clears the failure clock', () => {
    expect(afterRead(null, 1000, s, 5000, GRACE)).toEqual({ sessions: s, failedAt: null });
  });

  it('keeps the last good sessions for one poll interval of failures, then clears them', () => {
    const first = afterRead(s, null, 'failed', 1000, GRACE);
    expect(first).toEqual({ sessions: s, failedAt: 1000 });
    // A manual refresh and a stream tick failing back to back stay inside the grace.
    const second = afterRead(first.sessions, first.failedAt, 'failed', 3000, GRACE);
    expect(second).toEqual({ sessions: s, failedAt: 1000 });
    expect(afterRead(second.sessions, second.failedAt, 'failed', 1000 + GRACE, GRACE)).toEqual({
      sessions: null,
      failedAt: 1000,
    });
  });
});

describe('readOf', () => {
  const result = (state: 'ok' | 'absent' | 'unreadable', sessions: LiveCard[] = []) => ({
    state,
    formatWarning: null,
    hidden: { outOfScope: 0, dead: 0, unparsed: 0, nonInteractive: 0 },
    sessions,
  });

  it('reads ok as its sessions and absent as a measured empty list', () => {
    const s = [card([epic()])];
    expect(readOf(result('ok', s))).toBe(s);
    expect(readOf(result('absent'))).toEqual([]);
  });

  it('treats an unreadable read as a failed one', () => {
    expect(readOf(result('unreadable'))).toBe('failed');
  });
});

describe('waitingLines', () => {
  const waitingFocus = (store: typeof A, project: string, epicId: string) => ({
    store,
    project,
    epicId,
    epicTitle: null,
    wave: 1,
    now: [],
    next: { kind: 'waiting_on_you' as const },
  });
  const waiting = liveMarks([
    card([epic()], waitingFocus(A, 'project-a', 'epic-a')),
    card([epic({ store: B, epicId: 'epic-b' })], waitingFocus(B, 'project-b', 'epic-b'), 'cli-2'),
  ]);

  it('keeps only the epics the board shows', () => {
    expect(waitingLines(waiting, [task('epic-a/t1')])).toEqual(['project-a · epic-a']);
    expect(waitingLines(waiting, [task('epic-a/t1'), task('epic-b/t1', B)])).toEqual([
      'project-a · epic-a',
      'project-b · epic-b',
    ]);
  });

  it('shows none for an epic of another store, or with no marks', () => {
    expect(waitingLines(waiting, [task('epic-a/t1', B)])).toEqual([]);
    expect(waitingLines(waiting, [])).toEqual([]);
    expect(waitingLines(null, [task('epic-a/t1')])).toEqual([]);
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

  it('groupMark skips a finished member', () => {
    const done = task('epic-a/n1', A, { taskStatus: 'completed' });
    expect(groupMark(marks, [done])).toBeNull();
    expect(groupMark(marks, [done, task('epic-a/x')])?.mark).toEqual({ kind: 'next' });
  });
});

// useLiveFocus needs a mounted component, which the node environment cannot
// give (see usePollLive.test.ts); the contract is locked at source level.
describe('useLiveFocus unmount', () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'composables', 'useLiveFocus.ts'),
    'utf8',
  );

  it('drops a read that finishes after the last caller unmounted', () => {
    const body = SRC.slice(SRC.indexOf('const run = '), SRC.indexOf('current = run;'));
    expect(body.indexOf('if (users === 0) return;')).toBeGreaterThan(-1);
    expect(body.indexOf('if (users === 0) return;')).toBeLessThan(
      body.indexOf('sessions.value = next.sessions'),
    );
  });
});
