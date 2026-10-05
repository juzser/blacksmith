// Shared prop/slot types for the new kit, mirroring ds/types.ts's own
// reasoning (see that file's header comment): ui/tsconfig.json doesn't
// type-check .vue files (no vue-tsc in this dispatch's sanctioned dep
// list), so a `declare module '*.vue'` shim can't see named exports from
// inside a <script setup> block — anything a .ts file needs to import
// (kit/Table.vue importing TableColumn) must live here instead.
import type { Component } from 'vue';

export interface TableColumn {
  key: string;
  label: string;
  numeric?: boolean;
  width?: string;
}

/** One entry of the app shell's SidebarNav / MobileTabBar (ds-spec.md §2.2). */
export interface NavItem {
  id: string;
  label: string;
  /** MobileTabBar's 375px label when it differs from `label` (ds-spec.md §3). */
  shortLabel?: string;
  /** Required on every top-level item; level-2 `children` render as plain
   * text rows (no icon column to fill, matching ds-review.html's indent). */
  icon?: Component;
  route: string;
  /** Highlights this item for any route whose path starts with this prefix,
   * in addition to an exact match on `route` (Work: /work/kanban,
   * /work/roadmap and the legacy /kanban, /roadmap redirects). */
  matchPrefix?: string;
  /** Operator decision 2026-10-05: always-visible level-2 items under this
   * item on desktop SidebarNav (Work -> Kanban, Roadmap). MobileTabBar never
   * reads this — the phone stays flat. */
  children?: NavItem[];
}
