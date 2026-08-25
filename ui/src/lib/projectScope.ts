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
  'timeline',
  // Errors and Analytics ship the full scope chain — the page passes
  // `project` to fetchErrors/fetchAnalytics, /api/errors and /api/analytics
  // forward it, and errorsPage/analytics filter on it — and both watch
  // `project` for a re-fetch. They were the two the switcher forgot.
  'errors',
  'analytics',
  'kanban',
  'roadmap',
  'flow',
]);
