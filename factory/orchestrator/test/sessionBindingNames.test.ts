import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Hermetic name scan for epic bs-use: it reads repo files and its own inline
// samples, never a roadmap, the overlay or git history, so CI and a
// workstation agree. The factory's own name is read from code, never typed.
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SELF = 'factory/orchestrator/test/sessionBindingNames.test.ts';

const ADDED = [
  'factory/orchestrator/src/sessionBinding.ts',
  'factory/orchestrator/test/sessionBinding.test.ts',
  'factory/policies/session-binding.yml',
  'factory/orchestrator/test/promptCaptureBinding.test.ts',
  'factory/orchestrator/src/bindingReminder.ts',
  'factory/orchestrator/test/bindingReminder.test.ts',
  '.claude/skills/bs/use.md',
  'factory/orchestrator/test/skillUse.test.ts',
  'factory/orchestrator/test/eventAppendHookOnly.test.ts',
  'factory/orchestrator/test/db/cliSessionBinding.test.ts',
  'factory/orchestrator/test/sessionBindingFlow.test.ts',
];

// Files this plan edits that already existed before it (a closed list).
const EDITED = [
  '.claude/skills/bs/SKILL.md',
  'factory/orchestrator/src/cli.ts',
  'factory/orchestrator/src/db/queries.ts',
  'factory/orchestrator/src/paths.ts',
  'factory/orchestrator/src/promptCapture.ts',
  'factory/orchestrator/src/promptHook.ts',
  'factory/orchestrator/test/helpers/eventTypeScan.ts',
  'factory/orchestrator/test/packaging.test.ts',
  'factory/orchestrator/test/promptHookEntry.test.ts',
  'ui/server/src/cliSessions.ts',
  'ui/server/test/cliSessions.test.ts',
  'ui/src/lib/timelineDisplay.ts',
  'ui/test/timelineDisplay.test.ts',
  'ui/src/lib/liveSessions.ts',
  'ui/test/liveSessions.test.ts',
  'ui/e2e/home.spec.ts',
  'README.md',
  'docs/guide/operator-loop.md',
  'docs/guide/operator-guide/queue-and-gate.md',
  'CLAUDE.md',
  'AGENTS.md',
  'docs/guide/dashboard.md',
];

const USE_ARGS = new Set(['project-a', 'project-b', '<project>', 'nothing-here']);
const PROJECT_VALUES = new Set(['project-a', 'project-b', '<project>']);

type Hit = { line: number; value: string };

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** The token after `/bs use` and spaces. */
function useArguments(text: string): Hit[] {
  return [...text.matchAll(/\/bs use[ ]+([A-Za-z0-9<>_.-]+)/g)].map((m) => ({
    line: lineOf(text, m.index ?? 0),
    value: m[1] as string,
  }));
}

/** Quoted `project:` / `"project":` values and `- project:` line values; `$` values are skipped. */
function projectValues(text: string): Hit[] {
  const quoted = [...text.matchAll(/["']?\bproject["']?\s*:\s*(["'])([^"']*)\1/g)].map((m) => ({
    line: lineOf(text, m.index ?? 0),
    value: m[2] as string,
  }));
  const bullets = [...text.matchAll(/^\s*- project:[ ]*["']?([^\s"']+)/gm)].map((m) => ({
    line: lineOf(text, m.index ?? 0),
    value: m[1] as string,
  }));
  return [...quoted, ...bullets].filter((h) => !h.value.startsWith('$'));
}

/** Every bad value across all given files as `<file>:<line> <value>`, never stopping at the first file. */
function collect(
  files: Record<string, string>,
  reader: (text: string) => Hit[],
  allowed: Set<string>,
): string[] {
  return Object.entries(files).flatMap(([file, text]) =>
    reader(text)
      .filter((h) => !allowed.has(h.value))
      .map((h) => `${file}:${h.line} ${h.value}`),
  );
}

const read = (rels: string[]): Record<string, string> =>
  Object.fromEntries(
    rels
      .filter((f) => f !== SELF)
      .map((rel) => [rel, readFileSync(path.join(REPO_ROOT, rel), 'utf8')]),
  );

describe('project names in the files the bs-use plan adds or edits', () => {
  it('every file the plan adds exists', () => {
    const missing = ADDED.filter((rel) => !existsSync(path.join(REPO_ROOT, rel)));
    expect(missing).toEqual([]);
  });

  it('every `/bs use` argument is a placeholder or the unknown name', () => {
    expect(collect(read([...ADDED, ...EDITED]), useArguments, USE_ARGS)).toEqual([]);
  });

  it('every project value in an added file is a placeholder', () => {
    expect(collect(read(ADDED), projectValues, PROJECT_VALUES)).toEqual([]);
  });

  it('positive control: the readers find what they should and skip what they should', () => {
    const values = (hits: Hit[]) => hits.map((h) => h.value);
    expect([
      ...values(useArguments('/bs use other-name')),
      ...values(projectValues("project: 'other-name'")),
      ...values(projectValues('- project: other-name')),
    ]).toEqual(['other-name', 'other-name', 'other-name']);
    expect([
      ...values(useArguments('/bs use <project>')),
      ...values(projectValues('project: name')),
      ...values(projectValues(`project: '\${x}'`)),
    ]).toEqual(['<project>']);
  });

  it('the collector names every bad site across files, not only the first', () => {
    const files = {
      'one.md': 'ok\n/bs use bad-one',
      'two.md': '/bs use project-a\n\n/bs use bad-two',
    };
    expect(collect(files, useArguments, USE_ARGS)).toEqual([
      'one.md:2 bad-one',
      'two.md:3 bad-two',
    ]);
  });
});
