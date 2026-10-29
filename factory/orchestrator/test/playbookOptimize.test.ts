import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { roleOfTemplateFile } from '../src/agentNames.js';
import { sliceSection, sliceWaveStep } from '../src/playbookSlice.js';
import { parseSharedRegions } from '../src/templateFragments.js';

// Epic bs-optimize criteria 5, 7, 8, 12 and 15 (doc halves): every rule the
// playbooks and role templates gained is pinned here against the real files,
// so a reworded paragraph that drops a rule fails by name.

const root = path.resolve(__dirname, '../../..');
const skillsDir = path.join(root, '.claude/skills/bs');
const agentsDir = path.join(root, '.claude/agents');

const read = (file: string): string => readFileSync(file, 'utf8');
const skill = (name: string): string => read(path.join(skillsDir, name));
const agent = (role: string): string => read(path.join(agentsDir, `bs-${role}.md`));

const wave = skill('wave.md');
const run = skill('run.md');
const dispatch = skill('dispatch.md');
const waveRunner = agent('wave-runner');

/** Collapse whitespace so a rule is matched across a hard-wrapped line break. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

/** The text from the line starting `heading` up to the next heading of any level. */
function cutHeading(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.startsWith(heading));
  expect(start, `no heading ${heading}`).toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6} /.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

const SUITE_RUNNERS = [
  'auditor',
  'coder',
  'grader',
  'merger',
  'reviewer',
  'security-reviewer',
  'spec-reviewer',
  'tester',
  'uiux',
  'verifier',
  'wave-runner',
];

describe('criterion 12: dispatch.md', () => {
  it('names `bs brief compose` as the way to build a brief and describes the D2 lessons', () => {
    const doc = flat(dispatch);
    expect(doc).toContain('`bs brief compose`');
    expect(doc).toMatch(/typed `bs-\*` agents only/i);
    expect(doc).toMatch(/recur/i);
    expect(doc).toContain('bs lessons for-dispatch --class');
  });

  it('keeps the Return discipline heading byte-identical (compose slices it)', () => {
    expect(dispatch.split('\n')).toContain('## Return discipline (agent-interviews.md M-6)');
    expect(() =>
      sliceSection(dispatch, 'Return discipline (agent-interviews.md M-6)'),
    ).not.toThrow();
  });

  it('no longer offers general-purpose as a way to dispatch a judge', () => {
    for (const file of readdirSync(skillsDir).filter((f) => f.endsWith('.md'))) {
      expect(flat(skill(file)), file).not.toMatch(/or use `general-purpose`/);
    }
  });
});

describe('criterion 12: the one-message batching rule', () => {
  const dispatching = readdirSync(skillsDir)
    .filter((f) => f.endsWith('.md'))
    .filter(
      (f) =>
        ['SKILL.md', 'waivers.md'].includes(f) ||
        /`bs-(coder|tester|grader|reviewer|verifier|planner|researcher|scribe|merger|uiux|auditor|spec-reviewer|security-reviewer|wave-runner)`/.test(
          skill(f),
        ),
    );

  it('finds the playbooks that dispatch', () => {
    for (const f of ['SKILL.md', 'run.md', 'wave.md', 'plan.md', 'audit.md', 'lessons.md']) {
      expect(dispatching).toContain(f);
    }
  });

  it.each(dispatching)('%s says independent dispatches go in one message', (file) => {
    expect(flat(skill(file))).toMatch(/independent dispatches go in one message/i);
  });
});

describe('criterion 12 and 8: wave.md', () => {
  it('puts grader, reviewer and security-reviewer in one message after the tester (step 6)', () => {
    const step = flat(sliceWaveStep(wave, 6));
    expect(step).toMatch(/one message/i);
    expect(step).toContain('bs-grader');
    expect(step).toContain('bs-reviewer');
    expect(step).toContain('bs-security-reviewer');
    expect(step).toMatch(/after the (`bs-)?tester/i);
  });

  it('runs the gate in the background and replaces every wait with a background task or Monitor', () => {
    const gate = flat(sliceWaveStep(wave, 7));
    expect(gate).toContain('run_in_background');
    expect(gate).toMatch(/while it runs, prepare/i);
    const doc = flat(wave);
    expect(doc).toContain('Monitor tool');
    expect(doc).toMatch(/never[^.]{0,80}`sleep`/);
  });

  it('routes full-suite and e2e runs through `bs heavy run` and never around a verb that takes the lock', () => {
    const doc = flat(wave);
    expect(doc).toContain('`bs heavy run --label <task-id>-<role>`');
    expect(doc).toContain('heavy-run');
    expect(doc).toMatch(/never[^.]{0,60}(wrap|around)[^.]{0,200}`bs gate run`/i);
    expect(doc).toContain('`bs integration check`');
  });

  it('documents the checks.json heavy field and its name defaults', () => {
    const doc = flat(wave);
    expect(doc).toContain('"heavy": true');
    for (const name of ['`test*`', '`unit`', '`coverage`', '`e2e*`']) {
      expect(doc, name).toContain(name);
    }
  });

  it('names a `bs playbook slice` command in every step 2-10', () => {
    for (let n = 2; n <= 10; n++) {
      expect(sliceWaveStep(wave, n), `step ${n}`).toContain(`bs playbook slice wave --step ${n}`);
    }
  });

  it('points at the two common sections by their real headings', () => {
    for (const heading of ['You own the log for what you dispatch', 'Run the whole wave at once']) {
      expect(() => sliceSection(wave, heading)).not.toThrow();
      expect(flat(wave)).toContain(`bs playbook slice wave --section "${heading}"`);
    }
  });

  it('step 10: bs queue run is a background task and a failure resumes from wave-merged events', () => {
    const step = flat(sliceWaveStep(wave, 10));
    expect(step).toMatch(/`bs queue run`[^.]{0,200}background task/);
    expect(step).toContain('run_in_background');
    expect(step).toContain('`heavy.wait-timeout`');
    expect(step).toContain('wave-merged');
    expect(step).toContain('bs event tail <session-id>');
    expect(step).toContain('tasks.json');
    expect(step).toMatch(/never re-queue/i);
    expect(step).toMatch(/nothing-to-merge/);
    expect(step).toMatch(/holder/i);
    expect(step).toContain('bs heavy status');
    expect(step).toMatch(/escalate[^.]{0,60}epic session/i);
  });
});

describe('criterion 15: the TaskStop rule', () => {
  const docs: [string, string][] = [
    ['run.md', run],
    ['wave.md', wave],
    ['bs-wave-runner.md', waveRunner],
  ];

  it.each(docs)(
    '%s stops its own tasks only, after EXIT lines, never with the lock held',
    (_n, text) => {
      const doc = flat(text);
      expect(doc).toContain('TaskStop');
      expect(doc).toContain('EXIT=<n>');
      expect(doc).toContain('bs heavy status');
      expect(doc).toMatch(/did not start/);
      expect(doc).toMatch(/idle subagents/);
    },
  );

  it('bs-wave-runner.md lists TaskStop and Monitor among its tools', () => {
    const tools = waveRunner.split('\n').find((l) => l.startsWith('tools:')) ?? '';
    expect(tools).toMatch(/\bTaskStop\b/);
    expect(tools).toMatch(/\bMonitor\b/);
  });
});

/** The blank-line-delimited paragraph that holds `TaskStop`, flattened. */
const taskStopParagraph = (text: string): string =>
  flat(text.split(/\n\s*\n/).find((p) => p.includes('TaskStop') && /EXIT=/.test(p)) ?? '');

/** Epic criterion 15: the five clauses of the TaskStop rule, in order, in one paragraph. */
const TASKSTOP_CLAUSES: RegExp[] = [
  /Use TaskStop on [^.]*own still-running background tasks and idle subagents/,
  /only once every output file the task was told to write ends with an `EXIT=<n>` line/,
  /does not hold the heavy lock \(`bs heavy status` names no holder whose label or cwd is that task's;/,
  /otherwise leave it running and say so/,
  /Never stop a task this session did not start\./,
];

describe('criterion 15: the TaskStop rule, clause by clause in one paragraph', () => {
  it.each([
    ['run.md', run],
    ['wave.md', wave],
    ['bs-wave-runner.md', waveRunner],
  ] as [string, string][])('%s carries every clause in order', (_n, text) => {
    const para = taskStopParagraph(text);
    expect(para, 'a paragraph with TaskStop and EXIT=').not.toBe('');
    let at = -1;
    for (const clause of TASKSTOP_CLAUSES) {
      const m = clause.exec(para);
      expect(m, String(clause)).not.toBeNull();
      expect(m?.index ?? -1, String(clause)).toBeGreaterThan(at);
      at = m?.index ?? -1;
    }
  });

  it('wave.md has the rule inside the step 10 cut (wave end)', () => {
    expect(taskStopParagraph(sliceWaveStep(wave, 10))).not.toBe('');
  });
});

describe('criterion 7: the wave-runner is never told to Read a PNG or a whole playbook', () => {
  it('has no imperative Read of a png, wave.md, dispatch.md or run.md', () => {
    const doc = flat(waveRunner);
    expect(doc).not.toMatch(/\bRead (the )?(`?[\w./-]*\.png`?|`?(wave|dispatch|run)\.md`?)/);
    for (const sentence of doc.split(/(?<=\.) /).filter((s) => /\bpng\b/i.test(s))) {
      expect(sentence, sentence).toMatch(/never|not|path/i);
    }
  });
});

describe('criterion 15: run.md cleanup step and rolling admission', () => {
  const at17 = run.search(/^17\. /m);
  const at18 = run.search(/^18\. /m);
  const cleanup = at18 >= 0 ? flat(run.slice(at18)) : '';

  it('adds a cleanup step after the integration-PR step', () => {
    expect(at17).toBeGreaterThan(0);
    expect(at18).toBeGreaterThan(at17);
  });

  it('fetches, dry-runs before --apply, then repeats unscoped', () => {
    expect(cleanup).toContain('git fetch --prune origin');
    const dry = cleanup.indexOf('bs cleanup --project <project-dir> --epic <epic>');
    const apply = cleanup.indexOf('--apply');
    const unscoped = cleanup.lastIndexOf('bs cleanup --project <project-dir>');
    expect(dry).toBeGreaterThanOrEqual(0);
    expect(apply).toBeGreaterThan(dry);
    expect(unscoped).toBeGreaterThan(apply);
    expect(cleanup).toMatch(/earlier epics/i);
  });

  it('reports what was removed and what was kept, and why', () => {
    expect(cleanup).toMatch(/report[^.]{0,80}removed[^.]{0,80}kept[^.]{0,40}why/i);
  });

  it('keeps the integration branch and its worktree until the PR merges', () => {
    expect(cleanup).toMatch(/integration branch[^.]{0,200}until[^.]{0,40}PR merges/i);
    expect(cleanup).toMatch(/next epic|next `bs cleanup`/i);
  });

  it('never deletes by hand: no rm, no branch -D, no force', () => {
    const step = run.slice(at18);
    expect(step).not.toMatch(/\brm\b/);
    expect(step).not.toMatch(/branch -D/);
    expect(step).not.toMatch(/--force/);
    expect(flat(step)).toMatch(/only through `bs cleanup --apply`/);
  });

  it('documents rolling admission after each merge', () => {
    const doc = flat(run);
    expect(doc).toMatch(/rolling admission/i);
    expect(doc).toMatch(/after (every|each) merge[^.]{0,120}`bs wave next`/i);
  });
});

describe('criteria 7 and 8: the wave-runner reads slices, not files', () => {
  it('reads the common sections once and one step slice per step', () => {
    const doc = flat(waveRunner);
    expect(doc).toContain('bs playbook slice wave --section');
    expect(doc).toContain('bs playbook slice wave --step');
    expect(doc).toMatch(/never the whole of `wave\.md` or `dispatch\.md`/);
  });

  it('never Reads a PNG and passes paths instead', () => {
    expect(flat(waveRunner)).toMatch(/never read (a|any) png/i);
    expect(flat(waveRunner)).toMatch(/pass(es)? (the )?paths/);
  });

  it('dispatches typed bs-* agents only', () => {
    expect(flat(waveRunner)).toMatch(/typed `bs-\*` agents only/);
  });
});

describe('criterion 12: INSTALL.md and CHANGELOG.md', () => {
  it('"Raise the concurrency caps" names the doctor warning and that bs init writes the caps', () => {
    const section = flat(
      cutHeading(read(path.join(root, 'INSTALL.md')), '#### Raise the concurrency caps'),
    );
    expect(section).toContain('`concurrency-caps`');
    expect(section).toContain('`bs doctor`');
    expect(section).toMatch(/`bs init`[^.]{0,40}writes/);
  });

  it('CHANGELOG ## Unreleased has an entry per feature', () => {
    const text = read(path.join(root, 'CHANGELOG.md'));
    const start = text.indexOf('## Unreleased');
    const end = text.indexOf('\n## ', start + 1);
    const unreleased = flat(text.slice(start, end)).toLowerCase();
    for (const feature of [
      '`bs cleanup`',
      '`bs brief compose`',
      '`bs heavy run`',
      '`bs playbook slice`',
      'rolling admission',
      '`concurrency-caps`',
      'error class',
      'one message',
    ]) {
      expect(unreleased, feature).toContain(feature.toLowerCase());
    }
  });
});

describe('criterion 12: no sleep', () => {
  const files = [
    ...readdirSync(skillsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join(skillsDir, f)),
    ...readdirSync(agentsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join(agentsDir, f)),
  ];

  it('no playbook or template tells an agent to sleep', () => {
    for (const file of files) {
      for (const paragraph of read(file).split(/\n\s*\n/)) {
        if (!/\bsleep\b/i.test(paragraph)) continue;
        expect(flat(paragraph), `${path.basename(file)}: ${paragraph.slice(0, 60)}`).toMatch(
          /\b(never|not|instead of|no)\b/i,
        );
        expect(paragraph, path.basename(file)).not.toMatch(/`sleep \d/);
      }
    }
  });
});

describe('criteria 12 and 5: the heavy-run fragment', () => {
  const fragment = () => read(path.join(root, '.claude/fragments/heavy-run.md'));

  it('holds the rule once: label form, exit 75, exclusions, scoped-run exemption', () => {
    const body = flat(fragment());
    // Unquoted on purpose: docCommands reads a bare `--` inside a code span as an empty flag.
    expect(body).toContain('bs heavy run --label <task-id>-<role> -- <cmd>');
    expect(body).toContain('`test_unit`');
    expect(body).toContain('`test_e2e`');
    expect(body).toMatch(/75/);
    expect(body).toContain('`heavy.wait-timeout`');
    expect(body).toMatch(/holder/);
    expect(body).toMatch(/not retry blind|never retry blind|do not retry blind/i);
    for (const verb of ['`bs gate run`', '`bs integration check`', '`bs queue run`']) {
      expect(body, verb).toContain(verb);
    }
    expect(body).toMatch(/scoped run[^.]{0,120}directly/i);
  });

  it('starts the run in the background and writes the exit code on a line of its own', () => {
    const body = flat(fragment());
    expect(body).toContain('`run_in_background: true`');
    expect(body).toContain(
      'bs heavy run --label <task-id>-<role> -- <cmd> > <out> 2>&1; printf \'\\nEXIT=%s\\n\' "$?" >> <out>',
    );
  });

  it('makes <out> with a foreground mktemp under state/results, not state/artifacts', () => {
    const body = flat(fragment());
    expect(body).toContain('mktemp <work-root>/state/results/<task-id>-<role>-XXXXXX');
    expect(body).toMatch(/before every start/i);
    expect(body).toMatch(/foreground call/i);
    expect(body).toMatch(/outside the worktree/i);
    expect(body).toMatch(/never `state\/artifacts\/`/);
  });

  it('waits with bs heavy wait in the foreground and says what decides calling again', () => {
    const body = flat(fragment());
    expect(body).toContain('bs heavy wait --file <out>');
    expect(body).toMatch(/waited for in the foreground|wait in the foreground/i);
    expect(body).toContain('`"done"`, not the exit code');
    expect(body).toMatch(/call it again, without re-running the command and without `sleep`/);
    expect(body).toMatch(/do not end your turn while the run is live/);
  });

  const LONG_CALL = '`bs heavy wait --file <out> --max-wait-ms 540000`';
  /** The one sentence of the flattened fragment that holds `--max-wait-ms`. */
  const steer = (): string => {
    const found = flat(fragment())
      .split('. ')
      .filter((s) => s.includes('--max-wait-ms'));
    expect(found, 'exactly one sentence holds --max-wait-ms').toHaveLength(1);
    return found[0] as string;
  };

  it('keeps the plain wait as its first wait line', () => {
    const first = fragment()
      .split('\n')
      .find((l) => l.startsWith('bs heavy wait'));
    expect(first).toBe('bs heavy wait --file <out>');
  });

  it('shows the long wait once, in one steer sentence, and no longer offers it', () => {
    const body = flat(fragment());
    expect(body).not.toMatch(/only together with/);
    expect(body.split('bs heavy wait --file <out> --max-wait-ms')).toHaveLength(2);
    expect(steer()).toContain(LONG_CALL);
  });

  it('the steer names "next" as what decides the bound, and why: every call is a turn', () => {
    const s = steer();
    expect(s).toContain('`"next"`');
    expect(s).toMatch(/every wait call is a turn/i);
    expect(s).toContain('`"holder"`');
    expect(s).toContain(LONG_CALL);
    expect(s).toMatch(/with a Bash `timeout` of 600000, never that bound without that timeout/);
  });

  it('the steer lets "next" govern the long call: "next" comes first, no "holder" before it', () => {
    const s = steer();
    const long = s.indexOf(LONG_CALL);
    expect(s.indexOf('"next"')).toBeGreaterThanOrEqual(0);
    expect(s.indexOf('"next"')).toBeLessThan(long);
    expect(s.slice(0, long)).not.toContain('"holder"');
  });

  // v6's fragment (e4341588) had 313 words, 16 of them in the offer sentence this
  // steer replaces: 313 - 16 = 297. Growing the fragment must raise this on purpose.
  const REST_WORDS = 297;
  const STEER_WORDS = 60;
  const words = (text: string): number => text.split(' ').filter((w) => w !== '').length;

  it('keeps the steer within 60 words and the rest of the fragment within 297', () => {
    const body = flat(fragment()).trim();
    const s = steer();
    expect(words(s), 'steer sentence').toBeLessThanOrEqual(STEER_WORDS);
    const rest = body
      .split('. ')
      .filter((x) => x !== s && x !== `${s}.`)
      .map(words)
      .reduce((a, b) => a + b, 0);
    expect(rest, 'rest of the fragment').toBeLessThanOrEqual(REST_WORDS);
  });

  it('stops after two not-done calls with no lock holder and reports the tail', () => {
    const body = flat(fragment());
    expect(body).toMatch(
      /Two calls in a row with `"done": false` and `"holder": null` mean the run is gone: report it with the file's tail/,
    );
  });

  const templates = readdirSync(agentsDir).filter((f) => /^bs-.*\.md$/.test(f));

  it('stamps exactly the eleven suite-running templates', () => {
    const carriers = templates
      .filter((f) =>
        parseSharedRegions(read(path.join(agentsDir, f))).some((r) => r.name === 'heavy-run'),
      )
      .map((f) => roleOfTemplateFile(f) ?? f)
      .sort();
    expect(carriers).toEqual([...SUITE_RUNNERS].sort());
  });

  it('fails when a Bash-holding template (bar planner/researcher) or one that names a suite lacks the region', () => {
    const missing: string[] = [];
    for (const f of templates) {
      const text = read(path.join(agentsDir, f));
      const role = roleOfTemplateFile(f) ?? f;
      const tools = text.split('\n').find((l) => l.startsWith('tools:')) ?? '';
      const holdsBash = /\bBash\b/.test(tools) && !['planner', 'researcher'].includes(role);
      const namesSuite = /run the suite|full suite|regression gate|test_unit|test_e2e/i.test(text);
      const has = parseSharedRegions(text).some((r) => r.name === 'heavy-run');
      if ((holdsBash || namesSuite) && !has) missing.push(role);
    }
    expect(missing).toEqual([]);
  });

  it('no template restates the rule outside its stamped region', () => {
    for (const f of templates) {
      const text = read(path.join(agentsDir, f));
      const stripped = text.replace(
        /<!-- BEGIN SHARED:heavy-run -->[\s\S]*?<!-- END SHARED:heavy-run -->/,
        '',
      );
      expect(stripped, f).not.toMatch(/bs heavy (run|wait)/);
    }
  });
});
