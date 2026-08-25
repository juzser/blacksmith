import { type CrosscheckPolicy, parseCrosscheckPolicy } from '../../src/crosscheck.js';

/**
 * The two `CrosscheckPolicy` fields a fixture almost never cares about, and so
 * kept forgetting: `planQuorum` and `asymmetricRoles`.
 *
 * Both are required by the interface and both are set unconditionally by the
 * loader (crosscheck.ts:306-307), so a fixture that omits them is annotated
 * `CrosscheckPolicy` while holding a shape `loadCrosscheckPolicy()` cannot
 * return. Five test files did exactly that and stayed green, because
 * `tsconfig.json` has never included `test/**` — D-148.
 *
 * Read out of the parser rather than copied from `DEFAULT_PLAN_QUORUM_*`: a
 * second copy of a default is the thing that drifts. Called per fixture, not
 * cached, so no two policies share an array a caller could mutate — the same
 * reason parsePlanQuorum() copies.
 */
export function crosscheckDefaults(): Pick<CrosscheckPolicy, 'planQuorum' | 'asymmetricRoles'> {
  const { planQuorum, asymmetricRoles } = parseCrosscheckPolicy(
    'providers:\n  claude: { kind: native, enabled: true }\n',
  );
  return { planQuorum, asymmetricRoles };
}
