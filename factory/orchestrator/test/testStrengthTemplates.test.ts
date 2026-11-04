import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENTS_DIR } from '../src/paths.js';

// The 2026-11-03 A/B trial found Blacksmith's whole edge in its tests. These
// pin the prose that makes the test-strength discipline explicit, so a
// template edit cannot drop it unnoticed. Only the coder edits code under
// test: the tester and reviewer reason about mutations, they never apply one.

const agent = (role: string): string =>
  readFileSync(path.join(AGENTS_DIR, `bs-${role}.md`), 'utf8').replace(/\s+/g, ' ');

describe('test-strength templates', () => {
  it('coder: criterion tests, behaviour lock, telling fixtures, criteria_evidence', () => {
    const t = agent('coder');
    expect(t).toContain('would fail if that criterion were removed or inverted');
    expect(t).toContain('behaviour-lock test **before** any code moves');
    expect(t).toContain('criteria_evidence');
    expect(t).toContain('"red-first" | "mutation"');
    expect(t).toContain('Never commit a mutation');
    expect(t).toContain('Commit the green implementation first');
    expect(t).toContain('`git status --porcelain` is empty');
    expect(t).toContain('assertion failure');
    expect(t).toContain('different order from the ids');
    expect(t).toContain('rows are inserted out of id order');
    expect(t).toContain('order the candidates differently under each plausible key');
    expect(t).toContain("every public function, route or export's observable output");
    expect(t).not.toContain('gate-enforced');
    expect(t).not.toContain('Code written before its test, or');
  });

  it('tester: mutation reasoning per criterion, never applies a mutation', () => {
    const t = agent('tester');
    expect(t).toContain('Per-criterion mutation reasoning');
    expect(t).toContain('criteria_evidence');
    expect(t).toContain('mutation_check');
    expect(t).toContain('would_fail');
    expect(t).toContain('added_test');
    expect(t).toContain('per public behaviour in the lock');
    expect(t).not.toContain('tree_state');
    expect(t).not.toContain('scratch copy');
  });

  it('reviewer: criteria compliance before code quality, by reading', () => {
    const t = agent('reviewer');
    const one = t.indexOf('Stage 1: criteria compliance');
    const two = t.indexOf('Stage 2: code quality');
    expect(one).toBeGreaterThan(-1);
    expect(two).toBeGreaterThan(one);
    expect(t).toContain('spot-check at least one row');
    expect(t).toContain('`test-coverage` finding');
    expect(t).not.toContain('scratch copy');
    expect(t).not.toContain('re-applying');
    expect(t).toContain('unmet acceptance criterion');
    expect(t).toContain('`S2-major`');
    expect(t).toContain('the suite stays green');
  });

  it('verifier: test-coverage is exempt from the wrong-output rule, with its own shape', () => {
    const t = agent('verifier');
    expect(t).toContain('`test-coverage`');
    expect(t).toContain('the named test fails');
  });

  it('agent-constraints.md carries the rules the templates cite', () => {
    const t = readFileSync(
      path.join(AGENTS_DIR, '..', '..', 'docs/standards/agent-constraints.md'),
      'utf8',
    ).replace(/\s+/g, ' ');
    expect(t).toContain('criteria_evidence');
    expect(t).toContain('mutation_check');
    expect(t).not.toContain('gate-enforced');
  });
});
