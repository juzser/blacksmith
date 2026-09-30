import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SFC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'OverviewPage.vue'),
  'utf8',
);

describe('OverviewPage.vue — Budget used card sources its label from lib/format.ts', () => {
  // ui/tsconfig.json does not type-check .vue and biome.json does not lint
  // it, so the source text is the only place this card can be held to
  // formatMeasuredTokens rather than a hand-rolled reduce that folds an
  // unmeasured result (issue #220) in as a fabricated 0 (D-221's rule).
  it('imports formatMeasuredTokens rather than hand-rolling the label', () => {
    expect(SFC).toMatch(/from '\.\.\/lib\/format\.js'/);
    expect(SFC).toContain('formatMeasuredTokens(');
  });

  it('reduces tokensByEpic nowhere in the template', () => {
    expect(SFC).not.toMatch(/tokensByEpic\.reduce/);
  });

  // Task 1 (compact token numbers): the StatCard headline is now compacted
  // ("1.2K tok" rather than "1234 tok"), so the exact integer the operator
  // might still want is kept as a `title` tooltip (StatCard forwards an
  // unclaimed `title` onto its root element).
  it('keeps the exact spend available as a title tooltip', () => {
    expect(SFC).toContain('budgetUsedTitle');
    expect(SFC).toMatch(/<StatCard[^>]*:title="budgetUsedTitle"/s);
  });
});

// Task 2 (friendly role labels): a raw taxonomy string like "spec-reviewer"
// is the thing the operator finds too technical, so every role render on
// this page routes through roleLabel() — the raw `role · tier` stays
// reachable (a title tooltip on the chips; the aria-label reads it in full).
describe('OverviewPage.vue — role labels', () => {
  it('imports roleLabel from lib/roleLabels', () => {
    expect(SFC).toMatch(/from '\.\.\/lib\/roleLabels\.js'/);
  });

  it('labels the Now-running agent chip and keeps the raw role · tier as a tooltip', () => {
    expect(SFC).toContain('roleLabel(a.agentRole)');
    expect(SFC).toMatch(/:label="`\$\{roleLabel\(a\.agentRole\)\} · \$\{a\.modelTier\}`"/);
    expect(SFC).toMatch(/:title="`\$\{a\.agentRole\} · \$\{a\.modelTier\}`"/);
  });

  it('labels the recent-dispatch row title and its trailing chip', () => {
    expect(SFC).toContain('roleLabel(d.agentRole)');
    expect(SFC).toMatch(
      /:title="`\$\{roleLabel\(d\.agentRole\)\} → \$\{d\.modelTier\}\/\$\{d\.provider\}`"/,
    );
    expect(SFC).toMatch(/:label="`\$\{roleLabel\(d\.agentRole\)\} · \$\{d\.modelTier\}`"/);
  });
});

// Task 3 (dispatch reason fallback): projector.ts's own reason ?? rationale
// ?? note ?? why chain still leaves rows with genuinely no reason at all —
// those named "no reason given" almost every time. Once there truly is
// nothing, the row says what happened instead: "<role label> on <task
// label> · round N".
describe('OverviewPage.vue — dispatch reason fallback', () => {
  it('imports taskLabel from lib/format', () => {
    expect(SFC).toMatch(/taskLabel/);
  });

  it('never falls back to the literal "no reason given"', () => {
    expect(SFC).not.toContain('no reason given');
  });

  it('routes the dispatch meta line through a dispatchReasonText helper', () => {
    expect(SFC).toContain('dispatchReasonText(d)');
  });

  it('derives the helper from role label, task label and round', () => {
    expect(SFC).toMatch(/function dispatchReasonText\(/);
    expect(SFC).toContain('roleLabel(d.agentRole)');
    expect(SFC).toContain('taskLabel(d.taskId');
    expect(SFC).toContain('d.round');
  });
});
