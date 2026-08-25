// Phase 6b, operator directive 2: deterministic identity colour for an epic
// (or, Phase 6b hub, a project) — hash(id) -> one of the 8 chart-palette
// slots (--ds-chart-1..8). Chart tokens are SERIES IDENTITY colours, never
// status tones (design-spec.md §3's governing rule) — this is the one
// shared util every page (Overview, Kanban, Roadmap, Flow, Projects) calls
// so the same epic/project renders the same colour everywhere.
const CHART_SLOTS = 8;

/** FNV-1a — small, fast, stable across runs/platforms (no crypto needed for a display hash). */
function hashString(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 1-based chart slot (1..8) for a given identity string (epic id or project id). */
export function identitySlot(id: string): number {
  return (hashString(id) % CHART_SLOTS) + 1;
}

/** CSS custom-property reference for `id`'s identity colour, e.g. "var(--ds-chart-3)". */
export function identityColorVar(id: string): string {
  return `var(--ds-chart-${identitySlot(id)})`;
}
