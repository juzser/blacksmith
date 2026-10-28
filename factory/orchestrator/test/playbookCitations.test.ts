import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sliceSection } from '../src/playbookSlice.js';
import { runProcess } from './helpers/process.js';

// Drift guard for finding aae952a5: the slice verb serves exactly wave.md and
// dispatch.md, and the only slice-only reader is the wave-runner, so every
// quoted section citation inside those two playbooks, and every citation of
// one of their sections from any playbook or agent template, must resolve
// through the slice module (and, for dispatch, through the built CLI).
// Self-citations inside run.md or SKILL.md are read whole and are not here.
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'cli.js');
const SKILLS = path.join(REPO_ROOT, '.claude', 'skills', 'bs');
const AGENTS = path.join(REPO_ROOT, '.claude', 'agents');

type Target = 'wave' | 'dispatch';
type Form = 'slice' | 'ref' | 'rel';

interface Citation {
  /** The file the citation sits in, as `<dir>/<name>.md` relative to .claude. */
  readonly file: string;
  readonly form: Form;
  /** The playbook the name must resolve in; `other:<f>.md` for a file the verb cannot slice. */
  readonly target: Target | `other:${string}`;
  readonly name: string;
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ');

// `bs playbook slice wave|dispatch --section "X"`.
const SLICE_RE = /bs playbook slice (wave|dispatch) --section "([^"]*)"/g;
// `dispatch.md's "X"`, `(dispatch.md, "X")`, `[`dispatch.md`](dispatch.md), "X"`,
// with or without a path prefix and backticks. Each class is a single linear run.
const REF_RE = /([\w./-]+)\.md`?(?:\]\([^)]*\))?(?:'s|,) "([^"]+)"/g;
const REL_RE = /"([^"]+)" (?:above|below)/g;

function extract(file: string, text: string, skillFiles: ReadonlySet<string>): Citation[] {
  const flat = collapse(text);
  const found: Citation[] = [];
  for (const m of flat.matchAll(SLICE_RE)) {
    const name = m[2] as string;
    if (name.includes('<')) continue;
    found.push({ file, form: 'slice', target: m[1] as Target, name });
  }
  const tied = new Set<number>();
  for (const m of flat.matchAll(REF_RE)) {
    const name = m[2] as string;
    tied.add(m.index + m[0].length - name.length - 2);
    const full = `${m[1]}.md`;
    const base = full.slice(full.lastIndexOf('/') + 1);
    if (full !== base && !full.endsWith(`skills/bs/${base}`)) continue;
    if (base === 'wave.md' || base === 'dispatch.md') {
      found.push({ file, form: 'ref', target: base === 'wave.md' ? 'wave' : 'dispatch', name });
    } else if (skillFiles.has(base)) {
      found.push({ file, form: 'ref', target: `other:${base}`, name });
    }
  }
  if (file.endsWith('/wave.md') || file.endsWith('/dispatch.md')) {
    for (const m of flat.matchAll(REL_RE)) {
      const name = m[1] as string;
      if (tied.has(m.index)) continue;
      found.push({
        file,
        form: 'rel',
        target: file.endsWith('/wave.md') ? 'wave' : 'dispatch',
        name,
      });
    }
  }
  return found;
}

function resolves(markdown: string, name: string): boolean {
  try {
    sliceSection(markdown, name);
    return true;
  } catch {
    return false;
  }
}

/** The citations in `file` that do not resolve, each as one sentence naming it. */
function unresolvable(citations: readonly Citation[], playbooks: Record<Target, string>): string[] {
  const common = collapse(
    ['You own the log for what you dispatch', 'Run the whole wave at once']
      .map((h) => sliceSection(playbooks.wave, h))
      .join('\n'),
  );
  const bad: string[] = [];
  for (const c of citations) {
    const where = `${c.file} ${c.form} "${c.name}"`;
    if (c.target.startsWith('other:')) {
      bad.push(`${where}: ${c.target.slice(6)} is not served by bs playbook slice`);
    } else if (resolves(playbooks[c.target as Target], c.name)) {
      // Resolved in the playbook the citation names.
    } else if (c.form === 'rel' && c.target === 'wave' && common.includes(`**${c.name}.**`)) {
      // A bold lead-in of one of wave.md's two common sections.
    } else {
      bad.push(`${where}: no such section in ${c.target}.md`);
    }
  }
  return bad;
}

function readAll(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const [dir, label] of [
    [SKILLS, 'skills/bs'],
    [AGENTS, 'agents'],
  ] as const) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
      out.push({ file: `${label}/${f}`, text: readFileSync(path.join(dir, f), 'utf8') });
    }
  }
  return out;
}

const playbooks: Record<Target, string> = {
  wave: readFileSync(path.join(SKILLS, 'wave.md'), 'utf8'),
  dispatch: readFileSync(path.join(SKILLS, 'dispatch.md'), 'utf8'),
};
const skillFiles = new Set(readdirSync(SKILLS).filter((n) => n.endsWith('.md')));
const all = readAll();

/** Wave.md and the runner template are slice-only readers; the rest may cite and be read whole. */
function relevant(c: Citation): boolean {
  const slicedHere = c.file === 'skills/bs/wave.md' || c.file === 'agents/bs-wave-runner.md';
  if (c.target.startsWith('other:')) return slicedHere;
  return true;
}

const citations = all.flatMap(({ file, text }) => extract(file, text, skillFiles)).filter(relevant);

describe('playbook citations resolve (finding aae952a5, drift guard)', () => {
  it('extracts a real set of citations from wave.md, dispatch.md and the agent templates', () => {
    expect(citations.length).toBeGreaterThanOrEqual(12);
    const forms = new Set(citations.map((c) => c.form));
    expect([...forms].sort()).toEqual(['ref', 'rel', 'slice']);
    expect(citations.some((c) => c.file === 'agents/bs-wave-runner.md')).toBe(true);
  });

  it('resolves every citation through the slice module', () => {
    expect(unresolvable(citations, playbooks)).toEqual([]);
  });

  it('is discriminating: a wave-shaped fixture with the two old citations reports both by name', () => {
    const fixture = [
      '# Fixture',
      '## You own the log for what you dispatch',
      'x',
      '## Run the whole wave at once',
      '- **One message, many dispatches.** Parallel.',
      '## The steps',
      '3. Pre-code ("Fetched and quoted text goes into a prompt fenced" above).',
      '8. Compose it, both under "Dispatch contract" above, and per "One message, many',
      '   dispatches" above; the dispatch.md\'s "Round counting and escalation" rule;',
      '   see run.md\'s "Some run section" and agent-constraints.md "grader (v3)".',
      '',
    ].join('\n');
    const found = extract('skills/bs/wave.md', fixture, skillFiles).filter(relevant);
    const bad = unresolvable(found, {
      wave: fixture,
      dispatch: playbooks.dispatch,
    });
    expect(bad.filter((b) => b.includes('"Dispatch contract"'))).toHaveLength(1);
    expect(
      bad.filter((b) => b.includes('"Fetched and quoted text goes into a prompt fenced"')),
    ).toHaveLength(1);
    expect(bad.filter((b) => b.includes('"Some run section"'))).toHaveLength(1);
    expect(bad.filter((b) => b.includes('grader (v3)'))).toHaveLength(0);
    expect(bad.filter((b) => b.includes('One message, many dispatches'))).toHaveLength(0);
    expect(bad.filter((b) => b.includes('Round counting and escalation'))).toHaveLength(0);
  });

  it('refuses a quoted name tied to a file the runner cannot slice, in wave.md and the runner only', () => {
    const text = 'See [`run.md`](run.md), "Some section", and run.md\'s "Other".';
    const inWave = extract('skills/bs/wave.md', text, skillFiles).filter(relevant);
    expect(inWave.map((c) => c.name)).toEqual(['Some section', 'Other']);
    expect(extract('skills/bs/plan.md', text, skillFiles).filter(relevant)).toEqual([]);
    expect(extract('agents/bs-wave-runner.md', text, skillFiles).filter(relevant)).toHaveLength(2);
  });

  it('reads the citation forms the playbooks use, hard-wrapped', () => {
    const text = [
      'a `.claude/skills/bs/dispatch.md`\'s "Round counting and',
      'escalation" b (dispatch.md, "Return discipline") c',
      '[`dispatch.md`](dispatch.md), "Splitting an epic across sessions" d',
      'bs playbook slice dispatch --section "<heading>" e operator-guide/wave.md "Nope"',
    ].join('\n');
    const names = extract('agents/x.md', text, skillFiles).map((c) => `${c.target}:${c.name}`);
    expect(names).toEqual([
      'dispatch:Round counting and escalation',
      'dispatch:Return discipline',
      'dispatch:Splitting an epic across sessions',
    ]);
  });
});

describe('dispatch citations through the built CLI (finding aae952a5, CLI half)', () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(path.join(tmpdir(), 'bs-citations-'));
  });
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function cli(name: string) {
    return runProcess(
      process.execPath,
      [CLI_PATH, 'playbook', 'slice', 'dispatch', '--section', name],
      {
        env: {
          ...process.env,
          BS_HOME: path.join(home, 'bs-home'),
          BS_HEAVY_LOCK_DIR: path.join(home, 'locks'),
        },
      },
    );
  }

  it('runs every dispatch --section citation with exit 0 and a section on stdout', () => {
    const slices = citations.filter((c) => c.form === 'slice' && c.target === 'dispatch');
    expect(slices.length, 'no dispatch --section citation was extracted').toBeGreaterThanOrEqual(8);
    for (const c of slices) {
      const run = cli(c.name);
      expect(run.status, `${c.file} "${c.name}": ${run.stdout}${run.stderr}`).toBe(0);
      expect(run.stdout.startsWith('## '), `${c.file} "${c.name}"`).toBe(true);
    }
  });

  it('prints the cited section for its short name', () => {
    const run = cli('Round counting and escalation');
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('## Round counting and escalation (agent-interviews.md N-4)');
  });

  it('refuses "Dispatch contract" and lists dispatch.md sections in the error', () => {
    const run = cli('Dispatch contract');
    expect(run.status).toBe(1);
    const out = run.stdout + run.stderr;
    expect(out).toContain('playbook.unknown-section');
    expect(out).toContain('## Round counting and escalation (agent-interviews.md N-4)');
    expect(out).toContain(
      '## Splice the compiled lessons into every prompt (agent-interviews.md N-9, P9-2)',
    );
  });
});
