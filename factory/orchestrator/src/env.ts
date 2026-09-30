/** The current and legacy namespace prefixes, for call sites that filter a whole env object rather than read one name (e.g. `testgate.ts`'s `projectCommandEnv`). */
export const BS_PREFIX = 'BS_';
export const LEGACY_PREFIX = 'SMITH_';

/**
 * The one place that knows `BS_<X>` is the current name and `SMITH_<X>` is
 * the transitional fallback (operator decision 3, bs-rename): `BS_` wins
 * when both are set, `SMITH_` is read when `BS_` is unset, and neither set
 * reads as unset — exactly what every direct `env.SMITH_*`/`env.BS_*` read
 * in this codebase should go through instead of hand-rolling the pair.
 *
 * `name` may be spelled either way — as the new `BS_<X>` name, or as the
 * legacy `SMITH_<X>` name a call site's own constant still carries — since
 * both resolve to the same pair of variables either way.
 */
export function readEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const bsName = name.startsWith(LEGACY_PREFIX)
    ? `${BS_PREFIX}${name.slice(LEGACY_PREFIX.length)}`
    : name;
  const legacyName = name.startsWith(BS_PREFIX)
    ? `${LEGACY_PREFIX}${name.slice(BS_PREFIX.length)}`
    : name;
  const bsValue = env[bsName];
  if (bsValue !== undefined) return bsValue;
  return env[legacyName];
}
