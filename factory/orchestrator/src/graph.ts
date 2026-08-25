/**
 * Small shared graph primitive: topological sort with a lexicographic
 * tie-break, used by both plan.ts (dependency-edge acyclic check) and
 * queue.ts (admission order) — one implementation, no duplication.
 */
export interface DependencyEdge {
  /** The task that depends on `dependsOn` (must run after it). */
  task: string;
  dependsOn: string;
}

export type TopoSortResult = { ok: true; order: string[] } | { ok: false; cycle: string[] };

export function topoSort(
  nodes: readonly string[],
  edges: readonly DependencyEdge[],
): TopoSortResult {
  const nodeSet = new Set(nodes);
  const dependents = new Map<string, string[]>(); // dependsOn -> [tasks waiting on it]
  const inDegree = new Map<string, number>();

  for (const node of nodeSet) {
    inDegree.set(node, 0);
    dependents.set(node, []);
  }

  for (const edge of edges) {
    if (!nodeSet.has(edge.task) || !nodeSet.has(edge.dependsOn)) continue;
    dependents.get(edge.dependsOn)?.push(edge.task);
    inDegree.set(edge.task, (inDegree.get(edge.task) ?? 0) + 1);
  }

  const ready: string[] = [...nodeSet].filter((n) => inDegree.get(n) === 0).sort();
  const order: string[] = [];

  while (ready.length > 0) {
    ready.sort();
    const next = ready.shift() as string;
    order.push(next);
    for (const dependent of dependents.get(next) ?? []) {
      const remaining = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }

  if (order.length === nodeSet.size) {
    return { ok: true, order };
  }

  const cycle = [...nodeSet].filter((n) => !order.includes(n)).sort();
  return { ok: false, cycle };
}

/**
 * Longest-path depth per node (Phase 6b, Flow page's wave bands —
 * docs/standards/stack.md: "layered by longest-path depth... no separate
 * layout library"). A node with no dependencies is wave 0; every other
 * node's wave is `1 + max(wave of its dependencies)` — so a node is never
 * drawn in an earlier band than something it depends on, and independent
 * branches that happen to be the same length land in the same band
 * (visually "these can run in parallel right now"). Cyclic input is
 * rejected via topoSort() first — wave computation assumes acyclic input.
 */
export function waveLayers(
  nodes: readonly string[],
  edges: readonly DependencyEdge[],
): Map<string, number> {
  const topo = topoSort(nodes, edges);
  const waves = new Map<string, number>();
  if (!topo.ok) return waves; // cyclic — caller's problem to surface, not this function's

  const dependsOnByTask = new Map<string, string[]>();
  for (const e of edges) {
    const list = dependsOnByTask.get(e.task) ?? [];
    list.push(e.dependsOn);
    dependsOnByTask.set(e.task, list);
  }

  for (const node of topo.order) {
    const deps = dependsOnByTask.get(node) ?? [];
    const wave = deps.length === 0 ? 0 : Math.max(...deps.map((d) => (waves.get(d) ?? 0) + 1));
    waves.set(node, wave);
  }
  return waves;
}
