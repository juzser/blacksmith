#!/usr/bin/env node
// Stamp `.claude/fragments/<name>.md` into every `<!-- BEGIN SHARED:<name> -->`
// … `<!-- END SHARED:<name> -->` region of `.claude/agents/*.md`.
//
//   node scripts/sync-shared-fragments.mjs          # rewrite drifted regions
//   node scripts/sync-shared-fragments.mjs --check  # report only; exit 1 on drift
//
// Needs a built dist (`pnpm run build`). The vitest suite runs the same check
// (templateFragments.test.ts), so CI fails on drift without this script — the
// script is the repair, not the gate.
import { syncTemplates } from '../factory/orchestrator/dist/templateFragments.js';

const check = process.argv.includes('--check');
const report = syncTemplates({ write: !check });

for (const { file, name } of report.drifted) {
  console.log(`${check ? 'DRIFT' : 'STAMP'} ${file}: SHARED:${name}`);
}
for (const name of report.unused) {
  console.log(`UNUSED .claude/fragments/${name}.md — no template carries a SHARED:${name} region`);
}
const regions = report.templates.reduce((n, t) => n + t.regions.length, 0);
console.log(
  `${report.fragments.length} fragment(s), ${regions} region(s) across ${report.templates.length} template(s); ${report.drifted.length} drifted, ${report.unused.length} unused${check ? '' : `, ${report.written.length} rewritten`}`,
);

const failed = (check && report.drifted.length > 0) || report.unused.length > 0;
process.exit(failed ? 1 : 0);
