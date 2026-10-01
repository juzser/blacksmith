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

  // `immediate: true`: a caller whose `open` is a reactive boolean toggled
  // after mount (Dialog/AlertDialog's usual pattern) sees this run once more
  // at setup with `open === false`, which is a no-op (nothing was acquired
  // yet to release, `triggerEl` is still null). A caller that instead mounts
  // the overlay itself already-open (TaskPeekPanel: `v-if="peekTaskId"`
  // wraps the whole `Dialog`, so its `:open` prop is a hardcoded `true` and
  // never transitions) needs exactly this immediate run to capture the
  // still-focused trigger card and wire up the Escape/Tab handlers at all —
  // without it, Escape silently did nothing for that caller (found via e2e).
  watch(
    isOpen,
    async (open) => {
      if (open) {
        triggerEl = document.activeElement as HTMLElement | null;
        // Capture phase, not bubble: Tooltip.vue (S3-1) registers its own
        // Escape listener on `document` in the capture phase, and capture
        // listeners on the same node always run before bubble listeners on
        // that node regardless of add order — so a bubble-phase listener
        // here would always lose to Tooltip's `stopPropagation()` whenever
        // focus happens to be on a Tooltip-wrapped IconButton (every current
        // Dialog/Sheet close button), eating the overlay's first Escape
        // (found via e2e two ways: an arrow-key-opened peek panel needing
        // two Escapes to close, and a Sheet whose close button had been
        // reached by a real Tab keypress). Matching Tooltip's phase makes
        // same-node, same-phase listeners run in registration order instead,
        // and this one is always registered first — at open, before the
        // tooltip can even mount.
        document.addEventListener('keydown', onKeydown, true);
        acquire();
        await nextTick();
        // Focus the modal surface itself, not its first focusable control,
        // so the common case (no manual Tab yet) never lands focus on that
        // Tooltip-wrapped close button at all. `container` carries
        // `tabindex="-1"` precisely so it is a valid, inert focus target
        // here without becoming a Tab stop itself.
        container.value?.focus();
      } else {
        document.removeEventListener('keydown', onKeydown, true);
        release();
        triggerEl?.focus();
      }
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKeydown, true);
    if (isOpen()) release();
  });
}
