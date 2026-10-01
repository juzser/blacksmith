import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  agentChip,
  agentNudgeDue,
  attemptLabel,
  capColumn,
  cardChips,
  columnTone,
  defaultMobileColumnKey,
  dependencyChainText,
  epicKeyForTask,
  foldIntoColumns,
  groupByKanban,
  isDoneStatus,
  isInteractiveDescendant,
  KANBAN_COLUMNS,
  KANBAN_PAGE_SIZE,
  subStatusSummary,
  visibleTaskCount,
} from '../src/lib/kanban.js';
import { TASK_STATUS_OUTCOME } from '../src/lib/taxonomy.js';

describe('lib/kanban.ts — §5.3 status-column folding', () => {
  it('folds all 10 non-terminal statuses into the 5 default columns, in order', () => {
    const tasks = [
      { taskId: 't1', taskStatus: 'todo' },
      { taskId: 't2', taskStatus: 'ready' },
      { taskId: 't3', taskStatus: 'in-progress' },
      { taskId: 't4', taskStatus: 'grading' },
      { taskId: 't5', taskStatus: 'reviewing' },
      { taskId: 't6', taskStatus: 'merging' },
      { taskId: 't7', taskStatus: 'blocked' },
      { taskId: 't8', taskStatus: 'escalated' },
      { taskId: 't9', taskStatus: 'completed' },
      { taskId: 't10', taskStatus: 'waived' },
    ];
    const columns = foldIntoColumns(tasks);
    expect(columns.map((c) => c.name)).toEqual([...KANBAN_COLUMNS]);
    expect(columns.find((c) => c.name === 'Todo')?.tasks.map((t) => t.taskId)).toEqual([
      't1',
      't2',
    ]);
    expect(columns.find((c) => c.name === 'In progress')?.tasks.map((t) => t.taskId)).toEqual([
      't3',
      't4',
    ]);
    expect(columns.find((c) => c.name === 'Reviewing')?.tasks.map((t) => t.taskId)).toEqual([
      't5',
      't6',
    ]);
    expect(columns.find((c) => c.name === 'Blocked')?.tasks.map((t) => t.taskId)).toEqual([
      't7',
      't8',
    ]);
    expect(columns.find((c) => c.name === 'Completed')?.tasks.map((t) => t.taskId)).toEqual([
      't9',
      't10',
    ]);
  });

  it('hides failed/superseded by default', () => {
    const tasks = [
      { taskId: 't1', taskStatus: 'failed' },
      { taskId: 't2', taskStatus: 'superseded' },
      { taskId: 't3', taskStatus: 'todo' },
    ];
    const columns = foldIntoColumns(tasks);
    const total = columns.reduce((sum, c) => sum + c.tasks.length, 0);
    expect(total).toBe(1);
  });

  it('adds Failed/Superseded columns when showAll is true', () => {
    const tasks = [
      { taskId: 't1', taskStatus: 'failed' },
      { taskId: 't2', taskStatus: 'superseded' },
    ];
    const columns = foldIntoColumns(tasks, true);
    expect(columns.map((c) => c.name)).toEqual([...KANBAN_COLUMNS, 'Failed', 'Superseded']);
    expect(columns.find((c) => c.name === 'Failed')?.tasks).toHaveLength(1);
    expect(columns.find((c) => c.name === 'Superseded')?.tasks).toHaveLength(1);
  });
});

describe('lib/kanban.ts subStatusSummary() (operator directive 1)', () => {
  it('returns null when a folded column has only one raw status', () => {
    const tasks = [
      { taskId: 't1', taskStatus: 'reviewing' },
      { taskId: 't2', taskStatus: 'reviewing' },
    ];
    expect(subStatusSummary(tasks)).toBeNull();
  });

  it('summarizes mixed raw statuses, alphabetical, with counts', () => {
    const tasks = [
      { taskId: 't1', taskStatus: 'reviewing' },
      { taskId: 't2', taskStatus: 'merging' },
      { taskId: 't3', taskStatus: 'reviewing' },
    ];
    expect(subStatusSummary(tasks)).toBe('Merging 1 · Reviewing 2');
  });
});

describe('lib/kanban.ts visibleTaskCount() (D-242)', () => {
  // The board and the count that labels it read the same payload through two
  // different rules. KanbanPage summed the server's grouping, which is keyed
  // by raw task_status and hides nothing; KanbanBoard re-folded that same
  // payload through foldIntoColumns(), which drops `failed` and `superseded`
  // from the default board. So the Toolbar counted cards the board had
  // already decided not to draw -- "9 tasks" over a board holding 7.
  const columns = [
    { taskStatus: 'todo', tasks: [{ taskId: 't1', taskStatus: 'todo' }] },
    { taskStatus: 'failed', tasks: [{ taskId: 't2', taskStatus: 'failed' }] },
    { taskStatus: 'superseded', tasks: [{ taskId: 't3', taskStatus: 'superseded' }] },
  ];

  it('counts only what the default board renders', () => {
    expect(visibleTaskCount(columns)).toBe(1);
    expect(visibleTaskCount(columns)).toBe(
      foldIntoColumns(columns.flatMap((c) => c.tasks)).reduce((n, c) => n + c.tasks.length, 0),
    );
  });

  it('counts the hidden statuses too once showAll opens their columns', () => {
    expect(visibleTaskCount(columns, true)).toBe(3);
  });

  // The empty state is the same number wearing a different face: a board of
  // nothing but superseded tasks draws no cards, so claiming "no tasks match
  // these filters" is the honest reading -- and the old count blocked it.
  it('reports zero for a payload the default board renders as empty', () => {
    expect(
      visibleTaskCount([{ taskStatus: 'failed', tasks: [{ taskId: 'x', taskStatus: 'failed' }] }]),
    ).toBe(0);
  });

  // An unknown status has no column, so no card. Counting it would put the
  // board back in the same disagreement by a different door.
  it('does not count a status no column claims', () => {
    expect(
      visibleTaskCount([
        { taskStatus: 'invented', tasks: [{ taskId: 'x', taskStatus: 'invented' }] },
      ]),
    ).toBe(0);
    expect(
      visibleTaskCount(
        [{ taskStatus: 'invented', tasks: [{ taskId: 'x', taskStatus: 'invented' }] }],
        true,
      ),
    ).toBe(0);
  });
});

/**
 * The directive is about scroll length, so the tests are about what the
 * column DRAWS and what it admits it is holding back -- not about how the
 * board happens to paint the control.
 */
describe('lib/kanban.ts capColumn()', () => {
  const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ taskId: `t${i}` }));

  it('draws at most one page on the first render', () => {
    const capped = capColumn(tasks(25));
    expect(capped.visible).toHaveLength(KANBAN_PAGE_SIZE);
    expect(capped.hidden).toBe(15);
  });

  it('leaves a column shorter than a page alone, and admits nothing hidden', () => {
    const capped = capColumn(tasks(3));
    expect(capped.visible).toHaveLength(3);
    expect(capped.hidden).toBe(0);
    expect(capped.nextStep).toBe(0);
  });

  it('adds exactly one page per reveal rather than jumping to the end', () => {
    expect(capColumn(tasks(25), 1).visible).toHaveLength(20);
    expect(capColumn(tasks(25), 1).hidden).toBe(5);
    expect(capColumn(tasks(25), 2).visible).toHaveLength(25);
    expect(capColumn(tasks(25), 2).hidden).toBe(0);
  });

  /** The control names what it will add, so a last reveal of 5 does not promise 10. */
  it('names the size of the next reveal, not the page size', () => {
    expect(capColumn(tasks(25), 1).nextStep).toBe(5);
    expect(capColumn(tasks(40), 0).nextStep).toBe(KANBAN_PAGE_SIZE);
  });

  it('keeps file order -- the slice is the head of the column, not a sample', () => {
    expect(capColumn(tasks(12)).visible.map((t) => t.taskId)).toEqual(
      tasks(10).map((t) => t.taskId),
    );
  });

  it('never over-reveals past the end', () => {
    const capped = capColumn(tasks(4), 99);
    expect(capped.visible).toHaveLength(4);
    expect(capped.hidden).toBe(0);
  });

  it('treats a nonsense page size as no cap rather than as an empty column', () => {
    expect(capColumn(tasks(30), 0, 0).visible).toHaveLength(30);
    expect(capColumn(tasks(30), 0, -1).hidden).toBe(0);
  });

  it('reads a negative reveal count as the first render', () => {
    expect(capColumn(tasks(30), -3).visible).toHaveLength(KANBAN_PAGE_SIZE);
  });

  it('does not mutate the column it was given', () => {
    const source = tasks(15);
    capColumn(source, 0);
    expect(source).toHaveLength(15);
  });
});

// Cross-provider UI check of 2026-09-14, fix (n). The card's chip is built
// from the latest dispatch — who was *sent* — and drew "coder · mid" on a
// completed task exactly as it did on one being worked. kanban() now says
// whether anyone is still there (`agentActivity`, off the agents rows); this
// helper turns that plus the task's own status into what the chip does.
describe('lib/kanban.ts — the agent chip says who is on the task', () => {
  const task = (over: Partial<Parameters<typeof agentChip>[0]>) => ({
    taskStatus: 'in-progress',
    agentRole: 'coder',
    agentModelTier: 'mid',
    agentActivity: null,
    ...over,
  });

  it('is nothing on a task never dispatched', () => {
    expect(agentChip(task({ agentRole: null, agentModelTier: null }))).toBeNull();
  });

  it('labels role · tier, and role alone when the dispatch named no tier', () => {
    // Task 2 (friendly role labels): the visible label reads "Builder", the
    // taxonomy string ("coder") is roleLabel()'s input, not its output.
    expect(agentChip(task({ agentActivity: 'working' }))?.label).toBe('Builder · mid');
    expect(agentChip(task({ agentModelTier: null }))?.label).toBe('Builder');
  });

  it('keeps the raw role · tier reachable as a title, alongside the friendly label', () => {
    expect(agentChip(task({ agentActivity: 'working' }))?.title).toBe('coder · mid');
    expect(agentChip(task({ agentModelTier: null }))?.title).toBe('coder');
  });

  it('pulses only for an agent that is working now', () => {
    expect(agentChip(task({ agentActivity: 'working' }))).toEqual({
      label: 'Builder · mid',
      title: 'coder · mid',
      live: true,
      gone: false,
      state: 'working',
    });
    // Stalled is still somebody: the registry has no terminal event, only
    // the clock says it should have — the chip stays but stops breathing.
    expect(agentChip(task({ agentActivity: 'stalled' }))).toEqual({
      label: 'Builder · mid',
      title: 'coder · mid',
      live: false,
      gone: false,
      state: 'waiting',
    });
  });

  it('sits back once the agent has returned, whatever column the task is in', () => {
    // A reviewing task whose coder has returned and whose reviewer is not
    // yet dispatched: the chip names who did the work, and nobody is on it.
    expect(agentChip(task({ taskStatus: 'reviewing' }))).toEqual({
      label: 'Builder · mid',
      title: 'coder · mid',
      live: false,
      gone: true,
      state: 'idle',
    });
  });

  it('never pulses on a task that is over, whichever way it ended', () => {
    // A live agents row on a completed task is a registry gap (the sweep
    // runs at epic close), not work in progress. The task's own status is
    // the stronger claim: nobody works on a task that is over.
    //
    // The list is the taxonomy's, not this file's: every status whose outcome
    // is something other than `open`. A thirteenth status classified there
    // lands here as a case nobody wrote, which is the point — the chip used
    // to consult four strings typed into kanban.ts.
    const over = Object.entries(TASK_STATUS_OUTCOME)
      .filter(([, outcome]) => outcome !== 'open')
      .map(([taskStatus]) => taskStatus);
    expect(over.length).toBeGreaterThan(0);
    for (const taskStatus of over) {
      expect(agentChip(task({ taskStatus, agentActivity: 'working' }))).toEqual({
        label: 'Builder · mid',
        title: 'coder · mid',
        live: false,
        gone: true,
        state: 'idle',
      });
    }
  });

  it('keeps pulsing on a status nobody has classified yet', () => {
    // An unclassified status is not a verdict, so the chip is left alone: the
    // operator sees the agent the registry says is there, rather than a card
    // muted on the strength of a status this build has never heard of.
    expect(agentChip(task({ taskStatus: 'invented-tomorrow', agentActivity: 'working' }))).toEqual({
      label: 'Builder · mid',
      title: 'coder · mid',
      live: true,
      gone: false,
      state: 'working',
    });
  });
});

// DS3 pattern 3 — the new kit's AgentChip state vocabulary, additive beside
// the pre-kit live/gone booleans above.
describe('lib/kanban.ts — agentChip() state (DS3 pattern 3)', () => {
  const task = (over: Partial<Parameters<typeof agentChip>[0]>) => ({
    taskStatus: 'in-progress',
    agentRole: 'coder',
    agentModelTier: 'mid',
    agentActivity: null,
    ...over,
  });

  it('is working while the agent is live and the status is not a Reviewing one', () => {
    expect(agentChip(task({ agentActivity: 'working' }))?.state).toBe('working');
  });

  it('is reviewing when the live agent sits on a status the board folds into Reviewing', () => {
    expect(agentChip(task({ taskStatus: 'reviewing', agentActivity: 'working' }))?.state).toBe(
      'reviewing',
    );
    expect(agentChip(task({ taskStatus: 'merging', agentActivity: 'working' }))?.state).toBe(
      'reviewing',
    );
  });

  it('is waiting when the clock, not a terminal event, says the agent should have returned', () => {
    expect(agentChip(task({ agentActivity: 'stalled' }))?.state).toBe('waiting');
  });

  it('is idle once the task is over or nobody is on it', () => {
    expect(agentChip(task({ agentActivity: null }))?.state).toBe('idle');
    expect(agentChip(task({ taskStatus: 'completed', agentActivity: 'working' }))?.state).toBe(
      'idle',
    );
  });
});

describe('lib/kanban.ts — agentNudgeDue() (DS3 pattern 3)', () => {
  it('is false before agentWaitingThresholdMs has elapsed', () => {
    // Threshold is 4h; 1h in is not yet long enough to suggest a nudge.
    expect(agentNudgeDue('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z')).toBe(false);
  });

  it('is true once agentWaitingThresholdMs has elapsed', () => {
    expect(agentNudgeDue('2026-01-01T00:00:00.000Z', '2026-01-01T04:00:00.000Z')).toBe(true);
  });

  it('is false for an unparseable timestamp rather than throwing', () => {
    expect(agentNudgeDue('not-a-date', '2026-01-01T04:00:00.000Z')).toBe(false);
  });
});

describe('lib/kanban.ts — cardChips() (DS3 pattern 6, row 4)', () => {
  const task = (over: Partial<Parameters<typeof cardChips>[0]> = {}) => ({
    taskStatus: 'blocked',
    project: 'shop-api',
    tags: { case: 'feature', severity: 'S2-major' },
    ...over,
  });

  it('suppresses the status chip only when grouped by status', () => {
    expect(cardChips(task(), 'project').chips.map((c) => c.text)).toContain('Blocked');
    expect(cardChips(task(), 'status').chips.map((c) => c.text)).not.toContain('Blocked');
  });

  it('suppresses the project chip only when grouped by project', () => {
    const noTags = task({ taskStatus: 'status-irrelevant', tags: { case: null, severity: null } });
    expect(cardChips(noTags, 'status').chips.map((c) => c.text)).toContain('shop-api');
    expect(cardChips(noTags, 'project').chips.map((c) => c.text)).not.toContain('shop-api');
  });

  it('drops the S4-nit default severity but keeps a non-default one', () => {
    expect(
      cardChips(task({ tags: { case: null, severity: 'S4-nit' } }), 'status').chips,
    ).not.toContainEqual(expect.objectContaining({ text: 'S4-nit' }));
    expect(cardChips(task(), 'status').chips).toContainEqual({ text: 'S2-major', tone: 'danger' });
  });

  it('caps at 2 chips and reports the rest as overflow', () => {
    // status + case + severity + project = 4 candidates when grouped by role.
    const result = cardChips(task(), 'role');
    expect(result.chips).toHaveLength(2);
    expect(result.overflow).toBe(2);
  });

  it('case chips carry no tone — descriptive, not evaluative', () => {
    expect(cardChips(task(), 'status').chips).toContainEqual({ text: 'Feature', tone: null });
  });
});

// DS3 pattern 7 — group-by switch's pure helpers.
describe('lib/kanban.ts — epicKeyForTask() (DS3 pattern 7)', () => {
  it('reads the prefix before the first slash', () => {
    expect(epicKeyForTask('harness-codex-dispatch/task-a-skill-install')).toBe(
      'harness-codex-dispatch',
    );
  });

  it('is null for a task id with no slash', () => {
    expect(epicKeyForTask('no-epic-task')).toBeNull();
  });
});

describe('lib/kanban.ts — groupByKanban() (DS3 pattern 7)', () => {
  const task = (over: Partial<Parameters<typeof groupByKanban>[0][number]>) => ({
    taskId: 'epic-a/task-1',
    taskStatus: 'in-progress',
    project: 'shop-api',
    agentRole: 'coder',
    epicLabel: 'shop-api: Epic a',
    ...over,
  });

  it('status grouping delegates to foldIntoColumns, in its fixed column order', () => {
    const columns = groupByKanban([task({})], 'status');
    expect(columns.map((c) => c.key)).toEqual([...KANBAN_COLUMNS]);
  });

  it('groups by project, with a task lacking one in a trailing "None" bucket', () => {
    const columns = groupByKanban(
      [task({ project: 'shop-api' }), task({ taskId: 'epic-b/task-2', project: null })],
      'project',
    );
    expect(columns.map((c) => c.key)).toEqual(['shop-api', '\u0000none']);
    expect(columns[1]?.label).toBe('None');
  });

  it('groups by epic, reading the key off the task id and the label off epicLabel', () => {
    const columns = groupByKanban(
      [task({ taskId: 'epic-a/task-1', epicLabel: 'shop-api: Epic a' })],
      'epic',
    );
    expect(columns).toEqual([{ key: 'epic-a', label: 'shop-api: Epic a', tasks: [task({})] }]);
  });

  it('groups by role, with the friendly label, and a task never dispatched in "None"', () => {
    const columns = groupByKanban(
      [task({ agentRole: 'coder' }), task({ taskId: 'epic-a/task-2', agentRole: null })],
      'role',
    );
    expect(columns[0]?.label).toBe('Builder');
    expect(columns[1]?.key).toBe('\u0000none');
  });

  it('drops failed/superseded tasks by default, same as the status board', () => {
    const columns = groupByKanban([task({ taskStatus: 'failed' })], 'project');
    expect(columns).toEqual([]);
  });
});

describe('lib/kanban.ts — every status the taxonomy declares reaches a column', () => {
  it('folds each declared task_status into some column of the "All" board', () => {
    // The declaration this board answers to is factory/policies/taxonomy.yml,
    // not the ten values copied into COLUMN_FOR_STATUS: events.ts validates a
    // `task-added` payload against that file, so a thirteenth status is on the
    // wire the day it is added there. `foldIntoColumns` drops a task whose
    // status no column claims — it does not render oddly, it leaves the board
    // — and the "All" toggle does not bring it back, which is the one place
    // an operator would go looking.
    //
    // This is the guard ui/test/taxonomy.test.ts runs over TASK_STATUS_OUTCOME
    // and AGENT_STATUSES. A browser cannot read the yml (timelineDisplay.ts
    // §201), so it belongs in a test rather than in a runtime read.
    //
    // Asked of `foldIntoColumns` rather than `columnForStatus`, because
    // `columnForStatus` is not the whole answer: `failed` and `superseded`
    // have no entry in COLUMN_FOR_STATUS and are routed to their own two
    // columns by `foldIntoColumns` itself.
    const yml = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'factory',
        'policies',
        'taxonomy.yml',
      ),
      'utf8',
    );
    const declared = yml.match(/\ntask_status:\s*\[([^\]]+)\]/);
    if (!declared) throw new Error('taxonomy.yml declares no task_status list');
    const statuses = (declared[1] as string)
      .split(',')
      .map((v) => v.replace(/#.*$/, '').trim())
      .filter(Boolean);
    // Anti-vacuity: an empty parse would satisfy the assertion below.
    expect(statuses).toContain('in-progress');
    expect(statuses).toContain('superseded');

    // `showAll`, because hiding `failed`/`superseded` from the default board
    // is a decision someone made (§5.3). Falling off the "All" board is the
    // other thing — nobody decided it.
    const dropped = statuses.filter((status) =>
      foldIntoColumns([{ taskId: `t-${status}`, taskStatus: status }], true).every(
        (column) => column.tasks.length === 0,
      ),
    );
    expect(dropped).toEqual([]);
  });

  it('can see a drop: a status nothing classifies leaves the "All" board too', () => {
    // Not a taxonomy value — the shape of the loss, so the guard above reads
    // as a guard rather than as an assertion that cannot fail.
    expect(
      foldIntoColumns([{ taskId: 't1', taskStatus: 'queued' }], true).flatMap((c) => c.tasks),
    ).toEqual([]);
  });
});

describe('lib/kanban.ts — dependencyChainText() (DS3 pattern 6, footer)', () => {
  it('reads "nothing" with no dependencies', () => {
    expect(dependencyChainText([])).toBe('Waits for: nothing');
  });

  it('names the first dependency with its status', () => {
    expect(
      dependencyChainText([{ taskId: 't1', title: 'Add login form', status: 'in-progress' }]),
    ).toBe('Waits for: Add login form (in-progress)');
  });

  it('falls back to the taskId when the dependency has no title', () => {
    expect(dependencyChainText([{ taskId: 't1', title: null, status: null }])).toBe(
      'Waits for: t1',
    );
  });

  it('tails off with a "+N more" count past the first dependency', () => {
    expect(
      dependencyChainText([
        { taskId: 't1', title: 'Add login form', status: 'done' },
        { taskId: 't2', title: 'Add logout', status: 'todo' },
        { taskId: 't3', title: 'Add session', status: 'todo' },
      ]),
    ).toBe('Waits for: Add login form (done) +2 more');
  });
});

describe('lib/kanban.ts — isDoneStatus() (DS3 pattern 7, column collapse)', () => {
  it('reads completed/waived as done', () => {
    expect(isDoneStatus('completed')).toBe(true);
    expect(isDoneStatus('waived')).toBe(true);
  });

  it('reads any other status as not done', () => {
    expect(isDoneStatus('in-progress')).toBe(false);
    expect(isDoneStatus('failed')).toBe(false);
  });
});

// S2 fix (review round 2) — `onCardKeydown` used to act on every bubbled
// keydown regardless of where it started, so Enter on the card's own "Open
// PR" link (or any other focusable descendant) opened the peek panel instead
// of letting the link's native activation run. The guard is keyed off
// `target !== currentTarget` plus an interactive tag/role check, not a single
// hardcoded selector for that one link, so it also covers the row-1 "Copy
// task id" IconButton and anything else focusable the card ever grows.
describe('lib/kanban.ts — isInteractiveDescendant() (S2 fix)', () => {
  const root = { tagName: 'DIV' };

  it('is false for the card root itself, even though the root also carries a role', () => {
    const cardRoot = {
      tagName: 'DIV',
      getAttribute: (name: string) => (name === 'role' ? 'link' : null),
    };
    expect(isInteractiveDescendant(cardRoot, cardRoot)).toBe(false);
  });

  it('is true for a descendant <a>', () => {
    const anchor = { tagName: 'A' };
    expect(isInteractiveDescendant(anchor, root)).toBe(true);
  });

  it('is true for a descendant <button> or <input>', () => {
    expect(isInteractiveDescendant({ tagName: 'BUTTON' }, root)).toBe(true);
    expect(isInteractiveDescendant({ tagName: 'INPUT' }, root)).toBe(true);
  });

  it('is true for a descendant carrying any role attribute', () => {
    const roled = {
      tagName: 'SPAN',
      getAttribute: (name: string) => (name === 'role' ? 'img' : null),
    };
    expect(isInteractiveDescendant(roled, root)).toBe(true);
  });

  it('is false for a plain descendant span with no role', () => {
    const span = { tagName: 'SPAN', getAttribute: () => null };
    expect(isInteractiveDescendant(span, root)).toBe(false);
  });

  it('is false for a null target', () => {
    expect(isInteractiveDescendant(null, root)).toBe(false);
  });
});

// S3 fix (review round 2) — row 5 used to render
// `Attempt {{ task.judgeRound ?? task.attemptCount }}`, silently swapping
// which number it showed depending on which field happened to be set. A
// judge round and a dispatch-attempt count are different counters
// (api.ts's own comments: attemptCount is "count of this task's
// dispatch_decision events", judgeRound is "highest judge round among this
// task's judge-role dispatches") and conflating them under one label misled
// whichever one lost. The card now only ever shows the attempt count, per
// ds-spec.md §4.2's own worked example ("Attempt 2" on a task with no judge
// round at all).
describe('lib/kanban.ts — attemptLabel() (S3 fix)', () => {
  it('is null on a task’s first attempt', () => {
    expect(attemptLabel({ attemptCount: 1 })).toBeNull();
    expect(attemptLabel({ attemptCount: 0 })).toBeNull();
  });

  it('names the attempt count once there has been more than one', () => {
    expect(attemptLabel({ attemptCount: 2 })).toBe('Attempt 2');
    expect(attemptLabel({ attemptCount: 5 })).toBe('Attempt 5');
  });
});

describe('lib/kanban.ts — defaultMobileColumnKey() (ds-spec.md §3.1 Work/Kanban row)', () => {
  it('picks the first column that has at least one task', () => {
    const columns = [
      { key: 'todo', total: 0 },
      { key: 'in-progress', total: 3 },
      { key: 'done', total: 2 },
    ];
    expect(defaultMobileColumnKey(columns)).toBe('in-progress');
  });

  it('falls back to the first column key when every column is empty', () => {
    const columns = [
      { key: 'todo', total: 0 },
      { key: 'done', total: 0 },
    ];
    expect(defaultMobileColumnKey(columns)).toBe('todo');
  });

  it('returns null for an empty board', () => {
    expect(defaultMobileColumnKey([])).toBeNull();
  });
});

describe('lib/kanban.ts — columnTone() (ds-spec.md §2.2 column header icon)', () => {
  it('reads the status grouping key as a real task_status tone', () => {
    expect(columnTone('status', 'completed')).toBe('done');
    expect(columnTone('status', 'blocked')).toBe('blocked');
  });

  it('falls back to neutral for groupings with no status of their own', () => {
    expect(columnTone('project', 'some-project')).toBe('neutral');
    expect(columnTone('epic', 'some-epic')).toBe('neutral');
    expect(columnTone('role', 'coder')).toBe('neutral');
  });
});
