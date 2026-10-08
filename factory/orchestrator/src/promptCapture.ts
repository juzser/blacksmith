/**
 * Where an operator prompt is recorded, decided from the working directory.
 *
 * The UserPromptSubmit hook reaches this through two entries (`promptHook.ts`
 * and `bs prompt capture`), and bs-mod asks the same resolver through
 * `bs-prompt-hook --resolve`, so "is this cwd a store" has one answer. The
 * import graph is kept small on purpose: no db layer, no `cli.ts`.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { readEnv } from './env.js';
import {
  appendWithin,
  type EventInput,
  listSessionIds,
  ROOT_EVENT_TYPE,
  readEvents,
  type StoredEvent,
} from './events.js';
import {
  IS_CLONE,
  REPO_ROOT,
  resolveProjectsDir,
  resolveWorkRoot,
  roadmapReadPath,
} from './paths.js';
import { factoryProjects } from './projects.js';
import { isHarnessText } from './prompts.js';
import { gitTop, hasEvents, storeRootAt } from './storeRoot.js';

/** Which rule found the store. M3 is `/bs` run where the work root already has one. */
export type CaptureRule = 'M1' | 'M2' | 'M3' | 'M4';

export interface CaptureStore {
  /** The `state/events` directory the prompt goes into. */
  eventsDir: string;
  /** The declared project name; set by M4 only. */
  project?: string;
  rule: CaptureRule;
}

export interface ResolveCaptureInput {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  /** The factory clone (or installed package) the running bin belongs to. */
  repoRoot: string;
  /** `paths.ts` IS_CLONE: whether `repoRoot` holds a `.git`. */
  isClone: boolean;
  /** The factory roadmap, i.e. `roadmapReadPath()`. */
  roadmapPath: string;
  /** The prompt's `/command` token, when it has one (M3 reads it). */
  command?: string;
}

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The checkout's own roadmap, read only after M1 and M2 miss (Q5b). */
const overlayRoadmapAt = (top: string): string =>
  path.join(top, '.blacksmith', 'factory', 'specs', 'roadmap.md');

/** The name a roadmap gives the checkout at `top`, or undefined. Never throws. */
function declaredAs(
  top: string,
  roadmapPath: string,
  roots: readonly string[],
): string | undefined {
  const want = realOr(top);
  const ref = factoryProjects({ roadmapPath, roots }).find(
    (r) => !r.self && realOr(r.dir) === want,
  );
  return ref?.name;
}

/**
 * M1, M2, M4, M3 in that order; null when the cwd is not managed. Reads the
 * environment, the file system and the roadmaps and writes nothing.
 */
export function resolveCaptureStore(input: ResolveCaptureInput): CaptureStore | null {
  const { cwd, env, repoRoot, isClone } = input;
  const declaredHome = readEnv(env, 'BS_HOME')?.trim();
  const workRoot = resolveWorkRoot(repoRoot, cwd, env, isClone);

  // M1: BS_HOME names a store that exists.
  if (declaredHome && hasEvents(workRoot)) {
    return { eventsDir: path.join(workRoot, 'state', 'events'), rule: 'M1' };
  }

  // M2: the checkout (or the main clone of a linked worktree) has a store.
  const top = gitTop(cwd);
  const own = top === null ? null : storeRootAt(top);
  if (own !== null) return { eventsDir: path.join(own.root, 'state', 'events'), rule: 'M2' };

  // M4: the factory's roadmap declares this checkout. A BS_HOME with no store
  // means `bs` itself would write elsewhere, so it is a no-op rather than a
  // fallback into the clone.
  if (top !== null && isClone && !declaredHome && hasEvents(repoRoot)) {
    const roots = [
      resolveProjectsDir(repoRoot, cwd, isClone),
      path.join(resolveWorkRoot(repoRoot, cwd, env, isClone), 'workspaces'),
    ];
    let project = declaredAs(top, input.roadmapPath, roots);
    const overlay = overlayRoadmapAt(top);
    if (project === undefined && existsSync(overlay)) project = declaredAs(top, overlay, roots);
    if (project !== undefined) {
      return { eventsDir: path.join(repoRoot, 'state', 'events'), project, rule: 'M4' };
    }
  }

  // M3: a bare `/bs` where the work root already has a store.
  if (input.command === 'bs' && hasEvents(workRoot)) {
    return { eventsDir: path.join(workRoot, 'state', 'events'), rule: 'M3' };
  }
  return null;
}

/** What the entries hand in besides the hook's own stdin. */
export type CaptureContext = Omit<ResolveCaptureInput, 'command'>;

/** The context both entries build from the running bin's own location. */
export const captureContext = (cwd: string, env: CaptureContext['env']): CaptureContext => ({
  cwd,
  env,
  repoRoot: REPO_ROOT,
  isClone: IS_CLONE,
  roadmapPath: roadmapReadPath(),
});

/** The `--resolve <cwd>` answer: one JSON line, or null when the cwd is not managed. */
export function resolveLine(cwd: string, ctx: CaptureContext): string | null {
  const store = resolveCaptureStore({ ...ctx, cwd });
  if (store === null || store.rule === 'M3') return null;
  return JSON.stringify({
    events_dir: store.eventsDir,
    ...(store.project === undefined ? {} : { project: store.project }),
    rule: store.rule,
  });
}

export const CLI_ID = /^[0-9a-f-]{8,64}$/i;
const COMMAND_NAME = /^[A-Za-z0-9_.:-]+$/;
const MAIN_THREAD = new Set(['user', 'operator', 'orchestrator']);
/** Wave logs belong to their wave-runner node (architecture §18 rule 4). */
const WAVE_RUNNER = 'wave-runner';
const FALLBACK_WINDOW_MS = 72 * 3600 * 1000;
const DEDUPE_MS = 10_000;
const SCAN_LIMIT = 20;

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The text an AskUserQuestion result puts on the timeline; null when no one answered. */
export function answerOf(
  result: Obj,
): { prompt: string; answers: Obj[]; response?: string } | null {
  const answers = isObj(result.answers) ? result.answers : {};
  const annotations = isObj(result.annotations) ? result.annotations : {};
  const questions = Array.isArray(result.questions) ? result.questions.filter(isObj) : [];
  const rows: Obj[] = [];
  for (const q of questions) {
    const question = str(q.question);
    const answer = question === undefined ? undefined : str(answers[question]);
    if (question === undefined || answer === undefined || answer === '') continue;
    const notes = isObj(annotations[question])
      ? str((annotations[question] as Obj).notes)
      : undefined;
    rows.push({
      question,
      header: str(q.header) ?? question,
      answer,
      ...(notes === undefined || notes === '' ? {} : { notes }),
    });
  }
  const response = str(result.response);
  const free = response === undefined || response === '' ? undefined : response;
  if (rows.length === 0 && free === undefined) return null;
  const prompt =
    rows.length > 0 ? rows.map((r) => `${r.header}: ${r.answer}`).join('\n') : (free as string);
  return { prompt, answers: rows, ...(free === undefined ? {} : { response: free }) };
}

/** `/bs-mod off` -> `bs-mod`; no `command` for text that is not a command name. */
export function commandOf(text: string): string | undefined {
  if (!text.startsWith('/')) return undefined;
  const token = /^\/(\S*)/.exec(text)?.[1] ?? '';
  return COMMAND_NAME.test(token) ? token : undefined;
}

export const newestMain = (events: readonly StoredEvent[], cli: string): StoredEvent | undefined =>
  [...events]
    .reverse()
    .find((e) => e.record.cli_session_id === cli && MAIN_THREAD.has(e.record.actor));

/** The epic main log this CLI session is driving, or null (design §2.1, target log). */
async function findMainLog(
  eventsDir: string,
  cli: string,
  floorMs: number,
): Promise<string | null> {
  const logs = listSessionIds(eventsDir)
    .map((id) => {
      try {
        return {
          id,
          file: path.join(eventsDir, `${id}.jsonl`),
          mtime: statSync(path.join(eventsDir, `${id}.jsonl`)).mtimeMs,
        };
      } catch {
        return null;
      }
    })
    .filter(
      (l): l is { id: string; file: string; mtime: number } => l !== null && l.mtime >= floorMs,
    )
    .sort((a, b) => b.mtime - a.mtime);

  let best: { id: string; ts: string } | null = null;
  let stamped = 0;
  for (const log of logs) {
    if (stamped >= SCAN_LIMIT) break;
    try {
      if (!readFileSync(log.file, 'utf8').includes(cli)) continue;
      stamped++;
      const events = await readEvents(log.id, { stateDir: eventsDir });
      if (events[0]?.record.actor === WAVE_RUNNER) continue;
      if (events.some((e) => e.record.event_type === 'epic-closed')) continue;
      const hit = newestMain(events, cli);
      if (hit !== undefined && (best === null || hit.record.ts > best.ts)) {
        best = { id: log.id, ts: hit.record.ts };
      }
    } catch {
      // An unreadable log is not a candidate.
    }
  }
  return best?.id ?? null;
}

/**
 * Record one UserPromptSubmit hook payload. Returns the single stdout line on
 * a write, null when nothing was written (not managed, skipped, duplicate,
 * malformed). Throws only on a store failure; the entries swallow it.
 * `answer` mode takes a PostToolUse AskUserQuestion payload instead and files
 * the operator's answers as a `user_prompt` (design §2.8).
 */
export async function capturePrompt(
  raw: string,
  ctx: CaptureContext,
  mode: 'prompt' | 'answer' = 'prompt',
): Promise<string | null> {
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    input = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const { session_id: cli } = input;
  if (typeof cli !== 'string' || !CLI_ID.test(cli)) return null;
  if (input.agent_id !== undefined) return null;

  let prompt: string;
  let promptId = typeof input.prompt_id === 'string' ? input.prompt_id : undefined;
  let extra: Record<string, unknown> = {};
  if (mode === 'answer') {
    const result = input.tool_response;
    if (input.tool_name !== 'AskUserQuestion' || !isObj(result)) return null;
    if (typeof input.tool_use_id !== 'string' || input.tool_use_id === '') return null;
    // A timeout answered nothing: no human chose.
    if (result.afkTimeoutMs !== undefined && result.afkTimeoutMs !== null) return null;
    const got = answerOf(result);
    if (got === null || isHarnessText(got.prompt)) return null;
    prompt = got.prompt;
    promptId = input.tool_use_id;
    extra = {
      kind: 'answer',
      answers: got.answers,
      ...(got.response === undefined ? {} : { response: got.response }),
    };
  } else {
    if (typeof input.prompt !== 'string' || isHarnessText(input.prompt)) return null;
    prompt = input.prompt;
  }

  const command = mode === 'answer' ? undefined : commandOf(prompt);
  const cwd = typeof input.cwd === 'string' ? input.cwd : ctx.cwd;
  const store = resolveCaptureStore({ ...ctx, cwd, command });
  if (store === null) return null;
  const { eventsDir, project: declared } = store;

  let floorMs = Date.now() - FALLBACK_WINDOW_MS;
  if (typeof input.transcript_path === 'string') {
    try {
      floorMs = statSync(input.transcript_path).birthtimeMs;
    } catch {
      // Keep the 72 h fallback.
    }
  }
  const home = `prompts-${cli}`;
  const found = await findMainLog(eventsDir, cli, floorMs);

  const write = (target: string) =>
    appendWithin(
      target,
      (existing) => {
        const nowMs = Date.now();
        const duplicate = existing.some(
          (e) =>
            e.record.event_type === 'user_prompt' &&
            ((promptId !== undefined && e.record.payload.prompt_id === promptId) ||
              (mode === 'prompt' &&
                e.record.cli_session_id === cli &&
                e.record.payload.prompt === prompt &&
                nowMs - Date.parse(e.record.ts) <= DEDUPE_MS)),
        );
        if (duplicate) return [];

        const out: EventInput[] = [];
        if (existing.length === 0) {
          out.push({
            session_id: target,
            actor: 'system',
            event_type: ROOT_EVENT_TYPE,
            plan_version: 1,
            causal_parent: null,
            payload: { kind: 'prompt-log' },
            ...(declared === undefined ? {} : { project: declared }),
          });
        }
        const parent = newestMain(existing, cli) ?? existing[0];
        const project =
          parent?.record.project ?? declared ?? (out[0]?.project as string | undefined);
        out.push({
          session_id: target,
          actor: 'user',
          event_type: 'user_prompt',
          plan_version: parent?.record.plan_version ?? 1,
          causal_parent: parent?.event_id ?? `${target}#0`,
          payload: {
            prompt,
            source: 'hook',
            ...extra,
            ...(promptId === undefined ? {} : { prompt_id: promptId }),
            ...(command === undefined ? {} : { command }),
          },
          ...(project === undefined ? {} : { project }),
        });
        return out;
      },
      { stateDir: eventsDir, cliSessionId: cli },
    );

  let target = found ?? home;
  let stored: StoredEvent[];
  try {
    stored = await write(target);
  } catch (err) {
    if (target === home) throw err;
    // The epic log the scan picked can no longer take the prompt: keep it in the home log.
    target = home;
    stored = await write(target);
  }
  const written = stored[stored.length - 1];
  if (written === undefined) return null;
  return `bs prompt capture: ${JSON.stringify({ event_id: written.event_id, session_id: target })}`;
}
