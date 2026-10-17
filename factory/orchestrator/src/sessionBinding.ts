/** The pure rules of a session binding (epic bs-use); nothing here refuses or holds a turn. No db, cli or usage imports, so the hook stays light. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { EventInput, EventRecord, StoredEvent } from './events.js';
import {
  OVERLAY_ROOT,
  REPO_ROOT,
  resolveOverlayRead,
  resolveProjectsDir,
  resolveWorkRoot,
  SESSION_BINDING_POLICY_DEFAULT_PATH,
  SESSION_BINDING_POLICY_PATH,
} from './paths.js';
import { normalizeProjectName } from './projectName.js';
import { factoryProjects } from './projects.js';

export const SESSION_BOUND_EVENT_TYPE = 'session-bound';
export const BYPASS_APPROVED_EVENT_TYPE = 'pipeline-bypass-approved';
export const HOOK_ONLY_EVENT_TYPES: readonly string[] = [
  SESSION_BOUND_EVENT_TYPE,
  BYPASS_APPROVED_EVENT_TYPE,
];

export const BYPASS_HEADER = 'Small change';
export const BYPASS_YES = 'Yes, skip the pipeline';
export const REMINDER_PREFIX = 'bs use: ';
export const BINDING_TAIL_BYTES = 1048576;

const POLICY_FILE = ['factory', 'policies', 'session-binding.yml'];

export { SESSION_BINDING_POLICY_DEFAULT_PATH, SESSION_BINDING_POLICY_PATH };

/** The operator's copy when it exists, else the shipped file. */
export function bindingPolicyReadPath(
  roots: { repoRoot: string; overlayRoot: string },
  exists?: (file: string) => boolean,
): string {
  return resolveOverlayRead(
    path.join(roots.overlayRoot, ...POLICY_FILE),
    path.join(roots.repoRoot, ...POLICY_FILE),
    exists,
  );
}

export interface BindingPolicy {
  maxFiles: number;
  maxChangedLines: number;
}

export type BindingPolicyRead =
  | { ok: true; policy: BindingPolicy }
  | { ok: false; file: string; problem: 'missing' | 'invalid' };

const positiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

/** Reads the policy; never throws. */
export function loadBindingPolicy(
  file: string = bindingPolicyReadPath({ repoRoot: REPO_ROOT, overlayRoot: OVERLAY_ROOT }),
): BindingPolicyRead {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { ok: false, file, problem: existsSync(file) ? 'invalid' : 'missing' };
  }
  try {
    const doc: unknown = parseYaml(text);
    const obj = doc !== null && typeof doc === 'object' ? (doc as Record<string, unknown>) : {};
    const { max_files: maxFiles, max_changed_lines: maxChangedLines } = obj;
    if (positiveInt(maxFiles) && positiveInt(maxChangedLines)) {
      return { ok: true, policy: { maxFiles, maxChangedLines } };
    }
  } catch {
    // Falls through to invalid.
  }
  return { ok: false, file, problem: 'invalid' };
}

/** `/bs use <project>` gives {name}, a bare `/bs use` {name: null}, anything else null. */
export function parseUseCommand(prompt: string): { name: string | null } | null {
  const m = /^\/bs use(?:\s+(\S+))?(?:\s|$)/.exec(prompt);
  return m === null ? null : { name: m[1] ?? null };
}

/** The known list's own spelling of `name`, comparing through the legacy mapping. */
export function matchProject(name: string, known: readonly string[]): string | undefined {
  const want = normalizeProjectName(name);
  return known.find((k) => normalizeProjectName(k) === want);
}

/** Known project names under the roots the capture hook's M4 rule uses; [] on failure. */
export function knownProjectNames(input: {
  repoRoot: string;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  isClone: boolean;
  roadmapPath: string;
}): string[] {
  const { repoRoot, cwd, env, isClone, roadmapPath } = input;
  try {
    const roots = [
      resolveProjectsDir(repoRoot, cwd, isClone),
      path.join(resolveWorkRoot(repoRoot, cwd, env, isClone), 'workspaces'),
    ];
    return factoryProjects({ roadmapPath, roots }).map((r) => r.name);
  } catch {
    return [];
  }
}

const bindingProject = (r: EventRecord): string | undefined =>
  typeof r.payload.project === 'string' ? r.payload.project : r.project;

export function newestBinding(
  events: readonly StoredEvent[],
  cli: string,
): { project: string; eventId: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as StoredEvent;
    if (e.record.event_type !== SESSION_BOUND_EVENT_TYPE || e.record.cli_session_id !== cli) {
      continue;
    }
    const project = bindingProject(e.record);
    if (project !== undefined) return { project, eventId: e.event_id };
  }
  return undefined;
}

/**
 * The same answer from the end of a log alone. A stamped hook prompt carries
 * `bound_to`, so a tail with no `session-bound` record still knows the binding.
 */
export function bindingFromTail(
  records: readonly EventRecord[],
  cli: string,
): { project: string } | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i] as EventRecord;
    if (r.cli_session_id !== cli) continue;
    if (r.event_type === SESSION_BOUND_EVENT_TYPE) {
      const project = bindingProject(r);
      if (project !== undefined) return { project };
      continue;
    }
    if (r.event_type === 'user_prompt' && r.payload.source === 'hook') {
      const bound = r.payload.bound_to;
      if (typeof bound !== 'string') return undefined;
      return { project: r.project ?? bound };
    }
  }
  return undefined;
}

interface BuilderBase {
  target: string;
  project: string;
  causalParent: string;
  planVersion: number;
}

export function bindingInput(input: BuilderBase & { promptId?: string }): EventInput {
  return {
    session_id: input.target,
    actor: 'user',
    event_type: 'session-bound',
    plan_version: input.planVersion,
    causal_parent: input.causalParent,
    payload: {
      project: input.project,
      source: 'hook',
      ...(input.promptId === undefined ? {} : { prompt_id: input.promptId }),
    },
    project: input.project,
  };
}

export function bypassInput(
  input: BuilderBase & { promptId: string; question: string },
): EventInput {
  return {
    session_id: input.target,
    actor: 'user',
    event_type: 'pipeline-bypass-approved',
    plan_version: input.planVersion,
    causal_parent: input.causalParent,
    payload: {
      project: input.project,
      question: input.question,
      answer: BYPASS_YES,
      prompt_id: input.promptId,
    },
    project: input.project,
  };
}

export function bypassRow(
  rows: readonly Record<string, unknown>[],
): { question: string } | undefined {
  for (const row of rows) {
    const { header, answer, question } = row;
    if (header !== BYPASS_HEADER || answer !== BYPASS_YES) continue;
    if (typeof question === 'string' && question.trim() !== '') return { question };
  }
  return undefined;
}

const line = (text: string): string => `${REMINDER_PREFIX}${text}`;

export function reminderLines(project: string, read: BindingPolicyRead): string[] {
  const bound = line(`this session is bound to ${project}.`);
  if (!read.ok) {
    return [
      bound,
      line(
        `the policy file ${read.file} is ${read.problem}, so no small-change bypass is available this turn; every change goes through /bs plan and /bs run.`,
      ),
    ];
  }
  const { maxFiles, maxChangedLines } = read.policy;
  return [
    bound,
    line('questions are free; every change goes through /bs plan and /bs run.'),
    line(
      `a small change may skip the pipeline: at most ${maxFiles} files and ${maxChangedLines} changed lines. Ask with AskUserQuestion, header "${BYPASS_HEADER}", answer "${BYPASS_YES}"; the question must name the files the change touches and its estimated changed lines.`,
    ),
    line(
      'one yes covers one change and a second change asks again. The yes is recorded. Nothing is blocked.',
    ),
  ];
}

export function unknownProjectLines(known: readonly string[]): string[] {
  return [
    line('that name is not a project this factory knows.'),
    line(`known projects: ${known.length === 0 ? 'none' : known.join(', ')}.`),
  ];
}

export function notRecordedLines(): string[] {
  return [
    line(
      'the binding could not be recorded from this directory; any earlier binding is unchanged.',
    ),
  ];
}
