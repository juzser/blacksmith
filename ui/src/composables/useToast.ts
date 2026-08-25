// Toast composable — module-level singleton queue (one toast region per
// app, mounted once in App.vue), per ux-conventions.md's aria-live=polite
// requirement (design-spec.md §7).
import { reactive } from 'vue';

export interface ToastItem {
  id: number;
  message: string;
}

const toasts = reactive<ToastItem[]>([]);
let nextId = 0;
const TOAST_DURATION_MS = 4000;

function dismiss(id: number) {
  const idx = toasts.findIndex((t) => t.id === id);
  if (idx !== -1) toasts.splice(idx, 1);
}

export function useToast() {
  function show(message: string) {
    const id = nextId++;
    toasts.push({ id, message });
    setTimeout(() => dismiss(id), TOAST_DURATION_MS);
  }
  return { toasts, show, dismiss };
}
