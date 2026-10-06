// lib/liveSessions.ts: what a Home "Live sessions" card says. The component
// only lays this out (no DOM harness here), so every wording and every null
// guard is held on the view model.
import { describe, expect, it } from 'vitest';
import {
  hiddenCount,
  type LiveCard,
  liveCardView,
  NOW_LINES_DESKTOP,
  NOW_LINES_PHONE,
} from '../src/lib/liveSessions';

const HOME = { id: 'home', label: 'home' };
const OTHER = { id: 'abcd1234', label: 'project-b' };

function card(over: Partial<LiveCard> = {}): LiveCard {
  return {
    cliSessionId: 'cli-1',
    name: null,
    cwdLabel: 'workspace-c',
    status: 'working',
    statusSince: '2026-10-06T10:00:00.000Z',
    focus: null,
    ...over,
  };
}

function focus(over: Partial<NonNullable<LiveCard['focus']>> = {}): LiveCard['focus'] {
  return {
    store: HOME,
    project: 'project-a',
    epicId: 'epic-a',
    epicTitle: 'Checkout redesign',
    wave: 6,
    now: [],
    next: null,
    ...over,
  };
}

const agent = (role: string, taskId: string | null, taskTitle: string | null, n = 1) => ({
  role,
  taskId,
  taskTitle,
  since: `2026-10-06T10:0${n}:00.000Z`,
});

describe('liveCardView title', () => {
  it('reads project, epic id and wave', () => {
    const v = liveCardView(card({ focus: focus() }), { phone: false, expanded: false });
    expect(v.title).toBe('project-a · epic-a · wave 6');
  });

  it('opens the epic on Kanban, named by the epic title, with the title as tooltip', () => {
    const v = liveCardView(card({ focus: focus() }), { phone: false, expanded: false });
    expect(v.titleLink).toEqual({ path: '/work/kanban', query: { epic: 'epic-a' } });
    expect(v.titleLabel).toBe('Open epic Checkout redesign');
    expect(v.titleTooltip).toBe('Checkout redesign');
  });

  it('falls back to the epic id in the accessible name when there is no epic title', () => {
    const v = liveCardView(card({ focus: focus({ epicTitle: null }) }), {
      phone: false,
      expanded: false,
    });
    expect(v.titleLabel).toBe('Open epic epic-a');
    expect(v.titleTooltip).toBe('epic-a');
  });

  it('drops a null project and a null wave with their separators, never printing null', () => {
    const v = liveCardView(card({ focus: focus({ project: null, wave: null }) }), {
      phone: false,
      expanded: false,
    });
    expect(v.title).toBe('epic-a');
    for (const bad of ['null', 'undefined', 'wave']) expect(v.title).not.toContain(bad);
  });

  it('keeps a project but drops only the wave', () => {
    const v = liveCardView(card({ focus: focus({ wave: null }) }), {
      phone: false,
      expanded: false,
    });
    expect(v.title).toBe('project-a · epic-a');
  });

  it('is the working-folder label plus a muted session name when unlinked', () => {
    const v = liveCardView(card({ name: 'fix login' }), { phone: false, expanded: false });
    expect(v.title).toBe('workspace-c');
    expect(v.titleMuted).toBe(' · fix login');
    expect(v.titleLink).toBeNull();
    expect(v.meta).toBe('Not linked to a Blacksmith epic');
    expect(v.now).toEqual([]);
    expect(v.next).toBeNull();
  });

  it('has no muted part for an unlinked session without a name', () => {
    const v = liveCardView(card(), { phone: false, expanded: false });
    expect(v.titleMuted).toBeNull();
  });
});

describe('liveCardView status', () => {
  const tag = (status: LiveCard['status']) =>
    liveCardView(card({ status }), { phone: false, expanded: false }).status;

  it('maps each status to a tone and a word', () => {
    expect(tag('working')).toEqual({ tone: 'progress', label: 'Working' });
    expect(tag('waiting_answer')).toEqual({ tone: 'warning', label: 'Waiting for your answer' });
    expect(tag('waiting_operator')).toEqual({ tone: 'warning', label: 'Waiting for you' });
    expect(tag('idle')).toEqual({ tone: 'neutral', label: 'Idle' });
    expect(tag('unknown')).toEqual({ tone: 'neutral', label: 'Status unknown' });
  });

  it('omits the "for ..." time when the status has no start', () => {
    expect(
      liveCardView(card({ statusSince: null }), { phone: false, expanded: false }).since,
    ).toBeNull();
    expect(liveCardView(card(), { phone: false, expanded: false }).since).toBe(
      '2026-10-06T10:00:00.000Z',
    );
  });
});

describe('liveCardView now', () => {
  const three = focus({
    now: [
      agent('tester', 'task-a3', 'Cover the fee rounding', 3),
      agent('coder', 'task-a1', 'Show shipping fee before payment', 2),
      agent('reviewer', null, null, 1),
    ],
  });

  it('humanizes the role and links the task title', () => {
    const v = liveCardView(card({ focus: three }), { phone: false, expanded: true });
    expect(v.now[1]).toEqual({
      role: 'Builder',
      taskTitle: 'Show shipping fee before payment',
      to: '/tasks/task-a1',
    });
  });

  it('gives an agent with no task a role-only line without a link', () => {
    const v = liveCardView(card({ focus: three }), { phone: false, expanded: true });
    expect(v.now[2]).toEqual({ role: 'Code reviewer', taskTitle: null, to: null });
  });

  it('shows two lines on desktop and counts the rest', () => {
    const v = liveCardView(card({ focus: three }), { phone: false, expanded: false });
    expect(NOW_LINES_DESKTOP).toBe(2);
    expect(v.now).toHaveLength(2);
    expect(v.moreCount).toBe(1);
  });

  it('shows one line on phone and counts the rest', () => {
    const v = liveCardView(card({ focus: three }), { phone: true, expanded: false });
    expect(NOW_LINES_PHONE).toBe(1);
    expect(v.now).toHaveLength(1);
    expect(v.moreCount).toBe(2);
  });

  it('shows every agent once expanded', () => {
    const v = liveCardView(card({ focus: three }), { phone: true, expanded: true });
    expect(v.now).toHaveLength(3);
    expect(v.moreCount).toBe(0);
  });

  it('adds ?store= to a task of a foreign store only', () => {
    const f = focus({ store: OTHER, now: [agent('coder', 'task-a1', 'A title')] });
    const v = liveCardView(card({ focus: f }), { phone: false, expanded: false });
    expect(v.now[0]?.to).toBe('/tasks/task-a1?store=abcd1234');
  });

  it('encodes a task id that needs it', () => {
    const f = focus({ now: [agent('coder', 'task a/1', 'A title')] });
    expect(liveCardView(card({ focus: f }), { phone: false, expanded: false }).now[0]?.to).toBe(
      '/tasks/task%20a%2F1',
    );
  });

  it('has no Now line for an epic with no working agent', () => {
    const v = liveCardView(card({ focus: focus() }), { phone: false, expanded: false });
    expect(v.now).toEqual([]);
    expect(v.moreCount).toBe(0);
  });
});

describe('liveCardView next', () => {
  const next = (n: NonNullable<LiveCard['focus']>['next'], store = HOME) =>
    liveCardView(card({ focus: focus({ next: n, store }) }), { phone: false, expanded: false })
      .next;

  it('links the next task by its title', () => {
    expect(next({ kind: 'task', taskId: 'task-a2', taskTitle: 'Add the tax line' })).toEqual({
      kind: 'task',
      taskTitle: 'Add the tax line',
      to: '/tasks/task-a2',
    });
  });

  it('adds ?store= to a foreign next task', () => {
    const n = next({ kind: 'task', taskId: 'task-a2', taskTitle: 'T' }, OTHER);
    expect(n).toMatchObject({ to: '/tasks/task-a2?store=abcd1234' });
  });

  it('says waiting on you and nothing queued', () => {
    expect(next({ kind: 'waiting_on_you' })).toEqual({ kind: 'waiting' });
    expect(next({ kind: 'none' })).toEqual({ kind: 'none' });
  });

  it('omits the line when the next step is unknown, never "none"', () => {
    expect(next(null)).toBeNull();
  });
});

describe('hiddenCount', () => {
  it('sums every reason a session is not listed', () => {
    expect(hiddenCount({ outOfScope: 2, dead: 1, unparsed: 0, nonInteractive: 3 })).toBe(6);
  });
});
