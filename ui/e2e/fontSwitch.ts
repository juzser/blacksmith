// BS_E2E_FONT=arial: run the suite under the font metrics CI renders with.
//
// Locally the dashboard's font stack resolves to the system font; the Linux CI
// runner resolves it to an Arial-metric font. Geometry sized off the font's
// line metrics (PR #381's `1.2em` hit boxes) can pass on a Mac and fail on CI.
// With the switch set, every page renders with Arial from its first paint.
// Unset, nothing changes.

/** The one CSS rule the switch injects. `!important` so it beats the token. */
export const ARIAL_FONT_CSS = ':root { --bs-font-sans: Arial, sans-serif !important; }';

/** True when BS_E2E_FONT=arial; throws on any other non-empty value. */
export function arialSwitchOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.BS_E2E_FONT;
  if (value === undefined || value === '') return false;
  if (value === 'arial') return true;
  throw new Error(`BS_E2E_FONT must be unset or "arial", got "${value}"`);
}
