import { describe, expect, it } from 'vitest';
import type { LiveAgentEntry, OverviewResult, RunningSession } from '../src/lib/api.js';
import {
  AGENT_COLUMN_X,
  AGENT_STEP_Y,
  AGENT_VISIBLE_CAP,
  BAND_COLUMN_STEP_X,
  BAND_GAP_Y,
  BAND_WIDTH,
  bandGridExtent,
  bandsPerRowFor,
  FIT_MAX_ZOOM,
  MAX_BANDS_PER_ROW,
  SESSION_BAND_CAP,
  SESSION_NODE_H,
  SESSION_NODE_W,
  type SessionsFlowNode,
  sessionGroups,
  sessionNodeId,
  sessionsFlowEdges,
  sessionsFlowNodes,
  unattachedAgents,
  visibleAgents,
  visibleBands,
} from '../src/lib/sessionsFlow.js';
import { nth } from './helpers.js';

const NOW = '2026-08-13T12:00:00.000Z';

function session(over: Partial<RunningSession> & { sessionId: string }): RunningSession {
  return {
    startedAt: '2026-08-13T10:00:00.000Z',
    lastEventAt: NOW,
    eventCount: 1,
    liveAgentCount: 0,
    lastEventType: 'task-created',
    projects: ['black-smith'],
    ...over,
  };
}

function agent(over: Partial<LiveAgentEntry> & { id: string; sessionId: string }): LiveAgentEntry {
  return {
    agentRole: 'coder',
    provider: 'anthropic',
    modelTier: 'high',
    taskId: null,
    epicId: null,
    dispatchedAt: NOW,
    ...over,
  };
}

function overview(over: Partial<OverviewResult>): OverviewResult {
  return {
    liveAgents: [],
    liveAgentEntries: [],
    liveAgentCount: 0,
    runningSessions: [],
    epicsInFlight: [],
    closedEpics: [],
    tokensByEpic: [],
    alerts: { escalations: 0, pendingWaivers: 0 },
    milestoneProgress: [],
    recentDispatches: [],
    liveAgentCountDelta5m: 0,
    budgetUsedPctPointDelta1h: null,
    ...over,
  };
}

/**
 * Node lookup that fails loudly with the ids that WERE emitted. `find(...)?.x`
 * would let a missing node pass as `undefined === undefined`, which is exactly
 * the layout bug these tests exist to catch.
 */
function nodeById(nodes: SessionsFlowNode[], id: string): SessionsFlowNode {
  const found = nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node "${id}" in [${nodes.map((n) => n.id).join(', ')}]`);
  return found;
}

/** 5 hours before NOW — past AGENT_STALE_AFTER_MS (4h) in liveness.ts. */
const LONG_AGO = '2026-08-13T07:00:00.000Z';
/** 20 minutes before NOW — past SESSION_ACTIVE_WITHIN_MS (15m) in liveness.ts. */
const QUIET_SINCE = '2026-08-13T11:40:00.000Z';

describe('lib/sessionsFlow.ts sessionGroups()', () => {
  it('orders sessions most recently active first and attaches agents to their own session', () => {
    const groups = sessionGroups(
      overview({
        runningSessions: [
          session({ sessionId: 'older', lastEventAt: '2026-08-13T11:00:00.000Z' }),
          session({ sessionId: 'newer', lastEventAt: '2026-08-13T11:59:00.000Z' }),
        ],
        liveAgentEntries: [
          agent({ id: 'a1', sessionId: 'older' }),
          agent({ id: 'a2', sessionId: 'newer' }),
        ],
      }),
    );

    expect(groups.map((g) => g.session.sessionId)).toEqual(['newer', 'older']);
    expect(nth(groups, 0).agents.map((a) => a.id)).toEqual(['a2']);
    expect(nth(groups, 1).agents.map((a) => a.id)).toEqual(['a1']);
  });

  it('orders agents within a session longest-running first', () => {
    const groups = sessionGroups(
      overview({
        runningSessions: [session({ sessionId: 's' })],
        liveAgentEntries: [
          agent({ id: 'recent', sessionId: 's', dispatchedAt: '2026-08-13T11:55:00.000Z' }),
          agent({ id: 'oldest', sessionId: 's', dispatchedAt: '2026-08-13T09:00:00.000Z' }),
          agent({ id: 'middle', sessionId: 's', dispatchedAt: '2026-08-13T11:00:00.000Z' }),
        ],
      }),
    );

    expect(nth(groups, 0).agents.map((a) => a.id)).toEqual(['oldest', 'middle', 'recent']);
  });

  it('keeps a session with no live agents — an idle run is a fact, not an absence', () => {
    const groups = sessionGroups(
      overview({ runningSessions: [session({ sessionId: 'quiet' })], liveAgentEntries: [] }),
    );
    expect(groups).toHaveLength(1);
    expect(nth(groups, 0).agents).toEqual([]);
  });
});

describe('lib/sessionsFlow.ts unattachedAgents()', () => {
  it('surfaces agents whose session is not in runningSessions instead of dropping them', () => {
    const data = overview({
      runningSessions: [session({ sessionId: 'known' })],
      liveAgentEntries: [
        agent({ id: 'attached', sessionId: 'known' }),
        agent({ id: 'orphan', sessionId: 'vanished' }),
      ],
    });

    expect(unattachedAgents(data).map((a) => a.id)).toEqual(['orphan']);
    // …and the orphan must not silently appear under some other session.
    const grouped = sessionGroups(data).flatMap((g) => g.agents.map((a) => a.id));
    expect(grouped).toEqual(['attached']);
  });
});

describe('lib/sessionsFlow.ts visibleBands()', () => {
  it('draws everything when the payload fits under the cap', () => {
    const groups = sessionGroups(
      overview({
        runningSessions: [session({ sessionId: 'a' }), session({ sessionId: 'b' })],
      }),
    );
    expect(visibleBands(groups)).toEqual({ shown: groups, hidden: 0 });
  });

  it('caps the bands it draws and reports the remainder rather than dropping it', () => {
    // `runningSessions` is every projected session, so a long-lived
    // state/smith.db hands this page hundreds. Truncating silently would claim
    // the drawn ones are all there are.
    const many = Array.from({ length: SESSION_BAND_CAP + 3 }, (_, i) =>
      // Descending lastEventAt so the ids stay in a known order after sorting.
      session({
        sessionId: `s${i}`,
        lastEventAt: `2026-08-13T11:${String(59 - i).padStart(2, '0')}:00.000Z`,
      }),
    );
    const { shown, hidden } = visibleBands(sessionGroups(overview({ runningSessions: many })));

    expect(shown).toHaveLength(SESSION_BAND_CAP);
    expect(hidden).toBe(3);
    // The cap keeps the most recently active, never an arbitrary slice.
    expect(nth(shown, 0).session.sessionId).toBe('s0');
    expect(shown.at(-1)?.session.sessionId).toBe(`s${SESSION_BAND_CAP - 1}`);
  });
});

describe('lib/sessionsFlow.ts sessionsFlowNodes()', () => {
  it('emits one session node and one node per agent, in two columns', () => {
    const groups = sessionGroups(
      overview({
        runningSessions: [session({ sessionId: 's' })],
        liveAgentEntries: [
          agent({ id: 'a1', sessionId: 's' }),
          agent({ id: 'a2', sessionId: 's' }),
        ],
      }),
    );
    const nodes = sessionsFlowNodes(groups, NOW);

    expect(nodes.map((n) => n.id)).toEqual(['session::s', 'agent::a1', 'agent::a2']);
    expect(nth(nodes, 0).position.x).toBe(0);
    expect(nth(nodes, 1).position.x).toBe(AGENT_COLUMN_X);
    expect(nth(nodes, 2).position.x).toBe(AGENT_COLUMN_X);
    // Agents stack down their session's band.
    expect(nth(nodes, 2).position.y - nth(nodes, 1).position.y).toBe(AGENT_STEP_Y);
  });

  it('packs bands across the row before starting a new one', () => {
    // The canvas is 640px tall and the full width of the page. One band per row
    // spent none of that width and all of that height, so fit-view-on-init had
    // to shrink 8 stacked bands into 640px and the operator dragged to read
    // anything. Bands tile across first for exactly that reason.
    const groups = sessionGroups(
      overview({
        runningSessions: Array.from({ length: 3 }, (_, i) =>
          session({
            sessionId: `s${i}`,
            lastEventAt: `2026-08-13T11:${String(59 - i).padStart(2, '0')}:00.000Z`,
          }),
        ),
      }),
    );
    const nodes = sessionsFlowNodes(groups, NOW, 2);

    // Row 0 runs left to right, in recency order — reading order, not a shuffle.
    for (let col = 0; col < 2; col++) {
      expect(nodeById(nodes, `session::s${col}`).position).toEqual({
        x: col * BAND_COLUMN_STEP_X,
        y: 0,
      });
    }
    // The one that did not fit wraps to the start of row 1, not to a third column.
    expect(nodeById(nodes, 'session::s2').position.x).toBe(0);
    expect(nodeById(nodes, 'session::s2').position.y).toBeGreaterThan(0);
  });

  it("keeps a band's agents in one column, offset from that band's own left edge", () => {
    // Agents are NOT wrapped the way bands are, and that is a decision rather
    // than an omission: every agent is drawn as an edge out of its session, and
    // a fan-out into a grid puts the edges to the second column straight
    // through the nodes of the first. Bands wrap because nothing is drawn
    // between them; agents stack because something is.
    const groups = sessionGroups(
      overview({
        runningSessions: [
          session({ sessionId: 'first', lastEventAt: NOW }),
          session({ sessionId: 'second', lastEventAt: '2026-08-13T11:00:00.000Z' }),
        ],
        liveAgentEntries: [
          agent({ id: 'b1', sessionId: 'second', dispatchedAt: LONG_AGO }),
          agent({ id: 'b2', sessionId: 'second', dispatchedAt: NOW }),
        ],
      }),
    );
    const nodes = sessionsFlowNodes(groups, NOW, 2);

    // Band 1 sits in column 1, so its agents are offset by the band step too —
    // an agent drawn at the row's absolute AGENT_COLUMN_X would land on top of
    // the neighbouring band.
    expect(nodeById(nodes, 'agent::b1').position).toEqual({
      x: BAND_COLUMN_STEP_X + AGENT_COLUMN_X,
      y: 0,
    });
    expect(nodeById(nodes, 'agent::b2').position).toEqual({
      x: BAND_COLUMN_STEP_X + AGENT_COLUMN_X,
      y: AGENT_STEP_Y,
    });
  });

  it('starts the next row below the tallest band in the row above, not the first', () => {
    const groups = sessionGroups(
      overview({
        runningSessions: [
          session({ sessionId: 'busy', lastEventAt: NOW }),
          session({ sessionId: 'quiet', lastEventAt: '2026-08-13T11:59:00.000Z' }),
          session({ sessionId: 'next-row', lastEventAt: '2026-08-13T11:00:00.000Z' }),
        ],
        liveAgentEntries: [
          agent({ id: 'a1', sessionId: 'busy' }),
          agent({ id: 'a2', sessionId: 'busy' }),
          agent({ id: 'a3', sessionId: 'busy' }),
        ],
      }),
    );
    const nodes = sessionsFlowNodes(groups, NOW, 2);

    // `quiet` is agentless and short; `busy` carries three agents. Advancing the
    // row by the last band placed rather than the tallest would slide row 1
    // under `busy`'s third agent.
    const lowestInBusy = Math.max(
      ...['agent::a1', 'agent::a2', 'agent::a3'].map((id) => nodeById(nodes, id).position.y),
    );
    expect(nodeById(nodes, 'session::next-row').position.y).toBe(
      lowestInBusy + AGENT_STEP_Y + BAND_GAP_Y,
    );
  });

  it('never makes a band shorter than the session node that has to fit inside it', () => {
    // A one-agent band's agent stack is shorter than the session node beside
    // it, so the agent arithmetic alone would let the next row overlap the
    // session card. The floor is the card's own height.
    expect(SESSION_NODE_H).toBeGreaterThan(AGENT_STEP_Y + BAND_GAP_Y);
    const groups = sessionGroups(
      overview({
        runningSessions: Array.from({ length: 3 }, (_, i) =>
          session({
            sessionId: `s${i}`,
            lastEventAt: `2026-08-13T11:${String(59 - i).padStart(2, '0')}:00.000Z`,
          }),
        ),
        liveAgentEntries: Array.from({ length: 2 }, (_, i) =>
          agent({ id: `a${i}`, sessionId: `s${i}` }),
        ),
      }),
    );
    const nodes = sessionsFlowNodes(groups, NOW, 2);

    expect(nodeById(nodes, 'session::s2').position.y).toBe(SESSION_NODE_H);
  });

  it('carries the activity each node claims, computed from liveness.ts thresholds', () => {
    const groups = sessionGroups(
      overview({
        runningSessions: [
          session({ sessionId: 'live', lastEventAt: NOW }),
          session({ sessionId: 'quiet', lastEventAt: QUIET_SINCE }),
        ],
        liveAgentEntries: [
          agent({ id: 'working', sessionId: 'live', dispatchedAt: NOW }),
          agent({ id: 'stalled', sessionId: 'live', dispatchedAt: LONG_AGO }),
        ],
      }),
    );
    const nodes = sessionsFlowNodes(groups, NOW);

    const live = nodeById(nodes, 'session::live').data;
    expect(live.kind).toBe('session');
    if (live.kind !== 'session') throw new Error('expected a session node');
    expect(live.activity).toBe('active');
    // The count the pulse claims: one of the two agents is actually working.
    expect(live.workingAgents).toBe(1);
    expect(live.agentCount).toBe(2);

    const quiet = nodeById(nodes, 'session::quiet').data;
    if (quiet.kind !== 'session') throw new Error('expected a session node');
    expect(quiet.activity).toBe('idle');

    const stalled = nodeById(nodes, 'agent::stalled').data;
    if (stalled.kind !== 'agent') throw new Error('expected an agent node');
    expect(stalled.activity).toBe('stalled');
  });

  it('never claims activity it cannot evidence — an unreadable clock is `unknown`', () => {
    const groups = sessionGroups(
      overview({
        runningSessions: [session({ sessionId: 'weird', lastEventAt: 'not-a-date' })],
        liveAgentEntries: [agent({ id: 'weird-a', sessionId: 'weird', dispatchedAt: 'nope' })],
      }),
    );
    const nodes = sessionsFlowNodes(groups, NOW);

    const s = nodeById(nodes, 'session::weird').data;
    if (s.kind !== 'session') throw new Error('expected a session node');
    expect(s.activity).toBe('unknown');
    const a = nodeById(nodes, 'agent::weird-a').data;
    if (a.kind !== 'agent') throw new Error('expected an agent node');
    expect(a.activity).toBe('unknown');
  });

  it('stacks the bands in one column when the canvas can only show one', () => {
    const groups = sessionGroups(
      overview({
        runningSessions: [
          session({ sessionId: 'a', lastEventAt: NOW }),
          session({ sessionId: 'b', lastEventAt: '2026-08-13T11:59:00.000Z' }),
        ],
      }),
    );
    const nodes = sessionsFlowNodes(groups, NOW, 1);

    expect(nodeById(nodes, 'session::a').position).toEqual({ x: 0, y: 0 });
    expect(nodeById(nodes, 'session::b').position).toEqual({ x: 0, y: SESSION_NODE_H });
  });
});

/** `n` single-agent bands — the shape the arithmetic is easiest to check against. */
function bands(n: number) {
  return sessionGroups(
    overview({
      runningSessions: Array.from({ length: n }, (_, i) =>
        session({
          sessionId: `s${i}`,
          lastEventAt: `2026-08-13T11:${String(59 - i).padStart(2, '0')}:00.000Z`,
        }),
      ),
      liveAgentEntries: Array.from({ length: n }, (_, i) =>
        agent({ id: `a${i}`, sessionId: `s${i}` }),
      ),
    }),
  );
}

/**
 * `n` bands with no agents under them at all — the ordinary state of a dashboard
 * whose runs are between dispatches, and the one case where a band is narrower
 * than `BAND_WIDTH` because there is no agent node to reach out to.
 */
function agentlessBands(n: number) {
  return sessionGroups(
    overview({
      runningSessions: Array.from({ length: n }, (_, i) =>
        session({
          sessionId: `s${i}`,
          lastEventAt: `2026-08-13T11:${String(59 - i).padStart(2, '0')}:00.000Z`,
        }),
      ),
      liveAgentEntries: [],
    }),
  );
}

describe('lib/sessionsFlow.ts bandGridExtent()', () => {
  it('measures the box the canvas has to fit, gutters and all', () => {
    expect(bandGridExtent(bands(4), 1)).toEqual({ width: BAND_WIDTH, height: 4 * SESSION_NODE_H });
    expect(bandGridExtent(bands(4), 2)).toEqual({
      width: BAND_COLUMN_STEP_X + BAND_WIDTH,
      height: 2 * SESSION_NODE_H,
    });
  });

  it('never claims a column that has no band in it', () => {
    // Two columns asked for, one band to put in them: the graph is one band
    // wide. Charging for the empty column would make the layout look worse than
    // it draws and push the fit smaller than it needs to be.
    expect(bandGridExtent(bands(1), 2).width).toBe(BAND_WIDTH);
  });

  it('stops at the session card when the last column dispatched nothing', () => {
    // A band with no agents draws one 320px card and no agent node, so charging
    // it the full 680px band width measures 360px of empty canvas per column.
    // That is not a rounding error on a dashboard: sessions sit agentless
    // between dispatches, and the overcharge is what decides how many columns
    // `bandsPerRowFor()` thinks it has room for.
    expect(bandGridExtent(agentlessBands(4), 1).width).toBe(SESSION_NODE_W);
    expect(bandGridExtent(agentlessBands(4), 2).width).toBe(BAND_COLUMN_STEP_X + SESSION_NODE_W);
  });

  it('still reaches past the agents the last column DID dispatch', () => {
    // Mixed rows: the right edge belongs to whatever the rightmost column holds,
    // and one agent anywhere in that column puts it back out at BAND_WIDTH.
    const mixed = sessionGroups(
      overview({
        runningSessions: [
          session({ sessionId: 's0', lastEventAt: '2026-08-13T11:59:00.000Z' }),
          session({ sessionId: 's1', lastEventAt: '2026-08-13T11:58:00.000Z' }),
        ],
        liveAgentEntries: [agent({ id: 'a1', sessionId: 's1' })],
      }),
    );
    expect(bandGridExtent(mixed, 2).width).toBe(BAND_COLUMN_STEP_X + BAND_WIDTH);
  });
});

describe('lib/sessionsFlow.ts bandsPerRowFor()', () => {
  it('keeps a small graph in one column, where it is drawn biggest', () => {
    // The complaint this whole layout answers is dragging, and dragging is a
    // function of the fit zoom, not of the column count. Two bands on a
    // desktop canvas fit at 1.25 in one column and 0.69 in two — tiling them
    // across would make the text SMALLER, which is the wrong direction.
    expect(bandsPerRowFor(bands(2), 990, 640)).toBe(1);
  });

  it('tiles a tall graph across the row it has width for', () => {
    // Eight bands stacked is 1088px against a 640px canvas: 0.59, which is the
    // squint the operator complained about. The same eight two across is 544px
    // tall and fits at 0.69.
    expect(bandsPerRowFor(bands(8), 990, 640)).toBe(2);
  });

  it('picks whichever column count Vue Flow would fit largest', () => {
    // Not a breakpoint and not a constant: every candidate is scored and the
    // winner is the one that leaves the nodes biggest.
    //
    // This re-derives the production formula rather than calling Vue Flow, so it
    // proves the search finds the maximum of that formula — not that the formula
    // is fitView. It cannot be: importing @vue-flow/core here would drag a
    // browser renderer into an `environment: node` suite, and reimplementing its
    // padding arithmetic would only assert that two copies of a guess agree. The
    // claim that the chosen layout really does land inside the real canvas is an
    // e2e one, and ui/e2e/sessions.spec.ts makes it against rendered boxes.
    for (const n of [1, 2, 3, 5, 8]) {
      for (const [w, h] of [
        [342, 640],
        [640, 640],
        [990, 640],
        [1600, 900],
      ] as const) {
        const chosen = bandsPerRowFor(bands(n), w, h);
        const zoomAt = (cols: number) => {
          const e = bandGridExtent(bands(n), cols);
          return Math.min(FIT_MAX_ZOOM, Math.min(w / e.width, h / e.height));
        };
        for (let cols = 1; cols <= MAX_BANDS_PER_ROW; cols++) {
          expect(
            zoomAt(chosen),
            `${n} bands in ${w}x${h}: chose ${chosen} columns, ${cols} fits larger`,
          ).toBeGreaterThanOrEqual(zoomAt(cols));
        }
      }
    }
  });

  it('stays in one column on a phone, where a second one would be cropped off', () => {
    // Vue Flow will not zoom out past its own 0.5 floor, so a graph wider than
    // twice the canvas is not shrunk to fit — it is cropped, and the first
    // thing cropped is the leftmost session card. Scoring on raw fit zoom
    // rather than the clamped one is what keeps that from being chosen.
    expect(bandsPerRowFor(bands(8), 342, 640)).toBe(1);
  });

  it('answers before it has been told anything — no groups, no canvas, no NaN', () => {
    // The canvas is measured after it mounts, so the first call happens with
    // zeroes on the board. A division by zero here would put NaN into every
    // node position.
    expect(bandsPerRowFor([], 990, 640)).toBe(1);
    expect(bandsPerRowFor(bands(4), 0, 0)).toBe(1);
    // NaN reaches here from a contentRect read on a detached element. It passes
    // the `<= 0` guard, so what actually holds the answer down is that every
    // comparison against NaN is false and `best` never moves off its initial 1.
    // Asserted because the guard does not cover it and the next edit to the
    // scoring loop could quietly take that away.
    expect(bandsPerRowFor(bands(4), Number.NaN, Number.NaN)).toBe(1);
  });
});

describe('lib/sessionsFlow.ts sessionsFlowEdges()', () => {
  it('connects each agent to the session that dispatched it', () => {
    const groups = sessionGroups(
      overview({
        runningSessions: [session({ sessionId: 's' })],
        liveAgentEntries: [agent({ id: 'a1', sessionId: 's' })],
      }),
    );
    const edges = sessionsFlowEdges(groups, NOW);

    expect(edges).toHaveLength(1);
    expect(nth(edges, 0).source).toBe('session::s');
    expect(nth(edges, 0).target).toBe('agent::a1');
    // Same reasoning as roadmapFlow.ts: nodes are content-sized, so a bezier
    // between handles at different y bows into an S-curve.
    expect(nth(edges, 0).type).toBe('straight');
  });

  it('animates only an edge where the run AND the agent are both moving', () => {
    const groups = sessionGroups(
      overview({
        runningSessions: [
          session({ sessionId: 'live', lastEventAt: NOW }),
          session({ sessionId: 'quiet', lastEventAt: QUIET_SINCE }),
        ],
        liveAgentEntries: [
          agent({ id: 'moving', sessionId: 'live', dispatchedAt: NOW }),
          agent({ id: 'stuck', sessionId: 'live', dispatchedAt: LONG_AGO }),
          // Working agent, but its run has gone quiet: motion here would claim
          // the session is producing something, which the events do not show.
          agent({ id: 'orphaned-by-silence', sessionId: 'quiet', dispatchedAt: NOW }),
        ],
      }),
    );
    const animated = sessionsFlowEdges(groups, NOW)
      .filter((e) => e.animated)
      .map((e) => e.target);

    expect(animated).toEqual(['agent::moving']);
  });
});

/**
 * `n` bands where band `busyIndex` carries `busyAgents` agents and every other
 * band carries one -- the shape the cap exists for. Recency order is `s0` first,
 * so the index is also the position in `sessionGroups()`'s output.
 */
function unevenBands(n: number, busyIndex: number, busyAgents: number) {
  const entries: LiveAgentEntry[] = [];
  for (let i = 0; i < n; i++) {
    const count = i === busyIndex ? busyAgents : 1;
    for (let k = 0; k < count; k++) {
      entries.push(
        agent({
          id: `a${i}-${k}`,
          sessionId: `s${i}`,
          // byRuntimeDesc reads dispatchedAt, so stagger it: k=0 is the
          // oldest and must stay first through the cap.
          dispatchedAt: `2026-08-13T09:${String(k).padStart(2, '0')}:00.000Z`,
        }),
      );
    }
  }
  return sessionGroups(
    overview({
      runningSessions: Array.from({ length: n }, (_, i) =>
        session({
          sessionId: `s${i}`,
          lastEventAt: `2026-08-13T11:${String(59 - i).padStart(2, '0')}:00.000Z`,
        }),
      ),
      liveAgentEntries: entries,
    }),
  );
}

/**
 * Operator directive (Phase 10): "the sessions view needs reorganising so it
 * is easier to read when many subagents are dispatched." A band's height was
 * unbounded in agent
 * count while `sessionsFlowNodes()` takes the tallest band in a row as the row's
 * height -- so one session that dispatched twenty subagents dragged its
 * row-mates down with it and collapsed the fit zoom for every band on the
 * canvas. These tests pin the two halves of the fix: the stack is capped, and an
 * expanded stack is routed out of the shared row rather than allowed to inflate
 * it.
 */
describe('lib/sessionsFlow.ts visibleAgents()', () => {
  const band = (count: number) => nth(unevenBands(1, 0, count), 0);

  it('caps a collapsed stack and says how many it left', () => {
    const { shown, hidden } = visibleAgents(band(10), false);
    expect(shown).toHaveLength(AGENT_VISIBLE_CAP);
    expect(hidden).toBe(10 - AGENT_VISIBLE_CAP);
  });

  it('draws every agent once the operator expands the band', () => {
    const { shown, hidden } = visibleAgents(band(10), true);
    expect(shown).toHaveLength(10);
    expect(hidden).toBe(0);
  });

  it('leaves a stack at or under the cap alone, expanded or not', () => {
    for (const expanded of [false, true]) {
      expect(visibleAgents(band(AGENT_VISIBLE_CAP), expanded)).toEqual({
        shown: nth(unevenBands(1, 0, AGENT_VISIBLE_CAP), 0).agents,
        hidden: 0,
      });
    }
  });

  it('reports nothing hidden for a band that dispatched nothing', () => {
    const idle = nth(agentlessBands(1), 0);
    expect(visibleAgents(idle, false)).toEqual({ shown: [], hidden: 0 });
  });

  it('keeps byRuntimeDesc order -- the cap is the head of the stack, not a sample', () => {
    const { shown } = visibleAgents(band(10), false);
    // byRuntimeDesc is longest-running first, and unevenBands staggers startedAt
    // ascending by k, so the oldest agent is a0-0.
    expect(shown.map((a) => a.id)).toEqual(['a0-0', 'a0-1', 'a0-2', 'a0-3', 'a0-4', 'a0-5']);
  });
});

describe('lib/sessionsFlow.ts sessionsFlowNodes() agent cap', () => {
  it('draws at most AGENT_VISIBLE_CAP agent nodes for a collapsed band', () => {
    const nodes = sessionsFlowNodes(unevenBands(1, 0, 10), NOW);
    expect(nodes.filter((n) => n.type === 'agent')).toHaveLength(AGENT_VISIBLE_CAP);
  });

  it('draws every agent node once the band is expanded', () => {
    const nodes = sessionsFlowNodes(unevenBands(1, 0, 10), NOW, 1, new Set(['s0']));
    expect(nodes.filter((n) => n.type === 'agent')).toHaveLength(10);
  });

  it('still reports the whole agent count on the session node, capped or not', () => {
    // The card counts the run's agents. The cap changes how many are drawn,
    // never how many there are (D-242).
    const nodes = sessionsFlowNodes(unevenBands(1, 0, 10), NOW);
    const card = nodeById(nodes, sessionNodeId('s0'));
    expect(card.data.kind === 'session' && card.data.agentCount).toBe(10);
  });

  it('places an expanded busy band alone in its row', () => {
    // Four bands, three across: without the isolate rule s0 would share row 0
    // with s1 and s2 and drag both down to 10*84+40 = 880px.
    const groups = unevenBands(4, 0, 10);
    const nodes = sessionsFlowNodes(groups, NOW, 3, new Set(['s0']));
    expect(nodeById(nodes, sessionNodeId('s0')).position).toEqual({ x: 0, y: 0 });
    // s1..s3 tile normally in the row below, starting under the tall band.
    const rowTop = 10 * AGENT_STEP_Y + BAND_GAP_Y;
    expect(nodeById(nodes, sessionNodeId('s1')).position).toEqual({ x: 0, y: rowTop });
    expect(nodeById(nodes, sessionNodeId('s2')).position).toEqual({
      x: BAND_COLUMN_STEP_X,
      y: rowTop,
    });
    expect(nodeById(nodes, sessionNodeId('s3')).position).toEqual({
      x: 2 * BAND_COLUMN_STEP_X,
      y: rowTop,
    });
  });

  it('closes the row already in progress before isolating a tall band', () => {
    // s2 is the busy one, so s0 and s1 have already filled two of three slots
    // in row 0. The tall band must not join them, and must not reorder them.
    const nodes = sessionsFlowNodes(unevenBands(4, 2, 10), NOW, 3, new Set(['s2']));
    expect(nodeById(nodes, sessionNodeId('s0')).position).toEqual({ x: 0, y: 0 });
    expect(nodeById(nodes, sessionNodeId('s1')).position).toEqual({
      x: BAND_COLUMN_STEP_X,
      y: 0,
    });
    const secondRow = SESSION_NODE_H;
    expect(nodeById(nodes, sessionNodeId('s2')).position).toEqual({ x: 0, y: secondRow });
    expect(nodeById(nodes, sessionNodeId('s3')).position).toEqual({
      x: 0,
      y: secondRow + 10 * AGENT_STEP_Y + BAND_GAP_Y,
    });
  });

  it('does not isolate a busy band that is merely collapsed', () => {
    // Collapsed, a ten-agent band is exactly as tall as any other capped band,
    // so it has no claim on a row of its own -- this is the default state, and
    // it must tile exactly as it did before the cap existed.
    const nodes = sessionsFlowNodes(unevenBands(3, 0, 10), NOW, 3);
    expect(nodeById(nodes, sessionNodeId('s1')).position).toEqual({
      x: BAND_COLUMN_STEP_X,
      y: 0,
    });
  });

  it('does not isolate an expanded band that is under the cap', () => {
    // Expanding a band with three agents reveals nothing, so it changes no
    // geometry either. An expansion state that moved a band without changing
    // what it draws would be a layout that jumps for no visible reason.
    const groups = unevenBands(3, 0, 3);
    expect(sessionsFlowNodes(groups, NOW, 3, new Set(['s0']))).toEqual(
      sessionsFlowNodes(groups, NOW, 3),
    );
  });
});

describe('lib/sessionsFlow.ts bandGridExtent() with expansion', () => {
  it('measures the isolated row, not the tiled one it would have been', () => {
    const groups = unevenBands(4, 0, 10);
    const tall = 10 * AGENT_STEP_Y + BAND_GAP_Y;
    expect(bandGridExtent(groups, 3, new Set(['s0']))).toEqual({
      width: 2 * BAND_COLUMN_STEP_X + BAND_WIDTH,
      height: tall + SESSION_NODE_H,
    });
  });

  it('measures a collapsed busy band at the capped height, not the raw one', () => {
    // Six agents fit; the seventh through the twentieth are not drawn and so
    // must not be charged for.
    expect(bandGridExtent(unevenBands(1, 0, 20), 1)).toEqual({
      width: BAND_WIDTH,
      height: AGENT_VISIBLE_CAP * AGENT_STEP_Y + BAND_GAP_Y,
    });
  });

  it('agrees with what sessionsFlowNodes() actually draws', () => {
    // The extent is what bandsPerRowFor() scores; if it disagreed with the
    // nodes, the page would pick a column count for a graph it never draws.
    const groups = unevenBands(5, 1, 12);
    const expanded = new Set(['s1']);
    const nodes = sessionsFlowNodes(groups, NOW, 2, expanded);
    const bottom = Math.max(...nodes.map((n) => n.position.y));
    expect(bandGridExtent(groups, 2, expanded).height).toBeGreaterThan(bottom);
  });
});

describe('lib/sessionsFlow.ts bandsPerRowFor() with expansion', () => {
  it('scores the extents the expanded layout will actually occupy', () => {
    const groups = unevenBands(4, 0, 10);
    // Same canvas, same bands, one expanded: the answer is allowed to differ,
    // but it must come from bandGridExtent under the SAME expansion set.
    const cols = bandsPerRowFor(groups, 990, 640, new Set(['s0']));
    const { width, height } = bandGridExtent(groups, cols, new Set(['s0']));
    for (let other = 1; other <= MAX_BANDS_PER_ROW; other++) {
      const alt = bandGridExtent(groups, other, new Set(['s0']));
      expect(Math.min(FIT_MAX_ZOOM, 990 / width, 640 / height)).toBeGreaterThanOrEqual(
        Math.min(FIT_MAX_ZOOM, 990 / alt.width, 640 / alt.height) - 1e-9,
      );
    }
  });

  it('reads an omitted expansion set as nothing expanded', () => {
    const groups = unevenBands(6, 0, 10);
    expect(bandsPerRowFor(groups, 990, 640)).toBe(bandsPerRowFor(groups, 990, 640, new Set()));
  });
});
