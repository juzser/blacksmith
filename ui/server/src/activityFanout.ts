/**
 * Activity across stores: the per-store `timeline()` / `errorsPage()` results
 * merged in TypeScript (see fanout.ts), plus the opaque cursor a merged page
 * hands back.
 *
 * Merge key. Rows order by `compareLogOrder` (ts, then session id, then index
 * within the session), the same key one store sorts by, then by store id so
 * two stores that logged the same instant and session name stay in a fixed
 * order. Event ids repeat across stores, so a row is identified by
 * `(store.id, eventId)`.
 *
 * Cursor. `v1.` + base64url of `{ "<storeId>": "<eventId>" }`: for each store,
 * the last row of that store this feed has shown (`before`) or the newest row
 * it has seen (`after`). A store absent from the map is unconstrained, so a
 * store that has not shown a row yet is read from its end. A caller treats
 * the string as opaque.
 */

import type { ErrorsResult, TimelineEntry } from '../../../factory/orchestrator/dist/db/queries.js';
import { compareLogOrder } from '../../../factory/orchestrator/dist/eventOrder.js';
import type { StoreRef } from './stores.js';

export const MAX_SESSIONS = 200;
const CURSOR_PREFIX = 'v1.';
const STORE_ID = /^(?:home|[0-9a-f]{8})$/;

export type Cursor = Map<string, string>;
export type StoreRow = TimelineEntry & { store: StoreRef };

export function encodeCursor(cursor: Cursor): string {
  const body = JSON.stringify(Object.fromEntries([...cursor.entries()].sort()));
  return CURSOR_PREFIX + Buffer.from(body).toString('base64url');
}

/** Decodes a cursor; `bad` builds the error thrown for anything that is not one. */
export function decodeCursor(value: string, bad: (message: string) => Error): Cursor {
  const refuse = () => bad(`"${value.slice(0, 40)}" is not a cursor this feed returned.`);
  if (!value.startsWith(CURSOR_PREFIX)) throw refuse();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value.slice(CURSOR_PREFIX.length), 'base64url').toString());
  } catch {
    throw refuse();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw refuse();
  const out: Cursor = new Map();
  for (const [id, eventId] of Object.entries(parsed)) {
    if (
      !STORE_ID.test(id) ||
      typeof eventId !== 'string' ||
      eventId.length === 0 ||
      eventId.length > 256
    ) {
      throw refuse();
    }
    out.set(id, eventId);
  }
  return out;
}

/**
 * Splits `?sessions=` under `stores=all`: `<storeId|home>/<sid>` goes to that
 * store, a bare id to home. Each id keeps the single-segment rule.
 */
export function sessionsByStore(
  values: string[],
  bad: (message: string) => Error,
): Map<string, string[]> {
  if (values.length > MAX_SESSIONS) {
    throw bad(`Query parameter "sessions" takes at most ${MAX_SESSIONS} values.`);
  }
  const out = new Map<string, string[]>();
  for (const value of values) {
    const slash = value.indexOf('/');
    const store = slash < 0 ? 'home' : value.slice(0, slash);
    const id = slash < 0 ? value : value.slice(slash + 1);
    if (!STORE_ID.test(store) || id.length === 0 || id === '.' || id === '..' || id.includes('/')) {
      throw bad(
        'Every "sessions" value must be "<storeId|home>/<sessionId>" or a bare home session id: one non-empty path segment, not "." or "..".',
      );
    }
    const ids = out.get(store) ?? [];
    if (!ids.includes(id)) ids.push(id);
    out.set(store, ids);
  }
  return out;
}

const rowOrder = (a: StoreRow, b: StoreRow): number =>
  compareLogOrder(a, b) || a.store.id.localeCompare(b.store.id);

export interface StorePage {
  store: StoreRef;
  /** The store's own page. */
  rows: TimelineEntry[];
  /** True when the store holds rows older than `rows` (a 'before' page only). */
  more: boolean;
}

/**
 * Merges per-store pages into one. 'before' keeps the newest `limit` of the
 * union (first page and "Load older"); 'after' keeps the oldest `limit`, so
 * no row between the cursor and the page is skipped. `previous` is the cursor
 * the request carried. Returns the merged rows newest first, the cursor for
 * the next older page (null when nothing older is left) and the cursor a
 * later `after` poll counts from.
 */
export function mergePages(
  parts: StorePage[],
  direction: 'before' | 'after',
  limit: number,
  previous: Cursor,
): { entries: StoreRow[]; nextBefore: Cursor | null; newest: Cursor } {
  const rows: StoreRow[] = parts.flatMap((p) => p.rows.map((r) => ({ ...r, store: p.store })));
  rows.sort(rowOrder); // oldest first
  const taken =
    direction === 'before' ? rows.slice(Math.max(0, rows.length - limit)) : rows.slice(0, limit);
  const older: Cursor = direction === 'before' ? new Map(previous) : new Map();
  const newest: Cursor = direction === 'after' ? new Map(previous) : new Map();
  let hasOlder = false;
  for (const part of parts) {
    const id = part.store.id;
    const mine = taken.filter((r) => r.store.id === id);
    const first = mine[0];
    const last = mine[mine.length - 1];
    if (first) older.set(id, first.eventId);
    if (part.rows.length > mine.length || part.more) hasOlder = true;
    if (direction === 'after') {
      if (last) newest.set(id, last.eventId);
    } else {
      const top = part.rows.reduce<TimelineEntry | undefined>(
        (m, r) => (m === undefined || compareLogOrder(r, m) > 0 ? r : m),
        undefined,
      );
      if (top) newest.set(id, top.eventId);
    }
  }
  return { entries: [...taken].reverse(), nextBefore: hasOlder ? older : null, newest };
}

/** Sums two records of counts. */
const addCounts = (a: Record<string, number>, b: Record<string, number>) => {
  const out = { ...a };
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n;
  return out;
};

/**
 * Combines per-store error pages. byClass keeps one row per store, id prefixed
 * with the store id so keys cannot collide; byDay adds counts per day;
 * classSummary adds count, severityMix and trend7d, keeps the latest lastSeen
 * and the union of projects.
 */
export function mergeErrors(
  parts: { store: StoreRef; data: ErrorsResult }[],
): Record<string, unknown> {
  const byClass = parts
    .flatMap((p) =>
      p.data.byClass.map((c) => ({ ...c, id: `${p.store.id}:${c.id}`, store: p.store })),
    )
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  const days = new Map<string, number>();
  const summaries = new Map<string, ErrorsResult['classSummary'][number]>();
  for (const p of parts) {
    for (const d of p.data.byDay) days.set(d.day, (days.get(d.day) ?? 0) + d.count);
    for (const s of p.data.classSummary) {
      const have = summaries.get(s.id);
      summaries.set(
        s.id,
        have
          ? {
              ...have,
              count: have.count + s.count,
              severityMix: addCounts(have.severityMix, s.severityMix),
              lastSeen: s.lastSeen > have.lastSeen ? s.lastSeen : have.lastSeen,
              projects: [...new Set([...have.projects, ...s.projects])],
              trend7d: have.trend7d.map((n, i) => n + (s.trend7d[i] ?? 0)),
            }
          : s,
      );
    }
  }
  return {
    byClass,
    byDay: [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, count]) => ({ day, count })),
    classSummary: [...summaries.values()].sort(
      (a, b) => b.count - a.count || a.id.localeCompare(b.id),
    ),
  };
}
