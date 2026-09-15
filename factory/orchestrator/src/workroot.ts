import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT,
  ROADMAP_DEFAULT_PATH,
  ROADMAP_PATH,
  SPECS_ACTIVE_DIR,
  STACK_POLICY_DEFAULT_PATH,
  STATE_ARTIFACTS_DIR,
  STATE_EVENTS_DIR,
  WORK_ROOT,
} from './paths.js';

// ---------------------------------------------------------------------------
// The work root, made to exist.
//
// `paths.ts` says where everything lives; this module is the one place that
// creates it. The distinction matters under an npm install, where the package
// directory and the work root are two different places: the tarball carries
// the factory's read-only assets, and the operator's own repository carries
// `.blacksmith/` -- the state the CLI writes and the two files the operator
// personalises. Nothing in the tarball may be written, because the next
// `npm i` replaces it wholesale.
//
// In a clone the two roots are the same directory and every function here is
// a no-op that reports it. That is not a degenerate case to be tolerated, it
// is the property that makes this safe to add mid-flight: an existing checkout
// behaves exactly as it did before this module existed.
// ---------------------------------------------------------------------------

/** What happened to one overlay file. */
export type SeedStatus = 'seeded' | 'kept' | 'missing-default';

export interface SeedResult {
  /** The copy that is read and written -- under the work root. */
  readonly personal: string;
  /** The copy that ships -- under the package. */
  readonly shipped: string;
  readonly status: SeedStatus;
}

/**
 * The files `paths.ts` declares twice: a default that ships and a copy the
 * operator then edits. Spelled relative to their own root, because the pairing
 * rule -- enforced in packaging.test.ts -- is that both halves are the same
 * relative path under two roots, which is what lets seeding be a plain copy.
 *
 * Derived from the constants rather than retyped, so a third overlay file
 * added to `paths.ts` is seeded without anyone remembering to edit this list.
 */
export const OVERLAY_FILES: readonly string[] = [
  path.relative(REPO_ROOT, ROADMAP_DEFAULT_PATH),
  path.relative(REPO_ROOT, STACK_POLICY_DEFAULT_PATH),
];

// `factory/policies/lessons.md` is the third overlay in `paths.ts` and is
// deliberately not in that list. The two above are seeded because INSTALL.md
// has the operator open them and edit them in place -- they must exist before
// anyone can answer. Nobody hand-edits lessons.md: it appears the first time
// `smith lessons compile` runs, and until then reading the shipped set is the
// right answer. Seeding a copy would freeze the lessons at install time and
// stop every later upgrade from delivering new ones.

/**
 * The directories the CLI writes into. Same derivation, same reason: the
 * relative spelling is `paths.ts`'s to decide, and this module should follow
 * it rather than hold a second opinion about where `state/events` is.
 */
const WORK_DIRS: readonly string[] = [
  path.relative(WORK_ROOT, STATE_EVENTS_DIR),
  path.relative(WORK_ROOT, STATE_ARTIFACTS_DIR),
  path.relative(WORK_ROOT, SPECS_ACTIVE_DIR),
];

/**
 * `state/` is a cache of the event log and `workspaces/` holds worktrees; both
 * are this machine's, not the project's. `factory/` is deliberately absent:
 * the roadmap and the stack answers are declarations the operator made, and a
 * team sharing the repository should share them.
 */
const WORK_ROOT_GITIGNORE = `# Written by \`smith init\`. Blacksmith's state is a cache of its event log
# and belongs to this machine; the answers under factory/ are declarations
# this project made, so they are tracked.
state/
workspaces/
.env
`;

/**
 * Give the operator their own copy of a file the factory ships a default of.
 *
 * Never overwrites: an operator who answers the stack questionnaire, upgrades,
 * and runs init again out of habit must not find the defaults back. And never
 * copies a file onto itself, which is the clone case -- there the personal
 * copy *is* the shipped default, and the honest report is that nothing needed
 * doing.
 */
export function seedFromShipped(personal: string, shipped: string): SeedResult {
  if (personal === shipped || existsSync(personal)) {
    return { personal, shipped, status: 'kept' };
  }
  if (!existsSync(shipped)) {
    // Not an throw: a missing default is a packaging defect, and the caller --
    // `smith init`, which is reporting a list -- can say which file is missing
    // more usefully than an exception thrown halfway through the list can.
    return { personal, shipped, status: 'missing-default' };
  }
  mkdirSync(path.dirname(personal), { recursive: true });
  copyFileSync(shipped, personal);
  return { personal, shipped, status: 'seeded' };
}

/**
 * The roadmap, guaranteed writable, returned.
 *
 * Used as the *default argument* of the functions that append to the roadmap,
 * so that an explicitly-passed path is never seeded -- a caller naming a file
 * is naming the file it means, and a missing one is still an error there.
 */
export function ensureWritableRoadmap(): string {
  seedFromShipped(ROADMAP_PATH, ROADMAP_DEFAULT_PATH);
  return ROADMAP_PATH;
}

export interface InitOptions {
  readonly workRoot?: string;
  readonly repoRoot?: string;
}

export interface InitReport {
  readonly workRoot: string;
  readonly repoRoot: string;
  /** True in a clone, where the work root and the package are one directory. */
  readonly inPlace: boolean;
  readonly directories: readonly string[];
  readonly files: readonly SeedResult[];
  readonly gitignore: 'written' | 'kept' | 'not-applicable';
}

/**
 * Make a work root that the CLI can run against: the directories it writes
 * into, a copy of each file the operator is expected to edit, and -- only when
 * the work root is a directory of our own inside somebody else's repository --
 * a `.gitignore` saying which half of it is state.
 *
 * Idempotent by construction: every step asks whether it has already been
 * done. Running it twice is not an undo.
 */
export function initWorkRoot(options: InitOptions = {}): InitReport {
  const workRoot = options.workRoot ?? WORK_ROOT;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const inPlace = path.resolve(workRoot) === path.resolve(repoRoot);

  for (const rel of WORK_DIRS) {
    mkdirSync(path.join(workRoot, rel), { recursive: true });
  }

  const files = OVERLAY_FILES.map((rel) =>
    seedFromShipped(path.join(workRoot, rel), path.join(repoRoot, rel)),
  );

  // In a clone this is the repository's own .gitignore, which means something
  // already. Appending to it would be a surprise and replacing it would be
  // data loss, so the only correct move is to leave it entirely alone.
  let gitignore: InitReport['gitignore'] = 'not-applicable';
  if (!inPlace) {
    const ignorePath = path.join(workRoot, '.gitignore');
    if (existsSync(ignorePath)) {
      gitignore = 'kept';
    } else {
      writeFileSync(ignorePath, WORK_ROOT_GITIGNORE, 'utf8');
      gitignore = 'written';
    }
  }

  return { workRoot, repoRoot, inPlace, directories: WORK_DIRS, files, gitignore };
}
