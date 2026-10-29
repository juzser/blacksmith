import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCREENSHOT_RE, STAGES_FOR_ROLE } from '../src/paperwork.js';
import { AGENTS_DIR, REPO_ROOT } from '../src/paths.js';
import { parseSharedRegions } from '../src/templateFragments.js';
import { flagSpecFor } from '../src/usage.js';
import { type CodeSpan, codeSpans } from './helpers/instructionSurface.js';

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
      for (const cmd of ['typecheck', 'typecheck:test', 'biome check .']) {
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
    expect(s).toMatch(/while it exits 1[^.]*does not call `gate run`/i);
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
    ]) {
      expect(unreleased, id).toContain(id);
    }
  });
});
