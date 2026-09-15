import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as paths from '../src/paths.js';

const POLICIES_DIR = path.join(paths.REPO_ROOT, 'factory', 'policies');

describe('paths.ts', () => {
  // D-159's precondition, one level up. Every gate in this factory is supposed
  // to read a declaration out of factory/policies/, and paths.ts is where the
  // repo agrees on where those files are. A policy file with no constant here
  // is a file no module can name without spelling the path itself -- which is
  // how severity.yml came to carry its own `${REPO_ROOT}/factory/policies/
  // severity.yml` inside severity.ts, the one path in the repo built by
  // interpolation rather than path.join.
  //
  // Compared as sorted arrays rather than sets on purpose: two constants
  // pointing at one file is the same drift in the other direction, and a set
  // would swallow it.
  it('declares a constant for every file in factory/policies/, and none twice', () => {
    const onDisk = readdirSync(POLICIES_DIR)
      .filter((entry) => statSync(path.join(POLICIES_DIR, entry)).isFile())
      .sort();

    const declared = Object.entries(paths)
      .filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && path.dirname(entry[1]) === POLICIES_DIR,
      )
      .map(([name, value]) => [name, path.basename(value)] as const);

    // An overlay pair is the one legal way two constants name one file: the
    // shipped default and the operator's copy are the same relative path under
    // two different roots, and in a clone those roots are one directory. Fold
    // the default half back into its partner, so the comparison below still
    // means "one policy file, one way to name it".
    const named = declared
      .filter(([name]) => !name.endsWith('_DEFAULT_PATH'))
      .map(([, base]) => base)
      .sort();
    expect(named).toEqual(onDisk);

    // ...and every default half is held to having that partner, so the filter
    // above cannot be used to smuggle a second constant past the check.
    const allNames = declared.map(([name]) => name);
    for (const name of allNames.filter((n) => n.endsWith('_DEFAULT_PATH'))) {
      expect(
        allNames,
        `${name} is excused as an overlay default with nothing to overlay`,
      ).toContain(name.replace('_DEFAULT_PATH', '_PATH'));
    }
  });

  // The filter above keys on path.dirname, so a constant assembled by string
  // interpolation with a stray separator would silently drop out of the
  // comparison and the guard would pass over a policy it never saw.
  it('builds every policy path with path.join, not interpolation', () => {
    const policyPaths = Object.entries(paths).filter(
      ([, value]) => typeof value === 'string' && value.includes(`${path.sep}policies${path.sep}`),
    );
    expect(policyPaths.length).toBeGreaterThan(0);
    for (const [name, value] of policyPaths) {
      expect(`${name}: ${value}`).toBe(`${name}: ${path.normalize(String(value))}`);
    }
  });

  // The factory builds projects; it does not house them. A project scaffolded
  // under REPO_ROOT sits inside this clone's git tree, its ignore rules and its
  // lint roots, and reads as part of the factory to every tool that walks up
  // from a file inside it. `workspaces/` is still a legal place to put one with
  // `--target-dir`; it is no longer where one goes when nothing says otherwise.
  it('puts a project beside this clone rather than inside it', () => {
    expect(paths.PROJECTS_DIR).toBe(path.dirname(paths.REPO_ROOT));
    expect(path.relative(paths.REPO_ROOT, path.join(paths.PROJECTS_DIR, 'demo'))).toMatch(/^\.\./);
  });
});

// ---------------------------------------------------------------------------
// PP-1 in the narrow: one anchor, two kinds of path.
//
// `REPO_ROOT` is derived from this module's own location, so under an npm
// install it resolves to `node_modules/@juzser/blacksmith`. That is the right
// answer for everything the CLI *reads* — the policies, the schemas, the
// scaffold, the role templates all ship inside the tarball. It is the wrong
// answer for everything the CLI *writes*: `npm i` replaces that directory
// wholesale, so an operator's event log, database and epic plans are deleted
// by the next upgrade of the tool that wrote them.
//
// The full separation PP-1 asks for is three roots. This is the half of it a
// published 0.1.0 cannot do without: written state anchors on a work root that
// is the clone when there is one and the operator's own directory when there
// is not. The layout under it is identical either way, which is the property
// worth having — `state/events/<session>.jsonl` means one thing, and only the
// root it hangs off moves.
// ---------------------------------------------------------------------------
describe('resolveWorkRoot', () => {
  const clone = '/home/dev/blacksmith';
  const install = '/home/dev/app/node_modules/@juzser/blacksmith';
  const cwd = '/home/dev/app';

  it('is the clone itself when the CLI runs out of a checkout', () => {
    // The case every test in this suite runs under, and the one that must not
    // move: state stays exactly where 4.6M of this clone's already sits.
    expect(paths.resolveWorkRoot(clone, cwd, {}, true)).toBe(clone);
  });

  it('is a dot-directory beside the operator when the CLI runs out of a package', () => {
    expect(paths.resolveWorkRoot(install, cwd, {}, false)).toBe('/home/dev/app/.blacksmith');
  });

  it('prefers SMITH_HOME to both, resolved against cwd rather than the package', () => {
    expect(paths.resolveWorkRoot(install, cwd, { SMITH_HOME: '/srv/smith' }, false)).toBe(
      '/srv/smith',
    );
    expect(paths.resolveWorkRoot(install, cwd, { SMITH_HOME: 'var/smith' }, false)).toBe(
      '/home/dev/app/var/smith',
    );
    // It overrides the clone too: an operator who names a root means it.
    expect(paths.resolveWorkRoot(clone, cwd, { SMITH_HOME: '/srv/smith' }, true)).toBe(
      '/srv/smith',
    );
  });

  it('reads an empty SMITH_HOME as unset rather than as cwd', () => {
    // `SMITH_HOME=` in a shell profile or a CI matrix is how an unset variable
    // is spelled by accident. Resolved literally it means cwd, which silently
    // scatters `state/` into whatever directory the operator happened to be in.
    for (const blank of ['', '  ']) {
      expect(paths.resolveWorkRoot(install, cwd, { SMITH_HOME: blank }, false)).toBe(
        '/home/dev/app/.blacksmith',
      );
    }
  });
});

describe('the work root', () => {
  it('anchors everything the CLI writes, and nothing it only reads', () => {
    // The two-way statement, so a constant added to one group cannot quietly
    // join the other. Read paths must stay on REPO_ROOT or they stop being in
    // the tarball; written paths must leave it or `npm i` deletes them.
    const written = [
      paths.STATE_EVENTS_DIR,
      paths.STATE_ARTIFACTS_DIR,
      paths.STATE_DB_PATH,
      paths.STATE_DAEMON_DIR,
      paths.SANDBOX_LEASE_DIR,
      paths.SPECS_ACTIVE_DIR,
      paths.WORKSPACES_DIR,
      paths.DOTENV_PATH,
      paths.ROADMAP_PATH,
      paths.STACK_POLICY_PATH,
    ];
    for (const abs of written) {
      expect(path.relative(paths.WORK_ROOT, abs)).not.toMatch(/^\.\./);
    }
    for (const abs of [
      paths.SCHEMA_DIR,
      paths.SCAFFOLD_DIR,
      paths.AGENTS_DIR,
      paths.ROADMAP_DEFAULT_PATH,
      paths.STACK_POLICY_DEFAULT_PATH,
    ]) {
      expect(path.relative(paths.REPO_ROOT, abs)).not.toMatch(/^\.\./);
    }
  });

  it('is this clone while the tests run, so the layout on disk is unchanged', () => {
    expect(paths.WORK_ROOT).toBe(paths.REPO_ROOT);
    expect(paths.STATE_EVENTS_DIR).toBe(path.join(paths.REPO_ROOT, 'state', 'events'));
  });
});

describe('where a new project lands', () => {
  it('is beside the clone, or beside the operator when there is no clone', () => {
    // `PROJECTS_DIR = dirname(REPO_ROOT)` is right for a clone and catastrophic
    // for an install: the parent of `node_modules/@juzser/blacksmith` is
    // `node_modules/@juzser`, so `smith new` would scaffold a project into a
    // directory the next `npm i` empties. Without this, fixing the roadmap
    // allowlist entry makes `smith new` *succeed* into node_modules, which is
    // strictly worse than the ENOENT it fails with today.
    expect(paths.resolveProjectsDir('/home/dev/blacksmith', '/anywhere', true)).toBe('/home/dev');
    expect(
      paths.resolveProjectsDir(
        '/home/dev/app/node_modules/@juzser/blacksmith',
        '/home/dev/app',
        false,
      ),
    ).toBe('/home/dev/app');
  });
});

// ---------------------------------------------------------------------------
// The third kind of path, which `paths.ts` had no name for.
//
// Most constants here are one of two things: an asset the CLI only reads,
// which ships and hangs off REPO_ROOT, or state the CLI writes, which must not
// ship and hangs off WORK_ROOT. Two files are both. `factory/specs/roadmap.md`
// ships as a starting roadmap and `smith new` appends a project to it;
// `factory/policies/stack.yml` ships as a commented questionnaire and
// INSTALL.md Step 5 tells the operator to "change the values in place".
//
// Anchored on REPO_ROOT, as both were, those writes land inside the installed
// package: `node_modules/@juzser/blacksmith/factory/...`, which the next
// `npm i` replaces wholesale and `npx` may re-resolve from the registry. The
// operator's answers survive until the first upgrade and then silently do not.
// Under pnpm it is worse than losing them -- the package directory is a tree
// of hard links into a content-addressable store, so writing through one edits
// the copy every other project on the machine reads.
//
// The shape that fits is an overlay: read the operator's copy when it exists,
// fall back to the shipped default when it does not, and write the operator's
// copy always. In a clone WORK_ROOT and REPO_ROOT are the same directory, so
// both halves name the same file and an existing checkout cannot tell the
// difference -- which is what makes this safe to land mid-epic.
// ---------------------------------------------------------------------------

describe('a file the factory ships and the operator then edits', () => {
  it('reads the operator copy when it exists', () => {
    const personal = '/home/dev/app/.blacksmith/factory/policies/stack.yml';
    const shipped = '/home/dev/app/node_modules/@juzser/blacksmith/factory/policies/stack.yml';
    expect(paths.resolveOverlayRead(personal, shipped, (p) => p === personal)).toBe(personal);
  });

  it('falls back to the shipped default before anyone has answered', () => {
    const personal = '/home/dev/app/.blacksmith/factory/policies/stack.yml';
    const shipped = '/home/dev/app/node_modules/@juzser/blacksmith/factory/policies/stack.yml';
    expect(paths.resolveOverlayRead(personal, shipped, () => false)).toBe(shipped);
  });

  it('writes under the work root, never into the package it shipped from', () => {
    for (const abs of [paths.ROADMAP_PATH, paths.STACK_POLICY_PATH]) {
      expect(path.relative(paths.WORK_ROOT, abs)).not.toMatch(/^\.\./);
    }
  });

  it('keeps the shipped default under the package, so the tarball can carry it', () => {
    for (const abs of [paths.ROADMAP_DEFAULT_PATH, paths.STACK_POLICY_DEFAULT_PATH]) {
      expect(path.relative(paths.REPO_ROOT, abs)).not.toMatch(/^\.\./);
    }
  });

  it('spells both halves the same way under their root, so seeding is a copy', () => {
    // The property `smith init` depends on, and the reason a pair can be
    // stated as one relative path rather than two absolute ones.
    expect(path.relative(paths.WORK_ROOT, paths.ROADMAP_PATH)).toBe(
      path.relative(paths.REPO_ROOT, paths.ROADMAP_DEFAULT_PATH),
    );
    expect(path.relative(paths.WORK_ROOT, paths.STACK_POLICY_PATH)).toBe(
      path.relative(paths.REPO_ROOT, paths.STACK_POLICY_DEFAULT_PATH),
    );
  });

  it('changes nothing for an operator standing in a clone', () => {
    // The whole safety argument in two lines: in a checkout the pair collapses,
    // so every read and every write names the file it named before.
    expect(paths.ROADMAP_PATH).toBe(paths.ROADMAP_DEFAULT_PATH);
    expect(paths.STACK_POLICY_PATH).toBe(paths.STACK_POLICY_DEFAULT_PATH);
    expect(paths.roadmapReadPath()).toBe(paths.ROADMAP_DEFAULT_PATH);
    expect(paths.stackPolicyReadPath()).toBe(paths.STACK_POLICY_DEFAULT_PATH);
  });
});
