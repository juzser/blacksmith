// Builds one dispatch brief from the plan, the store events and the shipped
// playbook. Nothing dispatch.md or results.ts defines is retyped here: the
// return discipline is cut from dispatch.md at run time and the envelope line
// is rendered from the constant the gate enforces.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readTemplateMaxTurns } from './agentsSync.js';
import { formatBriefMarker } from './briefMarker.js';
import { formatDeclaredArtifactLine, parseStatedTurns } from './dispatchLint.js';
import { SmithError } from './errors.js';
import type { EventOpts, StoredEvent } from './events.js';
import { findingsForDispatch } from './findingContext.js';
import { JUDGE_TURN_ROLES } from './judgeRoles.js';
import { lessonsForDispatch } from './lessons.js';
import { REPO_ROOT, SPECS_ACTIVE_DIR } from './paths.js';
import {
  latestPlanVersion,
  liveSpec,
  loadPlan,
  type PlanFile,
  resolveTaskId,
  type TaskSpecRecord,
} from './plan.js';
import { sliceSection } from './playbookSlice.js';
import { ORCHESTRATOR_OWNED_RESULT_FIELDS } from './results.js';
import { epicOfTaskId } from './taskId.js';

export class BriefError extends SmithError {}

/** The heading compose cuts from dispatch.md; T11 keeps it byte-identical. */
const RETURN_DISCIPLINE_HEADING = 'Return discipline (agent-interviews.md M-6)';

const SHIPPED_DISPATCH_DOC = path.join(REPO_ROOT, '.claude', 'skills', 'bs', 'dispatch.md');

/** Judges that read a task's worktree (spec-reviewer and auditor judge no worktree). */
const WORKTREE_ROLES: ReadonlySet<string> = new Set([
  'coder',
  'tester',
  ...JUDGE_TURN_ROLES.filter((role) => role !== 'spec-reviewer' && role !== 'auditor'),
]);

const JUDGE_TURN_ROLE_SET: ReadonlySet<string> = new Set(JUDGE_TURN_ROLES);

export interface ComposeBriefOptions {
  role: string;
  /** Qualified or bare; absent for an epic-level role, which then needs `epicId`. */
  taskId?: string;
  /** The epic, when `taskId` is absent or bare. */
  epicId?: string;
  /** Overrides the latest plan found under `specsDir`. */
  planFile?: string;
  specsDir?: string;
  sessionId: string;
  /** Absolute; required for a worktree role. */
  worktree?: string;
  /** Defaults to `bs/<qualified task id>`. */
  branch?: string;
  /** Refused with `brief.turns-mismatch` unless it equals the template's `maxTurns`. */
  turnBudget?: number;
  /** Absolute declared artifact; required for a judge role and uiux, ignored for any other. */
  artifactPath?: string;
  /** The recurrence events (`readRecurrenceEvents`); compose reads no store for lessons. */
  events: readonly StoredEvent[];
  now: Date;
  agentsDir?: string;
  lessonsPath?: string;
  /** Overrides the shipped dispatch.md the return discipline is cut from. */
  dispatchDoc?: string;
  /** Where the findings block reads the session log. */
  eventOpts?: EventOpts;
  /** When set, the manifest is written there as JSON, and nowhere else. */
  manifestPath?: string;
}

export interface BriefManifest {
  role: string;
  task_id: string;
  lessons_spliced: string[];
  lessons_withheld: { lesson_id: string; error_class: string }[];
  warnings: string[];
  finding_ids: string[];
  /** Bytes per section of the text, in text order. */
  sections: Record<string, number>;
  total_bytes: number;
}

function loadPlanFor(opts: ComposeBriefOptions, epicId: string): PlanFile {
  if (opts.planFile !== undefined) {
    return JSON.parse(readFileSync(opts.planFile, 'utf8')) as PlanFile;
  }
  const planOpts = { specsDir: opts.specsDir ?? SPECS_ACTIVE_DIR };
  const version = latestPlanVersion(epicId, planOpts);
  if (version === null) {
    throw new BriefError('brief.plan-not-found', `No plan file for epic "${epicId}".`, { epicId });
  }
  return loadPlan(epicId, version, planOpts);
}

function specFor(
  opts: ComposeBriefOptions,
  typed: string,
): { plan: PlanFile; spec: TaskSpecRecord } {
  const epicId = epicOfTaskId(typed) ?? opts.epicId;
  if (epicId === undefined) {
    throw new BriefError('brief.epic-required', `Bare task id "${typed}" needs an epicId.`, {
      taskId: typed,
    });
  }
  const plan = loadPlanFor(opts, epicId);
  let spec: TaskSpecRecord | undefined;
  try {
    spec = liveSpec(plan, resolveTaskId(plan, typed));
  } catch {
    spec = undefined;
  }
  if (spec === undefined) {
    throw new BriefError('brief.task-not-in-plan', `Task "${typed}" is not in the plan.`, {
      taskId: typed,
      epicId: plan.epic_id,
    });
  }
  return { plan, spec };
}

/**
 * Serves epic bs-optimize criterion 5: composes one dispatch brief in
 * dispatch.md's carry-into-the-prompt order, plus the manifest of what was
 * spliced and withheld. Throws `BriefError` (`brief.*`) or `PlaybookError`
 * rather than emit a brief that `lintDispatchPrompt` would fail.
 */
export async function composeBrief(
  opts: ComposeBriefOptions,
): Promise<{ text: string; manifest: BriefManifest }> {
  const { role } = opts;
  const agentsDir = opts.agentsDir ?? path.join(REPO_ROOT, '.claude', 'agents');
  const turns = readTemplateMaxTurns(agentsDir, role);
  if (turns === undefined) {
    throw new BriefError('brief.template-unreadable', `No readable maxTurns for role "${role}".`, {
      role,
    });
  }
  if (opts.turnBudget !== undefined && opts.turnBudget !== turns) {
    throw new BriefError(
      'brief.turns-mismatch',
      `Turn budget ${opts.turnBudget} differs from the ${role} template's maxTurns ${turns}.`,
      { role, requested: opts.turnBudget, template: turns },
    );
  }

  const needsWorktree = WORKTREE_ROLES.has(role);
  if (needsWorktree && (opts.worktree === undefined || !path.isAbsolute(opts.worktree))) {
    throw new BriefError(
      'brief.worktree-required',
      `Role "${role}" needs an absolute worktree path.`,
      { role, worktree: opts.worktree ?? null },
    );
  }
  const judgeTurn = JUDGE_TURN_ROLE_SET.has(role);
  if (judgeTurn && (opts.artifactPath === undefined || !path.isAbsolute(opts.artifactPath))) {
    throw new BriefError(
      'brief.artifact-required',
      `Role "${role}" needs an absolute declared artifact path.`,
      { role, artifactPath: opts.artifactPath ?? null },
    );
  }

  let spec: TaskSpecRecord | undefined;
  let epicId: string;
  if (opts.taskId === undefined) {
    if (opts.epicId === undefined) {
      throw new BriefError('brief.epic-required', 'An epic-level brief needs an epicId.', { role });
    }
    epicId = opts.epicId;
  } else {
    const found = specFor(opts, opts.taskId);
    spec = found.spec;
    epicId = found.plan.epic_id;
  }
  const taskId = spec?.task_id ?? epicId;
  const claims = Array.isArray(spec?.claims) ? (spec.claims as string[]) : [];
  const specsDir = opts.specsDir ?? SPECS_ACTIVE_DIR;
  const budget = (spec?.budget ?? {}) as { tokens?: number; diff_lines?: number };

  const lessons = lessonsForDispatch(role, claims, {
    agentsDir,
    ...(opts.lessonsPath !== undefined ? { lessonsPath: opts.lessonsPath } : {}),
    ...(typeof spec?.case === 'string' ? { caseType: spec.case } : {}),
    events: opts.events,
    epicId,
    now: opts.now,
    full: true,
  });
  const findings = await findingsForDispatch(
    { sessionId: opts.sessionId, ...(spec ? { taskId: taskId } : {}), claims },
    opts.eventOpts ?? {},
  );
  const returnDiscipline = sliceSection(
    readFileSync(opts.dispatchDoc ?? SHIPPED_DISPATCH_DOC, 'utf8'),
    RETURN_DISCIPLINE_HEADING,
  );

  const sections: [string, string][] = [];
  const add = (name: string, text: string | null) => {
    if (text !== null) sections.push([name, text]);
  };
  add(
    'header',
    [
      formatBriefMarker({ role, taskId, sessionId: opts.sessionId }),
      `Role: ${role}. Task: ${taskId}`,
      ...(needsWorktree
        ? [`Worktree (absolute): ${opts.worktree}`, `Branch: ${opts.branch ?? `bs/${taskId}`}`]
        : []),
    ].join('\n'),
  );
  add(
    'spec',
    spec ? `Task spec (verbatim from the plan):\n${JSON.stringify(spec, null, 2)}` : null,
  );
  add(
    'claims',
    spec
      ? `Claims (the only paths you may touch):\n${claims.map((c) => `- ${c}`).join('\n')}`
      : null,
  );
  add(
    'limits',
    [
      ...(budget.tokens !== undefined ? [`Token cap: ${budget.tokens}`] : []),
      ...(budget.diff_lines !== undefined ? [`Diff cap: ${budget.diff_lines} lines`] : []),
      `Turn budget: ${turns}`,
    ].join('\n'),
  );
  add('epic_spec', `Read first: ${path.resolve(specsDir, epicId, 'epic-spec.md')}`);
  add('lessons', lessons.text);
  add('findings', findings.text);
  add('return_discipline', returnDiscipline);
  add(
    'envelope',
    `Result envelope: never write these fields, the dispatcher stamps them: ${ORCHESTRATOR_OWNED_RESULT_FIELDS.join(', ')}.`,
  );
  if (judgeTurn && opts.worktree !== undefined && needsWorktree) {
    const before = `${opts.artifactPath}.before.json`;
    add(
      'fingerprint',
      `Worktree fingerprint, run by the dispatcher around this judge:\nbs worktree fingerprint ${opts.worktree} > ${before}\nbs worktree verify ${opts.worktree} --before ${before}`,
    );
  }
  if (judgeTurn) add('artifact', formatDeclaredArtifactLine(opts.artifactPath as string));

  const text = `${sections.map(([, body]) => body).join('\n\n')}\n`;
  // The lint reads one occurrence, or among several the single standalone
  // line (ours); spliced text that adds a second standalone line would pass
  // here and fail there, so refuse it.
  if (parseStatedTurns(text) !== turns) {
    throw new BriefError(
      'brief.turn-budget-ambiguous',
      'The brief carries another standalone "Turn budget:" line in spliced text, so the lint cannot read one number.',
      { role, taskId },
    );
  }

  const manifest: BriefManifest = {
    role,
    task_id: taskId,
    lessons_spliced: (lessons.lessons ?? []).map((l) => l.lessonId),
    lessons_withheld: lessons.withheld,
    warnings: lessons.warnings,
    finding_ids: findings.findings.map((f) => f.finding_id),
    sections: Object.fromEntries(sections.map(([name, body]) => [name, Buffer.byteLength(body)])),
    total_bytes: Buffer.byteLength(text),
  };
  if (opts.manifestPath !== undefined) {
    mkdirSync(path.dirname(opts.manifestPath), { recursive: true });
    writeFileSync(opts.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return { text, manifest };
}
