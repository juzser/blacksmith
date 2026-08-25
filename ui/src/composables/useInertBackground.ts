// Fix-round (uiux S3 #6): while a Dialog/AlertDialog is open, the rest of
// the app (#app — the sidebar/topbar/main landmarks; the dialog itself is
// Teleport'd to a body-level sibling) should be `inert` so a screen reader
// user tabbing/browsing by landmark can't reach background content behind
// the modal. Module-level open-count (not a boolean) so two dialogs
// momentarily open at once (shouldn't normally happen, but Task detail's
// artifact lightbox + a future nested confirm could overlap) don't have the
// first one's close() re-enable the background while the second is still open.
let openCount = 0;

function appRoot(): HTMLElement | null {
  return document.getElementById('app');
}

export function useInertBackground() {
  function acquire() {
    openCount += 1;
    appRoot()?.setAttribute('inert', '');
  }
  function release() {
    openCount = Math.max(0, openCount - 1);
    if (openCount === 0) appRoot()?.removeAttribute('inert');
  }
  return { acquire, release };
}
