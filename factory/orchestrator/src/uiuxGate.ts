import { resolveArtifactPath } from './artifacts.js';
import type { EventOpts, StoredEvent } from './events.js';
import { eventTaskId, readLineageEvents } from './events.js';
import { foldJudgeTurns, JUDGE_DISPATCH_EVENT_TYPE } from './judges.js';
import { taskIdsMatch } from './taskId.js';

/** `judges.ts`'s uiux role, spelled out here rather than imported: the string is the taxonomy value, not an implementation detail of judges.ts. */
const UIUX_ROLE = 'uiux';

export type UiuxBlockReason =
  | 'uiux-spec-missing'
  | 'screenshots-missing'
  | 'screenshots-stale'
  | 'uiux-visual-missing';

export type UiuxCheckResult = { outcome: 'pass' } | { outcome: 'blocked'; reason: UiuxBlockReason };

export interface UiuxCheckInput {
  taskId: string;
  /**
   * The sha the freshness check proves screenshots against — the gate's
   * `commitCheck.head`. Optional: a preflight call with no worktree to read a
   * head from (`bs uiux check` with no `--worktree`) still checks the spec
   * turn, the screenshot set, and visual-turn ordering, it just cannot judge
   * staleness against anything, so that one reason never fires.
   */
  head?: string;
  artifactsDir?: string;
}

/** One `results record --worktree` call's screenshot entry, as recorded on `artifact-check-result`. */
interface RecordedScreenshot {
  path: string;
  viewport: string;
  theme: string;
}

/** The latest `results record --worktree` call for this task — the gate's freshness evidence (U2 D2). */
interface TesterRecord {
  /** Position in the lineage, not wall-clock time: two events minted in the same millisecond still have a real order. */
  index: number;
  head: string;
  screenshots: RecordedScreenshot[];
}

/** desktop × mobile, light × dark — the four shots a visual pass has to cover. */
const REQUIRED_COMBOS: readonly [string, string][] = [
  ['desktop', 'light'],
  ['desktop', 'dark'],
  ['mobile', 'light'],
  ['mobile', 'dark'],
];

function latestTesterRecord(events: readonly StoredEvent[], taskId: string): TesterRecord | null {
  let latest: TesterRecord | null = null;
  events.forEach(({ record }, index) => {
    if (record.event_type !== 'artifact-check-result') return;
    if (!taskIdsMatch(eventTaskId(record) ?? undefined, taskId)) return;
    const head = record.payload.head;
    if (typeof head !== 'string') return; // an artifact-check-result with no --worktree behind it
    const screenshots = Array.isArray(record.payload.screenshots)
      ? (record.payload.screenshots as RecordedScreenshot[])
      : [];
    latest = { index, head, screenshots };
  });
  return latest;
}

/** The lineage position of the dispatch that opened a judge turn — `JudgeTurn.dispatchedAt` is wall-clock only. */
function dispatchIndex(
  events: readonly StoredEvent[],
  taskId: string,
  role: string,
  kind: string,
  round: number,
): number {
  let found = -1;
  events.forEach(({ record }, index) => {
    if (record.event_type !== JUDGE_DISPATCH_EVENT_TYPE) return;
    if (!taskIdsMatch(eventTaskId(record) ?? undefined, taskId)) return;
    if (record.payload.agent_role !== role) return;
    if (record.payload.judge_kind !== kind) return;
    if (record.payload.round !== round) return;
    found = index;
  });
  return found;
}

/**
 * `checkUiux`: the one function both the gate stage and `bs uiux check`
 * (the preflight verb, D4) call, so the two can never disagree about the same
 * fixture. Reads the lineage once and folds both judge turns and the tester's
 * freshness record out of it — no separate dispatch, no separate store.
 */
export async function checkUiux(
  input: UiuxCheckInput,
  ctx: { sessionId: string },
  opts: EventOpts = {},
): Promise<UiuxCheckResult> {
  const events = await readLineageEvents(ctx.sessionId, opts);
  const turns = foldJudgeTurns(events, input.taskId);

  const specTurn = turns.find((t) => t.role === UIUX_ROLE && t.kind === 'spec');
  if (!specTurn?.reported) {
    return { outcome: 'blocked', reason: 'uiux-spec-missing' };
  }

  const tester = latestTesterRecord(events, input.taskId);
  if (tester === null) {
    return { outcome: 'blocked', reason: 'screenshots-missing' };
  }

  const haveCombos = new Set(tester.screenshots.map((s) => `${s.viewport}:${s.theme}`));
  const allComboesPresent = REQUIRED_COMBOS.every(([viewport, theme]) =>
    haveCombos.has(`${viewport}:${theme}`),
  );
  const allOnDisk = tester.screenshots.every(
    (s) => resolveArtifactPath(input.taskId, s.path, input.artifactsDir) !== null,
  );
  if (!allComboesPresent || !allOnDisk) {
    return { outcome: 'blocked', reason: 'screenshots-missing' };
  }

  if (input.head !== undefined && tester.head !== input.head) {
    return { outcome: 'blocked', reason: 'screenshots-stale' };
  }

  const visualTurn = turns.find((t) => t.role === UIUX_ROLE && t.kind === 'visual');
  const visualDispatchIndex =
    visualTurn === undefined
      ? -1
      : dispatchIndex(events, input.taskId, UIUX_ROLE, 'visual', visualTurn.round);
  if (!visualTurn?.reported || !(visualDispatchIndex > tester.index)) {
    return { outcome: 'blocked', reason: 'uiux-visual-missing' };
  }

  return { outcome: 'pass' };
}
