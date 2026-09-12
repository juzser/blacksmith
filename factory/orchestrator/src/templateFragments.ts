import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SmithError } from './errors.js';
import { AGENTS_DIR, REPO_ROOT } from './paths.js';

/**
 * Shared fragments: one paragraph, stamped into several role templates.
 *
 * Six judges carry the same read-only rule, six workers the same
 * `token_usage` paragraph, three judges the same finding-field rule. Before
 * this module each copy was hand-maintained, and the copies had drifted —
 * the same rule in three wordings, one of them a sentence short. The fix is
 * not a template include: an agent template is what Claude Code reads
 * *verbatim* as a system prompt, so the text has to be *in* the file. So the
 * fragment is the source, the template carries a stamped copy inside a fence,
 * and a test holds every fence byte-equal to its fragment. Editing the
 * paragraph means editing the fragment and re-running the sync — editing one
 * copy fails the gate by name.
 */
export class TemplateFragmentsError extends SmithError {}

/**
 * Where the fragments live. Deliberately not a `paths.ts` export: everything
 * anchored on `REPO_ROOT` there must ship in the npm package (packaging
 * test), and the fragments are dev-time source — the templates carry the
 * stamped text, and nothing the CLI runs at an operator's desk reads this
 * directory.
 *
 * And deliberately not `.claude/agents/_shared/`: Claude Code's agent loader
 * recurses into `.claude/agents/`, so a fragment there with front matter
 * registers as an agent and one without is skipped silently — neither is a
 * fragment. `.claude/fragments/` is a directory the loader does not watch.
 */
export const FRAGMENTS_DIR = path.join(REPO_ROOT, '.claude', 'fragments');

/** A fragment name is its file's basename; the fence names it the same way. */
export const FRAGMENT_NAME = /^[a-z][a-z0-9-]*$/;

const BEGIN_FENCE = /^<!-- BEGIN SHARED:(\S+) -->$/;
const END_FENCE = /^<!-- END SHARED:(\S+) -->$/;

export function beginFence(name: string): string {
  return `<!-- BEGIN SHARED:${name} -->`;
}

export function endFence(name: string): string {
  return `<!-- END SHARED:${name} -->`;
}

export interface SharedRegion {
  name: string;
  /** 0-based line index of the BEGIN fence. */
  start: number;
  /** 0-based line index of the END fence. */
  end: number;
  /** The lines strictly between the fences, newline-terminated (`''` when empty). */
  body: string;
}

/**
 * Every `<!-- BEGIN SHARED:x -->` … `<!-- END SHARED:x -->` region in a
 * template, in file order. Fences are whole lines, so a fence quoted inside
 * a sentence is prose, not a region. Regions do not nest: a BEGIN inside a
 * region and an END with no open region are both errors, as is an END that
 * names a different fragment than the BEGIN it closes — the fence pair is the
 * unit the sync rewrites, and a mismatched pair has no single body to rewrite.
 */
export function parseSharedRegions(text: string, file = '<template>'): SharedRegion[] {
  const lines = text.split('\n');
  const regions: SharedRegion[] = [];
  let open: { name: string; start: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const begin = BEGIN_FENCE.exec(line);
    if (begin) {
      const name = begin[1] as string;
      if (open) {
        throw new TemplateFragmentsError(
          'fragments.nested-fence',
          `${file}:${i + 1}: BEGIN SHARED:${name} opens inside SHARED:${open.name} (opened at line ${open.start + 1}); regions do not nest.`,
          { file, line: i + 1, name, open: open.name },
        );
      }
      assertFragmentName(name, `${file}:${i + 1}`);
      open = { name, start: i };
      continue;
    }
    const end = END_FENCE.exec(line);
    if (end) {
      const name = end[1] as string;
      if (!open || open.name !== name) {
        throw new TemplateFragmentsError(
          'fragments.unbalanced-fence',
          open
            ? `${file}:${i + 1}: END SHARED:${name} closes SHARED:${open.name} (opened at line ${open.start + 1}).`
            : `${file}:${i + 1}: END SHARED:${name} has no open BEGIN.`,
          { file, line: i + 1, name, open: open?.name ?? null },
        );
      }
      const between = lines.slice(open.start + 1, i);
      regions.push({
        name,
        start: open.start,
        end: i,
        body: between.length === 0 ? '' : `${between.join('\n')}\n`,
      });
      open = null;
    }
  }
  if (open) {
    throw new TemplateFragmentsError(
      'fragments.unbalanced-fence',
      `${file}:${open.start + 1}: BEGIN SHARED:${open.name} is never closed.`,
      { file, line: open.start + 1, name: open.name, open: open.name },
    );
  }
  return regions;
}

function assertFragmentName(name: string, where: string): void {
  if (!FRAGMENT_NAME.test(name)) {
    throw new TemplateFragmentsError(
      'fragments.invalid-fragment-name',
      `${where}: ${JSON.stringify(name)} is not a fragment name (expected ${FRAGMENT_NAME}).`,
      { name, where },
    );
  }
}

/**
 * The fragments in a directory, by name. Every `.md` file there is a
 * fragment and its basename is the name — the directory holds nothing else,
 * so a README or a draft dropped in it fails by name rather than stamping
 * itself into a template that asks for it.
 */
export function listFragments(dir = FRAGMENTS_DIR): Map<string, string> {
  const fragments = new Map<string, string>();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  for (const file of files) {
    const name = path.basename(file, '.md');
    assertFragmentName(name, path.join(dir, file));
    fragments.set(name, readFileSync(path.join(dir, file), 'utf8'));
  }
  return fragments;
}

export interface StampedRegion {
  name: string;
  /** True when the region's body did not already equal the fragment. */
  drifted: boolean;
}

export interface StampResult {
  text: string;
  regions: StampedRegion[];
}

/**
 * Rewrite every fenced region so its body equals the named fragment. The
 * fences stay; only the lines between them change. Stamping a template that
 * is already in sync returns it byte-for-byte, which is what lets the sync
 * script run on every template without a diff to explain.
 */
export function stampFragments(
  text: string,
  fragments: ReadonlyMap<string, string>,
  file = '<template>',
): StampResult {
  const regions = parseSharedRegions(text, file);
  const lines = text.split('\n');
  const out: string[] = [];
  const stamped: StampedRegion[] = [];
  let cursor = 0;
  for (const region of regions) {
    const fragment = fragments.get(region.name);
    if (fragment === undefined) {
      throw new TemplateFragmentsError(
        'fragments.unknown-fragment',
        `${file}:${region.start + 1}: SHARED:${region.name} names no file under the fragments directory (have: ${[...fragments.keys()].join(', ') || 'none'}).`,
        { file, line: region.start + 1, name: region.name, known: [...fragments.keys()] },
      );
    }
    out.push(...lines.slice(cursor, region.start + 1));
    if (fragment !== '') out.push(...fragment.replace(/\n$/, '').split('\n'));
    out.push(lines[region.end] as string);
    cursor = region.end + 1;
    stamped.push({ name: region.name, drifted: region.body !== fragment });
  }
  out.push(...lines.slice(cursor));
  return { text: out.join('\n'), regions: stamped };
}

export interface SyncOptions {
  agentsDir?: string;
  fragmentsDir?: string;
  /** Write the stamped text back. Default false: report only. */
  write?: boolean;
}

export interface SyncReport {
  /** Every fragment name the directory holds. */
  fragments: string[];
  /** Per template (basename), the regions it carries. */
  templates: { file: string; regions: StampedRegion[] }[];
  /** `{file, name}` for every region whose body differed from its fragment. */
  drifted: { file: string; name: string }[];
  /** Fragments no template stamps — a fragment with no reader is a stale file. */
  unused: string[];
  /** Template basenames rewritten (empty unless `write`). */
  written: string[];
}

/**
 * Stamp every fragment into every role template. Reads the templates
 * non-recursively, the same set `scripts/check.sh` validates, so a file in a
 * subdirectory is neither a template here nor an agent there.
 */
export function syncTemplates(opts: SyncOptions = {}): SyncReport {
  const agentsDir = opts.agentsDir ?? AGENTS_DIR;
  const fragments = listFragments(opts.fragmentsDir ?? FRAGMENTS_DIR);
  const used = new Set<string>();
  const report: SyncReport = {
    fragments: [...fragments.keys()],
    templates: [],
    drifted: [],
    unused: [],
    written: [],
  };
  const files = readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
  for (const file of files) {
    const templatePath = path.join(agentsDir, file);
    const before = readFileSync(templatePath, 'utf8');
    const { text, regions } = stampFragments(before, fragments, templatePath);
    report.templates.push({ file, regions });
    for (const region of regions) {
      used.add(region.name);
      if (region.drifted) report.drifted.push({ file, name: region.name });
    }
    if (opts.write && text !== before) {
      writeFileSync(templatePath, text, 'utf8');
      report.written.push(file);
    }
  }
  report.unused = report.fragments.filter((name) => !used.has(name));
  return report;
}
