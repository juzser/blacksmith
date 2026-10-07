// Predicates over `GET /api/active-scope`: is this project / epic / factory
// session driven by a live CLI session? All keyed by storeKey, since an epic
// id and a project name can repeat between two stores. Nothing reads these
// yet; the pages switch over in later slices.
//
// A null or unmeasured scope answers false to everything. That is "unknown",
// not "nothing is active": a caller that must tell the two apart reads
// `scope.measured` itself.
import type { ActiveScopeResult } from './api.js';
import { HOME_STORE_ID, type StoreRef, storeKey } from './storeKey.js';

type Row = { store?: StoreRef };

const keyOf = (row: Row, id: string): string =>
  storeKey(row.store ? row : { store: { id: HOME_STORE_ID, label: HOME_STORE_ID } }, id);
const entryKey = (storeId: string, id: string): string =>
  storeKey({ store: { id: storeId, label: storeId } }, id);

function has(scope: ActiveScopeResult | null, keys: string[], key: string): boolean {
  return scope?.measured === true && keys.includes(key);
}

export function isActiveProject(
  scope: ActiveScopeResult | null,
  row: Row,
  project: string,
): boolean {
  return has(
    scope,
    (scope?.projects ?? []).map((p) => entryKey(p.storeId, p.project)),
    keyOf(row, project),
  );
}

export function isActiveEpic(scope: ActiveScopeResult | null, row: Row, epicId: string): boolean {
  return has(
    scope,
    (scope?.epics ?? []).map((e) => entryKey(e.storeId, e.epicId)),
    keyOf(row, epicId),
  );
}

export function isActiveSession(
  scope: ActiveScopeResult | null,
  row: Row,
  sessionId: string,
): boolean {
  return has(
    scope,
    (scope?.factorySessions ?? []).map((s) => entryKey(s.storeId, s.sessionId)),
    keyOf(row, sessionId),
  );
}

// The one check by name alone: under `?project=` the overview merges every
// store that holds the name into one store-less card, so a live session on
// that name in any store makes it active.
export function isActiveProjectName(scope: ActiveScopeResult | null, project: string): boolean {
  return scope?.measured === true && scope.projects.some((p) => p.project === project);
}
