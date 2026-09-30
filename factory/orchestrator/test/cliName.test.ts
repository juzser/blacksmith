import { describe, expect, it } from 'vitest';
import { invokedName, warnIfLegacyName } from '../src/cliName.js';

describe('invokedName (bs-rename)', () => {
  it('reads the basename off argv[1]', () => {
    expect(invokedName('/usr/local/bin/smith')).toBe('smith');
    expect(invokedName('/usr/local/bin/bs')).toBe('bs');
  });

  it('returns undefined when argv[1] itself is undefined', () => {
    expect(invokedName(undefined)).toBeUndefined();
  });

  it('reads a bare name with no directory component', () => {
    expect(invokedName('bs')).toBe('bs');
  });
});

describe('warnIfLegacyName (bs-rename)', () => {
  it('writes exactly one deprecation line naming both the legacy and current name, to the given sink', () => {
    const written: string[] = [];
    warnIfLegacyName('/usr/local/bin/smith', 'smith', 'bs', (text) => written.push(text));
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('smith');
    expect(written[0]).toContain('bs');
    expect(written[0]).toMatch(/deprecat/i);
    expect(written[0]?.endsWith('\n')).toBe(true);
    expect(written[0]?.split('\n').filter((line) => line.length > 0)).toHaveLength(1);
  });

  it('does nothing when invoked under the current name', () => {
    const written: string[] = [];
    warnIfLegacyName('/usr/local/bin/bs', 'smith', 'bs', (text) => written.push(text));
    expect(written).toEqual([]);
  });

  it('does nothing when argv[1] is undefined', () => {
    const written: string[] = [];
    warnIfLegacyName(undefined, 'smith', 'bs', (text) => written.push(text));
    expect(written).toEqual([]);
  });

  it('does nothing for an unrelated invocation name, e.g. a direct node dist/cli.js run', () => {
    const written: string[] = [];
    warnIfLegacyName('/repo/factory/orchestrator/dist/cli.js', 'smith', 'bs', (text) =>
      written.push(text),
    );
    expect(written).toEqual([]);
  });

  it('defaults its sink to process.stderr.write', () => {
    const original = process.stderr.write.bind(process.stderr);
    const written: string[] = [];
    process.stderr.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      warnIfLegacyName('/usr/local/bin/smith-run', 'smith-run', 'bs-run');
    } finally {
      process.stderr.write = original;
    }
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('smith-run');
    expect(written[0]).toContain('bs-run');
  });
});
