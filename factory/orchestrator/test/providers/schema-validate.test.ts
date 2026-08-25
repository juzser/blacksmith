import { describe, expect, it } from 'vitest';
import { extractAndValidate, extractBalancedJson } from '../../src/providers/schema-validate.js';

function validFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    finding_id: 'f-1',
    task_id: 'epic-1/task-1',
    fingerprint: 'abc123',
    file_path: 'src/parse.ts',
    finding_category: 'correctness',
    severity: 'S2-major',
    finding_status: 'raised',
    summary: 'off by one',
    failure_scenario: { inputs: 'n=0', expected: '0', actual: '-1' },
    found_by: 'reviewer',
    ...overrides,
  };
}

describe('providers/schema-validate.ts extractBalancedJson', () => {
  it('extracts a bare JSON object', () => {
    expect(extractBalancedJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('extracts JSON wrapped in surrounding prose', () => {
    expect(extractBalancedJson('Sure, here you go:\n{"a":1}\nEnjoy!')).toEqual({ a: 1 });
  });

  it('extracts a JSON array', () => {
    expect(extractBalancedJson('notes: [1,2,3] done')).toEqual([1, 2, 3]);
  });

  it('handles nested braces/brackets and strings containing brackets', () => {
    const text = 'blah {"a":{"b":[1,2]},"c":"contains } and [ chars"} trailing';
    expect(extractBalancedJson(text)).toEqual({ a: { b: [1, 2] }, c: 'contains } and [ chars' });
  });

  it('skips a candidate that balances but fails to parse, and tries the next one', () => {
    // "{not json}" balances but is not valid JSON; the real payload follows.
    const text = '{not json} then {"a":1}';
    expect(extractBalancedJson(text)).toEqual({ a: 1 });
  });

  it('returns null when there is no JSON at all', () => {
    expect(extractBalancedJson('no json here whatsoever')).toBeNull();
  });
});

describe('providers/schema-validate.ts extractAndValidate', () => {
  it('validates a judge-verdict object', () => {
    const result = extractAndValidate(
      '{"verdict":"confirm","rationale":"real issue"}',
      'judge-verdict',
    );
    expect(result).toEqual({ valid: true, value: { verdict: 'confirm', rationale: 'real issue' } });
  });

  it('rejects a judge-verdict object missing a required field', () => {
    const result = extractAndValidate('{"verdict":"confirm"}', 'judge-verdict');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('schema-invalid');
  });

  it('reports no-json-found when extraction fails', () => {
    const result = extractAndValidate('not json at all', 'judge-verdict');
    expect(result).toEqual({ valid: false, reason: 'no-json-found' });
  });

  it('validates a finding array element-wise (schemaName "finding")', () => {
    const findings = [validFinding(), validFinding({ finding_id: 'f-2' })];
    const result = extractAndValidate(JSON.stringify(findings), 'finding');
    expect(result).toEqual({ valid: true, value: findings });
  });

  it('rejects a finding array with an invalid taxonomy value, pathing to the failing element', () => {
    const findings = [validFinding({ severity: 'not-a-real-severity' })];
    const result = extractAndValidate(JSON.stringify(findings), 'finding');
    expect(result.valid).toBe(false);
    if (!result.valid && result.reason === 'schema-invalid') {
      expect(result.errors.some((e) => e.path.startsWith('/0'))).toBe(true);
    } else {
      throw new Error('expected schema-invalid');
    }
  });

  it('accepts an empty finding array (no findings raised)', () => {
    const result = extractAndValidate('[]', 'finding');
    expect(result).toEqual({ valid: true, value: [] });
  });

  // D-118. Taking the first candidate that *parses* is not the same as taking
  // the judge's answer. Real `codex exec` echoes the prompt to stderr, the
  // transport merges stderr into the extraction buffer, and this prompt says
  // "initialised to the empty list `[]`" — so `[]` arrived before the verdict
  // and won. Observed against the real binary; no fixture predicted it.
  describe('D-118: the first parseable candidate is not necessarily the answer', () => {
    it('skips a candidate that parses but does not validate, and takes the one that does', () => {
      const echoed = 'the empty list [] and a template {"verdict": "confirm" | "refute"}\n';
      const answer = '{"verdict":"refute","rationale":"the gate is reachable via the seed path"}';
      const result = extractAndValidate(echoed + answer, 'judge-verdict');
      expect(result).toEqual({
        valid: true,
        value: { verdict: 'refute', rationale: 'the gate is reachable via the seed path' },
      });
    });

    it('finds a verdict that arrives after a prose-wrapped decoy object', () => {
      const text =
        'Here is the schema I was given: {"a":1}\nMy verdict:\n{"verdict":"confirm","rationale":"holds"}';
      const result = extractAndValidate(text, 'judge-verdict');
      expect(result).toEqual({ valid: true, value: { verdict: 'confirm', rationale: 'holds' } });
    });

    // Diagnostics must not get worse: when nothing validates, the operator
    // still needs the schema errors for the judge's actual (malformed) answer,
    // not a bare `no-json-found`.
    it('reports schema errors from the first candidate when none validate', () => {
      const result = extractAndValidate(
        '{"verdict":"confirm"} then {"unrelated":true}',
        'judge-verdict',
      );
      expect(result.valid).toBe(false);
      if (!result.valid && result.reason === 'schema-invalid') {
        expect(result.errors.some((e) => e.message.includes('rationale'))).toBe(true);
      } else {
        throw new Error('expected schema-invalid');
      }
    });

    it('still reports no-json-found when there is no candidate at all', () => {
      expect(extractAndValidate('no json here', 'judge-verdict')).toEqual({
        valid: false,
        reason: 'no-json-found',
      });
    });
  });
});
