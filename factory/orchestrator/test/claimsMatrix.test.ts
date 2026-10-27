import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';

// Every claim the README first screen and the five description strings make
// has a row in docs/claims-matrix.md, and every path a row names exists. The
// first screen is cut into claims by structure only (tables, bullets,
// paragraphs, preformatted and fenced blocks), so a rewrite of it is cut the
// same way and no README word is named here.

const COMMAND_INFO = new Set(['bash', 'sh', 'shell', 'zsh', 'console']);
const COMMAND_START = /^(\$|\/|bs |npm |pnpm |npx |git |claude )/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z"(])/;
const UNESCAPED_PIPE = /(?<!\\)\|/;

/** The one normalisation both sides of the comparison go through. */
function normalise(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The cells of one table line; a `\|` inside a cell reads as `|`. */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(UNESCAPED_PIPE)
    .map((cell) => cell.trim().replaceAll('\\|', '|'));
}

const isSeparator = (line: string): boolean => /^[|\-:\s]+$/.test(line);

/** The body rows of every table in the text: header and separator rows are left out. */
function tableBodyRows(markdown: string): string[][] {
  const rows: string[][] = [];
  let inTable = false;
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      inTable = false;
    } else if (!inTable) {
      inTable = true;
    } else if (!isSeparator(trimmed)) {
      rows.push(splitRow(trimmed));
    }
  }
  return rows;
}

/** The claims of the text from the `# Blacksmith` heading to the first `## ` heading. */
function extractClaims(markdown: string): string[] {
  const from = markdown.search(/^# Blacksmith$/m);
  if (from < 0) return [];
  const screen = markdown.slice(from).split('\n').slice(1).join('\n').split(/^## /m)[0] ?? '';
  const lines = screen.split('\n');
  const claims: string[] = [];
  let paragraph: string[] = [];
  let inTable = false;

  const add = (raw: string): void => {
    const claim = normalise(raw);
    if (claim !== '') claims.push(claim);
  };
  const flush = (): void => {
    const raw = paragraph.join(' ');
    paragraph = [];
    const rest = raw.replace(/\[[^\]]*\]\(#[^)]*\)/g, '').replace(/[\s*·|•,–—-]/g, '');
    if (rest === '') return;
    for (const sentence of normalise(raw).split(SENTENCE_END)) add(sentence);
  };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] as string).trim();
    if (!trimmed.startsWith('|')) inTable = false;
    if (trimmed === '') {
      flush();
    } else if (trimmed.startsWith('```')) {
      flush();
      const info = trimmed.slice(3).trim();
      const block: string[] = [];
      while (++i < lines.length && !(lines[i] as string).trim().startsWith('```'))
        block.push((lines[i] as string).trim());
      const filled = block.filter((line) => line !== '');
      const command =
        COMMAND_INFO.has(info) ||
        (filled.length > 0 && filled.every((line) => COMMAND_START.test(line)));
      if (!command) add(block.join(' '));
    } else if (/^<pre[\s>]/i.test(trimmed)) {
      flush();
      const block = [trimmed];
      while (!/<\/pre>/i.test(block[block.length - 1] as string) && ++i < lines.length)
        block.push((lines[i] as string).trim());
      add(block.join(' '));
    } else if (trimmed.startsWith('#')) {
      flush();
    } else if (trimmed.startsWith('|')) {
      flush();
      if (!inTable) inTable = true;
      else if (!isSeparator(trimmed)) add(splitRow(trimmed).join(' | '));
    } else if (BULLET.test(lines[i] as string)) {
      flush();
      const item = [trimmed.replace(BULLET, '')];
      while (
        i + 1 < lines.length &&
        /^\s+\S/.test(lines[i + 1] as string) &&
        !BULLET.test(lines[i + 1] as string)
      )
        item.push((lines[++i] as string).trim());
      add(item.join(' '));
    } else if (/^!?\[!?\[|^!\[/.test(trimmed) || /^<\/?[a-z][^>]*>$/i.test(trimmed)) {
      // Badge, image and bare-tag lines carry no claim.
    } else {
      paragraph.push(trimmed);
    }
  }
  flush();
  return claims;
}

/** The first column of every matrix row, normalised. */
function quotedClaims(matrix: string): Set<string> {
  return new Set(tableBodyRows(matrix).map((cells) => normalise(cells[0] ?? '')));
}

/** The claims that no row of the matrix quotes. */
function unquotedClaims(claims: readonly string[], matrix: string): string[] {
  const quoted = quotedClaims(matrix);
  return claims.filter((claim) => !quoted.has(claim));
}

/** For each row, the backticked spans of its third column ("Backed by"). */
function namedPaths(matrix: string): { claim: string; paths: string[] }[] {
  return tableBodyRows(matrix).map((cells) => ({
    claim: normalise(cells[0] ?? ''),
    paths: [...(cells[2] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1] as string),
  }));
}

describe('the claim extraction, shown on a fixture first screen', () => {
  const fixture = [
    '<div align="center">',
    '',
    '# Blacksmith',
    '',
    '| Step | Before | After |',
    '|---|---|---|',
    '| Spec | by hand | by contract |',
    '',
    '- A bullet claim',
    '  with a continuation line.',
    '',
    'First sentence here.<br />',
    'Second sentence there.',
    '',
    '<pre>',
    'line one',
    'line two',
    '</pre>',
    '',
    '```',
    'Untagged fenced prose',
    'spanning two lines',
    '```',
    '',
    '```bash',
    'bs doctor',
    '```',
    '',
    '<sub>A sub line.</sub>',
    '',
    '</div>',
    '',
    '## Next',
    '',
    'Not on the first screen.',
  ].join('\n');

  const claims = {
    table: 'Spec | by hand | by contract',
    bullet: 'A bullet claim with a continuation line.',
    first: 'First sentence here.',
    second: 'Second sentence there.',
    pre: 'line one line two',
    fenced: 'Untagged fenced prose spanning two lines',
    sub: 'A sub line.',
  };
  const row = (claim: string): string =>
    `| ${claim.replaceAll('|', '\\|')} | source | \`README.md\` | none |`;
  const matrixOf = (omit?: string): string =>
    [
      '| Claim | Source | Backed by | Limits |',
      '|---|---|---|---|',
      ...Object.values(claims)
        .filter((claim) => claim !== omit)
        .map(row),
    ].join('\n');

  it('cuts the fixture into exactly its claims', () => {
    expect(extractClaims(fixture)).toEqual(Object.values(claims));
  });

  it('yields no claim for the header row, the separator row or the command fence', () => {
    const cut = extractClaims(fixture).join('\n');
    expect(cut).not.toContain('Before');
    expect(cut).not.toContain('---');
    expect(cut).not.toContain('bs doctor');
    expect(cut).not.toContain('Not on the first screen');
  });

  it('passes when the matrix quotes every claim of the fixture', () => {
    expect(unquotedClaims(extractClaims(fixture), matrixOf())).toEqual([]);
  });

  it.each([
    ['the table body row', claims.table],
    ['the bullet', claims.bullet],
    ['the second sentence of the split paragraph', claims.second],
    ['the pre block', claims.pre],
    ['the fenced prose block', claims.fenced],
    ['the sub sentence', claims.sub],
  ])('fails and names the claim when the row for %s is removed', (_unit, claim) => {
    expect(unquotedClaims(extractClaims(fixture), matrixOf(claim))).toEqual([claim]);
  });

  it('reads the paths a row names from its Backed by column', () => {
    expect(namedPaths(matrixOf(claims.sub))[0]).toEqual({
      claim: claims.table,
      paths: ['README.md'],
    });
  });
});

describe('the claim extraction, further units on a second fixture', () => {
  const second = [
    '# Blacksmith',
    '',
    '![logo](logo.png)',
    '[![badge](badge.svg)](https://example.test)',
    '### A sub heading',
    '',
    '1. Numbered item',
    '   with an indented continuation',
    '2) Second numbered item',
    '   - Nested bullet',
    '+ Plus bullet',
    '',
    '| Left | Right |',
    '|:--|--:|',
    '| a \\| b | c |',
    '',
    'Between the tables.',
    '',
    '| Only header |',
    '|---|',
    '| second table body |',
    '',
    '<pre>',
    'Alpha one.',
    'Beta two.',
    '</pre>',
    '',
    '[One](#one) · [Two](#two)',
    '',
    'Alpha<br>beta<br/>gamma<br />delta. Next sentence follows.',
    '',
    'See the [guide](docs/guide.md) first.',
    '',
    '<pre>Single line pre.</pre>',
    '',
    '```sh',
    'echo hello world',
    '```',
    '',
    '```',
    '$ npm install',
    '$ npm test',
    '```',
    '',
    '```',
    '/plugin install example',
    '```',
    '',
    '```text',
    'Tagged prose block',
    '```',
    '',
    '```',
    'npm install',
    'then some prose',
    '```',
  ].join('\n');

  it('cuts the second fixture into exactly its claims', () => {
    expect(extractClaims(second)).toEqual([
      'Numbered item with an indented continuation',
      'Second numbered item',
      'Nested bullet',
      'Plus bullet',
      'a | b | c',
      'Between the tables.',
      'second table body',
      'Alpha one. Beta two.',
      'Alpha beta gamma delta.',
      'Next sentence follows.',
      'See the guide first.',
      'Single line pre.',
      'Tagged prose block',
      'npm install then some prose',
    ]);
  });

  it('returns no claim when the text has no Blacksmith heading', () => {
    expect(extractClaims('# Other\n\nSome text here.')).toEqual([]);
  });

  it('starts the first screen at the exact Blacksmith heading line', () => {
    expect(
      extractClaims('# Blacksmith plugins\n\nWrong one.\n\n# Blacksmith\n\nRight one.'),
    ).toEqual(['Right one.']);
  });

  it('compares a matrix cell after the same normalisation as the claim', () => {
    const matrix = [
      '| Claim | S | B | L |',
      '|---|---|---|---|',
      '| **Bold** [link](docs/a.md)<br />tail | s | `x` | l |',
    ];
    expect(unquotedClaims(['Bold link tail'], matrix.join('\n'))).toEqual([]);
  });

  it('reads an escaped pipe in a matrix cell as a pipe when comparing', () => {
    const matrix = ['| Claim | S | B | L |', '|---|---|---|---|', '| a \\| b | s | `x` | l |'];
    expect(unquotedClaims(['a | b'], matrix.join('\n'))).toEqual([]);
    expect(unquotedClaims(['a'], matrix.join('\n'))).toEqual(['a']);
  });

  it('reads no path from a row with no backticked span', () => {
    const matrix = ['| Claim | S | B | L |', '|---|---|---|---|', '| a | s | plain | l |'];
    expect(namedPaths(matrix.join('\n'))[0]?.paths).toEqual([]);
  });

  it('reports a named path that is absent from the working tree', () => {
    const matrix = [
      '| Claim | S | B | L |',
      '|---|---|---|---|',
      '| a | s | `no/such/file.md` | l |',
    ];
    const [named] = namedPaths(matrix.join('\n'))[0]?.paths ?? [];
    expect(existsSync(path.join(REPO_ROOT, named as string))).toBe(false);
  });
});

describe('the claims matrix', () => {
  const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  const matrix = (): string => read('docs/claims-matrix.md');

  const manifest = JSON.parse(read('.claude-plugin/marketplace.json')) as {
    plugins: readonly { name: string; description: string }[];
  };
  const described = (name: string): string =>
    manifest.plugins.find((one) => one.name === name)?.description ?? '';
  const descriptions = {
    'package.json': (JSON.parse(read('package.json')) as { description: string }).description,
    'the blacksmith marketplace entry': described('blacksmith'),
    'the bs-mod marketplace entry': described('bs-mod'),
    'the pr-mod marketplace entry': described('pr-mod'),
    'the plugin manifest': (
      JSON.parse(read('.claude/.claude-plugin/plugin.json')) as { description: string }
    ).description,
  };

  it('reads at least one claim from the README first screen', () => {
    expect(extractClaims(read('README.md')).length).toBeGreaterThan(0);
  });

  it.each(Object.entries(descriptions))('reads a description from %s', (_where, text) => {
    expect(normalise(text)).not.toBe('');
  });

  it('has a row quoting every claim of the README first screen', () => {
    expect(unquotedClaims(extractClaims(read('README.md')), matrix())).toEqual([]);
  });

  it('has a row quoting every description string', () => {
    const all = Object.values(descriptions).map(normalise);
    expect(unquotedClaims(all, matrix())).toEqual([]);
  });

  it.each(Object.keys(descriptions))(
    'fails and names the description when its row is missing: %s',
    (where) => {
      const text = normalise(descriptions[where as keyof typeof descriptions]);
      const without = matrix()
        .split('\n')
        .filter(
          (line) => !(line.trim().startsWith('|') && quotedClaims(`| h |\n${line}`).has(text)),
        )
        .join('\n');
      expect(unquotedClaims(Object.values(descriptions).map(normalise), without)).toContain(text);
    },
  );

  it('names at least one path in every row, and each path exists in the working tree', () => {
    const rows = namedPaths(matrix());
    expect(rows.length).toBeGreaterThan(0);
    for (const { claim, paths } of rows) {
      expect(paths.length, `a path for: ${claim}`).toBeGreaterThan(0);
      for (const named of paths)
        expect(existsSync(path.join(REPO_ROOT, named)), `${named} for: ${claim}`).toBe(true);
    }
  });

  it('ends with a changes section', () => {
    const headings = matrix()
      .split('\n')
      .filter((line) => line.startsWith('#'));
    expect(headings[headings.length - 1]).toMatch(/^## Changes/);
  });
});
