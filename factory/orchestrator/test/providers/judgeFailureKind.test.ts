import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../src/paths.js';
import {
  JUDGE_SCHEMA_FAILURE_CODES,
  JUDGE_TRANSPORT_FAILURE_CODES,
  judgeFailureKind,
} from '../../src/providers/types.js';

// ---------------------------------------------------------------------------
// D-253. A judge run that produced no verdict failed for one of two reasons,
// and they are not the same repair:
//
//   schema     the provider answered and the answer could not be used
//              -> the prompt/schema pairing needs work
//   transport  no usable answer ever arrived: no key, no binary, no route,
//              a timeout, an HTTP error
//              -> the transport needs work, and nothing here is evidence
//                 about how this provider judges
//
// Every code the orchestrator can raise has to sit in exactly one of those
// buckets, or the split silently degrades: an unlisted code falls to
// `transport` (the safe default -- it claims nothing about the provider's
// judgement), and without this test a new schema-shaped code would land there
// unnoticed and go on being reported as a broken transport forever.
// ---------------------------------------------------------------------------

const SRC = path.join(REPO_ROOT, 'factory/orchestrator/src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Every `provider.*` error code literal the orchestrator can actually raise. */
function codesInSource(): Set<string> {
  const found = new Set<string>();
  for (const file of tsFiles(SRC)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/'(provider\.[a-z-]+)'/g)) {
      const code = match[1];
      if (code) found.add(code);
    }
  }
  return found;
}

describe('providers/types.ts judgeFailureKind()', () => {
  it('classifies every provider error code the source can raise', () => {
    const unclassified = [...codesInSource()].filter(
      (code) => !JUDGE_SCHEMA_FAILURE_CODES.has(code) && !JUDGE_TRANSPORT_FAILURE_CODES.has(code),
    );
    expect(unclassified).toEqual([]);
  });

  it('puts no code in both buckets', () => {
    const both = [...JUDGE_SCHEMA_FAILURE_CODES].filter((code) =>
      JUDGE_TRANSPORT_FAILURE_CODES.has(code),
    );
    expect(both).toEqual([]);
  });

  it('reads a rejected answer as a schema failure', () => {
    expect(judgeFailureKind('provider.invalid-output')).toBe('schema');
    expect(judgeFailureKind('provider.malformed-response')).toBe('schema');
    // The provider answered; the answer was too big to accept. Still an
    // answer-shape problem, and still fixed at the prompt, not the transport.
    expect(judgeFailureKind('provider.output-too-large')).toBe('schema');
  });

  it('reads an unsent or unanswered request as a transport failure', () => {
    // The factory's own deepseek judge, eight days running.
    expect(judgeFailureKind('provider.missing-api-key')).toBe('transport');
    expect(judgeFailureKind('provider.cli-unavailable')).toBe('transport');
    expect(judgeFailureKind('provider.timeout')).toBe('transport');
    expect(judgeFailureKind('provider.http-error')).toBe('transport');
  });

  // A code from a future transport, or from a provider SDK that invents its
  // own: it says nothing about the provider's judgement, so it must not be
  // charged to the rate that does.
  it('defaults an unrecognised code to transport', () => {
    expect(judgeFailureKind('provider.some-future-code')).toBe('transport');
  });
});
