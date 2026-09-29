import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';

// #252. run.md step 17 had the scribe write the integration PR body with no
// facts handed to it and a pointer to report.md, which has no PR-body section.
// The scribe has no Bash and a small turn cap; when it capped it filled the
// gaps by invention (a wrong event id, a merged task called dead, "no waivers"
// over two grants). The fix is a fact pack the orchestrator computes with real
// commands and hands over as the scribe's only source, under "omit, never
// infer" -- and the scribe's own mission carries the same rule.

const RUN_MD = readFileSync(path.join(REPO_ROOT, '.claude/skills/bs/run.md'), 'utf8');
const SCRIBE_MD = readFileSync(path.join(REPO_ROOT, '.claude/agents/scribe.md'), 'utf8');

/** Step 17 runs from its numbered marker to the end of the file. */
function step17(text: string): string {
  const start = text.search(/^17\. /m);
  if (start === -1) throw new Error('run.md has no step 17');
  return text.slice(start);
}

/** The scribe's "## Mission" section, up to the next heading or marker. */
function mission(text: string): string {
  const start = text.indexOf('## Mission');
  if (start === -1) throw new Error('scribe.md has no "## Mission" heading');
  const rest = text.slice(start + '## Mission'.length);
  const end = rest.search(/^(## |<!-- )/m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Collapse wrapped prose so a phrase split across lines still matches. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('run.md step 17 hands the scribe a fact pack (#252)', () => {
  const step = step17(RUN_MD);
  const prose = flat(step);

  it('names the fact pack and makes it the only source', () => {
    expect(prose).toMatch(/fact pack/i);
    expect(prose).toMatch(/only source/i);
    expect(prose).toMatch(/omit, never infer/i);
  });

  it('computes each fact with a real command', () => {
    // waivers granted: the epic's findings, waived, carry the granting event id
    expect(prose).toMatch(/smith findings list --session \S+ --epic \S+ --status waived/);
    // waivers denied: only the log has them
    expect(prose).toMatch(/smith event tail \S+ --lineage/);
    expect(prose).toContain('waiver-denied');
    // each task's status
    expect(prose).toMatch(/smith stats kanban --epic \S+ --session \S+ --lineage/);
    // the merge events
    expect(prose).toMatch(/smith stats timeline --epic \S+ --session \S+ --lineage/);
    expect(prose).toContain('wave-merged');
    // the branch itself
    expect(prose).toMatch(/git log --oneline \S+\.\.smith\/<epic>\/integration/);
    expect(prose).toMatch(/git diff --shortstat/);
  });

  it('defines the PR-body shape itself instead of pointing at report.md', () => {
    // report.md has a digest section only; sending the scribe there is the bug.
    expect(step).not.toContain('report.md');
    expect(prose).toMatch(/PR body/i);
  });
});

describe("scribe.md's mission carries the omit-never-infer rule (#252)", () => {
  it('says a fact missing from the handed source is omitted, never inferred', () => {
    expect(flat(mission(SCRIBE_MD))).toMatch(/omit, never infer/i);
  });
});
