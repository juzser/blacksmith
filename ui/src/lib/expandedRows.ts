// TimelineRow's "Show details" open state, persisted per-page (DS6 PR3
// scope item 3) so a reload of Activity (or a task's history tab) reopens
// whatever the operator had open. `storage` is injected rather than read
// from `globalThis.sessionStorage` directly so this stays unit-testable
// under ui/vitest.config.ts's DOM-free `environment: 'node'`.
const PREFIX = 'bs-activity-expanded:';

export function loadExpanded(storage: Storage, scopeKey: string): Set<string> {
  const raw = storage.getItem(`${PREFIX}${scopeKey}`);
  if (raw === null) return new Set();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((v) => typeof v === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

export function saveExpanded(storage: Storage, scopeKey: string, ids: Set<string>): void {
  storage.setItem(`${PREFIX}${scopeKey}`, JSON.stringify([...ids]));
}

export function toggleExpanded(ids: Set<string>, id: string): Set<string> {
  const next = new Set(ids);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
