// Cuts one step or one section out of a playbook. A cut, not a copy: the
// text always comes from the file it is given.
import { SmithError } from './errors.js';

export class PlaybookError extends SmithError {}

interface Line {
  readonly text: string;
  /** True when the line sits inside a ``` fence (fence lines included). */
  readonly fenced: boolean;
}

function scan(markdown: string): Line[] {
  let open = false;
  return markdown.split('\n').map((text) => {
    const fence = /^\s*```/.test(text);
    const fenced = open || fence;
    if (fence) open = !open;
    return { text, fenced };
  });
}

/** The lines `from..to` as text: trailing blank lines dropped, one final newline. */
function join(lines: readonly Line[], from: number, to: number): string {
  let last = to;
  while (last > from + 1 && (lines[last - 1]?.text.trim() ?? '') === '') last--;
  return `${lines
    .slice(from, last)
    .map((l) => l.text)
    .join('\n')}\n`;
}

const HEADING_RE = /^(#{1,6}) (.*)$/;

/**
 * Serves epic bs-optimize criterion 7: the top-level numbered item `n. ` under
 * `## The steps`, up to the next top-level numbered item or heading.
 */
export function sliceWaveStep(markdown: string, n: number): string {
  const lines = scan(markdown);
  const unknown = () =>
    new PlaybookError('playbook.unknown-step', `playbook has no step ${n}`, { step: n });
  const heading = lines.findIndex((l) => !l.fenced && l.text === '## The steps');
  if (heading === -1) throw unknown();
  let start = -1;
  for (let i = heading + 1; i < lines.length; i++) {
    const line = lines[i] as Line;
    if (line.fenced) continue;
    if (HEADING_RE.test(line.text)) {
      if (start === -1) break;
      return join(lines, start, i);
    }
    const item = /^(\d+)\. /.exec(line.text);
    if (item === null) continue;
    if (start !== -1) return join(lines, start, i);
    if (Number(item[1]) === n) start = i;
  }
  if (start === -1) throw unknown();
  return join(lines, start, lines.length);
}

/** The heading text minus one trailing ` (...)` group, or null when it has none. */
function withoutParenthetical(text: string): string | null {
  if (!text.endsWith(')')) return null;
  const open = text.lastIndexOf(' (');
  return open > 0 ? text.slice(0, open) : null;
}

/**
 * Serves epic bs-optimize criterion 7: the `##`/`###` heading `heading` to the
 * next heading of the same or a higher level, else EOF. The exact heading text
 * wins; failing that, a heading whose text minus one trailing parenthetical
 * group equals the name (whitespace runs read as one space) is taken when
 * exactly one does. No prefix, substring or fuzzy match.
 */
export function sliceSection(markdown: string, heading: string): string {
  const lines = scan(markdown);
  const name = heading.trim().replace(/\s+/g, ' ');
  const exact: number[] = [];
  const named: number[] = [];
  const sections: string[] = [];
  lines.forEach((l, i) => {
    if (l.fenced) return;
    const m = HEADING_RE.exec(l.text);
    if (m === null || (m[1]?.length !== 2 && m[1]?.length !== 3)) return;
    const text = m[2] as string;
    sections.push(l.text);
    if (text === heading || text === name) exact.push(i);
    else if (withoutParenthetical(text) === name) named.push(i);
  });
  const hits = exact.length > 0 ? exact : named;
  if (hits.length === 0) {
    throw new PlaybookError('playbook.unknown-section', `playbook has no section "${heading}"`, {
      heading,
      sections,
    });
  }
  if (hits.length > 1) {
    throw new PlaybookError(
      'playbook.ambiguous-section',
      `playbook has ${hits.length} sections "${heading}"`,
      { heading, sections: hits.map((i) => (lines[i] as Line).text) },
    );
  }
  const start = hits[0] as number;
  const level = ((lines[start] as Line).text.match(/^#+/) as RegExpMatchArray)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as Line;
    const m = line.fenced ? null : HEADING_RE.exec(line.text);
    if (m !== null && (m[1] as string).length <= level) {
      end = i;
      break;
    }
  }
  return join(lines, start, end);
}
