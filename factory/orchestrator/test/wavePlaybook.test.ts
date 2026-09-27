import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';
import { WAVE_VERDICTS } from '../src/waveConcurrency.js';

// wave.md must instruct the wave to audit its own parallelism (`smith wave
// audit --session ... --epic ...`) at two call points -- once at the end of
// step 4's coder fan-out, before step 5's tester dispatch, and again before
// merge-queue admission (`smith queue run`) -- and name every WAVE_VERDICTS
// outcome somewhere in that instruction so a reader knows what the audit can
// come back saying.

const WAVE_MD_PATH = path.join(REPO_ROOT, '.claude/skills/bs/wave.md');

/** Isolate "## The steps" heading through end of file. */
function stepsSection(text: string): string {
  const headingIndex = text.indexOf('## The steps');
  if (headingIndex === -1) {
    throw new Error('wave.md has no "## The steps" heading');
  }
  return text.slice(headingIndex);
}

/**
 * Match `smith wave audit` across a line break or inside a fenced code
 * block, carrying both `--session` and `--epic` somewhere after it on the
 * same logical invocation (allowing wrapped lines and other flags between).
 * Whitespace between words (including a newline) collapses to \s+.
 */
const WAVE_AUDIT_INVOCATION =
  /smith\s+wave\s+audit\b(?:[^\n]|\n(?!\n))*?--session\b(?:[^\n]|\n(?!\n))*?--epic\b|smith\s+wave\s+audit\b(?:[^\n]|\n(?!\n))*?--epic\b(?:[^\n]|\n(?!\n))*?--session\b/g;

describe('wave.md instructs the wave to audit its own parallelism', () => {
  const fullText = readFileSync(WAVE_MD_PATH, 'utf8');
  const steps = stepsSection(fullText);

  it('names a `smith wave audit --session ... --epic ...` invocation in the steps section', () => {
    const matches = steps.match(WAVE_AUDIT_INVOCATION);
    expect(
      matches,
      'expected at least one smith wave audit --session ... --epic ... invocation',
    ).not.toBeNull();
    expect((matches ?? []).length).toBeGreaterThan(0);
  });

  it('runs `smith wave audit` before the first `smith queue run` in the steps section', () => {
    const auditMatch = steps.match(WAVE_AUDIT_INVOCATION);
    expect(auditMatch).not.toBeNull();
    const auditIndex = steps.search(WAVE_AUDIT_INVOCATION);
    const queueRunIndex = steps.indexOf('smith queue run');
    expect(auditIndex).toBeGreaterThanOrEqual(0);
    expect(queueRunIndex).toBeGreaterThanOrEqual(0);
    expect(auditIndex).toBeLessThan(queueRunIndex);
  });

  it("runs `smith wave audit` a second time, at the end of step 4's fan-out, before step 5's tester dispatch", () => {
    // Anchor on step 5's own numbered marker: stable across reflow of step 4's
    // prose, and the spec's call point (a) is "the end of step 4's fan-out",
    // i.e. anywhere before step 5 begins.
    const step5Index = steps.indexOf('\n5. Dispatch');
    expect(step5Index).toBeGreaterThan(0);
    const beforeStep5 = steps.slice(0, step5Index);
    const matches = beforeStep5.match(WAVE_AUDIT_INVOCATION);
    expect(matches, 'expected a smith wave audit invocation before step 5').not.toBeNull();
    expect((matches ?? []).length).toBeGreaterThan(0);
  });

  it('does not count a prose mention of "wave audit" lacking both flags as satisfying the requirement', () => {
    // A bare mention of "wave audit" in prose (no `smith`, no flags) must not
    // match the invocation pattern used above.
    const proseOnly = 'the wave audit result is discussed here, but not invoked';
    expect(proseOnly.match(WAVE_AUDIT_INVOCATION)).toBeNull();
  });

  it('names every WAVE_VERDICTS value in the steps section', () => {
    for (const verdict of WAVE_VERDICTS) {
      expect(
        steps.includes(verdict),
        `expected steps section to mention verdict "${verdict}"`,
      ).toBe(true);
    }
  });

  it('has one sentence naming both `wave check` and `wave audit` and contrasting them', () => {
    // Join wrapped lines (single newlines) into spaces first, so a sentence
    // that wraps across a markdown line break still counts as one sentence.
    const joined = steps.replace(/\n(?!\n)/g, ' ').replace(/[ \t]+/g, ' ');
    // Split into sentences on a period followed by whitespace and the start
    // of the next sentence (capital letter, backtick, quote, or paren).
    const sentenceList = joined
      .split(/(?<=\.)\s+(?=[A-Z`"(])/)
      .map((s) => s.trim())
      .filter(Boolean);

    // Extract each backtick-delimited code span as its own capture, rather
    // than matching backtick...backtick loosely -- the loose form can start
    // at the closing backtick of one span and end at the opening backtick of
    // an unrelated later span, letting plain prose in between (which is not
    // inside any code span at all) satisfy the check.
    const codeSpans = (s: string): string[] => [...s.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
    const hasWaveCheckSpan = (s: string) => codeSpans(s).some((span) => /\bwave check\b/.test(span));
    const hasWaveAuditSpan = (s: string) => codeSpans(s).some((span) => /\bwave audit\b/.test(span));

    const contrastSentences = sentenceList.filter(
      (s) => hasWaveCheckSpan(s) && hasWaveAuditSpan(s),
    );

    expect(
      contrastSentences.length,
      'expected a single sentence in "## The steps" naming both ' +
        '`wave check` and `wave audit` and stating the difference between ' +
        'them; sentences mentioning only one of the two: ' +
        JSON.stringify(sentenceList.filter((s) => hasWaveCheckSpan(s) || hasWaveAuditSpan(s))),
    ).toBeGreaterThan(0);
  });
});
