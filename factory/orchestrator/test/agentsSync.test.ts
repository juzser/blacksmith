import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentsSyncError,
  maxTurnsEnvName,
  resetAgentMaxTurns,
  syncAgentMaxTurns,
} from '../src/agentsSync.js';
import { AGENTS_DIR } from '../src/paths.js';

function template(role: string, maxTurns: number): string {
  return [
    '---',
    `name: bs-${role}`,
    `description: The ${role} role. maxTurns: is mentioned here too.`,
    'model: sonnet',
    'effort: medium',
    'tools: Read, Grep',
    `maxTurns: ${maxTurns}`,
    '---',
    '',
    '# Body',
    '',
    'maxTurns: 999 in the body is prose, never frontmatter.',
    '',
  ].join('\n');
}

let root: string;
let agentsDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'smith-agents-sync-'));
  agentsDir = path.join(root, '.claude', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(path.join(agentsDir, 'bs-coder.md'), template('coder', 40));
  writeFileSync(path.join(agentsDir, 'bs-spec-reviewer.md'), template('spec-reviewer', 15));
  writeFileSync(path.join(agentsDir, 'bs-wave-runner.md'), template('wave-runner', 60));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const read = (role: string) => readFileSync(path.join(agentsDir, `bs-${role}.md`), 'utf8');

describe('maxTurnsEnvName', () => {
  it('upper-cases the role and turns - into _', () => {
    expect(maxTurnsEnvName('coder')).toBe('SMITH_MAXTURNS_CODER');
    expect(maxTurnsEnvName('spec-reviewer')).toBe('SMITH_MAXTURNS_SPEC_REVIEWER');
    expect(maxTurnsEnvName('wave-runner')).toBe('SMITH_MAXTURNS_WAVE_RUNNER');
  });
});

describe('syncAgentMaxTurns', () => {
  it('rewrites only the frontmatter maxTurns line of the named role', () => {
    const before = read('coder');
    const report = syncAgentMaxTurns({ agentsDir, env: { SMITH_MAXTURNS_CODER: '55' } });
    expect(report.changes).toEqual([
      { role: 'coder', env: 'SMITH_MAXTURNS_CODER', from: 40, to: 55, changed: true },
    ]);
    expect(report.dryRun).toBe(false);
    const after = read('coder');
    expect(after).toBe(before.replace('maxTurns: 40\n', 'maxTurns: 55\n'));
    // Other roles untouched.
    expect(read('spec-reviewer')).toBe(template('spec-reviewer', 15));
  });

  it('BS_MAXTURNS_CODER rewrites bs-coder.md, never BS_MAXTURNS_BS_CODER', () => {
    const report = syncAgentMaxTurns({ agentsDir, env: { BS_MAXTURNS_CODER: '61' } });
    expect(report.changes[0]).toMatchObject({ role: 'coder', env: 'BS_MAXTURNS_CODER', to: 61 });
    expect(readFileSync(path.join(agentsDir, 'bs-coder.md'), 'utf8')).toContain('maxTurns: 61\n');
  });

  it('maps hyphenated roles through the env name', () => {
    syncAgentMaxTurns({
      agentsDir,
      env: { SMITH_MAXTURNS_SPEC_REVIEWER: '25', SMITH_MAXTURNS_WAVE_RUNNER: '80' },
    });
    expect(read('spec-reviewer')).toBe(template('spec-reviewer', 25));
    expect(read('wave-runner')).toBe(template('wave-runner', 80));
  });

  it('reports an unchanged value without writing', () => {
    const report = syncAgentMaxTurns({ agentsDir, env: { SMITH_MAXTURNS_CODER: '40' } });
    expect(report.changes[0]?.changed).toBe(false);
    expect(read('coder')).toBe(template('coder', 40));
  });

  it('does nothing when no SMITH_MAXTURNS_* is set, or it is empty', () => {
    expect(syncAgentMaxTurns({ agentsDir, env: {} }).changes).toEqual([]);
    expect(syncAgentMaxTurns({ agentsDir, env: { SMITH_MAXTURNS_CODER: '' } }).changes).toEqual([]);
    expect(read('coder')).toBe(template('coder', 40));
  });

  it('--dry-run prints the diff and writes nothing', () => {
    const report = syncAgentMaxTurns({
      agentsDir,
      env: { SMITH_MAXTURNS_CODER: '70' },
      dryRun: true,
    });
    expect(report.dryRun).toBe(true);
    expect(report.changes).toEqual([
      { role: 'coder', env: 'SMITH_MAXTURNS_CODER', from: 40, to: 70, changed: true },
    ]);
    expect(read('coder')).toBe(template('coder', 40));
  });

  it('refuses an unknown role and lists the valid ones', () => {
    try {
      syncAgentMaxTurns({ agentsDir, env: { SMITH_MAXTURNS_CODRE: '10' } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AgentsSyncError);
      expect((err as AgentsSyncError).code).toBe('agents.unknown-role');
      expect((err as Error).message).toMatch(/SMITH_MAXTURNS_CODRE/);
      expect((err as AgentsSyncError).details.roles).toEqual([
        'coder',
        'spec-reviewer',
        'wave-runner',
      ]);
    }
  });

  it('refuses a value that is not a positive integer, and writes nothing', () => {
    for (const bad of ['0', '-3', '12.5', 'forty', '1e3', '40 ']) {
      expect(() =>
        syncAgentMaxTurns({
          agentsDir,
          env: { SMITH_MAXTURNS_SPEC_REVIEWER: '20', SMITH_MAXTURNS_CODER: bad },
        }),
      ).toThrow(AgentsSyncError);
    }
    // Validation runs before any write: the valid sibling was not applied.
    expect(read('spec-reviewer')).toBe(template('spec-reviewer', 15));
  });

  it('refuses a template with no frontmatter maxTurns line', () => {
    writeFileSync(path.join(agentsDir, 'bs-coder.md'), '---\nname: bs-coder\n---\n\nmaxTurns: 3\n');
    expect(() => syncAgentMaxTurns({ agentsDir, env: { SMITH_MAXTURNS_CODER: '5' } })).toThrow(
      /maxTurns/,
    );
  });

  // bs-rename, operator decision 3: BS_MAXTURNS_<ROLE> is the current name,
  // SMITH_MAXTURNS_<ROLE> still works as a fallback, and BS_ wins when both
  // are set.
  it('accepts BS_MAXTURNS_<ROLE> as well as the legacy SMITH_MAXTURNS_<ROLE>', () => {
    const report = syncAgentMaxTurns({ agentsDir, env: { BS_MAXTURNS_CODER: '55' } });
    expect(report.changes).toEqual([
      { role: 'coder', env: 'BS_MAXTURNS_CODER', from: 40, to: 55, changed: true },
    ]);
    expect(read('coder')).toBe(template('coder', 55));
  });

  it('prefers BS_MAXTURNS_<ROLE> over SMITH_MAXTURNS_<ROLE> when both are set', () => {
    const report = syncAgentMaxTurns({
      agentsDir,
      env: { BS_MAXTURNS_CODER: '55', SMITH_MAXTURNS_CODER: '99' },
    });
    expect(report.changes).toEqual([
      { role: 'coder', env: 'BS_MAXTURNS_CODER', from: 40, to: 55, changed: true },
    ]);
    expect(read('coder')).toBe(template('coder', 55));
  });

  it('refuses an unknown role named through BS_MAXTURNS_, same as the legacy prefix', () => {
    try {
      syncAgentMaxTurns({ agentsDir, env: { BS_MAXTURNS_CODRE: '10' } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AgentsSyncError);
      expect((err as AgentsSyncError).code).toBe('agents.unknown-role');
      expect((err as Error).message).toMatch(/BS_MAXTURNS_CODRE/);
    }
  });
});

describe('resetAgentMaxTurns', () => {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

  beforeEach(() => {
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  });

  it("restores every template's maxTurns to the committed value", () => {
    syncAgentMaxTurns({
      agentsDir,
      env: { SMITH_MAXTURNS_CODER: '99', SMITH_MAXTURNS_WAVE_RUNNER: '5' },
    });
    const report = resetAgentMaxTurns({ agentsDir });
    expect(report.changes).toEqual([
      { role: 'coder', env: 'SMITH_MAXTURNS_CODER', from: 99, to: 40, changed: true },
      {
        role: 'spec-reviewer',
        env: 'SMITH_MAXTURNS_SPEC_REVIEWER',
        from: 15,
        to: 15,
        changed: false,
      },
      { role: 'wave-runner', env: 'SMITH_MAXTURNS_WAVE_RUNNER', from: 5, to: 60, changed: true },
    ]);
    expect(read('coder')).toBe(template('coder', 40));
    expect(read('wave-runner')).toBe(template('wave-runner', 60));
  });

  it('touches only the maxTurns line, keeping other local edits', () => {
    const edited = template('coder', 70).replace('# Body', '# Body, edited locally');
    writeFileSync(path.join(agentsDir, 'bs-coder.md'), edited);
    resetAgentMaxTurns({ agentsDir });
    expect(read('coder')).toBe(edited.replace('maxTurns: 70\n', 'maxTurns: 40\n'));
  });

  it('--dry-run reports the reset and writes nothing', () => {
    syncAgentMaxTurns({ agentsDir, env: { SMITH_MAXTURNS_CODER: '99' } });
    const report = resetAgentMaxTurns({ agentsDir, dryRun: true });
    expect(report.changes[0]).toMatchObject({ role: 'coder', from: 99, to: 40, changed: true });
    expect(read('coder')).toBe(template('coder', 40).replace('maxTurns: 40', 'maxTurns: 99'));
  });

  it('refuses outside a git checkout, rather than guessing a default', () => {
    rmSync(path.join(root, '.git'), { recursive: true, force: true });
    expect(() => resetAgentMaxTurns({ agentsDir })).toThrow(AgentsSyncError);
  });
});

describe('the shipped templates', () => {
  it('every one carries a frontmatter maxTurns line sync can rewrite', () => {
    const report = syncAgentMaxTurns({ agentsDir: AGENTS_DIR, env: {}, dryRun: true });
    expect(report.roles.length).toBeGreaterThan(0);
    for (const role of report.roles) {
      const text = readFileSync(path.join(AGENTS_DIR, `bs-${role}.md`), 'utf8');
      expect(text.split('---')[1]).toMatch(/\nmaxTurns: \d+\n/);
    }
  });

  it('a real (non-dry-run) sync on a template carrying the judge-stop.sh hook block rewrites only the maxTurns: line', () => {
    // `reviewer.md` is one of the six templates whose frontmatter carries a
    // multi-line `hooks:\n  Stop:\n    - hooks: [...]` block (task 6). Copy
    // the real shipped template into a scratch agentsDir, actually write
    // (not dry-run) a new maxTurns value, and assert the diff is exactly
    // that one line -- the hooks block, and everything else, unchanged.
    const before = readFileSync(path.join(AGENTS_DIR, 'bs-reviewer.md'), 'utf8');
    const scratchDir = mkdtempSync(path.join(tmpdir(), 'smith-agents-sync-hooks-'));
    try {
      const scratchAgentsDir = path.join(scratchDir, '.claude', 'agents');
      mkdirSync(scratchAgentsDir, { recursive: true });
      writeFileSync(path.join(scratchAgentsDir, 'bs-reviewer.md'), before);
      const beforeMaxTurns = /\nmaxTurns: (\d+)\n/.exec(before)?.[1];
      expect(beforeMaxTurns).toBeDefined();
      const newValue = String(Number(beforeMaxTurns) + 1);

      const report = syncAgentMaxTurns({
        agentsDir: scratchAgentsDir,
        env: { SMITH_MAXTURNS_REVIEWER: newValue },
      });
      expect(report.dryRun).toBe(false);
      expect(report.changes).toEqual([
        {
          role: 'reviewer',
          env: 'SMITH_MAXTURNS_REVIEWER',
          from: Number(beforeMaxTurns),
          to: Number(newValue),
          changed: true,
        },
      ]);

      const after = readFileSync(path.join(scratchAgentsDir, 'bs-reviewer.md'), 'utf8');
      expect(after).toBe(
        before.replace(`maxTurns: ${beforeMaxTurns}\n`, `maxTurns: ${newValue}\n`),
      );
      // The hooks block survives verbatim -- the rewrite touched nothing else.
      expect(after).toContain('hooks:');
      expect(after).toContain('judge-stop.sh');
      const hooksLine = (text: string) => text.split('\n').find((l) => l.includes('judge-stop.sh'));
      expect(hooksLine(after)).toBe(hooksLine(before));
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
