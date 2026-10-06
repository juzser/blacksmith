// The shared Active/All scope every activity screen reads from `?scope=`.
// Active is the default and is never written to the URL; "Archive" is not a
// third mode, it is what All reveals. Pure rules only -- the Vue binding is
// composables/useActivityScope.ts.
export type ActivityScope = 'active' | 'all';

/** Anything but the exact string 'all' (absent, empty, array, unknown) is active. */
export function parseActivityScope(value: unknown): ActivityScope {
  return value === 'all' ? 'all' : 'active';
}

/** The query for `scope`: active drops the key, all sets it; every other key stays. */
export function scopeQuery<Q extends Record<string, unknown>>(
  query: Q,
  scope: ActivityScope,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...query };
  if (scope === 'all') next.scope = 'all';
  else delete next.scope;
  return next;
}
