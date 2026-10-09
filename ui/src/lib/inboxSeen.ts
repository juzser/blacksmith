// Needs-you read state (ds-spec.md pattern 12): which rows this viewer has
// already opened. Per viewer, localStorage-backed, default "all unseen". Takes
// the storage as an argument so it stays DOM-free, same seam as
// kanbanDisplayOptions.ts.

export interface InboxSeenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const INBOX_SEEN_KEY = 'bs.inbox.seen.v1';
export const INBOX_SEEN_CAP = 200;

/**
 * The seen key of one decision. The row id names the task, not the decision
 * (a second escalation of it, or a newer finding in its waiver batch, reuses
 * the id), so the date the decision was raised rides along: a new decision
 * reads as unread again, the same one stays read across polls.
 */
export function inboxSeenId(row: { id: string; createdAt: string }): string {
  return `${row.id}@${row.createdAt}`;
}

/** Splits on the last `@`: a store prefix or task id may hold other punctuation. */
function splitKey(key: string): { id: string; at: string } {
  const i = key.lastIndexOf('@');
  return i < 0 ? { id: key, at: '' } : { id: key.slice(0, i), at: key.slice(i + 1) };
}

/**
 * Whether the viewer has opened this decision or a later one for the same row.
 * A waiver batch's date can move back (its newest finding is waived), which
 * must not read as unread; a newer decision still does.
 */
export function isSeen(seen: ReadonlySet<string>, row: { id: string; createdAt: string }): boolean {
  for (const key of seen) {
    const k = splitKey(key);
    if (k.id === row.id && k.at >= row.createdAt) return true;
  }
  return false;
}

function readKeys(storage: InboxSeenStorage): string[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(INBOX_SEEN_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/** Garbage, a missing key or a throwing storage all read as nothing seen. */
export function loadSeen(storage: InboxSeenStorage): Set<string> {
  return new Set(readKeys(storage));
}

/** Records `key` (newest last, 200 newest kept) and returns the new set. A failing write still returns it. */
export function markSeen(storage: InboxSeenStorage, key: string): Set<string> {
  const { id, at } = splitKey(key);
  const keys = readKeys(storage).filter((k) => {
    const o = splitKey(k);
    return k !== key && !(o.id === id && o.at < at);
  });
  keys.push(key);
  const kept = keys.slice(-INBOX_SEEN_CAP);
  try {
    storage.setItem(INBOX_SEEN_KEY, JSON.stringify(kept));
  } catch {
    // Unavailable storage: the row stays read for this page view only.
  }
  return new Set(kept);
}
