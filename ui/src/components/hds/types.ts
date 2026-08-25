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
}

export interface TableColumn {
  key: string;
  label: string;
  numeric?: boolean;
  width?: string;
}
