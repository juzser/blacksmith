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

/**
 * Step 17 runs from its numbered marker to the next step marker, or EOF.
 * Step 17 is run.md's last step today, so the bound only bites once a step
 * 18 lands; until then the slice runs to EOF.
 */
function step17(text: string): string {
  const start = text.search(/^17\. /m);
  if (start === -1) throw new Error('run.md has no step 17');
  const rest = text.slice(start + 4);
  const end = rest.search(/^\d+\. /m);
  return end === -1 ? text.slice(start) : text.slice(start, start + 4 + end);
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
    // one pass over the log: grants, denials, merges, the close, the resolve
    expect(prose).toMatch(/smith event tail \S+ --lineage --n \S+/);
    for (const type of [
      'waiver-granted',
      'waiver-denied',
      'wave-merged',
      'epic-closed',
      'audit-resolved',
      'integration-check',
    ]) {
      expect(prose).toContain(type);
    }
    // the fingerprint map: the epic's findings, unfiltered
    expect(prose).toMatch(/smith findings list --session \S+ --epic \S+/);
    // the goal, with the roadmap flag for a roadmap outside this repo
    expect(prose).toMatch(/smith epic goal --epic \S+/);
    expect(prose).toContain('--roadmap-path');
    // the branch itself
    expect(prose).toMatch(/git log --oneline \S+\.\.smith\/<epic>\/integration/);
    expect(prose).toMatch(/git diff --shortstat/);
  });

  it('takes grants from the log, not the waived status', () => {
    // reconcileFindingsToWaived moves only raised/confirmed findings, so an
    // amended or fix-verified finding's grant never shows as status waived.
    expect(prose).not.toMatch(/--status waived/);
  });

  it('reads no SQLite projection', () => {
    // stats kanban / stats timeline read a projection that can be stale.
    expect(prose).not.toMatch(/smith stats (kanban|timeline)/);
    expect(prose).toMatch(/summary\.tasks/);
  });

  it('matches decisions on the stored fingerprint, scoped to the epic', () => {
    // fingerprintAliases is private and no verb exposes the recompute.
    expect(prose).toMatch(/stored `fingerprint`/);
    expect(prose).not.toMatch(/fingerprintAliases|recomputed/);
    expect(prose).toMatch(/earlier epic/i);
  });

  it('scopes audit-resolved to this epic and unions its repeats', () => {
    // audit.ts emits { epic, fixed: [fps], deferred: [fps] }; one epic can
    // resolve more than once and the lineage carries a parent's resolve.
    expect(prose).toMatch(/`payload\.epic`/);
    expect(prose).toMatch(/union/i);
  });

  it('scopes integration-check to the epic and the closed head', () => {
    expect(prose).toMatch(/`payload\.epic_id`/);
    expect(prose).toMatch(/summary\.integration\.check\.head_sha/);
  });

  it("takes screenshots from each task's tester result, never a local path", () => {
    expect(prose).toMatch(/state\/results\/<task-id>\.tester\S*\.json/);
    expect(prose).toMatch(/state\/artifacts\/<task-id>\//);
    expect(prose).toMatch(/never a local path/i);
  });

  it('does not publish a follow-up cleared by waivers as open', () => {
    expect(prose).toMatch(/cleared by waiving/i);
  });

  it('keeps the pack to filtered facts and states the word-cap rule', () => {
    expect(prose).toMatch(/filtered/i);
    expect(prose).toMatch(/raw (command )?output/i);
    expect(prose).toMatch(/300/);
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
