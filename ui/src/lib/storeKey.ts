/** Which store a row came from; absent on rows from an API that predates multi-store reads. */
export interface StoreRef {
  id: string;
  label: string;
}

/**
 * A list key that cannot collide across stores: every id (epic, task, event)
 * can repeat between two projects. A row with no `store` keeps its bare id.
 */
export function storeKey(row: { store?: StoreRef }, id: string): string {
  return row.store ? `${row.store.id}:${id}` : id;
}
