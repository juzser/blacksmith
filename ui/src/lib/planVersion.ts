// DS4 S3 §1 — the plan-version picker, moved out of lib/flowLayout.ts before
// that file was deleted along with FlowPage.vue (spec §4). EpicBlock's epic
// mode now owns the only consumer.
import type { FlowGraph } from './api.js';

export interface PlanVersionOption {
  value: string;
  label: string;
}

/**
 * Built from the graph's own `planVersions` — every version in scope — and
 * never from `graph.nodes`, which the query has already narrowed to the
 * version being shown; a picker derived from those could only offer what is
 * on screen, so a superseded plan was unreachable once the page had
 * filtered it away (D-165). Sorted and de-duplicated here as well as in the
 * query, so an older server cannot scramble the list.
 */
export function planVersionOptions(graph: FlowGraph | null): PlanVersionOption[] {
  const versions = [...new Set(graph?.planVersions ?? [])].sort((a, b) => b - a);
  return [
    { value: '', label: 'Current plan' },
    ...versions.map((v) => ({ value: String(v), label: `v${v}` })),
  ];
}
