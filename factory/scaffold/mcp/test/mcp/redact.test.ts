import { describe, expect, it } from 'vitest';
import { REDACTED, redact, redactError, redactText } from '../../src/mcp/redact.js';

describe('redactText', () => {
  it('scrubs credential shapes out of free text', () => {
    const text = 'failed with Bearer abcdefghijklmnop and ghp_0123456789abcdefghij';
    expect(redactText(text)).not.toContain('ghp_0123456789abcdefghij');
    expect(redactText(text)).not.toContain('abcdefghijklmnop');
    expect(redactText(text)).toContain(REDACTED);
  });

  it('leaves ordinary text alone', () => {
    expect(redactText('no credentials here')).toBe('no credentials here');
  });
});

describe('redact', () => {
  it('drops values under secret-looking keys whatever they contain', () => {
    const out = redact({ apiKey: 'x', password: 'y', session_id: 'z', name: 'keep' });
    expect(out).toEqual({
      apiKey: REDACTED,
      password: REDACTED,
      session_id: REDACTED,
      name: 'keep',
    });
  });

  it('recurses through arrays and nested objects', () => {
    const out = redact({ items: [{ token: 'secret', label: 'ok' }] });
    expect(out).toEqual({ items: [{ token: REDACTED, label: 'ok' }] });
  });

  it('survives a cyclic value instead of throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'self' };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
  });

  it('passes primitives through untouched', () => {
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
    expect(redact(true)).toBe(true);
  });

  it('truncates rather than walking an arbitrarily deep structure', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 20; i += 1) deep = { next: deep };
    expect(JSON.stringify(redact(deep))).toContain('[truncated]');
  });
});

describe('redactError', () => {
  it('redacts the message of a thrown Error', () => {
    const error = new Error('token ghp_0123456789abcdefghij rejected');
    expect(redactError(error)).toBe(`token ${REDACTED} rejected`);
  });

  it('handles a non-Error throw', () => {
    expect(redactError('plain string')).toBe('plain string');
  });
});
