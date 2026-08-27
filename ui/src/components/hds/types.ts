// Shared prop/slot types for HDS components — kept in a plain .ts module,
// not exported from the .vue SFCs themselves. ui/tsconfig.json doesn't
// type-check .vue files (no vue-tsc — not in this dispatch's sanctioned
// dep list), so a `declare module '*.vue'` shim can't see named exports
// from inside a component's <script setup> block; anything a .ts file
// needs to import must live here instead.
export interface NavItem {
  id?: string;
  category?: string;
  label?: string;
  icon?: string;
  disabled?: boolean;
  disabledReason?: string;
  /**
   * How many things are waiting behind this item — arrivals since the operator
   * last opened it, or a pending count. Absent or 0 draws nothing; the shell
   * computes it in lib/navBadges.ts, which also owns why a badge and not a
   * toast.
   */
  badge?: number;
  /**
   * What the badge means, spoken. The glyph is a bare number, and "3 new" and
   * "3 pending" are different claims — a rail that renders only the digit has
   * told a screen reader neither, so the count reaches the accessible name
   * through here rather than through the number alone.
   */
  badgeLabel?: string;
}

export interface TableColumn {
  key: string;
  label: string;
  numeric?: boolean;
  width?: string;
}
