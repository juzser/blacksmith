import { type CrosscheckPolicy, parseCrosscheckPolicy } from '../../src/crosscheck.js';

/**
 * Every `CrosscheckPolicy` field a fixture almost never cares about, and so
 * kept forgetting: today `planQuorum`, `asymmetricRoles`, `roleIsolation` and
 * `independentFinder`.
 *
 * All of them are required by the interface and all are set unconditionally by
 * the loader, so a fixture that omits one is annotated `CrosscheckPolicy` while
 * holding a shape `loadCrosscheckPolicy()` cannot return. Five test files did
 * exactly that and stayed green, because `tsconfig.json` has never included
 * `test/**` — D-148. `pnpm typecheck:test` does, which is what catches it now.
 *
 * Typed as `Omit<..., 'providers' | 'quorumRule'>` — the complement of the two
 * fields a fixture always writes itself — rather than a `Pick` naming today's
 * four. A `Pick` has to be extended by hand every time the policy grows a
 * block, and the extension is exactly what gets forgotten: `roleIsolation` was
 * added to the interface and not to this helper, and six fixtures stopped
 * compiling. Stated as a complement, a new block flows through untouched.
 *
 * Read out of the parser rather than copied from `DEFAULT_*`: a second copy of
 * a default is the thing that drifts. Called per fixture, not cached, so no two
 * policies share an array a caller could mutate — the same reason
 * parsePlanQuorum() copies.
 */
export function crosscheckDefaults(): Omit<CrosscheckPolicy, 'providers' | 'quorumRule'> {
  const { providers, quorumRule, ...rest } = parseCrosscheckPolicy(
    'providers:\n  claude: { kind: native, enabled: true }\n',
  );
  void providers;
  void quorumRule;
  return rest;
}
