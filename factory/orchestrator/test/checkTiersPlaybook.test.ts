import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type ProposalItem, validateDecisions } from '../src/tierProposals.js';
import { REPO_ROOT, runCli } from './helpers/cliHarness.js';
import { git } from './helpers/process.js';

// Epic bs-check-tiers task-11: the playbooks and operator docs run the tiers.
// Prose is a contract here: every anchor is a label or a sentence the playbook
// states, never a command another line also carries, and the fixture at the
// bottom drives the commands the playbook writes against the built binary.

const RUN = '.claude/skills/bs/run.md';
const WAVE = '.claude/skills/bs/wave.md';
const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();
const run = read(RUN);
const wave = read(WAVE);

/** The text of numbered step `n`: from its `n. ` line to the next numbered step. */
function stepText(text: string, n: number): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${n}. `));
  expect(start, `step ${n}`).toBeGreaterThanOrEqual(0);
  const after = lines.slice(start + 1).findIndex((l) => /^\d+\. /.test(l));
  return lines.slice(start, after < 0 ? undefined : start + 1 + after).join('\n');
}

const indentOf = (l: string): number => l.length - l.trimStart().length;

/** One-based-free line offset of the single line that carries `label`; refuses a label used twice. */
function offsetOf(text: string, label: string): number {
  expect(text.split(label).length - 1, `${label} occurs once`).toBe(1);
  return text.split('\n').findIndex((l) => l.includes(label));
}

/** A labelled item: its label's line to the first blank line or line at or left of the bullet. */
function itemEnd(text: string, label: string): number {
  const lines = text.split('\n');
  const at = offsetOf(text, label);
  const bullet = indentOf(lines[at] as string);
  let end = at;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i] as string;
    if (l.trim() === '' || indentOf(l) <= bullet) break;
    end = i;
  }
  return end;
}
function itemText(text: string, label: string): string {
  const at = offsetOf(text, label);
  return flat(
    text
      .split('\n')
      .slice(at, itemEnd(text, label) + 1)
      .join('\n'),
  );
}

/** The post-merge block: its lead-in to the next column-0 line starting `**` or `#`. */
function postMergeBlock(): string {
  const lines = run.split('\n');
  const start = lines.findIndex((l) => l.startsWith('**Post-merge and held tasks.**'));
  if (start < 0) return '';
  const rel = lines.slice(start + 1).findIndex((l) => /^(\*\*|#)/.test(l));
  return lines.slice(start, rel < 0 ? undefined : start + 1 + rel).join('\n');
}

/** Inline code spans, line breaks joined; fenced blocks are removed first so backticks pair up. */
const spansOf = (text: string): string[] =>
  [...flat(text.replace(/```[\s\S]*?```/g, ' ')).matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);

describe('wave.md', () => {
  const step7 = stepText(wave, 7);
  const step8 = stepText(wave, 8);
  const step9 = stepText(wave, 9);
  const step10 = stepText(wave, 10);

  it('step 7 still states that the unit check is the full test command', () => {
    expect(flat(step7)).toMatch(/unit check must be the project's full test command/);
    expect(flat(step7)).toMatch(/in whatever tier the full suite sits/);
  });

  it('step 8 lists only the pre-merge checks in a tiered brief and names the deferred ones', () => {
    expect(flat(step8)).toMatch(
      /tiered checks file the composed brief lists only the pre-merge checks the gate runs and names the deferred ones/,
    );
  });

  it('step 10 passes --checks beside --test-cmd and says the post-merge batch is the epic session', () => {
    const t = flat(step10);
    const queue = spansOf(step10).find((s) => s.startsWith('bs queue run'));
    expect(queue).toContain('--checks');
    expect(queue).toContain('--test-cmd');
    expect(t).toContain('--select-test-cmd');
    expect(t).toMatch(/keeps today's command for an unlabelled file/);
    expect(t).toMatch(/runs neither command[^.]*without refusing either flag/);
    expect(t).toMatch(/post-merge batch is the epic session's, never the runner's/);
    expect(t).toMatch(/runner never admits/);
  });

  it('step 9 reopens a reverted task with the revert in the brief and hands refusals up once', () => {
    const t = flat(step9);
    expect(t).toContain(
      'bs worktree create <project> <epic> <task> --reopen --revert <revert-sha>',
    );
    for (const k of ['failing_checks', 'log_tail', 'red_record_event_id', 'wave-reverted'])
      expect(t, k).toContain(k);
    expect(t).toMatch(/S2 ladder/);
    for (const code of [
      'worktree.reopen-dirty',
      'worktree.reopen-not-ancestor',
      'worktree.reopen-revert-not-on-integration',
      'worktree.reopen-revert-conflict',
    ])
      expect(t, code).toContain(code);
    expect(t).toMatch(/hands the refusal to the operator once/);
    expect(t).toMatch(/supersedes the task with one cut from the integration head/);
  });

  it('never tells the operator to drop --select-test-cmd', () => {
    expect(flat(wave)).not.toMatch(/drop `--select-test-cmd`/i);
  });

  it('writes every bs wave check command with --session, --checks and --project', () => {
    for (const [name, text] of [
      [RUN, run],
      [WAVE, wave],
    ] as const) {
      for (const span of spansOf(text)) {
        if (!/^bs wave check\s+\S/.test(span)) continue;
        for (const flag of ['--session', '--checks', '--project'])
          expect(span, `${name}: ${span}`).toContain(flag);
      }
    }
    expect(spansOf(run).some((s) => /^bs wave check\s+\S/.test(s))).toBe(true);
  });

  it('adds no numbered line beyond steps 2 to 10', () => {
    const nums = [...wave.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(nums).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('run.md post-merge and held tasks', () => {
  const block = postMergeBlock();
  const t = flat(block);
  const OUTCOMES = [
    'green',
    'reverted',
    'no-checks-in-tier',
    'no-new-merges',
    'batch-not-ready',
    'setup-failed',
    'lock-timeout',
    'env-failure',
    'not-reproduced',
    'red-at-base',
    'batch-has-foreign-commit',
    'revert-has-dependents',
    'revert-recorded',
    'revert-not-applicable',
    'revert-conflict',
    'revert-red',
    'integration-dirty',
    'integration-moved',
  ];
  const PROCEED = ['green', 'reverted', 'no-checks-in-tier', 'no-new-merges', 'batch-not-ready'];
  const labels = ['**(a)**', '**(b)**', '**(c)**', '**(d)**'];

  it('starts the batch in the background with --setup-cmd, never --specs-dir, never under bs heavy run', () => {
    expect(block, 'the **Post-merge and held tasks.** block').not.toBe('');
    const commands = spansOf(block).filter(
      (s) => s.startsWith('bs checks post-merge') && s.includes('--epic'),
    );
    expect(commands.length).toBeGreaterThanOrEqual(2);
    const start = commands.find((s) => !s.includes('--held')) as string;
    expect(start).toContain('--setup-cmd');
    for (const flag of ['--project', '--checks', '--plan ', '--plan-version', '--causal-parent'])
      expect(start, flag).toContain(flag);
    expect(t).not.toContain('--specs-dir');
    for (const c of commands) expect(c, c).toContain('--session');
    expect(t).toContain('run_in_background');
    expect(t).toContain('; echo EXIT=$?');
    expect(t).toMatch(/completion notification or the Monitor tool/);
    expect(t).toMatch(/never wrapped in `bs heavy run`/);
  });

  it('writes the four steps as labelled bullets, each label once, in order, no numbered list', () => {
    const offsets = labels.map((l) => offsetOf(run, l));
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
    const start = run.split('\n').findIndex((l) => l.startsWith('**Post-merge and held tasks.**'));
    const end = start + block.split('\n').length;
    for (const o of offsets) {
      expect(o).toBeGreaterThan(start);
      expect(o).toBeLessThan(end);
    }
    for (const l of labels)
      expect(
        run
          .split('\n')
          .find((x) => x.includes(l))
          ?.startsWith(`- ${l}`),
        l,
      ).toBe(true);
    for (const line of block.split('\n')) expect(line).not.toMatch(/^\s*\d+\. /);
  });

  it('item (a) starts the batch, (b) reads the hold, (c) admits what is not held', () => {
    const a = itemText(run, '**(a)**');
    expect(a).toContain('bs checks post-merge');
    expect(a).toContain('--setup-cmd');
    expect(a).toContain('run_in_background');
    const b = itemText(run, '**(b)**');
    expect(b).toContain('bs checks post-merge --held');
    expect(b).toContain('bs wave next');
    expect(b).toContain('--session');
    const c = itemText(run, '**(c)**');
    expect(c).toMatch(
      /[Aa]dmit at once every task `bs wave next` returns that `--held` does not list/,
    );
  });

  it('item (d) admits held tasks after a proceed outcome, by the re-read of --held', () => {
    const d = itemText(run, '**(d)**');
    for (const o of PROCEED) expect(d, o).toContain(`\`${o}\``);
    expect(d).toContain('bs checks post-merge --held');
    expect(d).toContain('bs wave next');
    expect(d).toMatch(/no longer lists/);
    expect(d).toMatch(/re-read of `--held`, not the outcome, decides/);
    expect(d).toMatch(
      /after `no-new-merges` it admits what an earlier call's record already certified/,
    );
  });

  it('keeps the pinned phrases and says they apply to every task --held does not list', () => {
    expect(t).toMatch(/'right away' and 'at once'[^.]*apply to every task `--held` does not list/);
    expect(t).toContain('wave.held-by-post-merge');
    expect(t).toContain('wave.checks-required');
    expect(t).toMatch(/`wave check` line without `--checks`/);
    expect(t).toMatch(/epic whose records use tiers/);
  });

  it('names every outcome and handles each one', () => {
    for (const o of OUTCOMES) expect(t, o).toContain(`\`${o}\``);
    const sentences = t.split(/(?<=\.)\s/);
    const naming = sentences.filter(
      (s) =>
        s.includes('`no-checks-in-tier`') &&
        s.includes('`no-new-merges`') &&
        s.includes('`batch-not-ready`'),
    );
    const none = naming.find((s) => /no batch was due and nothing ran/.test(s));
    expect(none, 'a sentence that names the three and says nothing ran').toBeDefined();
    expect(none).toMatch(/[Oo]nly `green` means the post-merge tier ran and passed/);
    expect(none).toMatch(/ever reported as a passed tier/);
    expect(t).toMatch(/`reverted`[^.]*logs[^.]*re-admit/);
    expect(t).toContain('`execution.env-failure`');
    expect(t).toContain('`execution.flaky-test`');
    expect(t).toMatch(/second[^.]*at the same head[^.]*operator/);
    expect(t).toMatch(/`revert-recorded`[^.]*operator/);
  });

  it('reports promotions entries once and names the three ways out of not-in-live-plan', () => {
    expect(t).toContain('`promotions`');
    expect(t).toMatch(/`promotion-skipped` and `declared-tier-wins`[^.]*`result`/);
    expect(t).toMatch(/never outcomes|not outcomes/);
    const way = t.split(/(?<=\.)\s/).find((s) => s.includes('`not-in-live-plan`')) as string;
    expect(way).toMatch(/amendment that re-adds the task/);
    expect(way).toMatch(/amendment adding a task that fixes the defect/);
    expect(way).toMatch(/edit to the failing check/);
    expect(way).toMatch(/no waiver/);
  });

  it('adds no approve button and no dashboard action', () => {
    expect(t).not.toMatch(/button|dashboard/i);
    expect(flat(stepText(run, 12))).not.toMatch(/button|dashboard/i);
  });

  it('keeps the pinned rolling-admission sentences word for word', () => {
    const r = flat(run);
    expect(r).toContain('admit what it returns right away');
    expect(r).toContain('and admit what it returns at once, as a wave of its own');
  });
});

describe('run.md step 12', () => {
  const step12 = stepText(run, 12);
  const f12 = flat(step12);
  const lines = run.split('\n');

  /** A fenced command as the playbook writes it: continuation lines joined. */
  function commandLine(prefix: string): string {
    const at = lines.findIndex((l) => l.trim().startsWith(prefix));
    expect(at, prefix).toBeGreaterThanOrEqual(0);
    let out = (lines[at] as string).trim();
    for (let i = at + 1; out.endsWith('\\'); i++)
      out = `${out.slice(0, -1).trim()} ${(lines[i] as string).trim()}`;
    return out;
  }

  it('asks the proposals with the envelope flags', () => {
    const c = commandLine('bs checks proposals');
    for (const flag of ['--epic', '--session', '--plan-version', '--causal-parent', '--checks'])
      expect(c, flag).toContain(flag);
  });

  it('asks one question for the whole batch and states the reply grammar', () => {
    expect(f12).toMatch(/ONE question for the whole batch/);
    expect(f12).toMatch(/`answered_in_epic` is false/);
    expect(f12).toMatch(/`<n><letter>`/);
    expect(f12).toContain('`1b 3c`');
    expect(f12).toContain('`none`');
    expect(f12).toMatch(/`a` is keep/);
    expect(f12).toMatch(/runs covered, minutes spent and minutes saved/);
    expect(f12).toMatch(/unparseable reply decides nothing/);
    expect(f12).toMatch(/no answer changes nothing/);
    expect(f12).toMatch(/at most twice/);
  });

  it('goes on to --final without asking when proposals exits 1', () => {
    expect(f12).toMatch(
      /exits 1[^.]*`checks\.overlay-busy`[^.]*once[^.]*goes on to `--final` without asking/,
    );
  });

  it('labels the three apply lines, each once, in order', () => {
    const offs = ['**Apply.**', '**Re-run.**', '**Hand-off.**'].map((l) => offsetOf(run, l));
    expect([...offs].sort((a, b) => a - b)).toEqual(offs);
    expect(itemText(run, '**Apply.**')).toContain('bs checks apply');
    const rerun = itemText(run, '**Re-run.**');
    expect(rerun).toMatch(
      /refused with `items`[^.]*reports each item and its reason to the operator/,
    );
    expect(rerun).toMatch(/same decisions minus those items/);
    expect(rerun).toMatch(/guardrails win over a reply/);
    expect(rerun).toMatch(/never asked twice/);
    const hand = itemText(run, '**Hand-off.**');
    expect(hand).toMatch(/`items: \[\]`/);
    expect(hand).toMatch(/second refusal/);
    expect(hand).toMatch(/decisions\.json path/);
    expect(hand).toMatch(/--hand-off <refusal-code>/);
    expect(hand).toMatch(/`answered_in_epic` true/);
  });

  it('writes the three apply items as column-0 bullets', () => {
    for (const l of ['**Apply.**', '**Re-run.**', '**Hand-off.**'])
      expect(
        lines.filter((x) => x.startsWith(`- ${l} `)),
        l,
      ).toHaveLength(1);
  });

  it('gives one instruction on what an exit 1 means: only a red check, named outcomes follow their own rules', () => {
    expect(f12).not.toMatch(/An exit 1 from either means the assembled branch is broken/);
    expect(f12).toMatch(
      /Only a red check outcome[^.]*(any refusal[^.]*not named)[^.]*means the assembled branch is broken/,
    );
    expect(f12).toMatch(/named outcomes[^.]*follow their own rules/);
  });

  it('runs --final, then --tier remaining, then verdict and close with --checks', () => {
    const handEnd = itemEnd(run, '**Hand-off.**');
    const lineAfter = (from: number, pred: (l: string) => boolean): number => {
      const at = lines.findIndex((l, i) => i > from && pred(l));
      expect(at).toBeGreaterThan(from);
      return at;
    };
    const fin = lineAfter(handEnd, (l) => l.includes('bs checks post-merge --final'));
    const rem = lineAfter(
      fin,
      (l) => l.includes('bs integration check') && l.includes('--tier remaining'),
    );
    const ver = lineAfter(rem, (l) => l.includes('bs epic verdict'));
    const close = lineAfter(ver, (l) => l.includes('bs epic close'));
    expect([fin, rem, ver, close].sort((a, b) => a - b)).toEqual([fin, rem, ver, close]);
    const own = (s: string) => step12.split('\n').filter((l) => l.includes(s)).length;
    expect(own('bs checks post-merge --final')).toBe(1);
    expect(
      step12
        .split('\n')
        .filter((l) => l.includes('bs integration check') && l.includes('--tier remaining')),
    ).toHaveLength(1);
    expect(commandLine('bs epic verdict')).toContain('--checks');
    expect(commandLine('bs epic close')).toContain('--checks');
  });

  it('goes on to the verdict after integration.nothing-remaining and stops on any other refusal', () => {
    expect(f12).toMatch(
      /refuses with `integration\.nothing-remaining`[^.]*every check is already certified at the head[^.]*goes on to `bs epic verdict` and `bs epic close`/,
    );
    expect(f12).toMatch(/any other refusal stops the close/);
  });
});

describe('the decisions.json example', () => {
  const items = (): ProposalItem[] =>
    [
      ['3f9a0c1d2b4e5f60', 'e2e'],
      ['5d4c3b2a19087f6e', 'lint'],
      ['8b7c6d5e4f3a2b1c', 'unit'],
    ].map(
      ([proposal_id, check]) =>
        ({
          proposal_id,
          check,
          cmd_sha256: 'x',
          from_tier: 'pre-merge',
          options: ['pre-merge', 'post-merge', 'pre-release'].map((to_tier) => ({
            to_tier,
            runs_covered: 26,
            minutes_spent: 124.8,
            minutes_saved: 0,
            basis: {},
          })),
          flake_rate: 0,
          importance: 0,
          real_catches: 0,
          evidence_event_ids: [],
        }) as unknown as ProposalItem,
    );

  /** The playbook's D7 reading of a reply: `<n><letter>` tokens or `none`; any fault decides nothing. */
  function decisionsOf(reply: string, pending: ProposalItem[]): unknown[] | null {
    const tokens = reply.trim().split(/\s+/);
    if (tokens.length === 1 && tokens[0] === 'none') return [];
    const seen = new Set<number>();
    const out: unknown[] = [];
    for (const token of tokens) {
      const m = /^(\d+)([a-z])$/.exec(token);
      if (m === null) return null;
      const n = Number(m[1]);
      const item = pending[n - 1];
      const option = item?.options[m[2]?.charCodeAt(0) ? (m[2] as string).charCodeAt(0) - 97 : -1];
      if (item === undefined || option === undefined || seen.has(n)) return null;
      seen.add(n);
      out.push(
        m[2] === 'a'
          ? { proposal_id: item.proposal_id, check: item.check, decision: 'decline' }
          : {
              proposal_id: item.proposal_id,
              check: item.check,
              decision: 'approve',
              to_tier: option.to_tier,
            },
      );
    }
    return out;
  }

  const example = (): unknown => {
    const m = /```json\n([\s\S]*?)```/.exec(stepText(run, 12));
    expect(m, 'a json example in step 12').not.toBeNull();
    return JSON.parse((m as RegExpExecArray)[1] as string);
  };

  it('is what the grammar example 1b 3c becomes, and passes validateDecisions', () => {
    const decisions = decisionsOf('1b 3c', items());
    expect(example()).toEqual(decisions);
    expect(validateDecisions(example(), items())).toEqual([]);
  });

  it('decides nothing for a parse failure, an unknown item or letter, or a repeated item', () => {
    for (const reply of ['1', 'b1', '1b,3c', '9b', '1z', '1b 1c', '1b maybe'])
      expect(decisionsOf(reply, items()), reply).toBeNull();
    expect(decisionsOf('none', items())).toEqual([]);
    expect(decisionsOf('2a', items())).toEqual([
      { proposal_id: '5d4c3b2a19087f6e', check: 'lint', decision: 'decline' },
    ]);
  });
});

describe('the operator docs', () => {
  const queue = read('docs/guide/operator-guide/queue-and-gate.md');
  const closing = read('docs/guide/operator-guide/closing-an-epic.md');
  const section = (text: string, heading: RegExp): string => {
    const lines = text.split('\n');
    const at = lines.findIndex((l) => heading.test(l));
    expect(at, String(heading)).toBeGreaterThanOrEqual(0);
    const rel = lines.slice(at + 1).findIndex((l) => /^##? /.test(l) || /^### \d/.test(l));
    return flat(lines.slice(at, rel < 0 ? undefined : at + 1 + rel).join('\n'));
  };

  it('queue-and-gate §5 documents tier, its values, the default and the overlay', () => {
    const t = section(queue, /^## 5\./);
    expect(t).toContain('"tier"');
    for (const v of ['pre-merge', 'post-merge', 'pre-release']) expect(t, v).toContain(v);
    expect(t).toMatch(/[Aa]bsent[^.]*pre-merge/);
    expect(t).toMatch(/empty file/);
    expect(t).toContain('.blacksmith/check-tiers.json');
    for (const k of ['declared', 'shadowed', 'orphaned']) expect(t, k).toContain(k);
    expect(t).toContain('check-tiers-scope.md');
  });

  it('closing-an-epic §7a documents per-tier close and the refusal without --checks', () => {
    const t = section(closing, /^## 7a\./);
    expect(t).toContain('--tier remaining');
    expect(t).toMatch(/`bs epic close` without `--checks`/);
    expect(t).toMatch(/one blocker that asks for `--checks`/);
    expect(t).toContain('integration.nothing-remaining');
  });

  it('the scope doc says each part shipped', () => {
    expect(read('docs/specs/check-tiers-scope.md')).not.toContain('Status: planned.');
  });

  it('CHANGELOG has one Unreleased entry naming every piece', () => {
    const log = read('CHANGELOG.md');
    expect(log.split('- **Check tiers**').length - 1).toBe(1);
    const at = log.indexOf('- **Check tiers**');
    const rest = log.slice(at + 1);
    const end = rest.search(/\n- \*\*|\n### |\n## /);
    const entry = flat(rest.slice(0, end < 0 ? undefined : end));
    expect(log.indexOf('## Unreleased')).toBeLessThan(at);
    for (const re of [
      /`tier`/,
      /overlay/,
      /queue/,
      /post-merge batch/,
      /per-tier close/i,
      /ledger/,
      /one question/,
      /lists only the pre-merge checks/,
      /scaffold[^.]*CI|CI[^.]*scaffold/,
    ])
      expect(entry, String(re)).toMatch(re);
  });
});

// The commands step 12 writes, run against the built binary on a fixture this file builds.
describe('step 12 re-entry after a refusal', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'smith-tiers-playbook-')));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const project = path.join(root, 'project');
  const specs = path.join(root, 'specs');
  const state = path.join(root, 'state');
  const checks = path.join(project, 'checks.json');
  const S = 'sess-s';
  const EPIC = 'epic-t';

  /** The one-line command the playbook writes for a verb, placeholders filled from the fixture. */
  function filled(span: string, fill: Record<string, string>): string[] {
    let s = span;
    for (const [k, v] of Object.entries(fill)) s = s.split(`<${k}>`).join(v);
    expect(s, 'unfilled placeholder').not.toMatch(/<[a-z.-]+>/);
    const parts = s.split(/\s+/);
    expect(parts[0]).toBe('bs');
    return [...parts.slice(1), '--state-dir', state];
  }
  const json = (r: { stdout: string; stderr: string }): Record<string, unknown> =>
    JSON.parse(r.stdout) as Record<string, unknown>;

  it('refuses {} before the lock, hands off as the playbook writes it, and then asks no more', () => {
    mkdirSync(project, { recursive: true });
    git(project, ['init', '-q', '-b', 'main']);
    git(project, ['config', 'user.email', 't@example.com']);
    git(project, ['config', 'user.name', 't']);
    writeFileSync(checks, `${JSON.stringify([{ name: 'unit', cmd: 'true', heavy: false }])}\n`);
    git(project, ['add', 'checks.json']);
    git(project, ['commit', '-q', '-m', 'checks']);

    const start = runCli(['session', 'start', S, '--state-dir', state]);
    expect(start.status, start.stdout + start.stderr).toBe(0);
    mkdirSync(path.join(specs, EPIC), { recursive: true });
    const plan = path.join(specs, EPIC, 'plan.json');
    writeFileSync(
      plan,
      JSON.stringify({
        epic_id: EPIC,
        version: 1,
        status: 'active',
        project: 'proj',
        tasks: [
          {
            task_id: `${EPIC}/task-1`,
            epic_id: EPIC,
            plan_version: 1,
            objective: 'Do the thing.',
            output_schema_ref: 'result.schema.json',
            acceptance_criteria: ['it works'],
            claims: ['src/x.ts'],
            budget: { tokens: 1000, diff_lines: 100 },
            contract: { functional_clauses: ['do it'], nonfunctional_clauses: [] },
            case: 'feature',
            origin: 'user',
            task_status: 'todo',
          },
        ],
        edges: [],
      }),
    );
    const ingest = runCli([
      'plan',
      'ingest',
      plan,
      '--session',
      S,
      '--plan-version',
      '1',
      '--causal-parent',
      `${S}#0`,
      '--state-dir',
      state,
    ]);
    expect(ingest.status, ingest.stdout + ingest.stderr).toBe(0);
    const ingestId = (JSON.parse(ingest.stdout) as { event_id?: string }).event_id;
    expect(ingestId, ingest.stdout).toMatch(/^sess-s#\d+$/);

    const fill = {
      epic: EPIC,
      'project-dir': project,
      'specs-dir': specs,
      'checks.json': checks,
      'session-id': S,
      n: '1',
      'event-id': ingestId as string,
    };
    const decisions = path.join(root, 'decisions.json');
    writeFileSync(decisions, '{}');

    const apply = spansOf(itemText(run, '**Apply.**')).find((s) => s.startsWith('bs checks apply'));
    const refused = runCli(filled(apply as string, { ...fill, 'decisions.json': decisions }));
    expect(refused.status, refused.stdout + refused.stderr).toBe(1);
    const out = json(refused) as { error: { code: string }; items: unknown[] };
    expect(out.error.code).toBe('checks.decisions-not-array');
    expect(out.items).toEqual([]);

    const hand = spansOf(itemText(run, '**Hand-off.**')).find(
      (s) => s.startsWith('bs checks apply') && s.includes('--hand-off'),
    );
    const handed = runCli(
      filled(hand as string, {
        ...fill,
        'decisions.json': decisions,
        'refusal-code': out.error.code,
      }),
    );
    expect(handed.status, handed.stdout + handed.stderr).toBe(0);
    expect(Object.keys(json(handed))).toEqual(['event_id']);

    const proposals = commandOf('bs checks proposals');
    const later = runCli(filled(proposals, fill));
    expect(later.status, later.stdout + later.stderr).toBe(0);
    expect(json(later).answered_in_epic).toBe(true);
  });

  function commandOf(prefix: string): string {
    const l = run.split('\n');
    const at = l.findIndex((x) => x.trim().startsWith(prefix));
    let out = (l[at] as string).trim();
    for (let i = at + 1; out.endsWith('\\'); i++)
      out = `${out.slice(0, -1).trim()} ${(l[i] as string).trim()}`;
    return out;
  }
});
