// DS4 S3 §6 — the muted dependency line on a WaveTaskCard is built from one
// FlowEdge, worded per edgeType. ORCHESTRATOR RULING: `claim-order` reads
// "runs after it (same files)" to keep the mock's "edits the same files"
// idea; the other four rows are spec §6's table verbatim.
const EDGE_WORDS: Record<string, string> = {
  artifact: 'uses its output',
  'claim-order': 'runs after it (same files)',
  'spec-clause': 'its test guards this',
  'regression-test': 'its test guards this',
  'research-brief': 'its research informs this',
};

/** Falls back to a neutral phrase for an edgeType the table above does not list. */
export function edgeWords(edgeType: string): string {
  return EDGE_WORDS[edgeType] ?? 'depends on it';
}
