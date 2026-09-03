// Parses `factory/specs/roadmap.md` (architecture §10 "Roadmap" page's
// source) into milestone rows. The roadmap is a declaration, like specs/
// policies elsewhere in this repo (agent-constraints.md: "committed files
// are declarations") — not event-sourced, so this is a plain file parser,
// not a fold over StoredEvent[] like the rest of db/projector.ts.
//
// Format: one `## <name>` heading per milestone, followed by `- key: value`
// bullet lines (order-independent). `milestone status` is a small closed
// set distinct from taxonomy.yml's `plan_status`/`task_status` — a roadmap
// phase isn't a plan or a task, it's a coarser grouping with no taxonomy.yml
// entry (documented as a deviation in ui/docs/DESIGN.md).
import { readFileSync } from 'node:fs';
import { SmithError } from './errors.js';
import { ROADMAP_PATH } from './paths.js';

export class RoadmapError extends SmithError {}

/**
 * The `- project:` value that means "this clone", not a project this factory
 * built. It is the default a milestone written before Phase 6b carries, so
 * every roadmap.md that predates the bullet still parses as the factory's own.
 *
 * Exported because a factory that maintains the projects it built has to be
 * able to tell them from itself, and by name is the only handle the roadmap
 * gives. Reading it as a directory is the one thing nothing may do: this
 * clone's parent holds a `black-smith` sibling that is a DIFFERENT repository,
 * so the factory's own checkout is `REPO_ROOT` and never a name lookup.
 *
 * Deliberately not imported from `db/queries.ts`'s `DEFAULT_PROJECT`, which
 * says the same word: that module reaches drizzle, and `test/cliBoot.test.ts`
 * pins that the CLI's module graph never does.
 */
export const FACTORY_PROJECT = 'black-smith';

export type MilestoneStatus = 'planned' | 'in-progress' | 'completed';

export const MILESTONE_STATUSES: readonly MilestoneStatus[] = [
  'planned',
  'in-progress',
  'completed',
];

/**
 * What a milestone's project IS to this factory.
 *
 * `- project:` says which project a milestone belongs to; it does not say
 * whether that project is one the factory shipped for an operator, one it
 * built to test itself, or the factory's own build-out. The Roadmap page
 * needs that distinction -- an operator asking "what has this factory built"
 * should not have to read past ten of the factory's own phases and four
 * dogfood milestones to find it -- and nothing in the data carried it.
 *
 * `factory` is derived, not declared: it is whatever `- project:` resolves to
 * FACTORY_PROJECT. `product` is the default for everything else, so a project
 * registered by `smith new` before this bullet existed still reads as what it
 * is. `dogfood` is the only value an operator has to write by hand, because
 * a project built to exercise the factory is indistinguishable, in the data,
 * from one built for its own sake -- the difference is intent.
 */
export type MilestoneKind = 'factory' | 'dogfood' | 'product';

export const MILESTONE_KINDS: readonly MilestoneKind[] = ['factory', 'dogfood', 'product'];

/**
 * The kind a project carries when no milestone of its own declares one.
 *
 * `product` for everything that is not this clone, so a project registered by
 * `smith new` needs no bullet at all -- and so neither scaffold.ts's
 * registerProjectInRoadmap() nor mcp.ts's registerMcpMilestone() has to learn
 * to write one. Marking a project `dogfood` stays a hand edit, because it is
 * a statement about why the project exists that no writer can infer.
 */
export function defaultKindFor(project: string): MilestoneKind {
  return project === FACTORY_PROJECT ? 'factory' : 'product';
}

export interface MilestoneDef {
  milestoneId: string;
  name: string;
  status: MilestoneStatus;
  /** 1-based, in file order. */
  sequence: number;
  goal: string | null;
  epicIds: string[];
  /**
   * Phase 6b: plain-string project identifier (architecture §8 note — not a
   * taxonomy.yml value). Defaults to 'black-smith' when the `- project:`
   * bullet is absent, so every pre-6b roadmap.md still parses unchanged.
   */
  project: string;
  /**
   * Phase 10: `factory` | `dogfood` | `product` -- see MilestoneKind. Derived
   * from `- project:` when the `- kind:` bullet is absent, so every roadmap.md
   * written before the bullet existed still parses, and still parses to the
   * same answer it would have given.
   */
  kind: MilestoneKind;
}

function bulletValue(line: string, key: string): string | null {
  const match = line.match(new RegExp(`^-\\s*${key}\\s*:\\s*(.*)$`));
  if (!match) return null;
  return (match[1] ?? '').trim();
}

/**
 * The epic ids a milestone declares, or a typed refusal.
 *
 * `[]` is not this parser's "nothing readable here" value -- it is a
 * declaration with a documented meaning, spelled out in roadmap.md's own
 * header: "`[]` when no epic has been mapped to this phase yet -- the join
 * yields zero tasks until an epic is tagged here". Anything that did not
 * start and end with a bracket used to return it anyway, so a value the
 * parser could not read arrived downstream as a phase the planner had
 * deliberately left empty, and the milestone parsed clean.
 *
 * That empty list is load-bearing. It is what queries.ts's roadmapPage()
 * joins tasks on (tasksTotal, tasksCompleted, tokensBudget all collapse to
 * zero/null), what kanban() builds its epicId -> milestoneId map from, and
 * what ownsEpic() reads to decide whether the MCP surface gate applies --
 * the failure that comment records, "skipped the MCP surface gate for every
 * project, silently, from the day it shipped", was an empty epicIds list.
 *
 * The un-bracketed spelling is the one to expect rather than an exotic typo:
 * `- goal:` and `- project:` on the lines beside it are bare scalars, so
 * `- epics: phase-9-hardening` reads as the obvious way to tag one epic. A
 * forgotten comma is the other half -- `[epic-a epic-b]` is one id that
 * matches nothing, and an epic id cannot hold whitespace in any case, since
 * it becomes a git branch (`smith/<epic>/integration`) and a worktree
 * directory name.
 *
 * Refusing is the same answer this file already gives a missing id, a
 * duplicate id and an unknown status, and it lands where those land:
 * db/projector.ts's projectMilestones() catches a parse error, logs it to
 * stderr and leaves the existing rows as-is, "so a markdown typo must
 * degrade the Roadmap/Overview milestone data only, not the write path".
 * A named refusal on stderr, not a phase that quietly reports no work.
 */
function parseEpicIds(milestoneId: string, raw: string | null): string[] {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return [];
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new RoadmapError(
      'roadmap.invalid-epics',
      `Milestone "${milestoneId}" has epics "${trimmed}" — expected a bracketed, comma-separated list such as [epic-a, epic-b], or [] for none.`,
      { id: milestoneId, epics: trimmed },
    );
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') return [];
  const ids = inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const spaced = ids.find((id) => /\s/.test(id));
  if (spaced !== undefined) {
    throw new RoadmapError(
      'roadmap.invalid-epics',
      `Milestone "${milestoneId}" declares the epic id "${spaced}" — epic ids hold no whitespace (each is a git branch and a worktree directory), so this is a missing comma.`,
      { id: milestoneId, epics: trimmed, epicId: spaced },
    );
  }
  return ids;
}

function isMilestoneStatus(value: string): value is MilestoneStatus {
  return (MILESTONE_STATUSES as readonly string[]).includes(value);
}

function isMilestoneKind(value: string): value is MilestoneKind {
  return (MILESTONE_KINDS as readonly string[]).includes(value);
}

/**
 * Settle every milestone's kind project-wide, and independently of the order
 * the milestones happen to sit in.
 *
 * `kind` describes a project but is written on a milestone, so one bullet has
 * to settle every milestone that names that project. Resolving per-milestone
 * instead would mean `smith mcp init` appending an undeclared milestone to a
 * dogfood project silently made that one milestone a product -- the project
 * would then show on the Roadmap page for one row and vanish for the rest,
 * which reads as missing data rather than as the drift it is.
 *
 * Two passes rather than one because the answer must not depend on which
 * milestone the operator wrote the bullet on: the bullets inside a block are
 * already order-independent, and the blocks should be too. An explicit
 * disagreement is a refusal, not a precedence rule -- there is no reading of
 * two different kinds for one project that is more likely than a typo.
 */
function resolveKinds(milestones: MilestoneDef[], explicit: (MilestoneKind | null)[]): void {
  const declared = new Map<string, { kind: MilestoneKind; by: string }>();
  for (let i = 0; i < milestones.length; i += 1) {
    const m = milestones[i] as MilestoneDef;
    const kind = explicit[i] ?? null;
    if (kind === null) continue;
    const first = declared.get(m.project);
    if (first === undefined) {
      declared.set(m.project, { kind, by: m.milestoneId });
      continue;
    }
    if (first.kind !== kind) {
      throw new RoadmapError(
        'roadmap.conflicting-kind',
        `Project "${m.project}" is kind "${first.kind}" on milestone "${first.by}" but "${kind}" on "${m.milestoneId}" — every milestone naming one project must agree.`,
        {
          project: m.project,
          id: m.milestoneId,
          kind,
          conflictsWith: first.by,
          conflictsWithKind: first.kind,
        },
      );
    }
  }
  for (const m of milestones) {
    m.kind = declared.get(m.project)?.kind ?? defaultKindFor(m.project);
  }
}

/** Parse the full roadmap.md text into milestone rows, in file order. */
export function parseRoadmap(markdown: string): MilestoneDef[] {
  const milestones: MilestoneDef[] = [];
  const explicitKinds: (MilestoneKind | null)[] = [];
  const seenIds = new Set<string>();
  const sections = markdown.split(/\n(?=## )/);
  let sequence = 0;

  for (const section of sections) {
    const trimmedSection = section.trimStart();
    if (!trimmedSection.startsWith('## ')) continue;

    const lines = trimmedSection.split('\n');
    const heading = (lines[0] ?? '').replace(/^##\s*/, '').trim();
    if (!heading) continue;

    let id: string | null = null;
    let status: string | null = null;
    let goal: string | null = null;
    let epicsRaw: string | null = null;
    let project: string = FACTORY_PROJECT;
    let kindRaw: string | null = null;

    for (const rawLine of lines.slice(1)) {
      const line = rawLine.trim();
      const idVal = bulletValue(line, 'id');
      if (idVal !== null) {
        id = idVal || null;
        continue;
      }
      const statusVal = bulletValue(line, 'status');
      if (statusVal !== null) {
        status = statusVal || null;
        continue;
      }
      const goalVal = bulletValue(line, 'goal');
      if (goalVal !== null) {
        goal = goalVal || null;
        continue;
      }
      const epicsVal = bulletValue(line, 'epics');
      if (epicsVal !== null) {
        epicsRaw = epicsVal;
        continue;
      }
      const projectVal = bulletValue(line, 'project');
      if (projectVal !== null && projectVal !== '') {
        project = projectVal;
        continue;
      }
      // An empty `- kind:` is absent, not invalid -- the same reading
      // `- project:` gives it, so a half-written bullet falls back to the
      // derived answer rather than taking the whole roadmap away.
      const kindVal = bulletValue(line, 'kind');
      if (kindVal !== null && kindVal !== '') {
        kindRaw = kindVal;
      }
    }

    if (!id) {
      throw new RoadmapError(
        'roadmap.missing-id',
        `Milestone "${heading}" is missing a required "- id:" field.`,
        { heading },
      );
    }
    if (seenIds.has(id)) {
      // milestoneId is the milestones table's primary key (db/schema.ts) —
      // a duplicate here would otherwise surface as a raw UNIQUE constraint
      // crash deep inside db/projector.ts's projectMilestones(), which runs
      // after every write (rebuild()/apply()). Fail with a typed error at
      // parse time instead, before it ever reaches the database.
      throw new RoadmapError(
        'roadmap.duplicate-id',
        `Milestone id "${id}" is declared more than once in roadmap.md — ids must be unique.`,
        { id },
      );
    }
    seenIds.add(id);
    if (!status || !isMilestoneStatus(status)) {
      throw new RoadmapError(
        'roadmap.invalid-status',
        `Milestone "${id}" has status "${status ?? ''}" — expected one of ${MILESTONE_STATUSES.join(', ')}.`,
        { id, status },
      );
    }

    let kind: MilestoneKind | null = null;
    if (kindRaw !== null) {
      if (!isMilestoneKind(kindRaw)) {
        throw new RoadmapError(
          'roadmap.invalid-kind',
          `Milestone "${id}" has kind "${kindRaw}" — expected one of ${MILESTONE_KINDS.join(', ')}.`,
          { id, kind: kindRaw },
        );
      }
      // The factory's own kind is structural, not declarative: which project
      // is this clone is settled by FACTORY_PROJECT and REPO_ROOT (see
      // projects.ts), and a roadmap bullet able to contradict that would be a
      // second source of truth for the one question the factory must never
      // get wrong about itself.
      if (project === FACTORY_PROJECT && kindRaw !== 'factory') {
        throw new RoadmapError(
          'roadmap.factory-kind-fixed',
          `Milestone "${id}" declares kind "${kindRaw}" on project "${FACTORY_PROJECT}" — the factory's own milestones are always kind "factory". Drop the bullet, or name a different project.`,
          { id, kind: kindRaw, project },
        );
      }
      kind = kindRaw;
    }
    explicitKinds.push(kind);

    // Read after the id is known and validated, so the refusal names the
    // milestone the way invalid-status does -- the bullets are
    // order-independent, and `- epics:` may well come first in the block.
    const epicIds = parseEpicIds(id, epicsRaw);

    sequence += 1;
    milestones.push({
      milestoneId: id,
      name: heading,
      status,
      sequence,
      goal,
      epicIds,
      project,
      // Provisional -- resolveKinds() below settles it project-wide.
      kind: defaultKindFor(project),
    });
  }

  resolveKinds(milestones, explicitKinds);
  return milestones;
}

/**
 * Read roadmap.md from disk, naming the file when it cannot be read.
 *
 * Every other way this module can fail is a typed RoadmapError naming the
 * milestone at fault; the file simply not being there was the one that
 * escaped as a bare Node ENOENT, stack and all. It escaped into the
 * epic-close gate, whose own resolveMcpSurface() promises that a manifest it
 * cannot read "resolves to `check: null` rather than throwing ... so the gate
 * reports the problem instead of crashing the verdict that was meant to
 * report it" -- one line under a roadmap read that did exactly that. The
 * guard is around the read rather than an existsSync in front of it so a
 * directory, a permission error and a missing file all answer the same way.
 */
export function readRoadmapText(roadmapPath: string = ROADMAP_PATH): string {
  try {
    return readFileSync(roadmapPath, 'utf8');
  } catch (err) {
    throw new RoadmapError(
      'roadmap.unreadable',
      `Could not read the roadmap at ${roadmapPath}: ${err instanceof Error ? err.message : String(err)}`,
      { roadmapPath },
    );
  }
}

/**
 * Does the roadmap already declare this milestone id?
 *
 * The writers (mcp.ts's registerMcpMilestone, scaffold.ts's
 * registerProjectInRoadmap) are append-once and need to know what is already
 * there. They each asked `text.includes('- id: ' + id)`, which is not what
 * any *reader* here means by a declaration, and the two definitions agree on
 * exactly the spelling the writers themselves emit -- while the roadmap is a
 * hand-maintained file (architecture §12, "the planner maintains it"). Both
 * directions of the disagreement are live: `- id:demo-mcp-surface` is the
 * same milestone to bulletValue and invisible to the substring, so the writer
 * appends a second copy and parseRoadmap then rejects the whole file on
 * duplicate-id; and `- id: demo-mcp-surface-hardening` contains the substring
 * while declaring a different milestone, so the writer reports a registration
 * it never made.
 *
 * So this answers with the parser's own field reader, over the parser's own
 * section scoping -- but without parseRoadmap's validation, deliberately: a
 * section with no `- status:` is a real fixture in this repo's tests and
 * refusing to register a milestone because a *different* one is incomplete
 * would be a new failure of its own.
 */
export function roadmapDeclaresId(markdown: string, id: string): boolean {
  let inSection = false;
  for (const rawLine of markdown.split('\n')) {
    // parseRoadmap splits sections on /\n(?=## )/, so a heading counts only at
    // column 0; bullets are read off the trimmed line.
    if (rawLine.startsWith('## ')) {
      inSection = true;
      continue;
    }
    if (inSection && bulletValue(rawLine.trim(), 'id') === id) return true;
  }
  return false;
}

/** Read and parse roadmap.md from disk (defaults to the real repo path). */
export function loadRoadmap(roadmapPath: string = ROADMAP_PATH): MilestoneDef[] {
  return parseRoadmap(readRoadmapText(roadmapPath));
}

/**
 * Whether a milestone claims this epic — the applicability test both
 * milestone-scoped gates share (MCP surface, spec-vs-goal).
 *
 * `epicIds` alone was the original rule and it made the gate unreachable:
 * registerMcpMilestone() writes `- epics: []`, nothing fills it in, and an
 * empty list matches no epic. So `smith epic close` skipped the MCP surface
 * gate for every project, silently, from the day it shipped — the whole
 * roadmap has `epics: []` on all but one milestone.
 *
 * The id fallback keys on a convention this codebase creates rather than on a
 * list it initializes to the disabling value: `smith mcp init <p>` names the
 * milestone `<p>-mcp-surface`, and the epic that closes it carries the same id
 * (envkit-config-loader/envkit-config-loader is the same pattern). An explicit
 * `epics:` entry still works and still wins for any epic named otherwise.
 *
 * Note what this deliberately does NOT do: match every epic in the project.
 * The standard scopes the gate to the epic under the surface milestone, and
 * widening it would block unrelated epics — including ones that legitimately
 * predate the surface — on a manifest they were never meant to own.
 */
export function ownsEpic(milestone: MilestoneDef, epicId: string): boolean {
  return milestone.epicIds.includes(epicId) || milestone.milestoneId === epicId;
}
