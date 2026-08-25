// The four behaviours `aria-modal="true"` promises but does not implement:
// move focus in on open, keep Tab inside while open, make the background
// inert, hand focus back to the trigger on close. The attribute only changes
// what assistive tech announces — enforcing it is the author's job.
//
// Extracted from Dialog.vue because Sheet.vue declared the same attribute and
// enforced none of it: the duplication is exactly how the second overlay came
// to be missing the behaviour (D-238). Any future `aria-modal` overlay should
// call this rather than re-derive it.
import { nextTick, onBeforeUnmount, type Ref, watch } from 'vue';
import { useInertBackground } from './useInertBackground.js';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * @param container the modal surface itself — not its overlay backdrop, since
 *   the trap walks this element's focusables.
 * @param isOpen a getter, not a `Ref`, so a caller whose open state is a prop
 *   can pass `() => props.open` without unwrapping.
 * @param onEscape what Esc means to the caller (both current callers emit
 *   `close`; the composable does not assume a `close` event exists).
 */
export function useModalFocus(
  container: Ref<HTMLElement | null>,
  isOpen: () => boolean,
  onEscape: () => void,
) {
  let triggerEl: HTMLElement | null = null;
  const { acquire, release } = useInertBackground();

  function focusables(): HTMLElement[] {
    if (!container.value) return [];
    return [...container.value.querySelectorAll<HTMLElement>(FOCUSABLE)];
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onEscape();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables();
    if (items.length === 0) return;
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Deliberately not `immediate`: an overlay that mounts already-open would
  // capture whatever had focus at app start as its "trigger". Both callers
  // render behind `v-if="open"`, so open is always a transition.
  watch(isOpen, async (open) => {
    if (open) {
      triggerEl = document.activeElement as HTMLElement | null;
      document.addEventListener('keydown', onKeydown);
      acquire();
      await nextTick();
      focusables()[0]?.focus();
    } else {
      document.removeEventListener('keydown', onKeydown);
      release();
      triggerEl?.focus();
    }
  });

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKeydown);
    if (isOpen()) release();
  });
}
