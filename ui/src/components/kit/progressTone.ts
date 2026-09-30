// Shared by ProgressRing.vue and ProgressBarMini.vue (ds-spec.md §2.1,
// "Progress tones and placement"). `kind` is an additive prop on both
// components, not in the spec's literal props table: the auto-tone rule
// reads differently depending on what the progress represents. A budget can
// be exceeded — over 100% is a real, meaningful state ("over budget"), so
// danger/warning trigger before the bar is even full. A plain ratio cannot
// exceed its own max by definition, so its only extra state is "done" at
// 100%. Neither value/max/label lets a component tell which rule applies on
// its own, hence `kind`. Centralizing the thresholds here (rather than
// duplicating them in both components) is what ds-spec.md asks for directly:
// "same tone/kind logic ... avoid duplicating threshold literals".
export type ProgressTone = 'accent' | 'success' | 'warning' | 'danger';
export type ProgressKind = 'budget' | 'ratio';

export function computeProgressTone(value: number, max: number, kind: ProgressKind): ProgressTone {
  const ratio = max > 0 ? value / max : 0;
  if (kind === 'budget') {
    if (ratio > 1) return 'danger';
    if (ratio >= 0.9) return 'warning';
    return 'accent';
  }
  return ratio >= 1 ? 'success' : 'accent';
}

// Clamped 0-100, for the visual fill only — a ring/track cannot draw past
// full. The percentage NUMBER shown beside it is a separate, unclamped read
// (see ProgressRing.vue/ProgressBarMini.vue's own rawPercent) so a budget
// past 100% still reports its true value, e.g. "103%".
export function clampedPercent(value: number, max: number): number {
  const ratio = max > 0 ? (value / max) * 100 : 0;
  return Math.min(Math.max(ratio, 0), 100);
}

const TONE_VAR: Record<ProgressTone, string> = {
  accent: 'var(--bs-accent)',
  // No --bs-tone-success-* token exists in bs-tokens.css (the tone family
  // stops at done/review/progress/todo/blocked/danger/warning/info/neutral).
  // Tag.vue's `done` tone is the kit's existing "complete" green semantic
  // (see Tag.vue's own comment for the same kind of token-set gap) — reused
  // here rather than inventing a new token name.
  success: 'var(--bs-tone-done-text)',
  warning: 'var(--bs-tone-warning-text)',
  danger: 'var(--bs-tone-danger-text)',
};

export function progressToneColor(tone: ProgressTone): string {
  return TONE_VAR[tone];
}
