// BS_E2E_FONT=arial: run the suite under the font metrics CI renders with.
//
// Locally the dashboard's font stack resolves to the system font; the Linux CI
// runner resolves it to an Arial-metric font. Geometry sized off the font's
// line metrics (PR #381's `1.2em` hit boxes) can pass on a Mac and fail on CI.
// With the switch set, every page renders with Arial from its first paint.
// Unset, nothing changes.

/** The one CSS rule the switch injects. `!important` so it beats the token. */
export const ARIAL_FONT_CSS = ':root { --bs-font-sans: Arial, sans-serif !important; }';

/** Init script body: adds the Arial rule as a <style>, waiting for <html> if it is not there yet. */
export const arialInit = (css: string): void => {
  const attach = () => {
    if (!document.documentElement) return false;
    const style = document.createElement('style');
    style.textContent = css;
    document.documentElement.appendChild(style);
    return true;
  };
  if (!attach()) {
    const observer = new MutationObserver(() => attach() && observer.disconnect());
    observer.observe(document, { childList: true });
  }
};

/**
 * True when BS_E2E_FONT=arial, false when it is unset. Throws on any other
 * value, the empty string included: `BS_E2E_FONT=` is a typo, not "off".
 */
export function arialSwitchOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.BS_E2E_FONT;
  if (value === undefined) return false;
  if (value === 'arial') return true;
  throw new Error(`BS_E2E_FONT must be unset or "arial", got "${value}"`);
}
