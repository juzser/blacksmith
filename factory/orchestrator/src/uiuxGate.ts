import { resolveArtifactPath } from './artifacts.js';
import type { EventOpts, StoredEvent } from './events.js';
import { eventTaskId } from './events.js';
import { foldJudgeTurns, JUDGE_DISPATCH_EVENT_TYPE } from './judges.js';
import { readLineage } from './lineageSnapshot.js';
import { taskIdsMatch } from './taskId.js';

/** `judges.ts`'s uiux role, spelled out here rather than imported: the string is the taxonomy value, not an implementation detail of judges.ts. */
const UIUX_ROLE = 'uiux';

export type UiuxBlockReason =
  | 'uiux-spec-missing'
  | 'screenshots-missing'
  | 'screenshots-stale'
  | 'mobile-overflow'
  | 'uiux-visual-missing';

/** A shot whose recorded in-page width does not prove its declared viewport: the file name says one thing, the page measured another (or nothing). */
export interface InvalidShot {
  path: string;
  viewport: string;
  inner_width?: number;
  client_width?: number;
  why: 'width-mismatch' | 'no-width-record' | 'page-not-mobile-scaled';
  /** What to look at first; absent when `why` already says it. */
  hint?: string;
}

/** A genuine mobile shot of a page that is wider than the viewport: a real horizontal-overflow defect of the page, not a crop. */
export interface OverflowShot {
  path: string;
  viewport: string;
  inner_width: number;
  client_width: number;
}

export type UiuxCheckResult =
  | { outcome: 'pass' }
  | {
      outcome: 'blocked';
      reason: UiuxBlockReason;
      invalidShots?: InvalidShot[];
      /** Set only on `mobile-overflow`: each mobile shot whose page is wider than its viewport. */
      overflow?: OverflowShot[];
    };

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
  inner_width?: number;
  client_width?: number;
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

/** One screenshot of a tester's set: its declared path and the viewport and theme its file name carries. */
interface ScreenshotEntry {
  path: string;
  viewport: string;
  theme: string;
  /** `window.innerWidth` the tester measured in the page when it took the shot. */
  inner_width?: number;
  /** `document.documentElement.clientWidth`, measured the same way. */
  client_width?: number;
}

/** The CSS width a `mobile` shot is declared at. */
const MOBILE_WIDTH = 390;
/**
 * How far below 390 a mobile `client_width` may sit: a classic scrollbar takes
 * 15-17 px off the layout viewport. A headless `--window-size=390` crop renders
 * at 485+, so it falls well outside the band on the other side.
 */
const SCROLLBAR_ALLOWANCE = 20;
/** Narrowest `window.innerWidth` a `desktop` shot may report. */
const DESKTOP_MIN_WIDTH = 768;
/** Where a layout viewport stops looking like a scrollbar quirk and starts looking like an unscaled page (980 with no meta viewport, 780 at initial-scale=0.5). */
const NOT_SCALED_MIN_WIDTH = 600;

/**
 * Why a shot's recorded widths do not prove its declared viewport, or null when
 * they do. No record is no proof: a crop of a wider layout looks like clipping
 * and must not reach the visual judge as evidence. Mobile is keyed on
 * `client_width` (the layout viewport): a page that overflows measures a large
 * `inner_width` under correct emulation, so `inner_width` alone cannot refuse it.
 */
function shotWidthIssue(s: ScreenshotEntry): InvalidShot['why'] | null {
  const { inner_width: inner, client_width: client } = s;
  if (typeof inner !== 'number' || typeof client !== 'number') return 'no-width-record';
  if (s.viewport === 'mobile') {
    if (client <= MOBILE_WIDTH && client >= MOBILE_WIDTH - SCROLLBAR_ALLOWANCE) return null;
    // The layout viewport sits far above 390, whatever the page overflows to: the emulated device did not scale the page.
    return client >= NOT_SCALED_MIN_WIDTH ? 'page-not-mobile-scaled' : 'width-mismatch';
  }
  return inner >= DESKTOP_MIN_WIDTH ? null : 'width-mismatch';
}

const HINTS: Partial<Record<InvalidShot['why'], string>> = {
  'width-mismatch':
    'a headless --window-size crop, or a custom wide ::-webkit-scrollbar, can cause this; shoot with viewport emulation',
  'page-not-mobile-scaled':
    'the page is not scaled to the device width: its meta viewport is missing or wrong, for example initial-scale below 1; it should be <meta name="viewport" content="width=device-width, initial-scale=1">; shoot with isMobile device emulation and do not drop isMobile to make this pass, the page is the defect',
};

/** Every shot whose recorded widths do not match its viewport, with the widths it recorded. */
export function shotWidthIssues(shots: readonly ScreenshotEntry[]): InvalidShot[] {
  const out: InvalidShot[] = [];
  for (const s of shots) {
    const why = shotWidthIssue(s);
    if (why === null) continue;
    out.push({
      path: s.path,
      viewport: s.viewport,
      ...(s.inner_width === undefined ? {} : { inner_width: s.inner_width }),
      ...(s.client_width === undefined ? {} : { client_width: s.client_width }),
      why,
      ...(HINTS[why] === undefined ? {} : { hint: HINTS[why] }),
    });
  }
  return out;
}

/** Valid mobile shots whose page is wider than the viewport (`inner_width` above `client_width`): the gate blocks on them as `mobile-overflow`. */
export function shotOverflows(shots: readonly ScreenshotEntry[]): OverflowShot[] {
  const out: OverflowShot[] = [];
  for (const s of shots) {
    if (s.viewport !== 'mobile' || shotWidthIssue(s) !== null) continue;
    const { inner_width: inner, client_width: client } = s;
    if (typeof inner === 'number' && typeof client === 'number' && inner > client)
      out.push({ path: s.path, viewport: s.viewport, inner_width: inner, client_width: client });
  }
  return out;
}

/**
 * The screenshot-set test, shared by the gate's uiux stage and the tester's own
 * pre-hand-back check: all four REQUIRED_COMBOS are present, and every shot
 * resolves to a file inside the task's artifact home. A shot whose recorded
 * in-page width does not match its declared viewport does not count toward
 * its combo.
 */
export function screenshotSetComplete(
  taskId: string,
  shots: readonly ScreenshotEntry[],
  artifactsDir?: string,
): boolean {
  const haveCombos = new Set(
    shots.filter((s) => shotWidthIssue(s) === null).map((s) => `${s.viewport}:${s.theme}`),
  );
  const allCombosPresent = REQUIRED_COMBOS.every(([viewport, theme]) =>
    haveCombos.has(`${viewport}:${theme}`),
  );
  const allOnDisk = shots.every((s) => resolveArtifactPath(taskId, s.path, artifactsDir) !== null);
  return allCombosPresent && allOnDisk;
}

/**
 * The uiux verdict over a given event list, with no I/O but the on-disk
 * screenshot test. `alsoReported` names judge turns the caller is about to
 * close: a turn that exists in the log counts as reported, one that was never
 * dispatched stays missing. Nothing is closed or written here.
 */
export function evaluateUiux(
  events: readonly StoredEvent[],
  input: UiuxCheckInput,
  alsoReported: readonly { role: string; kind?: string | null }[] = [],
): UiuxCheckResult {
  const turns = foldJudgeTurns(events, input.taskId);
  const isReported = (turn: { role: string; kind: string | null; reported: boolean }) =>
    turn.reported ||
    alsoReported.some((r) => r.role === turn.role && (r.kind ?? null) === turn.kind);

  const specTurn = turns.find((t) => t.role === UIUX_ROLE && t.kind === 'spec');
  if (specTurn === undefined || !isReported(specTurn)) {
    return { outcome: 'blocked', reason: 'uiux-spec-missing' };
  }

  const tester = latestTesterRecord(events, input.taskId);
  if (tester === null) {
    return { outcome: 'blocked', reason: 'screenshots-missing' };
  }

  if (!screenshotSetComplete(input.taskId, tester.screenshots, input.artifactsDir)) {
    const invalidShots = shotWidthIssues(tester.screenshots);
    return {
      outcome: 'blocked',
      reason: 'screenshots-missing',
      ...(invalidShots.length === 0 ? {} : { invalidShots }),
    };
  }

  if (input.head !== undefined && tester.head !== input.head) {
    return { outcome: 'blocked', reason: 'screenshots-stale' };
  }

  const overflow = shotOverflows(tester.screenshots);
  if (overflow.length > 0) {
    return { outcome: 'blocked', reason: 'mobile-overflow', overflow };
  }

  const visualTurn = turns.find((t) => t.role === UIUX_ROLE && t.kind === 'visual');
  const visualDispatchIndex =
    visualTurn === undefined
      ? -1
      : dispatchIndex(events, input.taskId, UIUX_ROLE, 'visual', visualTurn.round);
  if (
    visualTurn === undefined ||
    !isReported(visualTurn) ||
    !(visualDispatchIndex > tester.index)
  ) {
    return { outcome: 'blocked', reason: 'uiux-visual-missing' };
  }

  return { outcome: 'pass' };
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
  return evaluateUiux(await readLineage(ctx.sessionId, opts), input);
}
