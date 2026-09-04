/**
 * Pure parsers for `docCitations.test.ts`: the `[[D-nnn]]` cross-reference
 * syntax dogfood record files use, and the roadmap milestone claims a spec
 * document can make about them.
 *
 * Extracted rather than inlined so the constructed-negative fixtures in the
 * test file exercise the exact same functions the live-corpus sweep runs --
 * `docCommands.test.ts`'s house rule that a parser is worth nothing until it
 * is shown able to fail.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../src/paths.js';

/** Directories that hold no markdown a citation guard should read. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'workspaces', 'state', '.wt']);

/**
 * Every markdown file under the repo, excluding runtime output and generated
 * trees -- deliberately not `instructionFiles()` from `instructionSurface.ts`.
 * That helper excludes `docs/specs/dogfood-4-findings.md` and `CHANGELOG.md`
 * as "record of the past", which is the right call for the command guard
 * (a struck command in a changelog entry is not a live instruction) and the
 * wrong one here: those two files carry the densest `[[D-nnn]]` citation
 * traffic in the repo, so a sweep that excludes them checks almost nothing.
 */
export function markdownCorpus(root: string = REPO_ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md')) out.push(path.join(dir, entry.name));
    }
  };
  walk(root);
  return out.map((full) => path.relative(root, full));
}

function stripFencedBlocks(markdown: string): string[] {
  const lines = markdown.split('\n');
  let fenced = false;
  return lines.map((line) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return '';
    }
    return fenced ? '' : line;
  });
}

/**
 * A `## D-NNN ...` heading. Anchored on the id, not on an em dash: real
 * headings like `## D-112 (carried, now fixed) — the plan quorum names a
 * trigger that did not fire` put a parenthetical between the id and the
 * dash, so an em-dash-anchored regex silently drops them and undercounts
 * real ids. Fence-aware: `docs/specs/dogfood-4-findings.md` quotes two of
 * `dogfood-envkit-findings.md`'s own headings verbatim inside a fenced code
 * block (its D-142 finding, about exactly this false-collision trap), and a
 * naive scan would count those as a second declaration.
 */
const HEADING = /^##\s+D-(\d+)\b/;

/**
 * The set of decision ids a record file declares.
 *
 * Ids, not full headings: a citation names only the number, and the title
 * carries no identity a citer could get wrong.
 */
export function findingIds(markdown: string): Set<string> {
  const ids = new Set<string>();
  for (const line of stripFencedBlocks(markdown)) {
    const match = HEADING.exec(line);
    if (match?.[1] !== undefined) ids.add(`D-${match[1]}`);
  }
  return ids;
}

export interface Citation {
  readonly line: number;
  readonly id: string;
}

/** Every `[[D-nnn]]` citation in a document, in file order. */
export function citations(markdown: string): Citation[] {
  const found: Citation[] = [];
  stripFencedBlocks(markdown).forEach((line, index) => {
    for (const match of line.matchAll(/\[\[D-(\d+)\]\]/g)) {
      const id = match[1];
      if (id !== undefined) found.push({ line: index + 1, id: `D-${id}` });
    }
  });
  return found;
}

export interface CitationProblem {
  readonly rel: string;
  readonly line: number;
  readonly id: string;
  readonly reason: string;
}

/**
 * Cross-check swept citations against the declared id set.
 *
 * `excused` is not a floor or a generic filter -- it is the caller's named,
 * sourced exception set (see `docCitations.test.ts` for the two it builds:
 * the `dogfood-mcp-close.md`-declared range, and the sibling-repo id list).
 * A cited id that is neither headed nor named in `excused` is reported: no
 * unnamed number gets to pass quietly.
 */
export function unresolvedCitations(
  files: readonly { rel: string; text: string }[],
  ids: ReadonlySet<string>,
  excused: ReadonlySet<string>,
): CitationProblem[] {
  const problems: CitationProblem[] = [];
  for (const file of files) {
    for (const cite of citations(file.text)) {
      if (ids.has(cite.id)) continue;
      if (excused.has(cite.id)) continue;
      problems.push({
        rel: file.rel,
        line: cite.line,
        id: cite.id,
        reason: `no "## ${cite.id}" heading in the union of dogfood-4-findings.md and dogfood-envkit-findings.md`,
      });
    }
  }
  return problems;
}

export interface MilestoneClaim {
  readonly line: number;
  readonly milestoneId: string;
}

/**
 * `epic id `<id>`` / `milestone `<id>`` -- the two phrasings this repo uses
 * to assert, in prose, that a specific roadmap milestone exists.
 *
 * Deliberately not "any backtick-quoted `phase-N`": that token also names a
 * session id (`phase-10-2026-09-04#4`), a log file
 * (`phase-9-lessons-1.jsonl`), a branch path (`phase-10/plan-v1`), and a
 * struck roadmap block quoted verbatim as history
 * (`docs/specs/dogfood-4-findings.md`'s D-271, which preserves four removed
 * `envkit` milestones' `- id:` lines on purpose). Widening to catch those
 * would flag intentional history as a live defect, which is the shape of
 * over-broad guard this repo waives rather than fixes. The two phrasings
 * kept are narrow enough to hold today's one real instance
 * (`docs/specs/phase-10-scope.md`: "a real epic, epic id `phase-10`") and
 * are the words an author reaches for specifically to assert current
 * roadmap membership.
 */
export function milestoneClaims(markdown: string): MilestoneClaim[] {
  const found: MilestoneClaim[] = [];
  const pattern = /\b(?:epic id|milestone) `([a-z][a-z0-9-]*)`/g;
  stripFencedBlocks(markdown).forEach((line, index) => {
    for (const match of line.matchAll(pattern)) {
      const milestoneId = match[1];
      if (milestoneId !== undefined) found.push({ line: index + 1, milestoneId });
    }
  });
  return found;
}
