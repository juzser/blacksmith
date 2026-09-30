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
  icon: Component;
  route: string;
}
