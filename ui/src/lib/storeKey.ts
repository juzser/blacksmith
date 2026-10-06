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

/** The id the served clone's own store carries in a fanned-out row. */
export const HOME_STORE_ID = 'home';

/**
 * The store id to read a row's task from, or undefined for the served store
 * (and for a row from an API that predates multi-store reads): task reads
 * default to the served store, so only a foreign row needs to name one.
 */
export function foreignStoreId(row: { store?: StoreRef }): string | undefined {
  return row.store && row.store.id !== HOME_STORE_ID ? row.store.id : undefined;
}
