import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';
import { factoryProjects, resolveProjectDirs, unwatchedProjects } from '../src/projects.js';
import { FACTORY_PROJECT } from '../src/roadmap.js';

// One scratch tree per test: a roadmap file, and a `roots/` beside it standing
// in for PROJECTS_DIR. Nothing here touches the real one -- a test that read
// the shipped roadmap would change its answer every time a milestone landed.
let scratch: string;
let roadmapPath: string;
let root: string;

const ROADMAP = (blocks: string): string => `# Roadmap\n${blocks}`;

const milestone = (id: string, project?: string): string =>
  `\n## ${id}\n- id: ${id}\n- status: completed\n${
    project === undefined ? '' : `- project: ${project}\n`
  }- epics: []\n- goal: whatever.\n`;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'smith-projects-'));
  roadmapPath = path.join(scratch, 'roadmap.md');
  root = path.join(scratch, 'roots');
  mkdirSync(root);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const checkout = (name: string): string => {
  const dir = path.join(root, name);
  mkdirSync(dir);
  return dir;
};

const write = (blocks: string): void => writeFileSync(roadmapPath, ROADMAP(blocks), 'utf8');

describe('factoryProjects', () => {
  // The mandate this exists to make checkable: the factory maintains itself
  // AND the projects it built. Itself is not a roadmap lookup -- REPO_ROOT is
  // known -- and it must be first, because a factory that watches its children
  // and not itself has the same blind spot the other way round.
  it('always names this clone first, whatever the roadmap says', () => {
    write(milestone('phase-1'));
    const refs = factoryProjects({ roadmapPath, roots: [root] });
    expect(refs[0]).toEqual({ name: FACTORY_PROJECT, dir: REPO_ROOT, self: true });
  });

  it('finds each declared project that has a checkout under a root', () => {
    const envkit = checkout('envkit');
    write(milestone('phase-1') + milestone('envkit-bootstrap', 'envkit'));
    const refs = factoryProjects({ roadmapPath, roots: [root] });
    expect(refs).toEqual([
      { name: FACTORY_PROJECT, dir: REPO_ROOT, self: true },
      { name: 'envkit', dir: envkit, self: false },
    ]);
  });

  // Four milestones declare `project: envkit` in the shipped roadmap today.
  // Four entries would mean four findings and four --project flags for one
  // repo.
  it('names a project once however many milestones declare it', () => {
    checkout('envkit');
    write(
      milestone('envkit-bootstrap', 'envkit') +
        milestone('envkit-config-loader', 'envkit') +
        milestone('envkit-mcp-surface', 'envkit'),
    );
    const refs = factoryProjects({ roadmapPath, roots: [root] });
    expect(refs.filter((r) => r.name === 'envkit')).toHaveLength(1);
  });

  // The factory's own project name resolves to a REAL sibling directory on
  // this machine -- `black-smith` sits beside `blacksmith` -- so looking it up
  // by name under PROJECTS_DIR would have the factory maintain somebody else's
  // clone while believing it was maintaining its own.
  it('never resolves the factory itself by name lookup', () => {
    checkout(FACTORY_PROJECT);
    write(milestone('phase-1', FACTORY_PROJECT));
    const refs = factoryProjects({ roadmapPath, roots: [root] });
    expect(refs).toHaveLength(1);
    expect(refs[0]?.dir).toBe(REPO_ROOT);
  });

  // A checkout is what makes a project maintainable. Declared-but-absent is
  // reported by nothing here on purpose: there is no repo to read a lockfile
  // from, so a finding about it would be one an operator cannot act on and
  // could never clear.
  it('drops a declared project with no checkout under any root', () => {
    write(milestone('envkit-bootstrap', 'envkit'));
    expect(factoryProjects({ roadmapPath, roots: [root] })).toHaveLength(1);
  });

  it('searches roots in order and takes the first that answers', () => {
    const legacy = path.join(scratch, 'workspaces');
    mkdirSync(legacy);
    mkdirSync(path.join(legacy, 'envkit'));
    const beside = checkout('envkit');
    write(milestone('envkit-bootstrap', 'envkit'));
    const refs = factoryProjects({ roadmapPath, roots: [root, legacy] });
    expect(refs.map((r) => r.dir)).toEqual([REPO_ROOT, beside]);
  });

  // D-21: a reader that only reports a fact must not crash over that fact. The
  // roadmap is an operator-edited file, and a watcher that dies on a bad bullet
  // is silent exactly when somebody is mid-edit.
  it('still names this clone when the roadmap cannot be read', () => {
    const refs = factoryProjects({ roadmapPath: path.join(scratch, 'nope.md'), roots: [root] });
    expect(refs).toEqual([{ name: FACTORY_PROJECT, dir: REPO_ROOT, self: true }]);
  });

  it('still names this clone when the roadmap does not parse', () => {
    writeFileSync(roadmapPath, '## broken\n- id: a\n- status: nonsense\n', 'utf8');
    const refs = factoryProjects({ roadmapPath, roots: [root] });
    expect(refs).toEqual([{ name: FACTORY_PROJECT, dir: REPO_ROOT, self: true }]);
  });
});

describe('resolveProjectDirs', () => {
  // The union, not a replacement: `--project /elsewhere` watches /elsewhere
  // AND this clone, not /elsewhere alone (contract clause 1).
  it('adds REPO_ROOT by default, ahead of whatever --project named', () => {
    expect(resolveProjectDirs(['/repo/envkit'])).toEqual([REPO_ROOT, '/repo/envkit']);
  });

  it('adds REPO_ROOT even when nothing was passed', () => {
    expect(resolveProjectDirs(undefined)).toEqual([REPO_ROOT]);
  });

  // `--no-self` is the only way to leave it out.
  it('drops REPO_ROOT when self is false', () => {
    expect(resolveProjectDirs(['/repo/envkit'], { self: false })).toEqual(['/repo/envkit']);
  });

  it('leaves nothing behind when self is false and nothing else was named', () => {
    expect(resolveProjectDirs(undefined, { self: false })).toEqual([]);
  });

  // REPO_ROOT present exactly once and path-resolved, even if the operator
  // also typed its absolute path explicitly.
  it('resolves paths and never duplicates REPO_ROOT', () => {
    expect(resolveProjectDirs([REPO_ROOT])).toEqual([REPO_ROOT]);
  });
});

describe('unwatchedProjects', () => {
  const refs = [
    { name: 'black-smith', dir: '/repo/self', self: true },
    { name: 'envkit', dir: '/repo/envkit', self: false },
  ];

  it('is everything when nothing was passed', () => {
    expect(unwatchedProjects(refs, []).map((r) => r.name)).toEqual(['black-smith', 'envkit']);
  });

  it('is empty when every repo is watched', () => {
    expect(unwatchedProjects(refs, ['/repo/self', '/repo/envkit'])).toEqual([]);
  });

  // The operator types `--project .`, not `--project /Users/.../blacksmith`.
  // Comparing what was typed against what was resolved would report a repo as
  // unwatched while the maintenance pass was reading it -- a false alarm that
  // no amount of adding flags could clear.
  it('compares resolved paths, so `.` and its absolute path are one repo', () => {
    const here = process.cwd();
    const local = [{ name: 'here', dir: here, self: false }];
    expect(unwatchedProjects(local, ['.'])).toEqual([]);
  });

  // A repo watched that nothing declares is not an error: an operator may
  // point the pass at anything. This function answers one question only.
  it('says nothing about a watched repo it does not know', () => {
    expect(unwatchedProjects(refs, ['/repo/self', '/repo/envkit', '/somewhere/else'])).toEqual([]);
  });
});
