// The install interview's answers, read back as data.
//
// Two things are worth testing here and nothing else is: that a hand-edited
// YAML file cannot quietly answer a question the operator did not answer
// (D-203 — `frontend: no` is the string `'no'`, and every non-empty string is
// truthy), and that `smith stack check` tells the truth about which answers
// the shipped templates can actually build. The second is the whole reason
// this file replaced a prose standard: a factory that reads an answer and
// scaffolds something else has run an interview for show.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STACK_POLICY_PATH } from '../src/paths.js';
import {
  checkStack,
  loadStackAnswers,
  parseStackAnswers,
  requireScaffoldable,
  type StackAnswers,
  StackError,
} from '../src/stack.js';

let scratchDirs: string[] = [];

function mkScratch(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  scratchDirs = [];
});

/** The shipped answers, with the one field under test moved. */
function answers(overrides: Partial<StackAnswers> = {}): StackAnswers {
  return { ...loadStackAnswers(), ...overrides };
}

function supportOf(report: ReturnType<typeof checkStack>, field: string): string {
  const row = report.answers.find((entry) => entry.field === field);
  expect(row, `no row for ${field}`).toBeDefined();
  return (row as { support: string }).support;
}

describe('parseStackAnswers', () => {
  it("ships answers that assume least, so a stranger inherits nobody else's stack", () => {
    const shipped = loadStackAnswers();
    // The file this replaced named one operator's 2026-08-03 stack — a
    // framework, a host, a database and a private design system — as if it
    // were everyone's. A public repo's shipped answers have to be the ones
    // that put no words in a new operator's mouth.
    expect(shipped.frontend).toBe('none');
    expect(shipped.designSystem).toBe('none');
    expect(shipped.designSystemSource).toBe('');
    expect(shipped.backend).toBe('none');
    expect(shipped.database).toBe('none');
    expect(shipped.orm).toBe('none');
  });

  it('falls back to the defaults for every unanswered question', () => {
    expect(parseStackAnswers('')).toEqual(loadStackAnswers());
  });

  it('refuses a value outside the vocabulary, and names the alternatives', () => {
    let caught: unknown;
    try {
      parseStackAnswers('frontend: angular\n');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StackError);
    expect((caught as StackError).message).toContain('vue');
    expect((caught as StackError).message).toContain('angular');
  });

  it('refuses the YAML-truthy traps rather than reading them as an answer (D-203)', () => {
    // YAML 1.2 reads these as the strings 'no' and 'off', and every non-empty
    // string is truthy — so a field that branched on them would silently pick
    // the opposite of what the operator wrote.
    expect(() => parseStackAnswers('frontend: no\n')).toThrow(StackError);
    expect(() => parseStackAnswers('lint: off\n')).toThrow(StackError);
    // An unquoted version is a number, not a string.
    expect(() => parseStackAnswers('hosting: 3.11\n')).toThrow(StackError);
    expect(() => parseStackAnswers('design_system: 2\n')).toThrow(StackError);
  });

  it('reads a blank free-text answer as the unanswered default', () => {
    const parsed = parseStackAnswers("design_system: ''\nhosting: '  '\n");
    expect(parsed.designSystem).toBe('none');
    expect(parsed.hosting).toBe('unspecified');
  });

  it('refuses a design_system_source with no design system to vendor', () => {
    expect(() => parseStackAnswers('design_system_source: ./kit\n')).toThrow(
      /design_system is none/,
    );
  });

  it('accepts a named design system with a source', () => {
    const parsed = parseStackAnswers('design_system: acme-ds\ndesign_system_source: ./kit\n');
    expect(parsed.designSystem).toBe('acme-ds');
    expect(parsed.designSystemSource).toBe('./kit');
  });

  it('loads the file the paths module points at', () => {
    expect(existsSync(STACK_POLICY_PATH)).toBe(true);
    expect(() => loadStackAnswers(STACK_POLICY_PATH)).not.toThrow();
  });
});

describe('checkStack', () => {
  it('is green on the shipped answers, and prices every one of them', () => {
    const report = checkStack(loadStackAnswers());
    expect(report.ok).toBe(true);
    expect(report.answers.every((entry) => entry.note !== '')).toBe(true);
    // design_system_source is half of the design_system answer, not a row of
    // its own: two rows could disagree about one fact.
    expect(report.answers.map((entry) => entry.field)).not.toContain('design_system_source');
  });

  it('stays green when the answers are merely wider than the template tree', () => {
    // `recorded` is not a fault. A check that went red for every operator
    // whose stack the templates do not scaffold is a check they learn to
    // ignore — and then it is red on the day it means something.
    const report = checkStack(answers({ packageManager: 'npm', backend: 'node', orm: 'drizzle' }));
    expect(report.ok).toBe(true);
    expect(supportOf(report, 'package_manager')).toBe('recorded');
    expect(supportOf(report, 'backend')).toBe('recorded');
    // The recorded row says where the hardcode lives, so the mismatch is
    // actionable rather than just noted.
    const row = report.answers.find((entry) => entry.field === 'package_manager');
    expect(row?.note).toContain('pnpm-workspace.yaml');
  });

  it('goes red on an answer smith new would refuse', () => {
    const report = checkStack(answers({ frontend: 'react' }));
    expect(report.ok).toBe(false);
    expect(supportOf(report, 'frontend')).toBe('refused');
  });

  it('calls a design system with a missing source refused, not recorded', () => {
    const workDir = mkScratch('smith-stack-ds-');
    const report = checkStack(
      answers({ designSystem: 'acme-ds', designSystemSource: path.join(workDir, 'gone') }),
    );
    expect(report.ok).toBe(false);
    expect(supportOf(report, 'design_system')).toBe('refused');
  });

  it('calls a design system with a real source honoured, and a nameless one recorded', () => {
    const workDir = mkScratch('smith-stack-dsok-');
    writeFileSync(path.join(workDir, 'tokens.css'), ':root {}\n', 'utf8');
    expect(
      supportOf(
        checkStack(answers({ designSystem: 'acme-ds', designSystemSource: workDir })),
        'design_system',
      ),
    ).toBe('honoured');
    // Named but not vendored: the uiux agent still grounds specs in it, and
    // nothing is copied. That is a real configuration, not a mistake.
    expect(supportOf(checkStack(answers({ designSystem: 'acme-ds' })), 'design_system')).toBe(
      'recorded',
    );
  });
});

describe('requireScaffoldable', () => {
  it('lets the shipped answers through, with and without --ui', () => {
    expect(() => requireScaffoldable(loadStackAnswers(), { ui: false })).not.toThrow();
    expect(() => requireScaffoldable(answers({ frontend: 'vue' }), { ui: true })).not.toThrow();
    expect(() =>
      requireScaffoldable(answers({ frontend: 'vue', styling: 'tailwind' }), { ui: true }),
    ).not.toThrow();
  });

  it('refuses a language the base template is not written in', () => {
    expect(() => requireScaffoldable(answers({ language: 'python' }), { ui: false })).toThrow(
      StackError,
    );
  });

  it('does not hold a frontend answer against a library project', () => {
    // A plain `smith new` scaffolds no UI at all, so a frontend the templates
    // cannot build is nothing to it — refusing here would block work the
    // scaffold does perfectly well.
    expect(() =>
      requireScaffoldable(answers({ frontend: 'react', styling: 'vanilla-extract' }), {
        ui: false,
      }),
    ).not.toThrow();
  });

  it('refuses --ui when no frontend was chosen, and says which answer to change', () => {
    expect(() => requireScaffoldable(answers({ frontend: 'none' }), { ui: true })).toThrow(
      /frontend: none/,
    );
  });

  it('refuses rather than substituting the framework it happens to ship', () => {
    // The failure this exists to prevent: answering `react` at install time
    // and being handed a Vue project, which reads as the factory ignoring the
    // interview it just ran.
    expect(() => requireScaffoldable(answers({ frontend: 'react' }), { ui: true })).toThrow(
      /react/,
    );
    expect(() =>
      requireScaffoldable(answers({ frontend: 'vue', styling: 'vanilla-extract' }), { ui: true }),
    ).toThrow(/vanilla-extract/);
  });
});
