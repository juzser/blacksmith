import { describe, expect, it } from 'vitest';
import { linesOfChunks } from '../src/promptImport.js';

async function* feed(chunks: Buffer[]): AsyncGenerator<Buffer> {
  for (const c of chunks) yield c;
}

async function collect(chunks: Buffer[]): Promise<string[]> {
  const out: string[] = [];
  for await (const l of linesOfChunks(feed(chunks))) out.push(l);
  return out;
}

function split(buf: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
}

describe('linesOfChunks', () => {
  it('keeps one very long line split across many small chunks whole', async () => {
    const line = 'x'.repeat(6 * 1024 * 1024);
    const lines = await collect(split(Buffer.from(`${line}\nend`), 1024));
    expect(lines.length).toBe(2);
    expect(lines[0]?.length).toBe(line.length);
    expect(lines[1]).toBe('end');
  });

  it('splits many short lines in one chunk', async () => {
    const n = 400_000;
    const text = 'ab\n'.repeat(n);
    const lines = await collect([Buffer.from(text)]);
    expect(lines.length).toBe(n);
    expect(lines[n - 1]).toBe('ab');
  });

  it('keeps a multi-byte character split across chunks intact', async () => {
    const b = Buffer.from('a\u20acb\nc');
    expect(await collect([b.subarray(0, 2), b.subarray(2, 3), b.subarray(3)])).toEqual([
      'a\u20acb',
      'c',
    ]);
  });

  it('decodes a multi-byte sequence truncated at EOF to U+FFFD', async () => {
    expect(await collect([Buffer.from('x'), Buffer.from([0xe2])])).toEqual(['x\ufffd']);
  });

  it('closes a pending line with a chunk that is exactly a newline', async () => {
    expect(await collect([Buffer.from('ab'), Buffer.from('\n'), Buffer.from('c')])).toEqual([
      'ab',
      'c',
    ]);
  });

  it('splits on \\n only and leaves CR in place', async () => {
    expect(await collect([Buffer.from('a\r\nb\r\n')])).toEqual(['a\r', 'b\r']);
  });

  it('yields a last line with no trailing newline', async () => {
    expect(await collect([Buffer.from('a\nb')])).toEqual(['a', 'b']);
  });

  it('yields nothing for empty input', async () => {
    expect(await collect([])).toEqual([]);
    expect(await collect([Buffer.alloc(0)])).toEqual([]);
  });

  it('yields empty strings for consecutive newlines', async () => {
    expect(await collect([Buffer.from('a\n\n\nb\n')])).toEqual(['a', '', '', 'b']);
  });

  it('joins a line that spans chunk boundaries', async () => {
    expect(await collect([Buffer.from('ab'), Buffer.from('c\nd'), Buffer.from('e\n')])).toEqual([
      'abc',
      'de',
    ]);
  });
});
