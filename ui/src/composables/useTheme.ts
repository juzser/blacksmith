// Theme toggle: localStorage first, falls back to prefers-color-scheme
// (design-spec.md §2). Module-level singleton state — every consumer
// shares one reactive theme rather than re-deriving it (there is exactly
// one toggle, in the topbar).
import { ref, watchEffect } from 'vue';

const STORAGE_KEY = 'smith-ui-theme';

function initial(): 'light' | 'dark' {
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  }
  if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

const theme = ref<'light' | 'dark'>(initial());

watchEffect(() => {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', theme.value === 'dark');
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, theme.value);
});

export function useTheme() {
  function toggle() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
  }
  return { theme, toggle };
}
