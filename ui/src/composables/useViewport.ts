// Responsive breakpoints (design-spec.md §2): sidebar auto-collapses
// <1024px, off-canvas Sheet <768px (repo-specific 390px floor override —
// the Sheet/scroll approach already holds down to 390px, no extra
// breakpoint needed for that floor itself). §3.1 adds a third, narrower
// breakpoint (--bs-bp-mobile, 640px) below which the shell itself swaps for
// MobileTopBar/MobileTabBar rather than just collapsing the same chrome.
import { onBeforeUnmount, onMounted, ref } from 'vue';

function useMediaQuery(query: string) {
  const matches = ref(typeof matchMedia !== 'undefined' ? matchMedia(query).matches : false);
  let mql: MediaQueryList | undefined;
  function handler(e: MediaQueryListEvent) {
    matches.value = e.matches;
  }
  onMounted(() => {
    if (typeof matchMedia === 'undefined') return;
    mql = matchMedia(query);
    matches.value = mql.matches;
    mql.addEventListener('change', handler);
  });
  onBeforeUnmount(() => mql?.removeEventListener('change', handler));
  return matches;
}

export function useViewport() {
  // ds-allow-hardcode:start — these two matchMedia queries ARE the
  // breakpoint definition (design-spec.md §2's 1024px/768px collapse
  // points); there is no CSS custom property a JS matchMedia() call can
  // read as a number.
  const isCollapsedWidth = useMediaQuery('(max-width: 1023px)');
  const isMobileWidth = useMediaQuery('(max-width: 767px)');
  // §3.1's --bs-bp-mobile (640px) is the phone-shell swap point.
  const isPhoneWidth = useMediaQuery('(max-width: 640px)');
  // ds-allow-hardcode:end
  return { isCollapsedWidth, isMobileWidth, isPhoneWidth };
}
