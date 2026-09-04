import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';
import { instructionFiles } from './helpers/instructionSurface.js';

// ---------------------------------------------------------------------------
// D-267. A lens is a named review pass, and the only place a review pass can
// live is the role template the reviewing agent is dispatched with. Policy
// files do not reach an agent; they describe what the templates are supposed
// to say. So "enforced by the reviewer's `over-engineering` lens" is a claim
// about a *different file*, and nothing checked that the file agreed.
//
// It did not. `severity.yml` and `agent-constraints.md` both named that lens
// as the thing enforcing YAGNI; `.claude/agents/reviewer.md` carried a
// behavioral-drift lens and no over-engineering lens at all. The category
// survived only as one string in a closed vocabulary list -- a rule two
// documents promise and no agent was ever told to apply.
//
// This is D-265's shape one surface over: a document naming a thing the
// dispatched surface does not ship. So it is read the same way -- the claim is
// parsed out of the prose and resolved against the template it names.
// ---------------------------------------------------------------------------

/** Role templates, by the name a document would call them: the filename. */
const ROLES = new Set(
  readdirSync(path.join(REPO_ROOT, '.claude', 'agents'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length)),
);

/**
 * The policy surface, which `instructionFiles()` does not cover: it walks
 * markdown, and half of what the factory is governed by is yaml. `severity.yml`
 * is where the over-engineering claim is load-bearing -- it is the file the
 * waiver batch and the same-mistake escalation are read from -- so a guard
 * that skipped it would have passed on the very line that made the promise.
 */
function policyFiles(): string[] {
  const dir = path.join('factory', 'policies');
  return readdirSync(path.join(REPO_ROOT, dir))
    .filter((name) => name.endsWith('.yml'))
    .map((name) => path.join(dir, name));
}

/**
 * A lens a document attributes to a role: "the reviewer's `over-engineering`
 * lens". The possessive is the whole point -- it is the form that says *this
 * agent applies this pass*, which is exactly the claim a template can fail.
 *
 * Matched against whitespace-collapsed text because markdown wraps at 80
 * columns and yaml folds at whatever the block scalar chose, so the phrase is
 * regularly written across a line break. Two of today's three mentions are.
 *
 * Case-insensitive because the same claim at the start of a sentence is the
 * same claim, and a guard that reads two of three attributions is the shape
 * it was written to catch.
 */
const ATTRIBUTED_LENS = /\bthe ([a-z][a-z-]*)'s [`*]*([a-z][a-z-]*)[`*]* lens\b/gi;

interface Claim {
  readonly source: string;
  readonly role: string;
  readonly lens: string;
}

function claims(): Claim[] {
  const found: Claim[] = [];
  for (const rel of [...instructionFiles(), ...policyFiles()]) {
    const text = readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\s+/g, ' ');
    for (const match of text.matchAll(ATTRIBUTED_LENS)) {
      const [, rawRole, lens] = match as unknown as [string, string, string];
      const role = rawRole.toLowerCase();
      if (!ROLES.has(role)) continue;
      found.push({ source: rel, role, lens });
    }
  }
  return found;
}

/** The `## <name> lens` headings a role template carries, lowercased. */
function lensHeadings(role: string): string[] {
  const template = readFileSync(path.join(REPO_ROOT, '.claude', 'agents', `${role}.md`), 'utf8');
  return [...template.matchAll(/^##\s+(.+?)\s+lens\b/gm)].map((match) =>
    (match[1] as string).toLowerCase(),
  );
}

describe('a lens a document attributes to a role', () => {
  it('is attributed somewhere, so the guard has a subject', () => {
    // A floor, not a count. The failure this guards against is a reword that
    // drops the possessive and leaves the check quietly reading nothing --
    // D-119, a gate scoped narrower than the thing it guards.
    expect(claims().length).toBeGreaterThan(0);
  });

  it('is carried by the template that role is dispatched with', () => {
    const missing = claims().filter(
      (claim) => !lensHeadings(claim.role).includes(claim.lens.toLowerCase()),
    );
    expect(
      missing.map((claim) => `${claim.source} names ${claim.role}'s "${claim.lens}" lens`),
    ).toEqual([]);
  });
});
