import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';

// The operator asked for a mandatory plain-language rule on every reply and
// human-facing document `/bs` produces. It lives once, in SKILL.md, because
// every verb loads that file; scribe.md writes two of the covered documents
// (the report digest and the integration PR body) but does not load SKILL.md,
// so it needs a pointer into the section rather than a second copy.

const SKILL_MD_PATH = path.join(REPO_ROOT, '.claude/skills/bs/SKILL.md');
const SCRIBE_MD_PATH = path.join(REPO_ROOT, '.claude/agents/scribe.md');

const SECTION_HEADING = '## Talking to the operator';

/** Isolate the named heading through the next `## ` heading, or EOF. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start === -1) throw new Error(`missing heading: ${heading}`);
  const rest = text.slice(start + heading.length);
  const end = rest.search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end);
}

const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('SKILL.md states the plain-language rule once, in "Talking to the operator"', () => {
  const skillText = readFileSync(SKILL_MD_PATH, 'utf8');
  const body = flat(section(skillText, SECTION_HEADING));

  it('scopes the rule to human replies/documents and exempts machine-facing text', () => {
    expect(body).toMatch(/report`? ?digest/i);
    expect(body).toMatch(/integration PR body/i);
    expect(body).toMatch(/structured_output/);
  });

  it("requires grounding jargon in the operator's own terms", () => {
    expect(body).toMatch(/operator's own terms|their (task|prompt)/i);
  });

  it('requires plain explanation first, technical details in a trailing part', () => {
    expect(body).toMatch(/Technical details/);
  });

  it('requires replying in the language the operator writes in', () => {
    expect(body).toMatch(/language the operator writes in/i);
  });

  it('requires asking before acting on an unclear request', () => {
    expect(body).toMatch(/ask/i);
  });

  it('carries one before/after example', () => {
    expect(body).toMatch(/Jargon:/);
    expect(body).toMatch(/Plain:/);
  });

  it('asks for the current state to be restated in the operator’s terms', () => {
    expect(body).toMatch(/restat/i);
    expect(body).toMatch(/\d of \d/i);
  });

  it('asks for multi-step replies to be numbered', () => {
    expect(body).toMatch(/number/i);
    expect(body).toMatch(/step/i);
  });

  it('asks for errors to be stated as what broke, why, and the fix', () => {
    expect(body).toMatch(/broke/i);
    expect(body).toMatch(/fix/i);
  });

  it('caps lists and holds the rest back rather than dropping it', () => {
    expect(body).toMatch(/5 items|five items/i);
    expect(body).toMatch(/on request|held back|shown if asked/i);
  });

  it('merges asking one question and confirming destructive steps into one bullet', () => {
    expect(body).toMatch(/one short question/i);
    expect(body).toMatch(/destructive|irreversible/i);
  });

  it('requires a confidence figure on every option title when one is recommended', () => {
    expect(body).toMatch(/confidence/i);
    expect(body).toMatch(/%/);
    expect(body).toMatch(/Recommended/);
    expect(body).toMatch(/highest figure/i);
  });

  it('asks for a pre-send check', () => {
    expect(body).toMatch(/pre-send check/i);
  });

  it('credits the ADHD reference skill without importing it as a rule set', () => {
    expect(body).toMatch(/ayghri\/i-have-adhd/);
  });
});

describe("scribe.md points at SKILL.md's rule instead of restating it", () => {
  const scribeText = readFileSync(SCRIBE_MD_PATH, 'utf8');

  it('cites the section by path and heading', () => {
    expect(scribeText).toContain('.claude/skills/bs/SKILL.md');
    expect(scribeText).toContain(SECTION_HEADING.replace('## ', ''));
  });

  it('does not restate the rule body (no Jargon/Plain example duplicated here)', () => {
    expect(scribeText).not.toMatch(/Jargon:/);
  });
});
