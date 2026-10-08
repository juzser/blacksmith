/**
 * Where an operator prompt is recorded, decided from the working directory.
 *
 * The UserPromptSubmit hook reaches this through two entries (`promptHook.ts`
 * and `bs prompt capture`), and bs-mod asks the same resolver through
 * `bs-prompt-hook --resolve`, so "is this cwd a store" has one answer. The
 * import graph is kept small on purpose: no db layer, no `cli.ts`.
 */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { readEnv } from './env.js';
import { resolveProjectsDir, resolveWorkRoot } from './paths.js';
import { factoryProjects } from './projects.js';
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
