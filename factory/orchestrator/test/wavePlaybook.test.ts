import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';
import { WAVE_VERDICTS } from '../src/waveConcurrency.js';

// wave.md must instruct the wave to audit its own parallelism (`smith wave
// audit --session ... --epic ...`) before merge-queue admission
// (`smith queue run`), and name every WAVE_VERDICTS outcome somewhere in that
// instruction so a reader knows what the audit can come back saying.

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
    expect(matches, 'expected at least one smith wave audit --session ... --epic ... invocation').not.toBeNull();
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

  it('does not count a prose mention of "wave audit" lacking both flags as satisfying the requirement', () => {
    // A bare mention of "wave audit" in prose (no `smith`, no flags) must not
    // match the invocation pattern used above.
    const proseOnly = 'the wave audit result is discussed here, but not invoked';
    expect(proseOnly.match(WAVE_AUDIT_INVOCATION)).toBeNull();
  });

  it('names every WAVE_VERDICTS value in the steps section', () => {
    for (const verdict of WAVE_VERDICTS) {
      expect(steps.includes(verdict), `expected steps section to mention verdict "${verdict}"`).toBe(true);
    }
  });
});
