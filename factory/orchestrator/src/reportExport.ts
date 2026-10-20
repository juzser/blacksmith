// Pure helpers for the opt-in Markdown export of `/bs report` and `bs stats`.
// No filesystem, network or os import: the running user's home directory is a
// parameter, and every renderer takes plain data and redacts every string it
// emits.

export interface RedactOptions {
  homeDir: string;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One path segment: stops at a separator, whitespace or a quote character.
const SEG = '[^/\\\\\\s"\'`]+';
const SEP = '(?:\\\\\\\\|\\\\|/)';
// A path form must not continue an earlier path or a `<placeholder>`, which is
// what keeps the redactor idempotent and leaves `repo/tmp/x` alone.
const START = '(?<![A-Za-z0-9._~<>-])';

const HOME_FORMS = [
  `[A-Za-z]:${SEP}Users${SEP}${SEG}`,
  `/Users/${SEG}`,
  `/home/${SEG}`,
  '/root(?![A-Za-z0-9._-])',
];
const TMP_FORMS = ['/private/tmp/', '/tmp/', '/var/folders/', '/private/var/folders/'].map(
  (root) => `${escapeRegExp(root)}[^\\s"'\`]*`,
);
const SLUG_FORM = '-(?:Users|home)-[^\\s/"\'`]*';

function buildPattern(homeDir: string): RegExp {
  const home = homeDir.replace(/[\\/]+$/, '');
  const injected = home === '' ? [] : [`${escapeRegExp(home)}(?![A-Za-z0-9._-])`];
  const homeAlt = [...injected, ...HOME_FORMS].join('|');
  // The named groups tell the replacer which placeholder applies.
  return new RegExp(
    `(?<slug>${SLUG_FORM})|${START}(?:(?<tmp>${TMP_FORMS.join('|')})|${homeAlt})`,
    'g',
  );
}

/**
 * Replaces home-directory and temp paths with stable placeholders: `<home>`
 * (rest of the path kept), `<home-slug>` (a dash-encoded slug, whole token),
 * `<tmp>` (through the end of the path). Other paths and `~/x` are kept.
 */
export function redact(text: string, { homeDir }: RedactOptions): string {
  return text.replace(buildPattern(homeDir), (...args) => {
    const groups = args[args.length - 1] as { slug?: string; tmp?: string };
    if (groups.slug !== undefined) return '<home-slug>';
    if (groups.tmp !== undefined) return '<tmp>';
    return '<home>';
  });
}

export type CheckState = 'passed' | 'failed' | 'not-run' | 'unknown';

const STATE_LABELS: Record<CheckState, string> = {
  passed: 'passed',
  failed: 'failed',
  'not-run': 'not run',
  unknown: 'unknown',
};

/** A check with no event is "not run"; anything unreadable is "unknown". */
export function renderCheckState(state: CheckState | null | undefined): string {
  if (state === undefined || state === null) return STATE_LABELS['not-run'];
  return Object.hasOwn(STATE_LABELS, state) ? STATE_LABELS[state] : STATE_LABELS.unknown;
}

export interface MetricRow {
  label: string;
  value: number | null | undefined;
  unit?: string;
}

export interface CheckRow {
  task: string;
  check: string;
  state?: CheckState | null;
  detail?: string;
}

export const NOT_MEASURED = 'NOT MEASURED';

const cell = (text: string, opts: RedactOptions): string =>
  redact(text, opts)
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|');

function table(title: string, header: string[], rows: string[][], opts: RedactOptions): string {
  const line = (cols: string[]): string => `| ${cols.join(' | ')} |`;
  return [
    `## ${cell(title, opts)}`,
    '',
    line(header),
    line(header.map(() => '---')),
    ...rows.map(line),
    '',
  ].join('\n');
}

export function renderMetricsTable(title: string, rows: MetricRow[], opts: RedactOptions): string {
  return table(
    title,
    ['Metric', 'Value'],
    rows.map((r) => {
      const measured = typeof r.value === 'number' && Number.isFinite(r.value);
      const value = measured ? `${r.value}${r.unit ? ` ${r.unit}` : ''}` : NOT_MEASURED;
      return [cell(r.label, opts), cell(value, opts)];
    }),
    opts,
  );
}

export function renderChecksTable(title: string, rows: CheckRow[], opts: RedactOptions): string {
  return table(
    title,
    ['Task', 'Check', 'State', 'Detail'],
    rows.map((r) => {
      const cols = [r.task, r.check, renderCheckState(r.state), r.detail ?? ''];
      return cols.map((c) => cell(c, opts));
    }),
    opts,
  );
}
