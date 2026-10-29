import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lintDispatchPrompt } from '../src/dispatchLint.js';
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
      'task-8-close-review-r2-fixes',
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
    'grader-invalid': 2,
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
      /neither a list nor a grader document shows three problems, the intake `judge-artifact` and then the stage problems `judges-outstanding` and `grader-invalid`; all three are branch 2, and it is never sent to `gate run`/,
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
      /9\. Gate outcome `blocked` → bounce to the builder whose output its reason\s+names/,
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

// ---- Task-8 close-review r2 --------------------------------------------------

/** The reasons wave.md step 7 puts in each branch, from the compiler-tied map below. */
const R2_REASON_BRANCH = {
  'deps-missing': 1,
  'judges-outstanding': 2,
  'uiux-spec-missing': 2,
  'uiux-visual-missing': 2,
  'grader-invalid': 2,
  'schema-invalid': 3,
  'artifacts-missing': 3,
  'not-committed': 3,
  'screenshots-missing': 3,
  'screenshots-stale': 3,
} satisfies Record<PaperworkReason, 1 | 2 | 3>;
const flatten = (text: string): string => text.replace(/\s+/g, ' ');
const stepOf = (text: string, n: number): string =>
  text.slice(
    text.search(new RegExp(`^${n}\\. `, 'm')),
    text.search(new RegExp(`^${n + 1}\\. `, 'm')),
  );
const waveText = read('.claude/skills/bs/wave.md');
const queueText = read('docs/guide/operator-guide/queue-and-gate.md');
const section5 = queueText.slice(
  queueText.indexOf('problem falls in exactly one of five branches'),
);
const branchOf = (text: string, reason: string, start: RegExp): number | undefined => {
  const marks = [...text.matchAll(start)];
  const holders = marks
    .map((m, i) => ({
      n: Number(m[1]),
      body: text.slice(m.index, marks[i + 1]?.index ?? m.index + 3000),
    }))
    .filter(({ body }) => body.includes(`\`${reason}\``));
  return holders.length === 1 ? holders[0]?.n : undefined;
};

describe('f-bs-gate-bounce/integration-1e8e9e9b: routing in wave.md', () => {
  const step9 = flatten(stepOf(waveText, 9));
  const BUILDER_OF: Record<string, RegExp> = {
    'schema-invalid':
      /for `schema-invalid` and `artifacts-missing` the worker whose result the gate line's `--result` and `--agent` name/,
    'artifacts-missing': /for `schema-invalid` and `artifacts-missing` the worker whose result/,
    'not-committed': /the coder for every other reason/,
    'screenshots-missing': /the tester for `screenshots-missing` and `screenshots-stale`/,
    'screenshots-stale': /the tester for `screenshots-missing` and `screenshots-stale`/,
  };

  it('names a builder in step 9 for every reason of branch 3, keyed from the branch-3 reasons', () => {
    const branch3 = Object.entries(R2_REASON_BRANCH)
      .filter(([, b]) => b === 3)
      .map(([r]) => r);
    expect(Object.keys(BUILDER_OF).sort()).toEqual(branch3.sort());
    for (const reason of branch3) expect(step9, reason).toMatch(BUILDER_OF[reason] as RegExp);
  });

  it('says the tester re-shoots at the gate HEAD, step 5 records it and the uiux pass reviews it', () => {
    expect(step9).toMatch(
      /re-shoots at the gate's HEAD, step 5 records the new set, and step 5's uiux visual pass reviews it/,
    );
  });

  it('answers a grader-invalid in the log with the grader turn and the epic session', () => {
    expect(step9).toMatch(
      /A `grader-invalid` `gate-outcome` in the log is still a failed round the ladder counts, is answered by the grader's turn and not by a bounce, and goes to the epic session/,
    );
  });

  it('says the ladder counts every blocked round whichever builder it bounces to', () => {
    expect(step9).toMatch(
      /counts every blocked round whichever builder it bounces to, so from the second failed round the bounced builder, a tester included, runs on a strictly higher model tier \(`checkModelTierRung`\)/,
    );
  });

  it('names the task builder in the blocked-task rule', () => {
    expect(flatten(waveText)).toMatch(
      /A blocked task blocks itself\.\*\* Gate outcome `blocked` bounces to \*that\* task's builder \(step 9\)/,
    );
  });

  it('branch 2 answers grader-invalid with the grader turn, within graderRounds', () => {
    const two = flatten(
      stepOf(waveText, 7).slice(
        stepOf(waveText, 7).search(/^ {5}2\. \*\*/m),
        stepOf(waveText, 7).search(/^ {5}3\. \*\*/m),
      ),
    );
    expect(two).toMatch(
      /re-poke the grader in the same round to rewrite its file in place, or re-run it as a new round only while step 6's `profile.graderRounds` leaves one; with none left the task goes to the epic session\. It is never sent to `gate run` and never to a builder/,
    );
  });

  it('keeps the word bounce in step 7 only inside branch 3', () => {
    const s7 = stepOf(waveText, 7);
    const three = s7.slice(s7.search(/^ {5}3\. \*\*/m), s7.search(/^ {5}4\. \*\*/m));
    expect(flatten(s7.replace(three, ''))).not.toMatch(/\bbounce\b/i);
  });
});

describe('f-bs-gate-bounce/integration-1e8e9e9b: routing in queue-and-gate.md', () => {
  it('has the grader-invalid, screenshots and schema-invalid rows', () => {
    const row = (reason: string) =>
      queueText
        .split('\n')
        .find((l) => l.startsWith(`| \`blocked\` (\`reason: "${reason}"\`)`)) as string;
    expect(row('grader-invalid')).toMatch(
      /grader's turn answers it \(re-poked in the same round, or re-run within its round cap\), never a builder/,
    );
    expect(row('grader-invalid')).toMatch(
      /wave\.md` step 7 sends it to the grader before `gate run`/,
    );
    expect(row('screenshots-missing')).toMatch(/bounce to the tester/);
    expect(row('screenshots-stale')).toMatch(/bounce to the tester/);
    expect(row('schema-invalid')).toMatch(/bounce to the worker whose result it is/);
  });

  it.each(Object.entries(R2_REASON_BRANCH))(
    'puts %s in branch %i in section 5 as in wave.md',
    (reason, branch) => {
      const s5 = section5.slice(0, section5.indexOf('One preflight result can hold'));
      expect(branchOf(s5, reason, /^([1-5])\. \*\*/gm)).toBe(branch);
      const s7 = stepOf(waveText, 7);
      expect(
        branchOf(
          s7.slice(0, s7.indexOf('One preflight result can hold')),
          reason,
          /^ {5}([1-5])\. \*\*/gm,
        ),
      ).toBe(branch);
    },
  );

  it('carries the three-problem sentence and the tester ladder sentence', () => {
    const flatQ = flatten(queueText);
    expect(flatQ).toMatch(
      /neither a list nor a grader document shows three problems, the intake `judge-artifact` and then the stage problems `judges-outstanding` and `grader-invalid`; all three are branch 2, and it never goes to `gate run`/,
    );
    expect(flatQ).toMatch(
      /The ladder counts a tester bounce \(the two screenshots reasons\) like a coder bounce/,
    );
  });
});

describe('f-bs-gate-bounce/integration-2afed53d: one counting rule for branch 4', () => {
  const sentenceOf = (text: string): string => {
    const flat = flatten(text);
    const at = flat.indexOf('At most one branch-4 return per task');
    expect(at).toBeGreaterThan(-1);
    return flat.slice(at, flat.indexOf('from any worker.', at) + 'from any worker.'.length);
  };

  it('carries one sentence, word for word, in wave.md step 7 and queue-and-gate.md section 5', () => {
    const a = sentenceOf(stepOf(waveText, 7));
    expect(a).toBe(sentenceOf(section5));
    expect(a).toMatch(
      /whatever the worker's role, counted as the task's builder dispatches whose `causal_parent` is such an `error-logged` event/,
    );
    expect(a).toMatch(
      /a second `result` problem on the same task goes to the epic session, which returns it no more without the operator's answer/,
    );
  });

  it('counts nothing per role', () => {
    expect(waveText).not.toContain('task and role');
    expect(queueText).not.toContain('task and role');
  });
});

describe('f-bs-gate-bounce/integration-1e8e9e9b: the ladder premise, through the built CLI', () => {
  const TASK_ID = 'epic-1/task-8';
  const SESSION_ID = 'sess-ladder';
  let home = '';
  beforeAll(() => {
    home = mkdtempSync(path.join(tmpdir(), 'bs-ladder-home-'));
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  const append = (
    event_type: string,
    payload: Record<string, unknown>,
    env: Record<string, string>,
  ) => {
    const out = runCli(
      [
        'event',
        'append',
        JSON.stringify({
          session_id: SESSION_ID,
          actor: 'orchestrator',
          event_type,
          task_id: TASK_ID,
          plan_version: 1,
          causal_parent: `${SESSION_ID}#0`,
          payload,
        }),
      ],
      env,
    );
    expect(out.status, out.stdout + out.stderr).toBe(0);
  };
  const run = (finalTier: string) => {
    const dir = mkdtempSync(path.join(home, 's-'));
    const env = { BS_HOME: dir };
    expect(runCli(['session', 'start', SESSION_ID], env).status).toBe(0);
    const dispatch = (agent_role: string, model_tier: string) =>
      append('dispatch_decision', { agent_role, provider: 'claude', model: 'm', model_tier }, env);
    const blockedRound = () =>
      append('gate-outcome', { outcome: 'blocked', reason: 'screenshots-missing' }, env);
    dispatch('coder', 'mid');
    dispatch('tester', 'mid');
    blockedRound();
    dispatch('tester', 'mid');
    blockedRound();
    dispatch('tester', finalTier);
    return runCli(['escalation', 'check', SESSION_ID, '--task', TASK_ID], env);
  };
  /** The tier-rung check: rung 2 of budgets.yml's ladder, the model-tier rung. */
  const tierRung = (stdout: string): string | undefined =>
    (JSON.parse(stdout).checks as { rung: number; status: string }[]).find((c) => c.rung === 2)
      ?.status;

  it('accepts a tester dispatch on a higher tier after the second screenshots block', () => {
    const out = run('frontier');
    expect(out.status, out.stdout).toBe(0);
    expect(tierRung(out.stdout)).toBe('ok');
  });

  it('flags the same log when the last tester dispatch stays on mid', () => {
    const out = run('mid');
    expect(out.status, out.stdout).toBe(1);
    expect(tierRung(out.stdout)).toBe('violation');
  });
});

describe('task-8 docs: composer, lint and the tester result file', () => {
  const TESTER_PATH = 'state/results/<task-id>.tester.json';
  const step8 = flatten(stepOf(waveText, 8));
  const dispatchDoc = read('.claude/skills/bs/dispatch.md');

  it('wave.md step 8 says compose writes the lines and checks, refuses without them, and the lint fails', () => {
    expect(step8).toMatch(
      /bs brief compose --role <role> --task <task-id> --session <id> --work-root <work-root>/,
    );
    expect(step8).toMatch(
      /`bs brief compose` writes each coder's, tester's and grader's line, and each coder's and tester's gate check commands, from the flags `--provider`, `--model-tier`, `--base` \(the coder\), `--checks` \(the file step 7's gate line takes\) and `--work-root <work-root>` \(the value of steps 5 and 7\); it refuses to compose such a brief without them, and `bs dispatch lint` exits 1 on a brief that lacks them/,
    );
  });

  it('names the tester result file in wave.md step 5, dispatch.md, the templates and the standard', () => {
    expect(flatten(stepOf(waveText, 5))).toContain(`\`<work-root>/${TESTER_PATH}\``);
    expect(flatten(dispatchDoc)).toContain(
      `the tester writes \`${TESTER_PATH}\`, never the coder's file`,
    );
    for (const rel of [
      '.claude/agents/bs-tester.md',
      '.claude/agents/bs-wave-runner.md',
      '.claude/agents/bs-uiux.md',
      'docs/standards/agent-constraints.md',
    ]) {
      expect(flatten(read(rel)), rel).toContain(TESTER_PATH);
    }
    const tester = outsideShared(agent('tester'));
    expect(tester).toContain(`**2. Write the full result** to \`${TESTER_PATH}\``);
    expect(tester).toContain(`"artifact_path": "${TESTER_PATH}"`);
    expect(read('.claude/skills/bs/run.md')).toContain('state/results/<task-id>.tester*.json');
    expect(flatten(read('.claude/agents/bs-uiux.md'))).not.toMatch(
      /coder's and the tester's own result path/,
    );
  });

  it('no instruction file says every worker or the tester writes the bare result file', () => {
    const bare = /(?:tester|every worker)[^.]{0,80}`state\/results\/<task-id>\.json`/i;
    for (const rel of [
      ...['coder', 'tester', 'grader', 'uiux', 'wave-runner'].map(
        (r) => `.claude/agents/bs-${r}.md`,
      ),
      '.claude/skills/bs/wave.md',
      '.claude/skills/bs/dispatch.md',
      'docs/standards/agent-constraints.md',
    ]) {
      const text = flatten(read(rel));
      for (const hit of text.matchAll(new RegExp(bare.source, 'gi'))) {
        // A bare mention is fine only when the same sentence gives the tester its own file.
        const rest = text.slice(hit.index, hit.index + hit[0].length + 120);
        expect(rest, `${rel}: ${hit[0]}`).toContain('.tester.json');
      }
    }
  });

  it('dispatch.md shows the preflight and gate_checks text form and names the refusals', () => {
    const doc = flatten(dispatchDoc);
    for (const piece of [
      'Result file: <work-root>/state/results/<task-id>.json',
      'Hand-back preflight line (run it as your last step, exactly as written):',
      "Gate checks (run each over the whole project before you hand back; run a check marked heavy as your template's heavy-run section says, never bare):",
      '- unit (heavy):',
      '`brief.preflight-values-required`',
      '`brief.invalid-value`',
      '`brief.preflight-unlintable`',
      'bs dispatch lint` exits 1 on a coder, tester or grader brief whose line is missing, ambiguous, for another task or role, or still holds a placeholder, and on a coder or tester brief that names no gate check',
    ]) {
      expect(doc, piece).toContain(piece);
    }
  });

  it('worktrees-and-judges.md names the flags, the refusals and a lint example with every real key', async () => {
    const doc = read('docs/guide/operator-guide/worktrees-and-judges.md');
    for (const flag of ['--provider', '--model-tier', '--base', '--checks', '--work-root']) {
      expect(doc, flag).toContain(`\`${flag}\``);
    }
    for (const code of [
      'brief.preflight-values-required',
      'brief.invalid-value',
      'brief.preflight-unlintable',
    ]) {
      expect(doc, code).toContain(code);
    }
    const example = doc.split('\n').find((l) => l.startsWith('{"turns":')) as string;
    const report = await lintDispatchPrompt({
      prompt: '',
      role: 'planner',
      taskId: 'e/t',
      sessionId: 'none',
      eventOpts: { stateDir: mkdtempSync(path.join(tmpdir(), 'bs-lint-keys-')) },
    });
    expect(Object.keys(JSON.parse(example)).sort()).toEqual(Object.keys(report).sort());
    expect(Object.keys(JSON.parse(example).preflight).sort()).toEqual(
      Object.keys(report.preflight).sort(),
    );
  });

  it('queue-and-gate.md says the composer writes the line and the lint fails a brief without it', () => {
    expect(flatten(queueText)).toMatch(
      /The composer writes that line: `bs brief compose` fills each coder's, tester's and grader's preflight line[^.]*and `bs dispatch lint` fails a brief without them/,
    );
  });

  it('leaves the handback-preflight fragment and the SHARED regions of the three templates alone', () => {
    for (const role of ['tester', 'wave-runner', 'uiux']) {
      const shared = [...agent(role).matchAll(SHARED)].map((m) => m[0]);
      expect(shared.length, role).toBeGreaterThan(0);
    }
  });
});
