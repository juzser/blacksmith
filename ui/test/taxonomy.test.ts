import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_STATUSES } from '../../factory/orchestrator/src/agents-registry.js';
import { MILESTONE_STATUSES } from '../../factory/orchestrator/src/roadmap.js';
import {
  AGENT_STATUS_TONE,
  agentStatusKitTone,
  agentStatusTone,
  errorGroupIcon,
  findingStatusKitTone,
  findingStatusTone,
  isTaskOver,
  lessonStatusTone,
  MILESTONE_STATUS_TONE,
  milestoneStatusLabel,
  milestoneStatusTone,
  planStatusTone,
  runOutcomeKitTone,
  runStatusTone,
  severityKitTone,
  severityTone,
  TASK_STATUS_OUTCOME,
  taskOutcome,
  taskStatusKitTone,
  taskStatusTone,
} from '../src/lib/taxonomy.js';

describe('lib/taxonomy.ts — design-spec.md §3 mapping', () => {
  it('maps every task_status value per §3.1', () => {
    expect(taskStatusTone('todo')).toBe('neutral');
    expect(taskStatusTone('ready')).toBe('neutral');
    expect(taskStatusTone('in-progress')).toBe('info');
    expect(taskStatusTone('grading')).toBe('info');
    expect(taskStatusTone('reviewing')).toBe('info');
    expect(taskStatusTone('merging')).toBe('info');
    expect(taskStatusTone('blocked')).toBe('warning');
    expect(taskStatusTone('escalated')).toBe('warning');
    expect(taskStatusTone('completed')).toBe('success');
    expect(taskStatusTone('waived')).toBe('success');
    expect(taskStatusTone('failed')).toBe('danger');
    expect(taskStatusTone('superseded')).toBe('neutral');
  });

  it('falls back to neutral for an unknown task_status', () => {
    expect(taskStatusTone('not-a-real-status')).toBe('neutral');
  });

  it('TASK_STATUS_OUTCOME covers taxonomy.yml task_status exactly (fails on drift)', () => {
    // The declaration this map answers to is the policy file, not a copy of it
    // in TypeScript: a thirteenth status added there has to be classified here
    // before anything divides by it.
    const yml = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'factory',
        'policies',
        'taxonomy.yml',
      ),
      'utf8',
    );
    const declared = yml.match(/\ntask_status:\s*\[([^\]]+)\]/);
    if (!declared) throw new Error('taxonomy.yml declares no task_status list');
    const statuses = (declared[1] as string)
      .split(',')
      .map((v) => v.replace(/#.*$/, '').trim())
      .filter(Boolean);
    expect(statuses).toHaveLength(12);
    expect(Object.keys(TASK_STATUS_OUTCOME).sort()).toEqual([...statuses].sort());
  });

  it('classifies an unknown task_status as open — never as a verdict', () => {
    expect(taskOutcome('not-a-real-status')).toBe('open');
    expect(taskOutcome('completed')).toBe('passed');
    expect(taskOutcome('waived')).toBe('passed');
    expect(taskOutcome('failed')).toBe('failed');
    expect(taskOutcome('superseded')).toBe('void');
  });

  it('reads "is it over" off the outcome, for every declared status', () => {
    // The board and the flow canvas each kept their own list of the statuses
    // that mean nobody is working any more. There is one answer, and it is a
    // question about the outcome: anything that is not still open is over.
    for (const [status, outcome] of Object.entries(TASK_STATUS_OUTCOME)) {
      expect(isTaskOver(status)).toBe(outcome !== 'open');
    }
  });

  it('treats an unclassified status as still running, not as finished', () => {
    // The direction that costs nothing: a status nobody has ruled on keeps its
    // card's agent chip and its node on the canvas, where it can be seen.
    expect(isTaskOver('not-a-real-status')).toBe(false);
  });

  it('maps plan_status per §3.2', () => {
    expect(planStatusTone('draft')).toBe('neutral');
    expect(planStatusTone('in-review')).toBe('info');
    expect(planStatusTone('active')).toBe('success');
    expect(planStatusTone('superseded')).toBe('neutral');
  });

  it('maps run_status per §3.3', () => {
    expect(runStatusTone('queued')).toBe('neutral');
    expect(runStatusTone('running')).toBe('info');
    expect(runStatusTone('done')).toBe('success');
    expect(runStatusTone('dead')).toBe('danger');
  });

  it('maps severity to tone+variant per §3.4, S1 alone is bold', () => {
    expect(severityTone('S1-stop-the-line')).toEqual({ tone: 'danger', variant: 'bold' });
    expect(severityTone('S2-major')).toEqual({ tone: 'danger', variant: 'subtle' });
    expect(severityTone('S3-minor')).toEqual({ tone: 'warning', variant: 'subtle' });
    expect(severityTone('S4-nit')).toEqual({ tone: 'neutral', variant: 'subtle' });
  });

  it('maps finding_status per §3.5', () => {
    expect(findingStatusTone('raised')).toBe('info');
    expect(findingStatusTone('fix-pending')).toBe('info');
    expect(findingStatusTone('fix-landed')).toBe('info');
    expect(findingStatusTone('confirmed')).toBe('warning');
    expect(findingStatusTone('fix-verified')).toBe('success');
    expect(findingStatusTone('waived')).toBe('success');
    expect(findingStatusTone('refuted')).toBe('neutral');
    expect(findingStatusTone('expired')).toBe('neutral');
    // D-127 added two statuses to taxonomy.yml. Without entries here both fall
    // through to `?? 'neutral'`, so an open S1 spec finding waiting on its
    // amendment renders as inert as a refuted one.
    expect(findingStatusTone('amend-pending')).toBe('warning'); // open, blocking
    expect(findingStatusTone('amended')).toBe('success'); // terminal, discharged
  });

  it('maps lesson_status per §3.6', () => {
    expect(lessonStatusTone('candidate')).toBe('neutral');
    expect(lessonStatusTone('novelty-rejected')).toBe('neutral');
    expect(lessonStatusTone('superseded')).toBe('neutral');
    expect(lessonStatusTone('pending-approval')).toBe('warning');
    expect(lessonStatusTone('approved')).toBe('success');
    expect(lessonStatusTone('invalidated')).toBe('danger');
  });

  it('maps roadmap.md MilestoneStatus (planned/in-progress/completed) — NOT plan_status', () => {
    expect(milestoneStatusTone('planned')).toBe('neutral');
    expect(milestoneStatusTone('in-progress')).toBe('info');
    expect(milestoneStatusTone('completed')).toBe('success');
  });

  it('MILESTONE_STATUS_TONE covers roadmap.ts MILESTONE_STATUSES exactly (fails on drift)', () => {
    expect(Object.keys(MILESTONE_STATUS_TONE).sort()).toEqual([...MILESTONE_STATUSES].sort());
  });

  it('humanizes roadmap.md MilestoneStatus for display (fix round 1 #4)', () => {
    expect(milestoneStatusLabel('planned')).toBe('Planned');
    expect(milestoneStatusLabel('in-progress')).toBe('In progress');
    expect(milestoneStatusLabel('completed')).toBe('Done');
    expect(milestoneStatusLabel('unknown-status')).toBe('unknown-status');
  });

  it('maps agents.status (live/done/error/superseded) — NOT run_status', () => {
    expect(agentStatusTone('live')).toBe('info');
    expect(agentStatusTone('done')).toBe('success');
    expect(agentStatusTone('error')).toBe('danger');
    expect(agentStatusTone('superseded')).toBe('neutral');
  });

  it('AGENT_STATUS_TONE covers agents-registry.ts AGENT_STATUSES exactly (fails on drift)', () => {
    expect(Object.keys(AGENT_STATUS_TONE).sort()).toEqual([...AGENT_STATUSES].sort());
  });

  it('maps every error group to an icon per §3.7, never a colour', () => {
    expect(errorGroupIcon('spec')).toBe('file-text');
    expect(errorGroupIcon('contract')).toBe('file-check');
    expect(errorGroupIcon('execution')).toBe('play');
    expect(errorGroupIcon('integration')).toBe('git-merge');
    expect(errorGroupIcon('economy')).toBe('coins');
    expect(errorGroupIcon('judgment')).toBe('scale');
    expect(errorGroupIcon('coordination')).toBe('users');
    expect(errorGroupIcon('memory')).toBe('database');
  });
});

describe('lib/taxonomy.ts — taskStatusKitTone() (DS3 §1.1 kit Tag tone)', () => {
  it('maps the done pair', () => {
    expect(taskStatusKitTone('completed')).toBe('done');
    expect(taskStatusKitTone('waived')).toBe('done');
  });

  it('maps the review trio', () => {
    expect(taskStatusKitTone('reviewing')).toBe('review');
    expect(taskStatusKitTone('grading')).toBe('review');
    expect(taskStatusKitTone('merging')).toBe('review');
  });

  it('maps the progress pair', () => {
    expect(taskStatusKitTone('in-progress')).toBe('progress');
    expect(taskStatusKitTone('ready')).toBe('progress');
  });

  it('maps todo and the blocked pair', () => {
    expect(taskStatusKitTone('todo')).toBe('todo');
    expect(taskStatusKitTone('blocked')).toBe('blocked');
    expect(taskStatusKitTone('escalated')).toBe('blocked');
  });

  it('maps failed to danger and superseded to neutral', () => {
    expect(taskStatusKitTone('failed')).toBe('danger');
    expect(taskStatusKitTone('superseded')).toBe('neutral');
  });

  it('falls back to neutral for an unclassified status', () => {
    expect(taskStatusKitTone('invented-tomorrow')).toBe('neutral');
  });
});

describe('lib/taxonomy.ts — severityKitTone/findingStatusKitTone/agentStatusKitTone (DS3 item 4)', () => {
  it('maps severity to kit tone + variant, S1 alone is bold', () => {
    expect(severityKitTone('S1-stop-the-line')).toEqual({ tone: 'danger', variant: 'bold' });
    expect(severityKitTone('S2-major')).toEqual({ tone: 'danger', variant: 'subtle' });
    expect(severityKitTone('S3-minor')).toEqual({ tone: 'warning', variant: 'subtle' });
    expect(severityKitTone('S4-nit')).toEqual({ tone: 'neutral', variant: 'subtle' });
  });

  it('falls back to neutral/subtle for an unclassified severity', () => {
    expect(severityKitTone('invented-tomorrow')).toEqual({ tone: 'neutral', variant: 'subtle' });
  });

  it('maps finding_status onto the kit tone set', () => {
    expect(findingStatusKitTone('raised')).toBe('progress');
    expect(findingStatusKitTone('confirmed')).toBe('warning');
    expect(findingStatusKitTone('amend-pending')).toBe('warning');
    expect(findingStatusKitTone('amended')).toBe('done');
    expect(findingStatusKitTone('fix-verified')).toBe('done');
    expect(findingStatusKitTone('waived')).toBe('done');
    expect(findingStatusKitTone('refuted')).toBe('neutral');
    expect(findingStatusKitTone('expired')).toBe('neutral');
  });

  it('maps agents.status onto the kit tone set — NOT run_status', () => {
    expect(agentStatusKitTone('live')).toBe('progress');
    expect(agentStatusKitTone('done')).toBe('done');
    expect(agentStatusKitTone('error')).toBe('danger');
    expect(agentStatusKitTone('superseded')).toBe('neutral');
    expect(agentStatusKitTone('abandoned')).toBe('neutral');
  });
});

describe('lib/taxonomy.ts — runOutcomeKitTone() (RunHistoryTimeline part 2 fix)', () => {
  it('follows the outcome, not the kind, for a failed result', () => {
    expect(runOutcomeKitTone('result', 'dead')).toBe('danger');
  });

  it('keeps the done tone for a successful result', () => {
    expect(runOutcomeKitTone('result', 'done')).toBe('done');
  });

  it('an error row is always danger, whatever its outcome text names', () => {
    expect(runOutcomeKitTone('error', 'spec.schema-invalid')).toBe('danger');
    expect(runOutcomeKitTone('error', null)).toBe('danger');
  });

  it('dispatch and judge-report keep their own default tone when outcome names no failure', () => {
    expect(runOutcomeKitTone('dispatch', null)).toBe('progress');
    expect(runOutcomeKitTone('judge-report', 'no-findings')).toBe('review');
    expect(runOutcomeKitTone('judge-report', '2-findings')).toBe('review');
  });

  it('a judge-verdict row keeps the review tone unless its outcome names a failure', () => {
    expect(runOutcomeKitTone('judge-verdict', 'refute')).toBe('review');
    expect(runOutcomeKitTone('judge-verdict', null)).toBe('review');
  });

  it('falls back to neutral for an unknown kind', () => {
    expect(runOutcomeKitTone('invented', null)).toBe('neutral');
  });
});
