// Which repositories this factory is responsible for.
//
// The mandate the repo is built to is two-sided -- Blacksmith maintains
// itself AND the projects it built -- and until now only the first half had an
// answer anything could read. `registerProjectInRoadmap` (scaffold.ts) writes a
// `- project: <name>` bullet into factory/specs/roadmap.md for every project
// the factory scaffolds, which makes the roadmap the register of its children
// already; nothing turned that register into the `--project <dir>` list the
// maintenance pass now accepts, so an operator who forgot one got silence.
//
// Two rules hold this file up, and both are about being wrong in the safe
// direction:
//
//   * The factory's own checkout is REPO_ROOT, never a lookup of
//     FACTORY_PROJECT under the roots. PROJECTS_DIR is this clone's PARENT,
//     and on the machine this was written on that parent holds a `black-smith`
//     directory which is a different repository with a different remote. A
//     name lookup would have the factory read somebody else's lockfile while
//     reporting that it was reading its own -- D-133's shape exactly: a
//     well-formed wrong answer is worse than a refusal.
//
//   * A declared project with no checkout is reported by nothing here. There
//     is no repo to read, so a finding about it would be one an operator
//     cannot act on and can never clear -- and daemon.ts's factory-width note
//     says what an alarm that cannot return to zero costs.
//
// Nothing in here throws. It is a reader for a watcher, and the roadmap is an
// operator-edited file: a watcher that dies over a half-written bullet is
// silent exactly when somebody is editing (D-21).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR, REPO_ROOT, WORKSPACES_DIR } from './paths.js';
import { FACTORY_PROJECT, loadRoadmap } from './roadmap.js';

/** One repository the factory is answerable for, and where it actually is. */
export interface ProjectRef {
  /** The roadmap's `- project:` value, or FACTORY_PROJECT for this clone. */
  name: string;
  /** An absolute path to a checkout that exists. */
  dir: string;
  /** This clone. True exactly once, on the first entry. */
  self: boolean;
}

export interface FactoryProjectsOptions {
  /** Defaults to the shipped `factory/specs/roadmap.md`. */
  roadmapPath?: string;
  /** Searched in order, first hit wins. Defaults to beside-this-clone, then `workspaces/`. */
  roots?: readonly string[];
}

/**
 * The factory's own clone, then every distinct project its roadmap declares
 * that has a checkout under one of the roots, in first-declared order.
 *
 * Self leads on purpose. A factory that watched its children and not itself
 * would have the same blind spot the other way round, and it is the one entry
 * that needs no roadmap and no search to be certain of.
 */
export function factoryProjects(opts: FactoryProjectsOptions = {}): ProjectRef[] {
  const roots = opts.roots ?? [PROJECTS_DIR, WORKSPACES_DIR];
  const refs: ProjectRef[] = [{ name: FACTORY_PROJECT, dir: REPO_ROOT, self: true }];

  let milestones: { project: string }[];
  try {
    milestones = opts.roadmapPath === undefined ? loadRoadmap() : loadRoadmap(opts.roadmapPath);
  } catch {
    // Unreadable or unparseable. The one thing still known is this clone, and
    // reporting that is strictly better than reporting nothing.
    return refs;
  }

  const seen = new Set<string>([FACTORY_PROJECT]);
  for (const milestone of milestones) {
    const name = milestone.project;
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = firstCheckout(name, roots);
    if (dir === null) continue;
    refs.push({ name, dir, self: false });
  }
  return refs;
}

/** The first root that actually holds a directory of this name. */
function firstCheckout(name: string, roots: readonly string[]): string | null {
  for (const root of roots) {
    const dir = path.join(root, name);
    if (existsSync(dir)) return dir;
  }
  return null;
}

/**
 * The directories a maintenance pass should read: this clone's REPO_ROOT,
 * path-resolved and present exactly once, joined with whatever `--project`
 * named -- a union, never a replacement, so `--project /elsewhere` watches
 * `/elsewhere` AND this clone rather than `/elsewhere` alone.
 *
 * `opts.self: false` is `--no-self`: the one way to leave this clone out.
 * Nothing else does -- there is no default a flag cannot be handed to say no
 * to, because a default an operator cannot refuse is policy welded shut.
 *
 * This is the one rule the three `--project` call sites in cli.ts share; none
 * of them re-derives it.
 */
export function resolveProjectDirs(
  projectDirs: readonly string[] | undefined,
  opts: { self?: boolean } = {},
): string[] {
  const resolved = (projectDirs ?? []).map((dir) => path.resolve(dir));
  const withSelf = opts.self === false ? resolved : [path.resolve(REPO_ROOT), ...resolved];
  return [...new Set(withSelf)];
}

/**
 * The repos in `refs` that `projectDirs` does not name.
 *
 * Both sides are resolved before they are compared, because the operator types
 * `--project .` and the register answers with an absolute path. Comparing what
 * was typed against what was resolved would report a repo as unwatched while
 * the maintenance pass was reading it -- a false alarm no amount of adding
 * flags could clear. This is the same reason `MaintenanceProposal.projectDir`
 * is resolved (D-42/P9-26).
 *
 * A watched directory the register does not know is not an answer this
 * function has: an operator may point the pass at anything, and this asks one
 * question only.
 */
export function unwatchedProjects(
  refs: readonly ProjectRef[],
  projectDirs: readonly string[],
): ProjectRef[] {
  const watched = new Set(projectDirs.map((dir) => path.resolve(dir)));
  return refs.filter((ref) => !watched.has(path.resolve(ref.dir)));
}
