import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';
import { instructionFiles } from './helpers/instructionSurface.js';

// ---------------------------------------------------------------------------
// The fifth guard of a shape this repo keeps rediscovering: a document asserts
// something about another surface, and nothing reads the two back together.
// D-259 caught it in command names, D-265 in error codes, D-267 in review
// lenses, D-268 in the language rule. Here the other surface is a *policy
// file*, and the claim is a value in it.
//
// The defect that opened it: an operator flipped codex to `enabled: auto,
// mode: active` in `crosscheck.yml`. `docs/runbooks/providers.md` was updated
// in the same breath. Four sites in the guides were not, and went on telling
// an operator "no call, no spend" while a judge was live on their box. Every
// one of them was true when written, which is exactly why prose cannot be
// trusted to notice.
//
// What this reads is narrower than "every claim about the policy", and says
// so, because a scanner that pretends to more coverage than it has is worse
// than one that states its edge (D-119):
//
//   - It reads the *declared* value, never the resolved one. `enabled: auto`
//     resolves against the box — codex is on a machine with the binary and off
//     on one without — so a guard that loaded the policy would pass here and
//     fail in CI. The docs describe what the file ships. So does this.
//   - A sentence is a claim about the shipped file only when it both names a
//     provider and says `crosscheck.yml` or some form of "ship". Prose about
//     what the knobs *mean* ("`enabled: false` stops it being invoked") names
//     no file and is not a claim about this one.
//   - A value binds only to providers named *before* it. English attributes a
//     value to the subject that precedes it, and the corpus obeys: "codex
//     ships `enabled: auto, mode: active`, so ... on findings claude raised"
//     is a claim about codex, and reading it as one about claude too would
//     report the document rather than the drift.
//
// Which leaves prose that makes the claim without a value span — "every
// external ships off" — outside the scan. That sentence was part of the same
// defect and had to be fixed by hand. It is named here rather than papered
// over: this guard holds attributed, file-scoped value claims, and a claim
// spelled out in words is still on the reader.
// ---------------------------------------------------------------------------

const POLICY_FILE = 'factory/policies/crosscheck.yml';

/** The fields a document is held to. Both are three-state and both drift. */
const FIELDS = ['enabled', 'mode'] as const;

/**
 * `independent_finder` is not under `providers:` and is named in the guides
 * beside those that are, with the same two fields and the same power to be
 * wrong about them.
 */
const TOP_LEVEL_BLOCKS = ['independent_finder'];

/**
 * How a value claim is spelled, inside one code span: an optional provider,
 * then one or more `field: value` pairs. `codex: enabled: auto, mode: active`
 * is one span attributing both pairs, and reading the second as unattributed
 * would hand it to whichever provider the sentence happened to name first.
 */
const SPAN = /`([^`]+)`/g;
const PAIR = /(?:([a-z_]+)\s*:\s*)?(enabled|mode)\s*:\s*([a-z]+)/g;

/** A sentence that is talking about the file rather than about the knob. */
const ABOUT_THE_FILE = /crosscheck\.yml|\bship(?:s|ped|ping)?\b/i;

/**
 * A sentence that reports another document's claim instead of making one.
 *
 * `recordOfThePast()` already draws this line for whole files -- a finding
 * that quotes a bug report is the report, not a second one -- and a spec that
 * lists drift has to quote it to name it. The grammar of reporting is a
 * located source: `docs/guide/status.md:48-49` fixes the claim to a place that
 * is not this sentence. The cost is real and worth stating: prose can leave
 * this scan by citing a line number, which is why the rule is a *markdown*
 * citation. A claim about the policy cites the policy, and `crosscheck.yml`
 * is not markdown.
 */
const QUOTES_A_SOURCE = /\b[\w./-]+\.md:\d/;

interface Claim {
  readonly file: string;
  readonly line: number;
  readonly provider: string;
  readonly field: string;
  readonly claimed: string;
  readonly sentence: string;
}

/**
 * What the file literally declares, comments stripped.
 *
 * A hand parse rather than a YAML load for the reason in the header: the
 * loader resolves `auto`, and the resolution is a fact about the box.
 */
function declared(): Map<string, Map<string, string>> {
  const text = readFileSync(path.join(REPO_ROOT, POLICY_FILE), 'utf8');
  const out = new Map<string, Map<string, string>>();
  let block: string | null = null;
  let indent = 0;

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const top = /^([a-z_]+):\s*$/.exec(line);
    if (top) {
      const name = top[1] as string;
      if (name === 'providers') {
        block = null;
        indent = 2;
      } else if (TOP_LEVEL_BLOCKS.includes(name)) {
        block = name;
        indent = 2;
        out.set(name, new Map());
      } else {
        block = null;
        indent = 0;
      }
      continue;
    }

    const named = new RegExp(`^ {${indent}}([a-z_]+):\\s*$`).exec(line);
    if (named && indent === 2 && !TOP_LEVEL_BLOCKS.includes(named[1] as string)) {
      block = named[1] as string;
      out.set(block, new Map());
      continue;
    }

    if (block === null) continue;
    const field = /^ +([a-z_]+):\s*(\S+)\s*$/.exec(line);
    if (field && FIELDS.includes(field[1] as (typeof FIELDS)[number])) {
      out.get(block)?.set(field[1] as string, field[2] as string);
    }
  }
  return out;
}

/** Paragraphs of prose, fences dropped, wrapped lines rejoined. */
function paragraphs(markdown: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let fenced = false;
  let buffer: string[] = [];
  let start = 1;

  const flush = (): void => {
    if (buffer.length > 0) out.push({ line: start, text: buffer.join(' ') });
    buffer = [];
  };

  markdown.split('\n').forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      flush();
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    if (line.trim() === '') {
      flush();
      return;
    }
    // A list item is its own unit. Joining bullets into one blob carries the
    // subject of one line into the claim on the next, which is how a document
    // that only *quotes* a wrong claim gets reported as making it.
    if (/^\s*(?:[-*+]|\d+\.|>)\s/.test(line)) flush();
    if (buffer.length === 0) start = index + 1;
    buffer.push(line.trim());
  });
  flush();
  return out;
}

/** Split on sentence ends, which is where attribution stops carrying. */
function sentences(paragraph: string): string[] {
  return paragraph.split(/(?<=\.)\s+/).filter((s) => s.trim() !== '');
}

function claimsIn(file: string, providers: Iterable<string>): Claim[] {
  const names = [...providers];
  const found: Claim[] = [];

  for (const { line, text } of paragraphs(readFileSync(path.join(REPO_ROOT, file), 'utf8'))) {
    for (const sentence of sentences(text)) {
      if (!ABOUT_THE_FILE.test(sentence)) continue;
      if (QUOTES_A_SOURCE.test(sentence)) continue;

      for (const span of sentence.matchAll(SPAN)) {
        const before = sentence.slice(0, span.index);
        let carried: string | undefined;

        for (const match of (span[1] as string).matchAll(PAIR)) {
          const attributed = match[1] ?? carried;
          if (match[1]) carried = match[1];
          const field = match[2] as string;
          const claimed = match[3] as string;

          const subjects = attributed
            ? names.includes(attributed)
              ? [attributed]
              : []
            : names.filter((name) => new RegExp(`\\b${name}\\b`, 'i').test(before));

          for (const provider of subjects) {
            found.push({ file, line, provider, field, claimed, sentence });
          }
        }
      }
    }
  }
  return found;
}

describe('what the guides say the policy ships', () => {
  const policy = declared();
  const claims = instructionFiles().flatMap((file) => claimsIn(file, policy.keys()));

  it('reads a policy file that actually declares the fields it holds', () => {
    // The floor (D-119): every provider the guides can be wrong about has to
    // be a provider this parse found a value for, or the comparison below is
    // vacuous for it and passes by reaching nothing.
    const missing = [...policy.entries()]
      .filter(([, fields]) => !fields.has('enabled'))
      .map(([name]) => name);
    expect(missing).toEqual([]);
    expect([...policy.keys()]).toEqual(
      expect.arrayContaining(['claude', 'codex', 'deepseek', 'independent_finder']),
    );
  });

  it('reaches the corpus, so a clean run is a read one', () => {
    // A scan that matches nothing passes. The externals are the two the docs
    // discuss by name, so a walk that resolves no claim about either is
    // broken, not clean.
    const covered = new Set(claims.map((claim) => claim.provider));
    expect([...covered].sort()).toEqual(expect.arrayContaining(['codex', 'deepseek']));
  });

  it('says nothing about a provider that the policy file does not', () => {
    const wrong = claims
      .filter((claim) => (policy.get(claim.provider)?.get(claim.field) ?? null) !== claim.claimed)
      .map(
        (claim) =>
          `${claim.file}:${claim.line}: says ${claim.provider} ${claim.field}: ${claim.claimed}, ` +
          `${POLICY_FILE} says ${policy.get(claim.provider)?.get(claim.field) ?? '(unset)'} ` +
          `— "${claim.sentence.slice(0, 96)}"`,
      );
    expect(wrong).toEqual([]);
  });
});
