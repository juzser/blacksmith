import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';
import { loadRoadmap } from '../src/roadmap.js';
import {
  type Citation,
  type CitationProblem,
  citations,
  findingIds,
  type MilestoneClaim,
  markdownCorpus,
  milestoneClaims,
  unresolvedCitations,
} from './helpers/docRecords.js';

// ---------------------------------------------------------------------------
// D-259 caught a document naming a verb the CLI does not ship; D-265 did the
// same for an error code. Both left a third surface unchecked (S3, this
// tester finding): `[[D-nnn]]` -- the repo's cross-reference syntax for its
// own decision records -- can name a "## D-nnn" heading that does not exist,
// and a milestone/epic-id claim in prose can name a roadmap.md milestone that
// is not declared, and nothing notices either.
//
// This file is that check, twice: `docs/specs/dogfood-4-findings.md`'s own
// headings are the one legal target a `[[D-nnn]]` citation can resolve to,
// and `parseRoadmap` over `factory/specs/roadmap.md` is the one legal target
// a milestone/epic-id claim can resolve to -- the real parser, not a grep, so
// this guard and the shipped code agree on what a milestone is.
// ---------------------------------------------------------------------------

const FINDINGS_REL = 'docs/specs/dogfood-4-findings.md';
const FINDINGS_PATH = path.join(REPO_ROOT, FINDINGS_REL);
const findingsText = (): string => readFileSync(FINDINGS_PATH, 'utf8');

const ENVKIT_REL = 'docs/specs/dogfood-envkit-findings.md';
const envkitText = (): string => readFileSync(path.join(REPO_ROOT, ENVKIT_REL), 'utf8');

const MCP_CLOSE_REL = 'docs/specs/dogfood-mcp-close.md';
const mcpCloseText = (): string => readFileSync(path.join(REPO_ROOT, MCP_CLOSE_REL), 'utf8');

/**
 * The one legal target set a `[[D-nnn]]` citation can resolve to: the union
 * of `docs/specs/dogfood-4-findings.md`'s own headings and
 * `docs/specs/dogfood-envkit-findings.md`'s. `dogfood-4-findings.md`
 * legitimately cross-cites the earlier envkit run's own findings (e.g. its
 * `[[D-19]]` names envkit's own "## D-19" heading) -- excluding envkit from
 * the sweep would report those as broken; the two heading sets do not
 * collide (verified below), so a union is safe.
 */
function unionFindingIds(): Set<string> {
  return new Set([...findingIds(findingsText()), ...findingIds(envkitText())]);
}

/**
 * `docs/specs/dogfood-mcp-close.md` states, in its own prose, that its
 * findings "continue that numbering at D-49 and run to D-115" -- but the
 * file has no `## D-nnn` headings at all (its findings live under lettered
 * `### A./B./C.` sections instead), so every id in that declared range is
 * citable but never addressable. Sourced from the sentence itself, not
 * hand-copied, and the test below asserts the sentence is still there: if
 * the file is restructured, this exception goes stale loudly, not quietly.
 */
function mcpCloseDeclaredRange(text: string): Set<string> {
  const match = /continue that numbering at \*\*D-(\d+)\*\* and run to \*\*D-(\d+)\*\*/.exec(text);
  if (!match?.[1] || !match[2]) return new Set();
  const start = Number(match[1]);
  const end = Number(match[2]);
  const ids = new Set<string>();
  for (let n = start; n <= end; n += 1) ids.add(`D-${n}`);
  return ids;
}

/**
 * D-116, D-118..D-121, D-126, D-127: the gap between `dogfood-mcp-close.md`'s
 * declared D-115 ceiling and `dogfood-4-findings.md`'s D-128 floor.
 * `dogfood-mcp-close.md` discusses D-126/D-127 by name and says both are
 * "numbered and fixed in **black-smith**" -- the sibling clone, a different
 * repository from this one -- so these ids were minted somewhere this repo
 * cannot see. Named explicitly: any id leaving this list fails immediately.
 */
const SIBLING_REPO_IDS = new Set(['D-116', 'D-118', 'D-119', 'D-120', 'D-121', 'D-126', 'D-127']);

describe('findingIds', () => {
  it('parses "## D-NNN — <title>" headings into a set of ids', () => {
    const ids = findingIds(
      ['## D-1 — first', '## D-2 — second', 'not a heading', '### D-3 — too deep'].join('\n'),
    );
    expect(ids).toEqual(new Set(['D-1', 'D-2']));
  });

  it('parses a real, non-trivial set from the live findings file', () => {
    // A scanner that silently matches nothing passes every "no broken
    // citations" assertion below forever -- docCommands.test.ts's
    // 'actually resolved the instruction surface' is the pattern. The floor
    // sits well under today's measured count (152).
    const ids = findingIds(findingsText());
    expect(ids.size).toBeGreaterThan(100);
    expect(ids.has('D-128')).toBe(true);
    // A non-standard heading form the em-dash-anchored regex would drop.
    expect(ids.has('D-112')).toBe(true);
  });

  it('does not double-count a fenced, illustrative quote of another heading', () => {
    const fenced = ['## D-1 — real', '```', '## D-2 — quoted inside a fence', '```'].join('\n');
    expect(findingIds(fenced)).toEqual(new Set(['D-1']));
  });
});

describe('citations', () => {
  it('finds every [[D-nnn]] with its line number', () => {
    const found = citations(
      ['line one', 'cites [[D-5]] and [[D-6]]', 'plain D-7 not bracketed'].join('\n'),
    );
    expect(found).toEqual<Citation[]>([
      { line: 2, id: 'D-5' },
      { line: 2, id: 'D-6' },
    ]);
  });
});

describe('unresolvedCitations', () => {
  const ids = new Set(['D-10', 'D-11']);

  it('resolves a citation that names a real id', () => {
    expect(unresolvedCitations([{ rel: 'f.md', text: '[[D-10]]' }], ids, new Set())).toEqual([]);
  });

  it('is provably able to fail: a constructed [[D-999]] resolves to nothing', () => {
    const problems = unresolvedCitations(
      [{ rel: 'fixture.md', text: 'see [[D-999]].' }],
      ids,
      new Set(),
    );
    expect(problems).toEqual<CitationProblem[]>([
      {
        rel: 'fixture.md',
        line: 1,
        id: 'D-999',
        reason:
          'no "## D-999" heading in the union of dogfood-4-findings.md and dogfood-envkit-findings.md',
      },
    ]);
  });

  it('excuses only a citation named in the excused set, not any other', () => {
    expect(unresolvedCitations([{ rel: 'f.md', text: '[[D-5]]' }], ids, new Set(['D-5']))).toEqual(
      [],
    );
    expect(
      unresolvedCitations([{ rel: 'f.md', text: '[[D-9]]' }], ids, new Set(['D-5'])),
    ).not.toEqual([]);
  });
});

describe('milestoneClaims', () => {
  it('reads the two phrasings this repo asserts current membership with', () => {
    const found = milestoneClaims(
      ['a real epic, epic id `phase-10`, through `/bs run`.', 'the milestone `phase-9` case'].join(
        '\n',
      ),
    );
    expect(found).toEqual<MilestoneClaim[]>([
      { line: 1, milestoneId: 'phase-10' },
      { line: 2, milestoneId: 'phase-9' },
    ]);
  });

  it('does not match a session id, a log filename, or a struck-history block', () => {
    const prose = [
      'settled at `phase-10-2026-09-04#4` with three options',
      '`phase-9-lessons-1.jsonl` (7 stack-wide, 4 claim-path)',
      'branch `smith/phase-10/task-2-strike-the-envkit-rows`',
      '- id: envkit-bootstrap',
    ].join('\n');
    expect(milestoneClaims(prose)).toEqual([]);
  });

  it('is provably able to fail: a constructed claim names a milestone that is not real', () => {
    expect(milestoneClaims('epic id `phase-99` was never planned.')).toEqual<MilestoneClaim[]>([
      { line: 1, milestoneId: 'phase-99' },
    ]);
  });
});

describe('the [[D-nnn]] citations swept resolve to a real heading', () => {
  it('the corpus covers the record files the command guard excludes', () => {
    // instructionFiles() (the command guard's corpus) drops these two as
    // "record of the past" -- correct for a live-instruction sweep, wrong
    // here: they carry the densest [[D-nnn]] citation traffic in the repo.
    const corpus = markdownCorpus();
    expect(corpus.includes(FINDINGS_REL)).toBe(true);
    expect(corpus.includes('CHANGELOG.md')).toBe(true);
  });

  it('the two named exceptions are still sourced from what they claim', () => {
    const range = mcpCloseDeclaredRange(mcpCloseText());
    expect(range.has('D-49')).toBe(true);
    expect(range.has('D-115')).toBe(true);
    expect(range.size).toBe(67);
  });

  it('names every broken citation as a worklist entry, grouped by cause', () => {
    const ids = unionFindingIds();
    const files = markdownCorpus().map((rel) => ({
      rel,
      text: readFileSync(path.join(REPO_ROOT, rel), 'utf8'),
    }));

    const swept = files.reduce((n, f) => n + citations(f.text).length, 0);
    const contributing = files.filter((f) => citations(f.text).length > 0).length;
    // A parser that matches spans but extracts no citations passes this
    // check forever too -- the resolved-invocation floor's counterpart.
    expect(swept).toBeGreaterThan(400);
    expect(contributing).toBeGreaterThanOrEqual(3);

    const mcpRange = mcpCloseDeclaredRange(mcpCloseText());
    const excused = new Set([...mcpRange, ...SIBLING_REPO_IDS]);
    const problems = unresolvedCitations(files, ids, excused);

    // Group 3 (the dogfood-4-findings.md heading gap at D-261) is not
    // excused: a hole in the file that owns the id is a real defect, not a
    // cross-repo or unaddressed-companion-file case, and this guard exists
    // to catch exactly that. See the coder's structured output for the
    // AC7 disposition -- the citations are real (CHANGELOG.md,
    // cli.ts, cli.test.ts all reference a shipped D-261) but no correct
    // replacement id could be determined from context, so this assertion
    // is left to report it rather than silently excuse it.
    expect(
      problems.map((p) => `${p.rel}:${p.line}  [[${p.id}]]  — ${p.reason}`),
      'a citation names a "## D-nnn" heading that does not exist',
    ).toEqual([]);
  });
});

describe('milestone/epic-id claims resolve to a real roadmap.md milestone', () => {
  it('names every broken claim as a worklist entry, or finds none', () => {
    const milestones = loadRoadmap();
    const declared = new Set(milestones.map((m) => m.milestoneId));
    expect(declared.size).toBeGreaterThan(5);

    const corpus = markdownCorpus();
    const problems: string[] = [];
    let checked = 0;
    for (const rel of corpus) {
      const text = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      for (const claim of milestoneClaims(text)) {
        checked += 1;
        if (!declared.has(claim.milestoneId))
          problems.push(
            `${rel}:${claim.line}  epic id/milestone \`${claim.milestoneId}\`  — no such milestone in factory/specs/roadmap.md`,
          );
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(
      problems,
      'a milestone/epic-id claim names a milestone roadmap.md does not declare',
    ).toEqual([]);
  });
});
