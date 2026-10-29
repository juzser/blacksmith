import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PaperworkReason, SCREENSHOT_RE, STAGES_FOR_ROLE } from '../src/paperwork.js';
import { AGENTS_DIR, REPO_ROOT } from '../src/paths.js';
import { loadTaxonomy } from '../src/taxonomy.js';
import { parseSharedRegions } from '../src/templateFragments.js';
import type { CheckEnvironment } from '../src/testgate.js';
import { COMMANDS, flagSpecFor } from '../src/usage.js';
import { runCli } from './helpers/cliHarness.js';
import { type CodeSpan, codeSpans } from './helpers/instructionSurface.js';
import { graderFile, graderVerdictBody, stampedResult } from './helpers/paperworkFixtures.js';

// The workers run their own role's `bs results check` line before hand-off,
// and the wave-runner runs `--as gate` before `gate run`. These tests pin the
// prose that says so, and parse every example line against usage.ts so a
// renamed flag fails here rather than in a worker's hands.

const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const agent = (role: string): string =>
  readFileSync(path.join(AGENTS_DIR, `bs-${role}.md`), 'utf8');
const SHARED = /<!-- BEGIN SHARED:([a-z-]+) -->[\s\S]*?<!-- END SHARED:\1 -->\n?/g;
const outsideShared = (text: string): string => text.replace(SHARED, '');
const WORK_ROOT_ARTIFACTS = '<work-root>/state/artifacts';

/** Flags of one command line, name to its value tokens joined (empty for a bare flag). */
function flagsOfLine(line: string): Map<string, string> {
  const flags = new Map<string, string>();
  let current: string | undefined;
  for (const token of line.split(/\s+/)) {
    if (token.startsWith('--')) {
      current = token.slice(2);
      flags.set(current, '');
    } else if (current !== undefined) {
      flags.set(current, `${flags.get(current)} ${token}`.trim());
    }
  }
  return flags;
}

function lineStarting(text: string, prefix: string): CodeSpan {
  const found = codeSpans(text)
    .map((s) => ({ ...s, text: s.text.trim() }))
    .filter((s) => s.text.startsWith(prefix));
  expect(found.length, `no code span starts with "${prefix}"`).toBeGreaterThan(0);
  return found[0] as CodeSpan;
}

function expectParses(line: string, as: string): Map<string, string> {
  const flags = flagsOfLine(line);
  const spec = flagSpecFor('results', 'check');
  expect(spec).toBeDefined();
  for (const name of flags.keys())
    expect(spec?.has(name), `--${name} is not in usage.ts`).toBe(true);
  expect(flags.get('as')).toBe(as);
  return flags;
}

describe('worker templates run the role preflight before hand-off', () => {
  const roles = {
    coder: ['result', 'agent', 'provider', 'model-tier', 'worktree', 'base', 'artifacts-dir'],
    tester: ['result', 'agent', 'provider', 'model-tier', 'plan', 'artifacts-dir'],
    grader: ['grader', 'artifacts-dir'],
  } as const;

  for (const [role, expected] of Object.entries(roles)) {
    describe(role, () => {
      const text = agent(role);

      it('carries the handback-preflight SHARED region', () => {
        expect(parseSharedRegions(text).map((r) => r.name)).toContain('handback-preflight');
      });

      it('says to run the briefed line last, fix, re-run to exit 0, quote the output, never work around', () => {
        const fragment = read('.claude/fragments/handback-preflight.md');
        expect(fragment).toMatch(/last step before (you )?return/);
        expect(fragment).toMatch(/`bs results check <task-id> --as <role>`/);
        expect(fragment).toMatch(/Fix every problem/);
        expect(fragment).toMatch(/re-run it until it exits 0/);
        expect(fragment).toMatch(/quote its final output in the result `notes`/);
        expect(fragment).toMatch(/in `notes` as it stands/);
        expect(fragment).toMatch(/never work around/);
        expect(fragment).toMatch(/no such line, say so in `notes`/);
        expect(fragment).toMatch(/runs no test/);
      });

      it('gives the role line, parsed against usage.ts, with the shared artifacts dir', () => {
        const line = lineStarting(outsideShared(text), `bs results check <task-id> --as ${role}`);
        const flags = expectParses(line.text, role);
        expect([...flags.keys()].filter((k) => k !== 'as')).toEqual([...expected]);
        expect(flags.get('artifacts-dir')).toBe(WORK_ROOT_ARTIFACTS);
        expect(line.text).not.toMatch(/\b(test|vitest|pnpm)\b/);
      });

      it('puts the preflight before the return line', () => {
        const preflight = text.indexOf('BEGIN SHARED:handback-preflight');
        const ret = text.indexOf('Return one line');
        expect(preflight).toBeGreaterThan(0);
        expect(ret).toBeGreaterThan(preflight);
      });
    });
  }

  it('bs-grader.md fixes shape only and never a verdict', () => {
    const text = outsideShared(agent('grader')).replace(/\s+/g, ' ');
    expect(text).toMatch(/preflight checks the shape of the grader file only/);
    expect(text).toMatch(/well-formed `fail` verdict exits 0 and shows in `verdicts\.grader`/);
    expect(text).toMatch(
      /never change a verdict, a criterion's status or its evidence to get a clean preflight/,
    );
    expect(text).toMatch(/where the verdict sits, a missing criterion field, the round number/);
  });
});

describe('coder and tester run every gate check whole at hand-back', () => {
  for (const role of ['coder', 'tester']) {
    it(`bs-${role}.md names the whole-project commands, exit codes and the heavy rule`, () => {
      const text = outsideShared(agent(role)).replace(/\s+/g, ' ');
      expect(text).toMatch(/run every check command the gate will run/i);
      expect(text).toMatch(/over the whole project, never a scoped path/);
      for (const cmd of ['`typecheck`', '`typecheck:test`', 'a lint of the whole repo']) {
        expect(text).toContain(cmd);
      }
      expect(text).toMatch(/report each exit code/);
      expect(text).toMatch(
        /full test command[^.]*heavy-run section[^.]*background[^.]*waited for in the foreground/,
      );
      // The section is referenced, never restated (playbookOptimize pins the same).
      expect(text).not.toMatch(/bs heavy (run|wait)/);
      expect(text).toMatch(/lint and type checks are not heavy and run directly/i);
      expect(text).toMatch(/Heavy checks/);
    });
  }

  it('no template wraps a lint or type check in bs heavy run or shows a scoped lint', () => {
    for (const file of ['coder', 'tester', 'grader', 'reviewer', 'wave-runner', 'merger']) {
      const text = outsideShared(agent(file));
      for (const span of codeSpans(text)) {
        expect(span.text, `${file}:${span.line}`).not.toMatch(
          /^bs heavy run\b.* -- .*(biome|typecheck|lint|tsc)/,
        );
        expect(span.text, `${file}:${span.line}`).not.toMatch(
          /biome\s+check\s+(?!\.(\s|$))(?!-)\S/,
        );
      }
    }
  });
});

describe('bs-tester.md screenshot rule', () => {
  const text = agent('tester');
  const constraints = text.slice(
    text.indexOf('- Screenshots for every UI-affecting task'),
    text.indexOf('- Touch-target measurement'),
  );
  const artifactsPara = text.slice(
    text.indexOf('- `artifacts` —'),
    text.indexOf('Also set `diff_lines_changed`'),
  );
  const RULE = '`<name>-<desktop|mobile>-<light|dark>.png`';

  it('states the suffix rule in both places and offers no fallback', () => {
    for (const [name, passage] of [
      ['constraints', constraints],
      ['artifacts', artifactsPara],
    ] as const) {
      expect(passage.length, name).toBeGreaterThan(100);
      expect(passage.replace(/\s+/g, ' '), name).toContain(RULE);
      const prose = passage.replace('[{type, path, description?}]', '').replace(/\s+/g, ' ');
      expect(prose, name).not.toMatch(/description|describe|failing that/i);
    }
  });

  it('the stated rule and every example filename match SCREENSHOT_RE', () => {
    for (const viewport of ['desktop', 'mobile']) {
      for (const theme of ['light', 'dark']) {
        expect(SCREENSHOT_RE.test(`shots/login-${viewport}-${theme}.png`)).toBe(true);
      }
    }
    const names = text.match(/[\w/.<>|-]+\.png/g) ?? [];
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      const concrete = n.replace('<desktop|mobile>', 'desktop').replace('<light|dark>', 'dark');
      expect(SCREENSHOT_RE.test(concrete), n).toBe(true);
    }
  });

  it('binds e2e servers to port 0 and stops only recorded PIDs', () => {
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toMatch(/port 0/);
    expect(flat).toMatch(/stop only the PIDs you recorded/);
  });
});

describe('wave.md', () => {
  const wave = read('.claude/skills/bs/wave.md');
  const step = (n: number): string => {
    const start = wave.search(new RegExp(`^${n}\\. `, 'm'));
    const next = wave.search(new RegExp(`^${n + 1}\\. `, 'm'));
    expect(start, `step ${n}`).toBeGreaterThan(0);
    return wave.slice(start, next === -1 ? undefined : next);
  };

  it('keeps steps 2 to 10', () => {
    for (let n = 2; n <= 10; n++) expect(wave).toMatch(new RegExp(`^${n}\\. `, 'm'));
  });

  it('one --artifacts-dir value on the record, gate, gate-preflight and per-role lines', () => {
    const lines = [
      lineStarting(step(5), 'bs results record --task'),
      lineStarting(step(7), 'bs gate run <task-id>'),
      lineStarting(step(7), 'bs results check <task-id> --as gate'),
      lineStarting(step(8), 'bs results check <task-id> --as coder'),
      lineStarting(step(8), 'bs results check <task-id> --as tester'),
      lineStarting(step(8), 'bs results check <task-id> --as grader'),
    ];
    for (const line of lines) {
      expect(flagsOfLine(line.text).get('artifacts-dir'), line.text).toBe(WORK_ROOT_ARTIFACTS);
    }
    expect(wave.replace(/\s+/g, ' ')).toMatch(
      /explicit because without it the home follows the caller's work root, which for an installed `bs` sits under its working directory/,
    );
  });

  it('per-role lines parse against usage.ts', () => {
    for (const role of ['coder', 'tester', 'grader']) {
      expectParses(lineStarting(step(8), `bs results check <task-id> --as ${role}`).text, role);
    }
  });

  it('step 7 preflight carries every flag of the gate line, and the gate line carries the envelope flags', () => {
    const gate = flagsOfLine(lineStarting(step(7), 'bs gate run <task-id>').text);
    const check = expectParses(
      lineStarting(step(7), 'bs results check <task-id> --as gate').text,
      'gate',
    );
    for (const [name, value] of gate) expect(check.get(name), `--${name}`).toBe(value);
    for (const name of ['agent', 'provider', 'model-tier']) {
      expect(gate.has(name), `gate --${name}`).toBe(true);
      expect(flagsOfLine(lineStarting(step(5), 'bs results record --task').text).has(name)).toBe(
        true,
      );
    }
  });

  it('step 7 says a grader fail or not-graded does not stop gate run, and bounces a failing preflight', () => {
    const s = step(7).replace(/\s+/g, ' ');
    expect(s).toMatch(/`verdicts\.grader` of `fail` or `not-graded` is not a preflight problem/);
    expect(s).toMatch(/does not stop `gate run`/);
    // The old rule sent any problem back to its worker with no `gate run`, so no
    // round was counted; step 7 now routes each problem through five branches.
    expect(s).not.toMatch(/bounces the problem to the worker whose file it names/);
    expect(s).not.toMatch(/and does not call `gate run`/);
  });

  it("step 7's stage list follows the gate's real order", () => {
    const s = step(7).replace(/\s+/g, ' ');
    const order = [
      ...STAGES_FOR_ROLE.gate.map((stage) => stage),
      'tests',
      'coverage',
      'findings',
      'severity',
    ];
    const words: Record<string, string> = {
      schema: 'schema check',
      artifacts: 'artifact check',
      commit: 'commit check',
      deps: 'deps check',
      judges: 'outstanding-judge check',
      uiux: 'uiux check',
      grader: 'grader verdict',
      tests: 'tests',
      coverage: 'coverage evidence',
      findings: 'findings intake',
      severity: 'severity decision',
    };
    const start = s.indexOf(words.schema as string);
    expect(start).toBeGreaterThan(0);
    let at = start;
    for (const stage of order) {
      const i = s.indexOf(words[stage] as string, at);
      expect(i, stage).toBeGreaterThanOrEqual(at);
      at = i;
    }
  });

  it('step 9 handles env-failure without a bounce, a re-run or a rung reset', () => {
    const s = step(9).replace(/\s+/g, ' ');
    expect(s).toMatch(/`error-logged` with error `execution\.env-failure`/);
    expect(s).toMatch(/raises no finding against the coder/);
    expect(s).toMatch(/not bounced to the coder/);
    expect(s).toMatch(/does not re-run the gate on its own/);
    expect(s).toMatch(/epic session decides whether and when to re-gate/);
    expect(s).toMatch(
      /second env-classified block for the same task at the same HEAD goes to the operator/,
    );
    expect(s).toMatch(/failed round on the escalation ladder/);
    expect(s).toMatch(/`readFailedRounds`/);
    expect(s).toMatch(/bare re-gate only after the first failed round/);
    expect(s).toMatch(/higher-tier builder dispatch from the second/);
    expect(s).toMatch(/operator from the third/);
    expect(s).toMatch(/never resets, skips or exempts a rung/);
    expect(s).toMatch(
      /"no coder bounce" means no finding against the coder and no fix-round brief[^.]*`checkModelTierRung` and `checkOperatorRung`/,
    );
  });
});

describe('queue-and-gate.md section 5 and the CHANGELOG', () => {
  const doc = read('docs/guide/operator-guide/queue-and-gate.md').replace(/\s+/g, ' ');

  it('documents bs results check, its modes and stage sets', () => {
    expect(doc).toContain('`bs results check`');
    for (const [role, stages] of Object.entries(STAGES_FOR_ROLE)) {
      expect(doc, role).toContain(`--as ${role}`);
      expect(doc, role).toContain(stages.join(', '));
    }
    expect(doc).toMatch(/never runs a check command/);
    expect(doc).toMatch(/exit 0 for a pass and 1 for blocked or refused/);
    expect(doc).toMatch(/same `--artifacts-dir`/);
  });

  it('documents the env-failure classification and the port-0 gap', () => {
    expect(doc).toContain('`execution.env-failure`');
    expect(doc).toContain('`SLEEP_GAP_MS`');
    expect(doc).toMatch(/command-only window/);
    expect(doc).toMatch(/load is evidence only/i);
    expect(doc).toMatch(/lock-wait timeout never classifies/);
    expect(doc).toMatch(/outcome stays `blocked`/);
    expect(doc).toMatch(/failed round on the escalation ladder/);
    expect(doc).toMatch(/port 0[^.]*prompt-level rule with no run-time check/);
  });

  it('the CHANGELOG names every task of the epic under Unreleased', () => {
    const log = read('CHANGELOG.md');
    const unreleased = log.slice(log.indexOf('## Unreleased'));
    for (const id of [
      'task-1-paperwork-validators',
      'task-2-results-check-verb',
      'task-3-testgate-env-evidence',
      'task-4-handback-preflight-playbooks',
      'task-5-deterministic-named-tests',
      'task-6-gate-block-counts-toward-class',
      'task-7-close-review-fixes',
    ]) {
      expect(unreleased, id).toContain(id);
    }
  });
});

describe('wave.md step 7 routes every preflight problem to one of five branches', () => {
  const wave = read('.claude/skills/bs/wave.md');
  const step7 = wave.slice(wave.search(/^7\. /m), wave.search(/^8\. /m));
  const flat = step7.replace(/\s+/g, ' ');
  // The numbered items under "The preflight comes first", by branch number.
  const items = new Map<number, string>();
  const marks = [...step7.matchAll(/^ {5}([1-5])\. \*\*/gm)];
  marks.forEach((m, i) => {
    const end = marks[i + 1]?.index ?? step7.indexOf('One preflight result can hold');
    items.set(Number(m[1]), step7.slice(m.index, end).replace(/\s+/g, ' '));
  });

  // The compiler ties this map to the type: a new reason without a branch fails to build.
  const REASON_BRANCH = {
    'deps-missing': 1,
    'judges-outstanding': 2,
    'uiux-spec-missing': 2,
    'uiux-visual-missing': 2,
    'schema-invalid': 3,
    'artifacts-missing': 3,
    'not-committed': 3,
    'screenshots-missing': 3,
    'screenshots-stale': 3,
    'grader-invalid': 3,
  } satisfies Record<PaperworkReason, 1 | 2 | 3>;
  const INPUT_BRANCH: Record<string, number> = {
    artifacts: 1,
    checks: 1,
    findings: 1,
    lessons: 1,
    plan: 1,
    'judge-dispatch': 1,
    grader: 2,
    evidence: 2,
    'uiux-visual': 2,
    'judge-artifact': 2,
    result: 4,
    'judge-internal': 5,
    paperwork: 5,
  };

  it('has the five branches', () => {
    expect([...items.keys()]).toEqual([1, 2, 3, 4, 5]);
  });

  it.each(Object.entries(REASON_BRANCH))(
    'puts the reason %s in branch %i only',
    (reason, branch) => {
      const holders = [...items]
        .filter(([, text]) => text.includes(`\`${reason}\``))
        .map(([n]) => n);
      expect(holders).toEqual([branch]);
    },
  );

  it.each(Object.entries(INPUT_BRANCH))('puts the input %s in branch %i only', (input, branch) => {
    const holders = [...items].filter(([, text]) => text.includes(`\`${input}\``)).map(([n]) => n);
    expect(holders).toEqual([branch]);
  });

  it('sends an input the list does not name to the epic session', () => {
    expect(items.get(5)).toMatch(/or one this list does not name/);
    expect(items.get(5)).toMatch(/goes to the epic session and never to an agent/);
    expect(items.get(5)).toMatch(/not a round/);
  });

  it('makes the line match the example before it reads the problems', () => {
    expect(flat).toMatch(/match the example above flag for flag \(the envelope flags included/);
    expect(flat).toMatch(/an `error` document or a difference is its own line to fix/);
  });

  it('branch 1 and 2 are not rounds; branch 3 is a counted gate run round', () => {
    expect(items.get(1)).toMatch(/not a round/);
    expect(items.get(2)).toMatch(/A judge's turn is not a ladder round/);
    expect(items.get(3)).toMatch(/Run `gate run` with the same flags/);
    expect(items.get(3)).toMatch(/before any check command runs/);
    expect(items.get(3)).toMatch(/blocked `gate-outcome` that `readFailedRounds` counts/);
    expect(items.get(3)).toMatch(/step 9's/);
  });

  it('branch 4 logs one error-logged with its fields and returns the result at most once', () => {
    const four = items.get(4) as string;
    expect(four).toMatch(/`gate run` would throw on it before it writes any event/);
    expect(four).toMatch(/so do not run it/);
    for (const field of ['task_id', 'task_ref', 'agent', 'agent_role']) {
      expect(four, field).toContain(`\`${field}\``);
    }
    expect(four).toMatch(/`error` `contract\.schema-violation`/);
    expect(four).toMatch(/`severity` `S3-minor`/);
    expect(four).toMatch(/`detail` that names the input and the reason/);
    expect(four).toMatch(/at most once per task/);
    expect(four).toMatch(
      /builder `dispatch_decision`[^.]*`causal_parent` is that `error-logged` event/,
    );
    expect(four).toMatch(/`continuation_of`/);
    expect(four).toMatch(
      /second `result` problem on the same task goes to the epic session, which returns it no more without the operator's answer/,
    );
  });

  it('settles intake problems first and sends a stage reason of branch 3 to gate run only without one', () => {
    expect(flat).toMatch(
      /first every `intake` problem, by its branch \(5 stops the task and goes to the epic session; then 1; then 2; then 4\); then the stage reasons of branches 1 and 2/,
    );
    expect(flat).toMatch(/run the preflight again after each step/);
    expect(flat).toMatch(
      /A stage reason of branch 3 goes to `gate run` only when the preflight shows no `intake` problem/,
    );
    expect(flat).toMatch(
      /it throws, and writes no `gate-outcome`, while any `intake` problem shows/,
    );
    expect(flat).toMatch(
      /neither a list nor a grader document shows both `judge-artifact` and `grader-invalid`; it takes branch 2 and is never sent to `gate run`/,
    );
  });

  it('breaks a tie toward the worker', () => {
    expect(flat).toMatch(
      /the line or a worker could have caused[^.]*is the worker's: branch 3 if it carries a stage, branch 4 if it is an `intake` problem/,
    );
  });

  it('applies the ladder unchanged to every builder dispatch these branches make', () => {
    expect(flat).toMatch(
      /Every dispatch these branches make for a builder role \(coder, tester or uiux\), a branch-4 return or a re-run uiux pass included, is a builder dispatch like any other, and the ladder applies to it unchanged/,
    );
    expect(flat).toMatch(
      /second blocked `gate-outcome`[^;]*strictly higher model tier[^;]*\(`checkModelTierRung`\)/,
    );
    expect(flat).toMatch(
      /no builder dispatch and no gate round goes out before an operator answer \(`checkOperatorRung`\)/,
    );
  });

  it('returns a file to an agent only in branches 2, 3 and 4', () => {
    expect(step7).not.toMatch(/bounces the problem/);
    expect(flat.replace(items.get(3) as string, '')).not.toMatch(/\bbounce\b/i);
  });

  it('leaves steps 2 to 10 and the step 9 text as they are', () => {
    for (let n = 2; n <= 10; n++) expect(wave).toMatch(new RegExp(`^${n}\\. `, 'm'));
    expect(wave).toMatch(
      /9\. Gate outcome `blocked` → bounce to the coder on the \*\*same branch\*\*/,
    );
  });
});

describe('the flags each mode takes, as the code accepts them', () => {
  const doc = read('docs/guide/operator-guide/queue-and-gate.md').replace(/\s+/g, ' ');
  const summary = (COMMANDS.find((c) => c.command === 'results check')?.summary ?? '').replace(
    /\s+/g,
    ' ',
  );

  it('usage.ts says coder and tester take the envelope flags, all three take --artifacts-dir', () => {
    expect(summary).toMatch(
      /--as coder and --as tester also take \[--agent --provider --model-tier\], --as grader refuses them/,
    );
    expect(summary).toMatch(
      /all three take \[--artifacts-dir\] \(under --as grader it only sets the reported artifact_home, because the grader stage reads no artifact\)/,
    );
    expect(summary).not.toMatch(/each also takes \[--agent/);
  });

  it('queue-and-gate.md says the same', () => {
    expect(doc).toMatch(
      /`--as coder` and `--as tester` also take `--agent --provider --model-tier`; `--as grader` refuses them/,
    );
    expect(doc).toMatch(/All three worker modes take `--artifacts-dir`/);
    expect(doc).toMatch(
      /Under `--as grader` the flag only sets the reported `artifact_home`, because the grader stage reads no artifact/,
    );
    expect(doc).toMatch(/`skipped` keeps the `artifacts` stage as `not-checked-for-grader`/);
    expect(doc).not.toMatch(/Each worker mode also takes/);
  });

  it('bs-grader.md says once, outside its SHARED regions, why the line carries the flag', () => {
    const text = outsideShared(agent('grader')).replace(/\s+/g, ' ');
    expect(text).toMatch(
      /The line carries `--artifacts-dir` so that every preflight line in a wave shares one value\. The grader stage reads no artifact, so the preflight prints a warning that says the flag only sets the reported `artifact_home`\. That warning is expected, it is not a problem to fix, and the flag stays on your line\./,
    );
    expect(text.match(/That warning is expected/g)).toHaveLength(1);
    expect(text).not.toMatch(/\b(pnpm|npm|vitest|biome|jest|pytest)\b/);
    const line = lineStarting(
      outsideShared(agent('grader')),
      'bs results check <task-id> --as grader',
    );
    expect(flagsOfLine(line.text).get('artifacts-dir')).toBe(WORK_ROOT_ARTIFACTS);
  });

  it('queue-and-gate.md documents input, the five branches and the precedence', () => {
    expect(doc).toMatch(/Every `intake` problem the output lists[^.]*carries `input`/);
    for (const input of [
      'result',
      'grader',
      'checks',
      'findings',
      'evidence',
      'uiux-visual',
      'lessons',
      'plan',
      'artifacts',
      'judge-artifact',
      'judge-dispatch',
      'judge-internal',
      'paperwork',
    ]) {
      expect(doc, input).toContain(`\`${input}\``);
    }
    expect(doc).toMatch(/Then every problem falls in exactly one of five branches/);
    for (const n of [1, 2, 3, 4, 5]) expect(doc).toContain(` ${n}. **`);
    expect(doc).toMatch(/first every intake problem, by its branch \(5 first, then 1, 2 and 4\)/);
    expect(doc).toMatch(
      /A stage reason of branch 3 goes to `gate run` only when the preflight shows no intake problem/,
    );
    expect(doc).toMatch(/`checkModelTierRung`/);
    expect(doc).toMatch(/`checkOperatorRung`/);
    expect(doc).toMatch(
      /Branch 4's bound of one return is a playbook rule: the log evidences it by structure[^.]*no verb enforces it, an accepted gap like the port-0 rule/,
    );
  });
});

describe('queue-and-gate.md env-failure block names the fields where the code puts them', () => {
  const doc = read('docs/guide/operator-guide/queue-and-gate.md');
  const section = doc
    .slice(doc.indexOf('### An env-failure block'), doc.indexOf('## 5a.'))
    .replace(/\s+/g, ' ');
  // The compiler ties this list to the type.
  const FIELDS = {
    name: true,
    window: true,
    wall_ms: true,
    monotonic_ms: true,
    clock_gap_ms: true,
    load_1m_start: true,
    load_1m_end: true,
    cpus: true,
  } satisfies Record<keyof CheckEnvironment, true>;

  it('names the environment array as every check, one entry per check in result order', () => {
    expect(section).toMatch(
      /`testgate-result` payload's `environment` array holds every check's evidence, one entry per check in result order/,
    );
  });

  it.each(Object.keys(FIELDS))('lists the field %s once, under that array', (field) => {
    expect(section.split(`\`${field}\``)).toHaveLength(2);
    expect(section.indexOf(`\`${field}\``)).toBeLessThan(
      section.indexOf('Only when a failed check'),
    );
  });

  it('puts error_class and environment_evidence only on a slept failed check, with only those entries', () => {
    expect(section).toMatch(
      /Only when a failed check's own clock gap shows sleep do the `testgate-result` and `gate-outcome` events also carry `error_class: execution\.env-failure` and `environment_evidence`/,
    );
    expect(section).toMatch(
      /outcome `gate run` prints carries `error_class` and `environmentEvidence` beside `testResult\.environment`/,
    );
    expect(section).toMatch(
      /hold only the entries of the checks that failed and slept, not one per check/,
    );
    expect(section).not.toMatch(/`environment_evidence`: one entry per check/);
    expect(section).not.toMatch(/blocked outcome then carry/);
  });
});

describe('CHANGELOG says what the release does', () => {
  const log = read('CHANGELOG.md');
  const start = log.indexOf('## Unreleased');
  const unreleased = log.slice(start, log.indexOf('### Fixed', start));

  it('no longer calls the release untouched', () => {
    expect(unreleased).not.toContain('`gate.ts` is untouched.');
    expect(unreleased).not.toContain('No production change.');
    expect(unreleased).not.toContain('Nothing in the npm package changes.');
  });

  it('says the gate writes the events it wrote before and recurrence reads the class', () => {
    expect(unreleased.replace(/\s+/g, ' ')).toMatch(
      /The gate writes the events it wrote before; recurrence reads the class when it counts/,
    );
  });
});

describe('the concrete preflight lines run through the built CLI', () => {
  const TASK = 'epic-1/task-1';
  const SESSION = 'sess-preflight';
  let scratch = '';
  let bsHome = '';
  let tier = '';

  beforeAll(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'bs-preflight-scratch-'));
    bsHome = mkdtempSync(path.join(tmpdir(), 'bs-preflight-home-'));
    tier = loadTaxonomy().dimensions.model_tier?.[0] ?? '';
    expect(tier).not.toBe('');
    const wt = path.join(scratch, 'wt');
    mkdirSync(wt, { recursive: true });
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.email', 'test@example.com'],
      ['config', 'user.name', 'Test'],
      ['commit', '-q', '--allow-empty', '-m', 'base'],
    ]) {
      execFileSync('git', args, { cwd: wt });
    }
    const started = runCli(['session', 'start', SESSION], { BS_HOME: bsHome });
    expect(started.status, started.stdout).toBe(0);
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(bsHome, { recursive: true, force: true });
  });

  /** The seven lines whose `--as` is a literal mode, read from the files. */
  function concreteLines(): { source: string; as: string; text: string }[] {
    const wave = read('.claude/skills/bs/wave.md');
    const step = (n: number): string =>
      wave.slice(
        wave.search(new RegExp(`^${n}\\. `, 'm')),
        wave.search(new RegExp(`^${n + 1}\\. `, 'm')),
      );
    const found: { source: string; as: string; text: string }[] = [];
    for (const role of ['coder', 'tester', 'grader']) {
      found.push({
        source: `bs-${role}.md`,
        as: role,
        text: lineStarting(outsideShared(agent(role)), `bs results check <task-id> --as ${role}`)
          .text,
      });
    }
    found.push({
      source: 'wave.md step 7',
      as: 'gate',
      text: lineStarting(step(7), 'bs results check <task-id> --as gate').text,
    });
    for (const role of ['coder', 'tester', 'grader']) {
      found.push({
        source: `wave.md step 8 ${role}`,
        as: role,
        text: lineStarting(step(8), `bs results check <task-id> --as ${role}`).text,
      });
    }
    return found;
  }

  const FILE_CONTENT: Record<string, unknown> = {
    result: { run_status: 'done', structured_output: {}, artifacts: [] },
    grader: graderFile(graderVerdictBody()),
    checks: [{ name: 'noop', cmd: 'true' }],
    findings: [],
    'uiux-visual': { run_status: 'done', structured_output: { deviations: [] }, artifacts: [] },
    plan: {
      epic_id: 'epic-1',
      version: 1,
      status: 'active',
      tasks: [
        {
          task_id: TASK,
          epic_id: 'epic-1',
          plan_version: 1,
          objective: 'Do the thing.',
          output_schema_ref: 'result.schema.json',
          acceptance_criteria: ['it works'],
          claims: ['src.ts'],
          budget: { tokens: 1000, diff_lines: 100 },
          contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
          ui_affecting: false,
        },
      ],
    },
  };

  /** Fill each placeholder with a value of its flag's type, creating the files it names. */
  function argvOf(line: string): string[] {
    const tokens = line.split(/\s+/).filter((t) => t !== 'bs' && t !== '\\');
    const argv: string[] = [];
    let flag = '';
    for (const token of tokens) {
      if (token.startsWith('--')) {
        flag = token.slice(2);
        argv.push(token);
        continue;
      }
      if (flag === '') {
        argv.push(token === '<task-id>' ? TASK : token);
        continue;
      }
      const filled = token.replaceAll('<task-id>', TASK).replaceAll('<round>', '1');
      switch (flag) {
        case 'as':
          argv.push(filled);
          break;
        case 'agent':
          argv.push('coder');
          break;
        case 'provider':
          argv.push('claude');
          break;
        case 'model-tier':
          argv.push(tier);
          break;
        case 'worktree':
          argv.push(path.join(scratch, 'wt'));
          break;
        case 'base':
          argv.push('main');
          break;
        case 'artifacts-dir': {
          const dir = path.join(scratch, filled.replace('<work-root>/', ''));
          mkdirSync(dir, { recursive: true });
          argv.push(dir);
          break;
        }
        case 'session':
          argv.push(SESSION);
          break;
        case 'plan-version':
          argv.push('1');
          break;
        case 'causal-parent':
          argv.push(`${SESSION}#0`);
          break;
        default: {
          const content = FILE_CONTENT[flag];
          expect(content, `no scratch content for --${flag}`).toBeDefined();
          const file = path.join(scratch, filled.replace(/[<>]/g, ''));
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, JSON.stringify(content));
          argv.push(file);
        }
      }
    }
    expect(argv.join(' '), line).not.toMatch(/[<>]/);
    return argv;
  }

  it('finds the seven concrete lines, the two grader lines among them', () => {
    const lines = concreteLines();
    expect(lines).toHaveLength(7);
    expect(lines.filter((l) => l.as === 'grader')).toHaveLength(2);
    expect(lines.map((l) => l.as).sort()).toEqual([
      'coder',
      'coder',
      'gate',
      'grader',
      'grader',
      'tester',
      'tester',
    ]);
  });

  for (const index of [0, 1, 2, 3, 4, 5, 6]) {
    it(`runs concrete line ${index} and prints the paperwork document`, () => {
      const line = concreteLines()[index];
      expect(line).toBeDefined();
      const { source, as, text } = line as { source: string; as: string; text: string };
      const run = runCli(argvOf(text), { BS_HOME: bsHome }, undefined, path.join(scratch, 'wt'));
      const out = JSON.parse(run.stdout.trim().split('\n').at(-1) as string);
      expect(out.error, `${source}: ${run.stdout}`).toBeUndefined();
      expect(out.as, source).toBe(as);
      expect(['pass', 'blocked'], source).toContain(out.outcome);
    });
  }
});
