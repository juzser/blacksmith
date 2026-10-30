import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';
import { runCli } from './helpers/cliHarness.js';
import { codeSpans, instructionFiles } from './helpers/instructionSurface.js';

// f-bs-gate-bounce/integration-7d2c72ec: the compose commands the docs lead
// with must carry the flags compose requires. The required set is read off
// compose's own refusal, so a later required flag fails here, not in a worker's
// hands; a command whose role is a literal is run as printed.

interface Documented {
  file: string;
  line: number;
  text: string;
}

const COMPOSE = /^bs brief compose\b/;
const FILE_FLAGS = new Set(['plan', 'checks', 'out', 'specs-dir', 'artifact']);
const flagNames = (text: string): string[] => text.match(/--[a-z][a-z-]*/g) ?? [];
const flagValue = (argv: string[], flag: string): string | undefined => {
  const at = argv.indexOf(`--${flag}`);
  return at === -1 ? undefined : argv[at + 1];
};

const documented: Documented[] = instructionFiles().flatMap((file) =>
  codeSpans(readFileSync(path.join(REPO_ROOT, file), 'utf8'))
    .map((span) => ({ file, line: span.line, text: span.text.trim() }))
    .filter((span) => COMPOSE.test(span.text) && flagNames(span.text).length > 0),
);

let home = '';
beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'bs-compose-docs-'));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** The flags compose's refusal lists for a coder, a tester and a grader brief given none of them. */
let required: string[] | undefined;
function requiredFlags(): string[] {
  if (required !== undefined) return required;
  const env = { BS_HOME: home };
  const session = 'sess-compose-docs-required';
  expect(runCli(['session', 'start', session], env).status).toBe(0);
  const plan = writePlan('epic-1/task-1');
  const union = new Set<string>();
  for (const role of ['coder', 'tester', 'grader']) {
    const run = runCli(
      [
        'brief',
        'compose',
        '--role',
        role,
        '--session',
        session,
        '--plan',
        plan,
        '--task',
        'epic-1/task-1',
        '--worktree',
        path.join(home, 'wt'),
        '--artifact',
        path.join(home, 'artifact.json'),
      ],
      env,
    );
    expect(run.status, run.stdout).toBe(1);
    const error = JSON.parse(run.stdout).error as { code: string; details: { missing: string[] } };
    expect(error.code, role).toBe('brief.preflight-values-required');
    for (const flag of error.details.missing) union.add(flag);
  }
  required = [...union].sort();
  return required;
}

let planCount = 0;
function writePlan(taskId: string): string {
  const epic = taskId.split('/')[0] as string;
  const file = path.join(home, `plan-${planCount++}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      epic_id: epic,
      version: 1,
      status: 'active',
      tasks: [
        {
          task_id: taskId,
          epic_id: epic,
          plan_version: 1,
          objective: 'Documented example task.',
          acceptance_criteria: ['it works'],
          claims: ['src/example.ts'],
          budget: { tokens: 1000, diff_lines: 100 },
          case: 'feature',
          task_status: 'todo',
        },
      ],
      edges: [],
    }),
  );
  return file;
}

describe('the documented bs brief compose commands (f-bs-gate-bounce/integration-7d2c72ec)', () => {
  it('finds the commands in dispatch.md, wave.md step 8 and worktrees-and-judges.md', () => {
    const files = new Set(documented.map((d) => d.file));
    for (const file of [
      '.claude/skills/bs/dispatch.md',
      '.claude/skills/bs/wave.md',
      'docs/guide/operator-guide/worktrees-and-judges.md',
    ]) {
      expect(files.has(file), file).toBe(true);
    }
  });

  it('derives the required flags from the code: the five worker flags', () => {
    expect(requiredFlags()).toEqual(
      ['--base', '--checks', '--model-tier', '--provider', '--work-root'].sort(),
    );
  });

  it.each(documented.map((d) => [`${d.file}:${d.line}`, d] as const))(
    '%s names a role and, when the role is a placeholder, every required flag',
    (_where, d) => {
      const argv = d.text.split(/\s+/);
      const role = flagValue(argv, 'role');
      expect(role, `${d.text}: compose requires --role`).toBeDefined();
      if (/^<.+>$/.test(role as string)) {
        const named = new Set(flagNames(d.text));
        for (const flag of requiredFlags())
          expect(named.has(flag), `${d.text}: ${flag}`).toBe(true);
      }
    },
  );

  const literal = documented.filter((d) => {
    const role = flagValue(d.text.split(/\s+/), 'role');
    return role !== undefined && !/^<.+>$/.test(role);
  });

  it('has at least one command with a literal role to run', () => {
    expect(literal.length).toBeGreaterThan(0);
  });

  it.each(literal.map((d) => [`${d.file}:${d.line}`, d] as const))(
    '%s composes as printed and its brief passes bs dispatch lint',
    (_where, d) => {
      const dir = mkdtempSync(path.join(home, 'run-'));
      const env = { BS_HOME: dir };
      const session = 'sess-compose-docs';
      expect(runCli(['session', 'start', session], env).status).toBe(0);
      const argv = d.text.split(/\s+/).slice(3);
      const given = flagValue(argv, 'task');
      const task = given === undefined || /^<.+>$/.test(given) ? 'epic-1/task-1' : given;
      const fixtures: Record<string, string> = {
        plan: writePlan(task),
        checks: path.join(dir, 'checks.json'),
        out: path.join(dir, 'brief.md'),
        'specs-dir': path.join(dir, 'specs'),
        artifact: path.join(dir, 'artifact.json'),
        session,
        task,
        provider: 'claude',
        'model-tier': 'mid',
        base: 'bs/epic-1/integration',
        'work-root': path.join(dir, 'work-root'),
        worktree: path.join(dir, 'wt'),
        branch: `bs/${task}`,
      };
      writeFileSync(
        fixtures.checks as string,
        JSON.stringify([{ name: 'unit', cmd: 'run-suite' }]),
      );
      mkdirSync(fixtures['specs-dir'] as string, { recursive: true });
      const args = argv.map((token, i) => {
        const flag = argv[i - 1]?.replace(/^--/, '');
        if (flag === undefined || !argv[i - 1]?.startsWith('--')) return token;
        const replace = /^<.+>$/.test(token) || FILE_FLAGS.has(flag);
        return replace && fixtures[flag] !== undefined ? (fixtures[flag] as string) : token;
      });
      expect(
        args.some((t) => /<.+>/.test(t)),
        `${d.text}: a placeholder is left`,
      ).toBe(false);
      const run = runCli(['brief', 'compose', ...args], env);
      expect(run.status, `${d.text}\n${run.stdout}${run.stderr}`).toBe(0);
      const out = flagValue(args, 'out') as string;
      expect(existsSync(out), 'no --out file').toBe(true);
      const lint = runCli(
        [
          'dispatch',
          'lint',
          out,
          '--role',
          flagValue(args, 'role') as string,
          '--task',
          task,
          '--session',
          session,
        ],
        env,
      );
      expect(lint.status, lint.stdout).toBe(0);
    },
  );
});
