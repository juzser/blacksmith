// Which routes show the topbar project switcher (App.vue).
//
// Kept out of App.vue so it is unit-testable under ui/vitest.config.ts's
// `environment: node` — .vue files are neither type-checked by
// ui/tsconfig.json nor linted by biome.json, so a set living inside
// <script setup> has no gate on it at all.
//
// The rule is not a taste call: a page shows the switcher IF AND ONLY IF it
// consumes the scope, i.e. it calls useProjectContext(). Anything else is
// either a control that does nothing (shown but unread) or, worse, a scope
// the operator can neither see nor clear (read but unsettable) — which is
// what D-216 was. projectScope.test.ts derives the expected set from
// router.ts + the page sources and fails on drift.
export const SCOPABLE_ROUTES: ReadonlySet<string> = new Set([
  'overview-global',
  'overview-project',
  'sessions',
  // 'timeline' is /activity's route name (kept across the DS6 PR3 rename) —
  // /errors now redirects into it rather than naming its own route, same
  // scope chain either way: the page passes `project` to fetchTimelinePage,
  // /api/timeline forwards it, and timeline() filters on it.
  'timeline',
  // Analytics ships the full scope chain too — the page passes `project` to
  // fetchAnalytics, /api/analytics forwards it, and it filters on it — and
  // watches `project` for a re-fetch. It was the other one the switcher forgot.
  'analytics',
  'work-kanban',
  'work-roadmap',
]);
