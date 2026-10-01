// DS3 pattern 8 (ds-spec.md §2.4b) — the Kanban board's persisted display
// options: show/hide the summary row, the active group-by, and which
// columns the operator has hidden. A storage param rather than a direct
// `window.localStorage` reference throughout: it makes every access here a
// plain, DOM-free unit test, and it is the one seam a caller needs to
// substitute a no-op when storage is unavailable (private browsing, quota).
import type { KanbanGroupBy } from './kanban.js';

export interface KanbanDisplayOptionsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface KanbanDisplayOptions {
  summary: boolean;
  groupBy: KanbanGroupBy;
  hidden: string[];
}

const STORAGE_KEY = 'bs.kanban.displayOptions';

export const DEFAULT_KANBAN_DISPLAY_OPTIONS: KanbanDisplayOptions = {
  summary: true,
  groupBy: 'status',
  hidden: [],
};

const GROUP_BY_VALUES: KanbanGroupBy[] = ['status', 'project', 'epic', 'role'];

function isWellFormed(value: unknown): value is KanbanDisplayOptions {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.summary === 'boolean' &&
    typeof v.groupBy === 'string' &&
    GROUP_BY_VALUES.includes(v.groupBy as KanbanGroupBy) &&
    Array.isArray(v.hidden) &&
    v.hidden.every((h) => typeof h === 'string')
  );
}

/**
 * Every failure mode — no stored value, unparseable JSON, a wrong-shaped
 * object, or storage access itself throwing (private browsing can make
 * `localStorage` throw on read) — falls back to the same hardcoded default,
 * silently. A corrupted or unavailable store is never worth surfacing to the
 * operator; it just means the board opens with its defaults.
 */
export function loadKanbanDisplayOptions(
  storage: KanbanDisplayOptionsStorage,
): KanbanDisplayOptions {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_KANBAN_DISPLAY_OPTIONS;
    const parsed = JSON.parse(raw);
    return isWellFormed(parsed) ? parsed : DEFAULT_KANBAN_DISPLAY_OPTIONS;
  } catch {
    return DEFAULT_KANBAN_DISPLAY_OPTIONS;
  }
}

/** Never throws: a save that fails (quota, private browsing) is silently dropped. */
export function saveKanbanDisplayOptions(
  storage: KanbanDisplayOptionsStorage,
  options: KanbanDisplayOptions,
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(options));
  } catch {
    // Intentionally silent — see loadKanbanDisplayOptions()'s comment.
  }
}
