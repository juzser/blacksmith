// Pure layout for the Sessions canvas — the operator's T1 answer to "có cách
// nào đưa dạng node flow tương tự [nodeterm] lên black-smith chạy trên
// browser không?".
//
// nodeterm's idea worth taking is not its terminals, it is that *cards are
// live sessions*: the spatial canvas shows the runs themselves, not a static
// plan. black-smith can already draw that from data it publishes today —
// `/api/overview` returns `runningSessions` and `liveAgentEntries`
// (api.ts) — so this page adds no dependency, no route, and no transport.
// It stays on usePoll like every other surface (design-spec.md §8, "No
// WebSockets"), and @vue-flow/core is the one graph package
// docs/standards/stack.md sanctions.
//
// What this page is NOT: a terminal. A live PTY node would need xterm + a
// bidirectional socket + arbitrary command execution from the browser, which
// contradicts §8, contradicts stack.md's Workers-first rule, and would be the
// largest write surface the dashboard has ever had. That is deliberately left
// out of T1 rather than half-built.
//
// Kept out of the .vue file so it is unit-tested under ui/vitest.config.ts's
// `environment: node` — same split as lib/roadmapFlow.ts and lib/liveness.ts.
import type { LiveAgentEntry, OverviewResult, RunningSession } from './api.js';
import {
  type AgentActivity,
  agentActivity,
  byRuntimeDesc,
  bySessionRecency,
  type SessionActivity,
  sessionActivity,
  workingCount,
} from './liveness.js';

/** Horizontal gap between a session node and the agents it dispatched. */
export const AGENT_COLUMN_X = 380;
/**
 * Vertical distance between two agents in the same session's band. Paired with
 * `.agent-node`'s 72px cap in ds-components.css, which leaves a 12px channel:
 * the node is the fixed thing and the step is what clears it, so these two move
 * together or agents touch.
 */
export const AGENT_STEP_Y = 84;
/** Blank space between one band and the row of bands below it. */
export const BAND_GAP_Y = 40;
/**
 * The height `.session-node` is capped at in ds-components.css. Duplicated
 * here on purpose: a band has to clear whichever is taller, its agent stack or
 * the session card beside it, and a one-agent stack (84+40 = 124) is shorter
 * than the card. Without this floor the row below would be drawn across the
 * bottom of a session card that has no agent to make room for it.
 */
export const SESSION_NODE_H = 136;
/**
 * The width `.session-node` is fixed at in ds-components.css. It is the whole
 * width of a band that dispatched nothing — the ordinary state of a run between
 * tasks — because with no agents there is no node out at `AGENT_COLUMN_X` for
 * the band to reach.
 */
export const SESSION_NODE_W = 320;

/** How wide a band with agents draws: the agent offset plus `.agent-node`'s 300px. */
export const BAND_WIDTH = AGENT_COLUMN_X + 300;
/**
 * Left edge of one band column to the left edge of the next — BAND_WIDTH plus
 * an 80px gutter, wide enough that a band's agents cannot be misread as
 * belonging to the session drawn to their right.
 */
export const BAND_COLUMN_STEP_X = BAND_WIDTH + 80;
/**
 * Most band columns worth scoring. Past three the graph is wider than any
 * canvas the dashboard renders into, so every further candidate is width-bound
 * and strictly worse — scoring them would only cost cycles.
 */
export const MAX_BANDS_PER_ROW = 3;
/**
 * Vue Flow's own default maxZoom. It is part of the scoring rather than a
 * detail of the renderer: above 2 the nodes stop getting bigger, so a candidate
 * that "fits at 4" is not better than one that fits at 2, and treating it as
 * better would spread a two-band graph across the row for nothing.
 */
export const FIT_MAX_ZOOM = 2;

/**
 * How many bands the canvas draws before it stops and says how many it left
 * out. `runningSessions()` (queries.ts) returns EVERY projected session — the
 * name is a misnomer, `sessions` rows are never closed out — so on a
 * long-lived state/smith.db this is a few hundred, not a handful. Overview's
 * "Now running" card caps the same payload at 5 for the same reason.
 *
 * 8 rather than Overview's 5 because a canvas earns its cost by showing more
 * than the list does. Tiled two across (which is what `bandsPerRowFor()` picks
 * for eight), the cap buys four rows rather than eight: 832px of two-agent
 * bands against a 640px canvas, which fits at ~0.77 instead of the ~0.34 that
 * made this page unreadable. The cap is deliberately NOT raised to spend that
 * headroom — the headroom is the point, since a band is as tall as its agent
 * stack and the payload decides how tall that is.
 */
export const SESSION_BAND_CAP = 8;

export interface SessionGroup {
  session: RunningSession;
  /** Live agents dispatched by this session, longest-running first. */
  agents: LiveAgentEntry[];
}

export type SessionsFlowNodeData =
  | {
      kind: 'session';
      session: RunningSession;
      activity: SessionActivity;
      /** Agents attached to this run — including the ones that have stalled. */
      agentCount: number;
      /** How many of them are actually working: the count a pulse may claim. */
      workingAgents: number;
    }
  | { kind: 'agent'; agent: LiveAgentEntry; activity: AgentActivity };

export interface SessionsFlowNode {
  id: string;
  type: 'session' | 'agent';
  position: { x: number; y: number };
  data: SessionsFlowNodeData;
  sourcePosition: 'right';
  targetPosition: 'left';
}

export interface SessionsFlowEdge {
  id: string;
  source: string;
  target: string;
  /**
   * Same reasoning as roadmapFlow.ts: these nodes are content-sized, so a
   * session and its agents share a band top but not a height, their handles
   * sit at different y, and Vue Flow's default bezier bows into an S-curve.
   */
  type: 'straight';
  animated: boolean;
}

export function sessionNodeId(sessionId: string): string {
  return `session::${sessionId}`;
}
export function agentNodeId(agentId: string): string {
  return `agent::${agentId}`;
}

/**
 * One band per run, most recently active first, each carrying the agents that
 * run dispatched. A session with no live agents keeps its band: "this run is
 * quiet" is a fact the canvas exists to show, and dropping it would make an
 * idle run indistinguishable from one that never happened.
 */
export function sessionGroups(overview: OverviewResult): SessionGroup[] {
  const entries = overview.liveAgentEntries ?? [];
  return bySessionRecency(overview.runningSessions ?? []).map((session) => ({
    session,
    agents: byRuntimeDesc(entries.filter((a) => a.sessionId === session.sessionId)),
  }));
}

/**
 * Agents whose `sessionId` matches no projected session. `agents` rows stay
 * `live` until a terminal event closes them out (api.ts), so this set is not
 * hypothetical — and an agent that is running with no run to hang it under is
 * exactly the thing an operator needs told. Returned rather than force-fitted
 * under some other session, because inventing a parent would be inventing
 * data.
 */
export function unattachedAgents(overview: OverviewResult): LiveAgentEntry[] {
  const known = new Set((overview.runningSessions ?? []).map((s) => s.sessionId));
  return byRuntimeDesc((overview.liveAgentEntries ?? []).filter((a) => !known.has(a.sessionId)));
}

/**
 * The bands the canvas will actually draw, and how many it is leaving out.
 * Truncation is returned rather than applied silently: a canvas that quietly
 * stops at 8 claims those are all the runs there are, which on a real
 * state/smith.db is false. Same contract as Overview's `hiddenRunning`.
 */
export function visibleBands(
  groups: SessionGroup[],
  cap: number = SESSION_BAND_CAP,
): { shown: SessionGroup[]; hidden: number } {
  return { shown: groups.slice(0, cap), hidden: Math.max(0, groups.length - cap) };
}

/**
 * Height a band needs: one row per agent, one row even with no agents, and
 * never less than the session card that sits beside the stack.
 */
function bandHeight(group: SessionGroup): number {
  return Math.max(SESSION_NODE_H, Math.max(1, group.agents.length) * AGENT_STEP_Y + BAND_GAP_Y);
}

/**
 * The box `sessionsFlowNodes()` would draw at this column count — the same
 * bounds Vue Flow's fitView measures, computed before anything is rendered.
 *
 * Width counts columns that actually receive a band: three bands asked to tile
 * four across span three columns, not four, and charging for the empty one
 * would score the layout as wider than it draws.
 *
 * It also counts what those bands actually drew. A band that dispatched nothing
 * is one 320px card, not a 680px band, so a rightmost column of idle runs ends
 * 360px sooner than the arithmetic first suggests — and a dashboard between
 * dispatches is entirely made of those. Only the rightmost occupied column is
 * consulted because the gutter is wider than the difference it could make
 * (760 > 680 - 320), so no earlier column can reach past it.
 */
export function bandGridExtent(
  groups: SessionGroup[],
  bandsPerRow: number,
): { width: number; height: number } {
  if (groups.length === 0) return { width: 0, height: 0 };
  const cols = Math.max(1, Math.min(bandsPerRow, groups.length));
  let height = 0;
  let lastColumnHasAgents = false;
  for (let start = 0; start < groups.length; start += cols) {
    const row = groups.slice(start, start + cols);
    height += Math.max(...row.map(bandHeight));
    // The last column of THIS row is the grid's last column only on full rows;
    // a short final row leaves the rightmost column to the rows above it.
    const last = row[cols - 1];
    if (last && last.agents.length > 0) lastColumnHasAgents = true;
  }
  const lastColumnWidth = lastColumnHasAgents ? BAND_WIDTH : SESSION_NODE_W;
  return { width: (cols - 1) * BAND_COLUMN_STEP_X + lastColumnWidth, height };
}

/**
 * How many bands to tile across a canvas of this size — whichever count Vue
 * Flow's fitView would then draw largest.
 *
 * The complaint this layout answers is dragging, and dragging is a function of
 * the fit zoom alone, not of the column count: a fixed two-across made eight
 * bands legible (0.34 → 0.69) and made two bands *worse* (1.46 → 0.69), which
 * is the wrong direction on the same page. So the rule is not a constant and
 * not a device breakpoint — it scores every candidate the way fitView will and
 * keeps the winner. Ties go to fewer columns, since a graph the operator reads
 * top-to-bottom beats one they read in a grid at equal size.
 *
 * "The way fitView will" and "what fitView computes" are not quite the same
 * number, deliberately. Vue Flow scales the bounds by its 0.1 padding and floors
 * the result to integer px before clamping; this scores the unpadded ratio. The
 * padding scales every candidate alike so it cannot reorder them, but the floor
 * and the maxZoom clamp are per-axis, so two candidates within ~0.3% of each
 * other can swap places. That is a near-tie between two layouts that fit — a
 * visually indistinguishable outcome — and buying it back would mean copying a
 * private helper's rounding and re-copying it on every Vue Flow upgrade.
 *
 * Scored on the RAW fit zoom, deliberately un-clamped at the bottom: Vue Flow
 * will not zoom out past its own 0.5 floor, so a graph twice the canvas's width
 * is not shrunk to fit, it is cropped — and the first thing cropped is the
 * leftmost session card. Comparing clamped values would score that crop as a
 * tie with a layout that fits.
 */
export function bandsPerRowFor(
  groups: SessionGroup[],
  canvasWidth: number,
  canvasHeight: number,
): number {
  if (groups.length === 0 || canvasWidth <= 0 || canvasHeight <= 0) return 1;
  let best = 1;
  let bestZoom = -1;
  for (let cols = 1; cols <= Math.min(MAX_BANDS_PER_ROW, groups.length); cols++) {
    const { width, height } = bandGridExtent(groups, cols);
    const zoom = Math.min(FIT_MAX_ZOOM, canvasWidth / width, canvasHeight / height);
    // Strictly greater, so an equal fit leaves `best` at the earlier — fewer —
    // column count rather than drifting wider for no gain.
    if (zoom > bestZoom + 1e-9) {
      bestZoom = zoom;
      best = cols;
    }
  }
  return best;
}

/**
 * Bands are laid out row-major, `bandsPerRow` across; a band's agents are NOT.
 *
 * That asymmetry is a decision rather than an oversight. Every agent is drawn
 * as a straight edge out of its session's right handle, which sits inside the
 * y-range of the first agent node — so an edge aimed at a second agent column
 * would leave the handle and immediately cross the first column's nodes, at
 * every stagger. Bands wrap because nothing is drawn between them; agents stack
 * because something is.
 */
export function sessionsFlowNodes(
  groups: SessionGroup[],
  nowIso: string,
  // One column unless a measured canvas says otherwise: the caller that knows
  // how wide the box is passes `bandsPerRowFor()`, and a caller that does not
  // gets the layout that cannot be drawn wider than it fits.
  bandsPerRow = 1,
): SessionsFlowNode[] {
  const nodes: SessionsFlowNode[] = [];
  let rowTop = 0;
  for (let start = 0; start < groups.length; start += bandsPerRow) {
    const row = groups.slice(start, start + bandsPerRow);
    row.forEach((group, col) => {
      const bandLeft = col * BAND_COLUMN_STEP_X;
      nodes.push({
        id: sessionNodeId(group.session.sessionId),
        type: 'session',
        position: { x: bandLeft, y: rowTop },
        data: {
          kind: 'session',
          session: group.session,
          activity: sessionActivity(group.session.lastEventAt, nowIso),
          agentCount: group.agents.length,
          workingAgents: workingCount(group.agents, nowIso),
        },
        sourcePosition: 'right',
        targetPosition: 'left',
      });
      group.agents.forEach((agent, idx) => {
        nodes.push({
          id: agentNodeId(agent.id),
          type: 'agent',
          position: { x: bandLeft + AGENT_COLUMN_X, y: rowTop + idx * AGENT_STEP_Y },
          data: { kind: 'agent', agent, activity: agentActivity(agent, nowIso) },
          sourcePosition: 'right',
          targetPosition: 'left',
        });
      });
    });
    // The tallest band in the row, not the last one placed: a short band beside
    // a four-agent one must not let the next row start under those agents.
    rowTop += Math.max(...row.map(bandHeight));
  }
  return nodes;
}

/**
 * One edge per agent, and motion only where BOTH ends are moving. A working
 * agent under a run that has gone quiet is not animated: the pulse would be
 * claiming the session is producing something, and the event log — the only
 * evidence there is — says it has appended nothing for 15 minutes.
 */
export function sessionsFlowEdges(groups: SessionGroup[], nowIso: string): SessionsFlowEdge[] {
  const edges: SessionsFlowEdge[] = [];
  for (const group of groups) {
    const runActive = sessionActivity(group.session.lastEventAt, nowIso) === 'active';
    for (const agent of group.agents) {
      edges.push({
        id: `${sessionNodeId(group.session.sessionId)}->${agentNodeId(agent.id)}`,
        source: sessionNodeId(group.session.sessionId),
        target: agentNodeId(agent.id),
        type: 'straight',
        animated: runActive && agentActivity(agent, nowIso) === 'working',
      });
    }
  }
  return edges;
}
