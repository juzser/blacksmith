import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRoadmap, parseRoadmap, RoadmapError } from '../src/roadmap.js';

let scratchDirs: string[] = [];

function mkScratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-roadmap-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  scratchDirs = [];
});

describe('roadmap.ts parseRoadmap()', () => {
  it('parses milestones in file order, assigning a 1-based sequence', () => {
    const md = `# Roadmap

## Phase 1 — Bootstrap
- id: phase-1
- status: completed
- epics: []
- goal: Stand up the scaffold.

## Phase 2 — Contracts
- id: phase-2
- status: in-progress
- epics: [epic-1, epic-2]
`;
    const milestones = parseRoadmap(md);
    expect(milestones).toEqual([
      {
        milestoneId: 'phase-1',
        name: 'Phase 1 — Bootstrap',
        status: 'completed',
        sequence: 1,
        goal: 'Stand up the scaffold.',
        epicIds: [],
        project: 'black-smith',
        kind: 'factory',
      },
      {
        milestoneId: 'phase-2',
        name: 'Phase 2 — Contracts',
        status: 'in-progress',
        sequence: 2,
        goal: null,
        epicIds: ['epic-1', 'epic-2'],
        project: 'black-smith',
        kind: 'factory',
      },
    ]);
  });

  it('reads an explicit "- project:" bullet (Phase 6b multi-project hub)', () => {
    const md = `## Phase 6b — Hub
- id: phase-6b
- status: in-progress
- epics: [epic-9]
- project: demo-hub
`;
    const milestones = parseRoadmap(md);
    expect(milestones[0]?.project).toBe('demo-hub');
  });

  it('defaults project to "black-smith" when the bullet is absent', () => {
    const md = `## Phase 1 — Bootstrap
- id: phase-1
- status: planned
`;
    const milestones = parseRoadmap(md);
    expect(milestones[0]?.project).toBe('black-smith');
  });

  it('ignores prose before the first "## " heading', () => {
    const md = `# Roadmap

Some intro prose that is not a milestone block.

## Phase 1 — Bootstrap
- id: phase-1
- status: planned
- epics: []
`;
    const milestones = parseRoadmap(md);
    expect(milestones).toHaveLength(1);
    expect(milestones[0]?.milestoneId).toBe('phase-1');
  });

  it('throws RoadmapError when a milestone is missing "- id:"', () => {
    const md = `## Phase 1 — Bootstrap
- status: planned
- epics: []
`;
    expect(() => parseRoadmap(md)).toThrow(RoadmapError);
  });

  it('throws RoadmapError when the same milestone id is declared twice', () => {
    const md = `## Phase 1 — Bootstrap
- id: phase-1
- status: planned
- epics: []

## Phase 1 again — dup
- id: phase-1
- status: completed
- epics: []
`;
    expect(() => parseRoadmap(md)).toThrow(RoadmapError);
    expect(() => parseRoadmap(md)).toThrow(/more than once/i);
  });

  it('throws RoadmapError when status is not one of the closed set', () => {
    const md = `## Phase 1 — Bootstrap
- id: phase-1
- status: done
- epics: []
`;
    expect(() => parseRoadmap(md)).toThrow(RoadmapError);
  });

  it('defaults epics to [] and goal to null when absent', () => {
    const md = `## Phase 1 — Bootstrap
- id: phase-1
- status: planned
`;
    const milestones = parseRoadmap(md);
    expect(milestones[0]).toMatchObject({ epicIds: [], goal: null });
  });

  it('reads an empty "- epics:" value as the same empty list as an absent bullet', () => {
    const md = `## Phase 1 — Bootstrap
- id: phase-1
- status: planned
- epics:
`;
    expect(parseRoadmap(md)[0]).toMatchObject({ epicIds: [] });
  });

  /**
   * `[]` here is not the absence of a value, it is a declaration: roadmap.md's
   * own header defines it as "no epic has been mapped to this phase yet — the
   * join yields zero tasks until an epic is tagged here". So a value the
   * parser cannot read must not answer with it. It used to: anything that did
   * not start and end with a bracket returned `[]` and the milestone parsed
   * clean, while every other malformed field in the same hand-maintained file
   * — a missing id, a duplicate id, an unknown status — throws.
   *
   * The cost is not cosmetic. An empty list is exactly what made the MCP
   * surface gate unreachable (mcp.ts's ownsEpic: "skipped the MCP surface gate
   * for every project, silently, from the day it shipped"); it is what
   * queries.ts's roadmapPage() joins on for tasksTotal/tasksCompleted/
   * tokensBudget, and what kanban() builds its epicId -> milestoneId map from.
   * The un-bracketed spelling is the one to expect, too: `- goal:` and
   * `- project:` beside it are bare scalars, so `- epics: phase-9-hardening`
   * reads as the obvious way to tag a single epic.
   */
  it('throws RoadmapError when the epics value is not a bracketed list', () => {
    for (const value of ['epic-a', 'epic-a, epic-b', '[epic-a', 'epic-a]', '"[epic-a]"']) {
      const md = `## Phase 1 — Bootstrap\n- id: phase-1\n- status: planned\n- epics: ${value}\n`;
      let caught: unknown;
      try {
        parseRoadmap(md);
      } catch (err) {
        caught = err;
      }
      expect(caught, value).toBeInstanceOf(RoadmapError);
      expect((caught as RoadmapError).code, value).toBe('roadmap.invalid-epics');
      expect((caught as RoadmapError).message, value).toContain(value);
    }
  });

  /**
   * A forgotten comma is the other way the list stops being a list, and it
   * fails the same way: `[epic-a epic-b]` parsed as the single id
   * "epic-a epic-b", which matches no epic and so yields the empty join all
   * over again. An epic id becomes a git branch (`smith/<epic>/integration`,
   * worktree.ts) and a worktree directory name, so whitespace inside one is
   * not a strict id rule invented here — it cannot be an epic id at all.
   */
  it('throws RoadmapError when a list entry holds whitespace (a forgotten comma)', () => {
    const md = `## Phase 1 — Bootstrap
- id: phase-1
- status: planned
- epics: [epic-a epic-b]
`;
    expect(() => parseRoadmap(md)).toThrow(RoadmapError);
    expect(() => parseRoadmap(md)).toThrow(/epic-a epic-b/);
  });
});

/**
 * `- kind:` says what a project IS to this factory, so the Roadmap page can
 * answer "what has this factory built" without the reader wading past ten of
 * the factory's own phases and four dogfood milestones. The rules under test
 * are all consequences of it describing a PROJECT while being written on a
 * MILESTONE: one bullet settles every milestone naming that project, the
 * answer cannot depend on which milestone carries it, and a writer that
 * appends an undeclared milestone to a declared project must not change it.
 */
describe('roadmap.ts parseRoadmap() milestone kind', () => {
  it('derives kind "factory" for the factory\'s own project when no bullet declares one', () => {
    const md = `## Phase 1 — Bootstrap
- id: phase-1
- status: planned
`;
    expect(parseRoadmap(md)[0]?.kind).toBe('factory');
  });

  /**
   * The default that lets scaffold.ts's registerProjectInRoadmap() stay as it
   * is: a project registered by `smith new` writes no kind bullet and still
   * reads as a product, which is the only thing it can be.
   */
  it('derives kind "product" for any other project when no bullet declares one', () => {
    const md = `## envkit — bootstrap
- id: envkit-bootstrap
- status: planned
- project: envkit
`;
    expect(parseRoadmap(md)[0]?.kind).toBe('product');
  });

  it('reads an explicit "- kind:" bullet', () => {
    const md = `## envkit — bootstrap
- id: envkit-bootstrap
- status: planned
- project: envkit
- kind: dogfood
`;
    expect(parseRoadmap(md)[0]?.kind).toBe('dogfood');
  });

  it('reads an empty "- kind:" value as absent, the way "- project:" reads one', () => {
    const md = `## envkit — bootstrap
- id: envkit-bootstrap
- status: planned
- project: envkit
- kind:
`;
    expect(parseRoadmap(md)[0]?.kind).toBe('product');
  });

  /**
   * The rule mcp.ts's registerMcpMilestone() depends on. It appends a
   * milestone to an EXISTING project and writes no kind bullet; if kind
   * resolved per-milestone that appended row would read `product` while its
   * siblings read `dogfood`, and the project would appear on the Roadmap page
   * for one row and vanish for the rest.
   */
  it('settles kind project-wide from a single bullet, whichever milestone carries it', () => {
    const declaredFirst = `## envkit — bootstrap
- id: envkit-bootstrap
- status: completed
- project: envkit
- kind: dogfood

## envkit — mcp surface
- id: envkit-mcp
- status: planned
- project: envkit
`;
    const declaredLast = `## envkit — bootstrap
- id: envkit-bootstrap
- status: completed
- project: envkit

## envkit — mcp surface
- id: envkit-mcp
- status: planned
- project: envkit
- kind: dogfood
`;
    for (const md of [declaredFirst, declaredLast]) {
      expect(parseRoadmap(md).map((m) => m.kind)).toEqual(['dogfood', 'dogfood']);
    }
  });

  it('settles each project independently', () => {
    const md = `## envkit — bootstrap
- id: envkit-bootstrap
- status: completed
- project: envkit
- kind: dogfood

## acme — bootstrap
- id: acme-bootstrap
- status: planned
- project: acme

## Phase 1 — Bootstrap
- id: phase-1
- status: completed
`;
    expect(parseRoadmap(md).map((m) => m.kind)).toEqual(['dogfood', 'product', 'factory']);
  });

  it('throws roadmap.invalid-kind when the value is outside the closed set', () => {
    const md = `## envkit — bootstrap
- id: envkit-bootstrap
- status: planned
- project: envkit
- kind: demo
`;
    let caught: unknown;
    try {
      parseRoadmap(md);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RoadmapError);
    expect((caught as RoadmapError).code).toBe('roadmap.invalid-kind');
    expect((caught as RoadmapError).message).toContain('demo');
  });

  /**
   * Which project is this clone is settled by FACTORY_PROJECT and REPO_ROOT
   * (projects.ts). A bullet able to contradict that would be a second source
   * of truth for the one question the factory must never get wrong about
   * itself, so the refusal is the answer, not a silent override.
   */
  it('throws roadmap.factory-kind-fixed when a factory milestone declares another kind', () => {
    const md = `## Phase 1 — Bootstrap
- id: phase-1
- status: planned
- kind: product
`;
    let caught: unknown;
    try {
      parseRoadmap(md);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RoadmapError);
    expect((caught as RoadmapError).code).toBe('roadmap.factory-kind-fixed');
  });

  it('accepts a redundant "- kind: factory" on the factory\'s own milestones', () => {
    const md = `## Phase 1 — Bootstrap
- id: phase-1
- status: planned
- kind: factory
`;
    expect(parseRoadmap(md)[0]?.kind).toBe('factory');
  });

  /**
   * Two different kinds for one project has no reading more likely than a
   * typo, so it is a refusal rather than a precedence rule -- and the message
   * names both milestones, because "which bullet is wrong" is the only
   * question the operator then has.
   */
  it('throws roadmap.conflicting-kind when two milestones disagree about one project', () => {
    const md = `## envkit — bootstrap
- id: envkit-bootstrap
- status: completed
- project: envkit
- kind: dogfood

## envkit — mcp surface
- id: envkit-mcp
- status: planned
- project: envkit
- kind: product
`;
    let caught: unknown;
    try {
      parseRoadmap(md);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RoadmapError);
    expect((caught as RoadmapError).code).toBe('roadmap.conflicting-kind');
    expect((caught as RoadmapError).message).toContain('envkit-bootstrap');
    expect((caught as RoadmapError).message).toContain('envkit-mcp');
  });
});

describe('roadmap.ts loadRoadmap()', () => {
  it('parses the file it was pointed at', () => {
    const roadmapPath = path.join(mkScratch(), 'roadmap.md');
    writeFileSync(
      roadmapPath,
      '# Roadmap\n\n## Phase 1\n- id: phase-1\n- status: planned\n',
      'utf8',
    );

    expect(loadRoadmap(roadmapPath).map((m) => m.milestoneId)).toEqual(['phase-1']);
  });

  // Every other failure this file can produce is a typed RoadmapError naming
  // the milestone at fault -- missing-id, duplicate-id, invalid-status. The
  // file simply not being there was the one that escaped as a bare Node
  // ENOENT, and it escapes into the epic-close gate: resolveMcpSurface()'s own
  // doc comment promises that a manifest which cannot be read "resolves to
  // `check: null` rather than throwing ... so the gate reports the problem
  // instead of crashing the verdict that was meant to report it", and the line
  // directly above that read the roadmap with a bare readFileSync. So the
  // stated design held for the second file the gate reads and not the first.
  // db/projector.ts is the only caller that guards, and its comment says it
  // guards because a markdown problem "must degrade the Roadmap/Overview
  // milestone data only, not the write path it happens to share a call site
  // with" -- the same argument, made once, at one of four call sites.
  it('names the roadmap it could not read, instead of raising a bare ENOENT', () => {
    const missing = path.join(mkScratch(), 'nope.md');

    let thrown: unknown;
    try {
      loadRoadmap(missing);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RoadmapError);
    expect((thrown as RoadmapError).code).toBe('roadmap.unreadable');
    // The path, so the operator can see *which* roadmap: these functions all
    // take a roadmapPath override, so "the roadmap" is not a single file.
    expect((thrown as RoadmapError).message).toContain(missing);
    expect((thrown as RoadmapError).details).toMatchObject({ roadmapPath: missing });
  });

  it('says so when the roadmap is a directory, not only when it is absent', () => {
    // Not a hypothetical variant for its own sake: the guard has to be around
    // the read, not an existsSync in front of it, or this case walks straight
    // back out as a bare EISDIR.
    const dir = mkScratch();

    expect(() => loadRoadmap(dir)).toThrow(RoadmapError);
  });
});
