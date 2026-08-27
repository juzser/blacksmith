import { createHash } from 'node:crypto';
import path from 'node:path';
import { claimCoversPath } from './claims.js';
import { SmithError } from './errors.js';
import { appendEvent, type EventOpts, readLineageEvents, type StoredEvent } from './events.js';
import { describeType } from './plan.js';
import { type CompiledSchemaSet, compileSchemas, validateRecord } from './schemas.js';
import { readAddedTasks } from './taskEvents.js';
import { bareTaskId, epicOfTaskId, taskIdsMatch } from './taskId.js';
import { loadTaxonomy, type Taxonomy, validateTag } from './taxonomy.js';
import { isWaived, WAIVABLE_SEVERITIES } from './waivers.js';

export class FindingError extends SmithError {}

export interface FailureScenario {
  inputs: string;
  expected: string;
  actual: string;
}

/** Which criterion of which plan version a spec finding is against (P9-9). */
export interface SpecRef {
  plan_version: number;
  criterion_ref: string;
}

/** Mirrors factory/specs/schema/finding.schema.json field-for-field. */
export interface Finding {
  finding_id: string;
  task_id: string;
  /**
   * The epic this finding belongs to, carried rather than derived (D-49/P9-10).
   * Absent only when the task id names no epic and no producer supplied one —
   * an unknown epic, never a guessed one.
   */
  epic_id?: string;
  fingerprint: string;
  /**
   * Repo-relative path this finding is anchored to, normalized. It is also the
   * fingerprint's first component, but a SHA-256 digest is one-way: the join
   * against a task's claims that dispatch-time context and the stale-evidence
   * check both need can only be computed from the path itself (P9-15).
   *
   * Optional because the fold's own contract says so (D-191). P9-15 added this
   * field on 2026-08-08 and `finding.schema.json` has required it since, so
   * everything written from then on carries one — but the log is append-only
   * and 23 of this repo's 57 `finding-raised` records predate the change.
   * `REQUIRED_FOLD_FIELDS` deliberately does not include it, so `listFindings`
   * returns those records; typing it required here only meant the two joins
   * above dereferenced `undefined` and crashed instead of skipping.
   */
  file_path?: string;
  finding_category: string;
  severity: string;
  finding_status: string;
  /** Absent means `diff` — see findingScope(). */
  finding_scope?: string;
  spec_ref?: SpecRef;
  summary: string;
  failure_scenario: FailureScenario;
  found_by: string;
  found_by_provider?: string;
  verified_by?: string;
  verified_by_provider?: string;
  same_mistake_of_lesson_id?: string | null;
  waiver_id?: string | null;
  /**
   * Set once an amendment took this finding to `amend-pending`: the task ids
   * that amendment added or superseded. They are the finding's discharge
   * condition — the thing `amended` is waiting on. Without them the amendment
   * obligates nothing and closes on the sentence that wrote it (D-127).
   */
  amends_task_ids?: string[];
  /** The plan version that amendment cut — where `amends_task_ids` are defined. */
  amends_plan_version?: number;
  /**
   * Set once `repairObligation` has corrected a malformed `amends_task_ids`
   * entry for this finding (D-21 Part 4): the reason the repair gave. Folded
   * from `finding-obligation-repaired` events onto `amends_task_ids` itself
   * (last-decision-wins, mirroring `isWaived`), so this field is never the
   * source of truth for the obligation — it exists only so a later discharge
   * can be shown to rest on a repaired list rather than silently dropping the
   * malformed entry. Absent means this finding's obligation was never repaired.
   */
  obligation_repair_reason?: string;
}

/**
 * Everything raiseFinding needs except the two fields it derives from the
 * anchoring path it is handed separately: `fingerprint` and the normalized
 * `file_path`.
 */
export type FindingDraft = Omit<Finding, 'fingerprint' | 'file_path'>;

export interface EventContext {
  sessionId: string;
  planVersion: number;
  causalParent: string | null;
  actor?: string;
}

/**
 * Legal finding_status transitions (architecture §11, agent-constraints.md).
 * `raised` and `confirmed` are the only non-terminal states that can end in
 * `waived`/`expired` directly: S3/S4 findings never enter the bounce-to-coder
 * fix cycle at all (severity.yml waiver_semantics), so a waiver or an
 * epic-boundary expiry can land straight from either. Everything else is a
 * strict forward chain; every other state is terminal (empty list).
 *
 * `amend-pending` hangs off the same two states and is gated a second time, on
 * scope: only a spec-scoped finding can reach it (P9-9). It opens the sole
 * exit for the S1/S2 spec finding of D-33, which is unwaivable by severity and
 * unfixable by diff — the criterion it names moved in a new plan version.
 *
 * D-127: `amended` is reachable ONLY from `amend-pending`, and that is the
 * point of the state existing. It used to hang off `raised`/`confirmed`
 * directly, so cutting a plan version — or typing `finding transition --to
 * amended` — discharged the one severity class severity.yml refuses to waive
 * in a single call, referring to no diff, no task outcome and no grade. The
 * amendment now names the task ids it made the discharge condition and the
 * finding waits on them, exactly as `fix-pending` waits on a diff.
 *
 * `amend-pending → expired` is the way an unwaivable finding can still leave
 * without its replacement work landing, and it is deliberate: it mirrors
 * `fix-pending` and `fix-landed`, an epic-boundary expiry over real
 * outstanding work. Narrower than what it replaces — an expiry is a recorded
 * epic-boundary fact, not a status anyone can type at any moment — but it is
 * not nothing, and this comment would be lying if it claimed otherwise.
 *
 * D-180: `waived` is the one closed state with a way back, because it is the
 * one closed state a later event can contradict. isWaived() folds
 * waiver-granted/waiver-denied last-decision-wins, so an operator who revokes
 * a grant has already changed the answer — and while this row was empty, the
 * finding stayed closed anyway, discretionary at the epic gate forever, with
 * no verb that could reopen it. The edge goes back to where the waiver found
 * it (`raised` or `confirmed`, whichever the grant recorded as from_status),
 * and it is gated on `waiverRevokedBy` naming the denial: this is a
 * reconciliation the log earns, not a status anyone can type.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  raised: ['confirmed', 'refuted', 'waived', 'expired', 'amend-pending'],
  confirmed: ['fix-pending', 'waived', 'expired', 'amend-pending'],
  'fix-pending': ['fix-landed', 'expired'],
  'fix-landed': ['fix-verified', 'expired'],
  'amend-pending': ['amended', 'expired'],
  refuted: [],
  'fix-verified': [],
  waived: ['raised', 'confirmed'],
  expired: [],
  amended: [],
});

/** The status an amendment puts a cited spec finding into; `amended` is what discharges it. */
export const AMEND_PENDING_STATUS = 'amend-pending';
/** Terminal: the amendment's task ids landed. Reachable only from AMEND_PENDING_STATUS. */
export const AMENDED_STATUS = 'amended';

/**
 * Both edges of the amendment path. Scope is checked on each rather than on
 * the entry edge alone: the table already makes `amended` unreachable except
 * through `amend-pending`, so the second check is redundant *given the table*
 * — which is exactly why it is here. It is the invariant, not a derivation of
 * one, and it survives someone widening the table again (D-127).
 */
const AMENDMENT_STATUSES: readonly string[] = [AMEND_PENDING_STATUS, AMENDED_STATUS];

/**
 * A finding still awaiting something. Derived from LEGAL_TRANSITIONS above by
 * reading, not by code: these are exactly the statuses with a non-empty
 * outgoing edge set that are not themselves a decision. `waived` has outgoing
 * edges too (a denial can reopen it) but is closed until one arrives, so it
 * belongs with `refuted`/`expired`/`fix-verified`/`amended` on the other side.
 *
 * `amend-pending` is in it for D-127 Part B: that finding is open the same way
 * `fix-pending` is, carrying an assigned discharge condition (amends_task_ids
 * at amends_plan_version, not a diff) that has not yet been shown to hold. A
 * reader holding the obligation data can tell a satisfied amendment from an
 * unsatisfied one and epic.ts does; every reader that cannot treats the status
 * as unconditionally open, which fails closed rather than silently agreeing
 * the amendment landed.
 *
 * Lives here rather than in the modules that ask, because they are all asking
 * the same lifecycle question about the same vocabulary: epic.ts's close gate
 * ("what is still open against this epic"), db/queries.ts's kanban chip, and
 * `smith crossfind run` ("which native findings is a second opinion allowed to
 * corroborate"). A second copy would drift the moment taxonomy.yml grows a
 * status.
 */
export const OPEN_FINDING_STATUSES: ReadonlySet<string> = new Set([
  'raised',
  'confirmed',
  'fix-pending',
  'fix-landed',
  AMEND_PENDING_STATUS,
]);

/**
 * D-21 Part 4. Appended by `repairObligation` to correct a malformed
 * `amends_task_ids` entry on a finding parked at `amend-pending` — never a
 * `finding-transitioned` event, because a repair changes no status. Folded
 * onto `amends_task_ids` the same way `finding-transitioned` is, last one in
 * the log wins, mirroring `isWaived`'s waiver-granted/waiver-denied fold.
 */
export const FINDING_OBLIGATION_REPAIRED_EVENT_TYPE = 'finding-obligation-repaired';

/** The scope dimension's default: a record written before P9-9 carries none. */
export const DEFAULT_FINDING_SCOPE = 'diff';

/**
 * Read a finding's scope, defaulting rather than requiring it. Every finding
 * already in an event log predates the dimension, and rewriting history to
 * add it is exactly the runtime taxonomy write the architecture forbids.
 */
export function findingScope(finding: Pick<Finding, 'finding_scope'>): string {
  return finding.finding_scope ?? DEFAULT_FINDING_SCOPE;
}

export const SPEC_FINDING_SCOPE = 'spec';

let cachedTaxonomy: Taxonomy | undefined;
let cachedSchemas: CompiledSchemaSet | undefined;

function resolveTaxonomyAndSchemas(opts: EventOpts): {
  taxonomy: Taxonomy;
  schemas: CompiledSchemaSet;
} {
  if (cachedTaxonomy === undefined) cachedTaxonomy = loadTaxonomy();
  if (cachedSchemas === undefined) cachedSchemas = compileSchemas(cachedTaxonomy);
  const taxonomy = opts.taxonomy ?? cachedTaxonomy;
  const schemas = opts.schemas ?? cachedSchemas;
  return { taxonomy, schemas };
}

export interface FingerprintInput {
  filePath: string;
  category: string;
  summary: string;
}

/**
 * The fingerprint's first component, and the only path form two findings may
 * be compared on. Exported because crossFinding.ts co-locates an independent
 * finder's evidence against native findings by path: `./src/a.ts`,
 * `src/a.ts` and `src\\a.ts` are the same file, and a private normalizer
 * would mean a second implementation that is allowed to disagree with the
 * one the fingerprints were built with.
 */
export function normalizeFilePath(filePath: string): string {
  return path.posix.normalize(filePath.replace(/\\/g, '/')).replace(/^\.\//, '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strip a `<path>:<line>[:<col>]` reference anchored to THIS finding's own
 * file path (full path and bare basename, since reviewers report both
 * forms) — never a bare `:digits` anywhere in the text. A blanket
 * `:\d+` strip is wrong: free-text like "debug endpoint exposed on :8080"
 * would collide with an unrelated ":9090" finding (reproduced regression,
 * reviewer finding #3).
 */
function stripPathLineRef(summary: string, filePath: string): string {
  const forwardSlashPath = filePath.replace(/\\/g, '/');
  const candidates = new Set([filePath, forwardSlashPath, path.posix.basename(forwardSlashPath)]);
  let result = summary;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const pattern = new RegExp(`${escapeRegExp(candidate)}:\\d+(?::\\d+)?`, 'g');
    result = result.replace(pattern, candidate);
  }
  return result;
}

/** lowercase, whitespace collapsed (spec wording; path-anchored line refs stripped by the caller). */
function normalizeSummary(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/\bline\s+\d+\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stable dedup key: same file + same finding_category + same normalized
 * summary maps to the same fingerprint regardless of line-number drift
 * between re-review rounds. Uses node:crypto (no new dependency).
 */
export function computeFingerprint(input: FingerprintInput): string {
  const summaryWithoutLineRef = stripPathLineRef(input.summary, input.filePath);
  const material = [
    normalizeFilePath(input.filePath),
    input.category,
    normalizeSummary(summaryWithoutLineRef),
  ].join(' ');
  return createHash('sha256').update(material).digest('hex');
}

export interface RaiseFindingInput {
  finding: FindingDraft;
  filePath: string;
}

/**
 * What a judge actually returns — evidence, no identity (interview N-2).
 * A judge cannot know its own task id or which provider ran it, and a judge
 * that invents its own `finding_id` breaks dedup across re-review rounds.
 */
export interface FindingEvidence {
  /** Repo-relative path the finding is anchored to; the fingerprint's first component. */
  file_path: string;
  finding_category: string;
  severity: string;
  summary: string;
  failure_scenario: FailureScenario;
  /**
   * Which acceptance criterion the evidence is against. Evidence, not
   * identity: a spec reviewer legitimately knows which criterion it read,
   * and cannot know the plan version it was dispatched on.
   */
  criterion_ref?: string;
}

export interface MintContext {
  taskId: string;
  /** taxonomy `agent` — the judge role that produced the evidence. */
  foundBy: string;
  foundByProvider?: string;
  /**
   * Present iff this was a spec-review dispatch. Its presence — not a flag on
   * each item — is what makes every finding in the batch spec-scoped: scope
   * is a property of what was reviewed, and one dispatch reviews one thing.
   */
  spec?: { planVersion: number };
}

/** Fields the orchestrator owns; evidence carrying any of them is a contract breach, not a hint. */
const ORCHESTRATOR_OWNED_FINDING_FIELDS = [
  'finding_id',
  'task_id',
  'fingerprint',
  'finding_status',
  'found_by',
  'found_by_provider',
] as const;

/**
 * Readable and unique: the task scopes it (two tasks can legitimately hit the
 * same file+category+summary), the fingerprint digest makes it deterministic,
 * so re-minting the same evidence in a later round yields the same id.
 */
function mintFindingId(taskId: string, fingerprint: string): string {
  return `f-${taskId}-${fingerprint.slice(0, 8)}`;
}

/**
 * Guess which taxonomy value a judge meant when it wrote something close but
 * not equal to one. Derived from the vocabulary itself rather than a synonym
 * table, so it cannot drift from taxonomy.yml the way a hand-written map
 * would, and it suggests without ever correcting — the judge's evidence is
 * rejected either way, the suggestion just saves a round trip.
 *
 * Three rules, each returning only when it picks out exactly one candidate:
 * the bare head (`S2` → `S2-major`), the bare tail (`coverage` →
 * `test-coverage`, `hds` → `visual-hds`), and one shared hyphen token
 * (`test-gap` → `test-coverage` — the wave-3 slip in D-37 that cost a full
 * gate round).
 */
function suggestCanonical(values: readonly string[], written: string): string | undefined {
  const head = values.filter((value) => value.startsWith(`${written}-`));
  if (head.length === 1) return head[0];
  const tail = values.filter((value) => value.endsWith(`-${written}`));
  if (tail.length === 1) return tail[0];
  const tokens = new Set(written.split('-').filter((token) => token !== ''));
  const shared = values.filter((value) => value.split('-').some((token) => tokens.has(token)));
  if (shared.length === 1) return shared[0];
  return undefined;
}

/**
 * Turn a judge's evidence array into `raiseFinding` inputs, minting the
 * identity fields the orchestrator owns (interview N-2).
 *
 * Three failures are caught here rather than at the schema, because the
 * schema's message does not tell an operator which side broke the contract:
 * evidence that carries orchestrator-owned identity (the judge overstepped),
 * a severity written as the bare grade "S2" instead of the canonical taxonomy
 * value "S2-major" — by far the most common template-to-taxonomy slip — and
 * (P9-20 / D-37) a `finding_category` outside the vocabulary. The category
 * used to be copied through untouched and first rejected at gate intake,
 * five checks later, by an error naming no legal value; a reviewer that wrote
 * `test-gap` for `test-coverage` cost a whole gate round that way.
 */
export function mintFindings(
  evidence: readonly FindingEvidence[],
  ctx: MintContext,
  opts: EventOpts = {},
): RaiseFindingInput[] {
  const { taxonomy } = resolveTaxonomyAndSchemas(opts);
  const severities = taxonomy.dimensions.severity ?? [];
  const categories = taxonomy.dimensions.finding_category ?? [];

  return evidence.map((item, index) => {
    const overstep = ORCHESTRATOR_OWNED_FINDING_FIELDS.filter(
      (field) => (item as unknown as Record<string, unknown>)[field] !== undefined,
    );
    if (overstep.length > 0) {
      throw new FindingError(
        'findings.evidence-carries-identity',
        `Finding evidence at index ${index} set orchestrator-owned field(s) ${overstep.join(', ')}. Judges return evidence only.`,
        { index, fields: [...overstep] },
      );
    }

    if (!severities.includes(item.severity)) {
      const canonical = suggestCanonical(severities, item.severity);
      throw new FindingError(
        'findings.non-canonical-severity',
        canonical
          ? `Finding evidence at index ${index} used severity "${item.severity}"; the taxonomy value is "${canonical}" — write it out in full.`
          : `Finding evidence at index ${index} used unknown severity "${item.severity}". Valid: ${severities.join(', ')}.`,
        { index, severity: item.severity },
      );
    }

    if (!categories.includes(item.finding_category)) {
      const canonical = suggestCanonical(categories, item.finding_category);
      throw new FindingError(
        'findings.non-canonical-finding-category',
        `Finding evidence at index ${index} used ` +
          (canonical
            ? `finding_category "${item.finding_category}"; the taxonomy value is "${canonical}" — write it out in full. `
            : `unknown finding_category "${item.finding_category}". `) +
          `Valid: ${categories.join(', ')}.`,
        { index, finding_category: item.finding_category },
      );
    }

    if (ctx.spec && !item.criterion_ref) {
      throw new FindingError(
        'findings.spec-evidence-needs-criterion',
        `Spec-review evidence at index ${index} names no criterion_ref. "The plan is wrong" has to say which clause.`,
        { index },
      );
    }

    const fingerprint = computeFingerprint({
      filePath: item.file_path,
      category: item.finding_category,
      summary: item.summary,
    });

    const epicId = epicOfTaskId(ctx.taskId);
    const finding: FindingDraft = {
      finding_id: mintFindingId(ctx.taskId, fingerprint),
      task_id: ctx.taskId,
      // Carried, not derived downstream (D-49/P9-10). Omitted rather than
      // guessed when the task id names no epic: a wrong epic reads exactly
      // like a right one everywhere it is consumed.
      ...(epicId === null ? {} : { epic_id: epicId }),
      finding_category: item.finding_category,
      severity: item.severity,
      // raiseFinding forces this too; set here so the minted draft is already
      // a valid finding record on its own (e.g. when written to disk first).
      finding_status: 'raised',
      // A criterion_ref on a diff dispatch is dropped, not promoted: scope
      // comes from how the judge was dispatched, never from what it returned.
      ...(ctx.spec && item.criterion_ref
        ? {
            finding_scope: SPEC_FINDING_SCOPE,
            spec_ref: { plan_version: ctx.spec.planVersion, criterion_ref: item.criterion_ref },
          }
        : {}),
      summary: item.summary,
      failure_scenario: item.failure_scenario,
      found_by: ctx.foundBy,
      ...(ctx.foundByProvider ? { found_by_provider: ctx.foundByProvider } : {}),
    };

    return { finding, filePath: item.file_path };
  });
}

/**
 * Move a minted finding to the task that actually owns its file (D-41/P9-24).
 *
 * The id is re-minted, not patched: `finding_id` embeds the task id, so a
 * finding carrying `f-<gated-task>-<fp>` while claiming `task_id: <owner>`
 * would read as two different answers to "whose is this" in the one record
 * an operator greps. The fingerprint is unchanged by construction — it is
 * computed from file, category and summary, none of which ownership touches —
 * so dedup and waivers survive the move.
 */
export function reattributeFinding(input: RaiseFindingInput, taskId: string): RaiseFindingInput {
  const fingerprint = computeFingerprint({
    filePath: input.filePath,
    category: input.finding.finding_category,
    summary: input.finding.summary,
  });
  const epicId = epicOfTaskId(taskId);
  // `epic_id` moves with `task_id` — a finding reassigned across epics whose
  // epic field still named the old one would be counted twice by the epic
  // verdict, once correctly and once as a phantom open finding.
  const { epic_id: _dropped, ...rest } = input.finding;
  return {
    ...input,
    finding: {
      ...rest,
      task_id: taskId,
      ...(epicId === null ? {} : { epic_id: epicId }),
      finding_id: mintFindingId(taskId, fingerprint),
    },
  };
}

export type RaiseFindingResult =
  | { suppressed: false; finding: Finding }
  | { suppressed: true; fingerprint: string; taskId: string };

/**
 * Validate the finding (schema + taxonomy, same pattern as plan.ts), compute
 * its fingerprint, and append it to the event log — unless that fingerprint
 * is already waived AND this finding sits at a waivable severity, in which
 * case a finding-suppressed event is logged instead (analytics keep seeing
 * the recurrence) and no duplicate raised finding is appended. An S1/S2 is
 * raised even over a waived fingerprint (D-196): a waiver answers the
 * question it was asked, and severity.yml never lets that question be asked
 * about a merge-blocking finding. Always forces finding_status to "raised": the whole
 * point of this call is the raise transition, regardless of what the
 * reviewer/verifier JSON happened to set.
 */
export async function raiseFinding(
  input: RaiseFindingInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<RaiseFindingResult> {
  const fingerprint = computeFingerprint({
    filePath: input.filePath,
    category: input.finding.finding_category,
    summary: input.finding.summary,
  });
  // Backfill `epic_id` for producers that never set it (`smith findings raise`,
  // a hand-written draft): this is the one boundary every finding crosses, so
  // one derivation here means every stored record carries the field. Still
  // omitted when the task id names no epic — see the field's comment.
  const epicId = input.finding.epic_id ?? epicOfTaskId(input.finding.task_id) ?? undefined;
  // `file_path` is stamped in the same normalized form the fingerprint was
  // computed from, so "same file" means the same thing to the dedup key and to
  // the claims join.
  const finding: Finding = {
    ...input.finding,
    ...(epicId === undefined ? {} : { epic_id: epicId }),
    finding_status: 'raised',
    fingerprint,
    file_path: normalizeFilePath(input.filePath),
  };

  // Scope and ref travel together or not at all. Enforced here rather than in
  // finding.schema.json because the JSON-Schema form of "required when scope
  // is spec" needs `const: "spec"` inline, and inlining a taxonomy value in a
  // schema is the drift the schema's own $comment forbids (architecture §8).
  if (findingScope(finding) === SPEC_FINDING_SCOPE && finding.spec_ref === undefined) {
    throw new FindingError(
      'findings.spec-finding-needs-ref',
      `Finding "${finding.finding_id}" is spec-scoped but names no criterion. A spec finding blocks the plan, so it has to say which clause moved.`,
      { findingId: finding.finding_id },
    );
  }
  if (findingScope(finding) !== SPEC_FINDING_SCOPE && finding.spec_ref !== undefined) {
    throw new FindingError(
      'findings.spec-ref-without-scope',
      `Finding "${finding.finding_id}" carries a spec_ref but is scoped "${findingScope(finding)}". A diff finding is answered by a diff, not by a plan amendment.`,
      { findingId: finding.finding_id, scope: findingScope(finding) },
    );
  }

  const { taxonomy, schemas } = resolveTaxonomyAndSchemas(opts);
  const validation = validateRecord(schemas, taxonomy, 'finding', finding);
  if (!validation.valid) {
    throw new FindingError(
      'findings.invalid-record',
      'Finding failed schema/taxonomy validation.',
      { errors: validation.errors },
    );
  }

  // D-196: the waiver has to be one that could have been granted over THIS
  // finding. The fingerprint is file + category + summary and deliberately
  // blind to severity, so that line-number and wording drift between
  // re-review rounds still dedups (see computeFingerprint) — which means a
  // grant made over an S3 is keyed the same as an S1 raised on the identical
  // sentence, and the S1 vanished into a finding-suppressed event that
  // nothing blocks on. Every other door into "a waiver answers this finding"
  // asks about severity first: pendingBatch only offers S3/S4, applyBatch
  // refuses to grant over a non-waivable sibling, reconcileFindingsToWaived
  // skips them, and transition() refuses `-> waived` outright. This is the
  // fifth door, and suppression is the only one of the five that leaves no
  // finding behind at all.
  const suppressible = WAIVABLE_SEVERITIES.includes(finding.severity);
  const waived = suppressible && (await isWaived(fingerprint, { sessionId: ctx.sessionId }, opts));
  if (waived) {
    await appendEvent(
      {
        session_id: ctx.sessionId,
        actor: ctx.actor ?? finding.found_by,
        event_type: 'finding-suppressed',
        task_id: finding.task_id,
        plan_version: ctx.planVersion,
        causal_parent: ctx.causalParent,
        payload: { fingerprint, finding_id: finding.finding_id, task_id: finding.task_id },
      },
      opts,
    );
    return { suppressed: true, fingerprint, taskId: finding.task_id };
  }

  await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? finding.found_by,
      event_type: 'finding-raised',
      task_id: finding.task_id,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: finding as unknown as Record<string, unknown>,
    },
    opts,
  );

  return { suppressed: false, finding };
}

export interface FindingFilter {
  taskId?: string;
  /**
   * Matches the finding's `epic_id` field, falling back to the epic its
   * task_id names for records raised before the field existed. An
   * unqualified task_id with no `epic_id` matches nothing — it is not
   * evidence that the finding belongs to an epic of that name (D-49/P9-10).
   *
   * It is not evidence of the reverse either, and this filter feeds the epic
   * close gate. So `foldFindingsDetailed` reports such a record on `skipped`
   * instead of dropping it silently (D-143); `foldFindings` still returns
   * only the placed findings, because its callers have nowhere to put a
   * record they cannot read.
   */
  epic?: string;
  status?: string;
  severity?: string;
  category?: string;
}

/**
 * Current state of every finding in this session's LINEAGE: a fold, never a
 * mutable store.
 *
 * Lineage, not session, since D-119. An epic that continues in a fresh session
 * — the thing `validateCausalParent` documents as "the documented way to run a
 * large epic" — used to arrive at its second session with an empty board, and
 * every gate downstream of this call answered `go` on it in the same words it
 * would have used for a genuinely clean one.
 */
export async function listFindings(
  sessionId: string,
  filter: FindingFilter = {},
  opts: EventOpts = {},
): Promise<Finding[]> {
  return foldFindings(await readLineageEvents(sessionId, opts), filter);
}

/**
 * The same fold, over events the caller already holds.
 *
 * `db/projector.ts` is why this is separate. `projectFindings` re-folds ONE
 * session's log and replaces only that session's rows, "leaving every other
 * session's projection intact" (`apply()`'s own contract) — so it must keep
 * reading one session, or a continuation's rows would become a second copy of
 * every ancestor's findings under a new session_id. Handing it a narrower
 * reader by NAME is the point: the safe scope is what `listFindings` does by
 * default, and the narrow one has to be asked for.
 */
export function foldFindings(events: StoredEvent[], filter: FindingFilter = {}): Finding[] {
  return foldFindingsDetailed(events, filter).findings;
}

/**
 * The fields the fold itself dereferences. Deliberately NOT the full
 * `finding.schema.json` required list: this is a reader coping with history,
 * and rejecting an old record for a field no reader touches would quarantine
 * data that is in fact usable. `appendEvent` enforces the full schema on
 * everything written from now on.
 */
export const REQUIRED_FOLD_FIELDS = ['finding_id', 'task_id'] as const;

/**
 * The fields the SQLite *projection* needs on top of the fold's — together,
 * every payload-sourced `notNull()` column of `db/schema.ts`'s `findings`
 * table. Superset of `REQUIRED_FOLD_FIELDS` by construction, and
 * `test/db/projector.test.ts` asserts the other direction: no `notNull()`
 * column may be added to that table without a payload field here to fill it.
 *
 * D-141. These two lists are allowed to differ — the fold serves
 * `smith findings list`, which can show a record it only partly understands,
 * while an INSERT either satisfies every constraint or aborts the transaction —
 * but they must differ *knowingly*. They did not: 18 of this repo's 57
 * `finding-raised` records predate `fingerprint`, the fold returned all of
 * them, and `smith db rebuild` died on the first with
 * `NOT NULL constraint failed: findings.fingerprint`. Splitting the lists
 * explicitly lets the projector quarantine what it cannot store while the fold
 * keeps showing it.
 */
export const REQUIRED_PROJECTION_FIELDS = [
  ...REQUIRED_FOLD_FIELDS,
  'fingerprint',
  'finding_category',
  'severity',
  'finding_status',
  'summary',
  'found_by',
] as const;

/**
 * Names the projection-required fields this finding cannot fill, in declaration
 * order. Empty means the record can become a row.
 */
export function missingProjectionFields(finding: Finding): string[] {
  const record = finding as unknown as Record<string, unknown>;
  return REQUIRED_PROJECTION_FIELDS.filter((field) => typeof record[field] !== 'string');
}

/**
 * One `finding-raised` record a reader had to hold back — either the fold could
 * not turn it into a Finding, or the SQLite projection could not turn that
 * Finding into a row (D-141). `event_id` locates it in the append-only log;
 * `reason` says which fields were missing.
 */
export interface SkippedFindingRecord {
  event_id: string;
  finding_id?: string;
  reason: string;
}

export interface DetailedFold {
  findings: Finding[];
  /**
   * Records the fold refused. NEVER empty-by-omission: a caller that renders
   * findings as a verdict must treat a non-empty `skipped` as a blocker, not
   * as a footnote, because the count it is about to print is short by exactly
   * this many and nothing else in the output says so.
   */
  skipped: SkippedFindingRecord[];
}

/**
 * `foldFindings`, plus what it had to leave behind.
 *
 * D-135. The fold rebuilds each Finding from `record.payload` alone, so a
 * payload missing `task_id` folded to `task_id: undefined` and the `--epic`
 * filter threw a bare TypeError out of `smith findings list`. `appendEvent`
 * now rejects such a payload at write time, but the log is append-only:
 * records written before that guard existed are still on disk and cannot be
 * validated away retroactively, so the reader has to cope with them.
 *
 * Coping is not the same as ignoring. Dropping a malformed record silently
 * would trade a loud crash for a quiet undercount — the same failure shape as
 * D-130, where a well-formed short answer read exactly like a complete one.
 * So the fold quarantines the record and NAMES it, and callers that report to
 * a human surface the quarantine alongside the count.
 */
export function foldFindingsDetailed(
  events: StoredEvent[],
  filter: FindingFilter = {},
): DetailedFold {
  const byId = new Map<string, Finding>();
  const skipped: SkippedFindingRecord[] = [];
  // Which record raised each finding, so a quarantine entry can name the row
  // an operator has to go repair (D-143).
  const eventIdOf = new Map<string, string>();

  for (const { event_id, record } of events) {
    if (record.event_type === 'finding-raised') {
      const finding = record.payload as unknown as Finding;
      const missing = REQUIRED_FOLD_FIELDS.filter((field) => typeof finding?.[field] !== 'string');
      if (missing.length > 0) {
        skipped.push({
          event_id,
          ...(typeof finding?.finding_id === 'string' ? { finding_id: finding.finding_id } : {}),
          reason: `finding-raised payload is missing required string field(s): ${missing.join(', ')}`,
        });
        continue;
      }
      byId.set(finding.finding_id, { ...finding });
      eventIdOf.set(finding.finding_id, event_id);
    } else if (record.event_type === 'finding-transitioned') {
      const payload = record.payload as {
        finding_id: string;
        to_status: string;
        waiver_id?: string;
        waiver_revoked_by?: string;
        amends_task_ids?: string[];
        amends_plan_version?: number;
      };
      const existing = byId.get(payload.finding_id);
      if (existing) {
        // D-180: the revocation takes the waiver's id with it, so a reopened
        // finding does not still name the waiver that stopped holding it.
        if (payload.waiver_revoked_by) delete existing.waiver_id;
        byId.set(payload.finding_id, {
          ...existing,
          finding_status: payload.to_status,
          ...(payload.waiver_id ? { waiver_id: payload.waiver_id } : {}),
          ...(payload.amends_task_ids ? { amends_task_ids: payload.amends_task_ids } : {}),
          ...(payload.amends_plan_version
            ? { amends_plan_version: payload.amends_plan_version }
            : {}),
        });
      }
    } else if (record.event_type === FINDING_OBLIGATION_REPAIRED_EVENT_TYPE) {
      // D-21 Part 4: last-decision-wins onto amends_task_ids, mirroring
      // isWaived's waiver-granted/waiver-denied fold -- a repair changes no
      // status, so it is not a finding-transitioned event and would
      // otherwise never reach this fold at all.
      const payload = record.payload as {
        finding_id: string;
        to_obligation?: string[];
        reason?: string;
      };
      const existing = byId.get(payload.finding_id);
      if (existing) {
        byId.set(payload.finding_id, {
          ...existing,
          ...(payload.to_obligation ? { amends_task_ids: [...payload.to_obligation] } : {}),
          ...(payload.reason !== undefined ? { obligation_repair_reason: payload.reason } : {}),
        });
      }
    }
  }

  let results = [...byId.values()];
  // D-143: the same two-spelling rule D-130 gave `filterEvents`. A raw `===`
  // answered `findings list --task <epic>/<task>` with an empty list for a
  // task holding two findings raised under the bare spelling.
  if (filter.taskId !== undefined)
    results = results.filter((f) => taskIdsMatch(f.task_id, filter.taskId));
  if (filter.epic !== undefined) {
    // The filter is right not to guess (see FindingFilter.epic): a bare id is
    // not evidence that the finding belongs to an epic of that name. But this
    // fold feeds the epic close gate, and there "matches nothing" was read as
    // "this epic has no findings" — `envkit-config-loader` folded 0 findings
    // and 0 quarantine while three `raised` ones sat in its log. So a record
    // this filter cannot PLACE is quarantined rather than dropped: unknown
    // membership is not evidence of non-membership, the same fail-closed call
    // as an unreadable payload above (D-143).
    const wanted = filter.epic;
    const placed: Finding[] = [];
    for (const finding of results) {
      const epicId = finding.epic_id ?? epicOfTaskId(finding.task_id);
      if (epicId === wanted) {
        placed.push(finding);
      } else if (epicId === null) {
        skipped.push({
          event_id: eventIdOf.get(finding.finding_id) ?? '(unknown)',
          finding_id: finding.finding_id,
          reason: `finding names no epic: task_id "${finding.task_id}" is unqualified and the record carries no epic_id, so it cannot be shown to belong to "${wanted}" or to any other epic`,
        });
      }
    }
    results = placed;
  }
  if (filter.status !== undefined)
    results = results.filter((f) => f.finding_status === filter.status);
  if (filter.severity !== undefined)
    results = results.filter((f) => f.severity === filter.severity);
  if (filter.category !== undefined)
    results = results.filter((f) => f.finding_category === filter.category);
  return { findings: results, skipped };
}

/**
 * The status a finding held immediately before its waiver closed it, read off
 * the grant's own `from_status` (D-180). `undefined` when the finding is not
 * waived, is unknown, or was waived by a transition written before this field
 * existed — callers reopening a waiver must treat that as "cannot place it"
 * rather than picking a status.
 *
 * Exported for waivers.ts, which needs the target BEFORE it calls transition()
 * and cannot get it from listFindings: the fold keeps the current status, and
 * the one this asks for is precisely the one the fold overwrote.
 */
export async function preWaiverStatus(
  findingId: string,
  sessionId: string,
  opts: EventOpts = {},
): Promise<string | undefined> {
  const events = await readLineageEvents(sessionId, opts);
  let from: string | undefined;
  for (const { record } of events) {
    if (record.event_type !== 'finding-transitioned') continue;
    const payload = record.payload as {
      finding_id: string;
      from_status?: string;
      to_status: string;
    };
    if (payload.finding_id !== findingId) continue;
    if (payload.to_status === 'waived') from = payload.from_status;
  }
  return from;
}

export interface TransitionExtra {
  /** Set on a → waived transition to record which waiver-granted event caused it. */
  waiverId?: string;
  /**
   * Required on a → amend-pending transition: the task ids the amendment
   * added or superseded, which become this finding's discharge condition.
   * Required because an amendment that obligates nothing is discharged the
   * moment it is written, which is the whole of D-127.
   */
  amendsTaskIds?: readonly string[];
  /** The plan version that amendment cut, so a reader can find the diff those ids came from. */
  amendsPlanVersion?: number;
  /**
   * Required on a → amended transition: the landed tasks the caller offers as
   * proof the amendment's obligation is discharged. See `outstandingObligations`.
   */
  amendsSatisfiedBy?: readonly AmendmentDischarge[];
  /**
   * Required to leave `waived` (D-180): the waiver-denied event that revoked
   * the grant which closed this finding. Without it the exit does not exist,
   * so a waived finding cannot be reopened by typing a status at it.
   */
  waiverRevokedBy?: string;
}

/** One landed task offered as proof that an amendment's obligation is met. */
export interface AmendmentDischarge {
  /** The task id, bare or epic-qualified — compared bare either way. */
  taskId: string;
  /** The plan version it landed under. */
  planVersion: number;
}

/**
 * Which of `finding`'s obligations the offered evidence does NOT discharge.
 *
 * An obligation is discharged by a row naming the same task (bare compare,
 * D-46/P9-29: `amends_task_ids` comes off the plan and the evidence off the
 * fold, and the two registers spell ids either way) at a plan version at or
 * past the one the amendment cut. The version clause is what stops a task that
 * landed under the plan the amendment REPLACED from discharging it — the D-125
 * shape, where a superseded task would satisfy the amendment that superseded it.
 *
 * An amendment naming no ids, or carrying no version, has no discharge
 * condition and so can never be satisfied: every id is outstanding and there
 * are none, which reads as `null` rather than `[]`. summarizeEpic draws the
 * same distinction, and for the same reason — "nothing to wait on" and
 * "waiting on nothing outstanding" must not look alike.
 */
export function outstandingObligations(
  finding: Pick<Finding, 'amends_task_ids' | 'amends_plan_version'>,
  evidence: readonly AmendmentDischarge[],
): string[] | null {
  const obligations = finding.amends_task_ids ?? [];
  const version = finding.amends_plan_version;
  if (obligations.length === 0 || version === undefined) return null;
  return obligations.filter((id) => {
    const bare = bareTaskId(id);
    return !evidence.some((row) => bareTaskId(row.taskId) === bare && row.planVersion >= version);
  });
}

/**
 * Enforce the finding_status state machine (LEGAL_TRANSITIONS) and append a
 * finding-transitioned event. Folds the log itself (rather than delegating
 * to listFindings) so it has the one finding's raw history without paying
 * for a full-session scan-and-filter.
 *
 * `→ waived` is additionally gated on WAIVABLE_SEVERITIES (severity.yml
 * waiver_semantics: only S3/S4 findings are ever waived) — the same
 * constant waivers.ts uses, so this is enforced identically whether reached
 * via a direct transition() call (e.g. the CLI) or via a waiver grant
 * (waivers.ts's reconciliation).
 *
 * Both amendment edges are gated the same way on scope: they are the spec
 * finding's exit, and letting a diff finding take them would turn "the plan
 * changed" into a way to close code defects nobody fixed (P9-9). `→
 * amend-pending` is additionally gated on naming at least one task id, since
 * an amendment owing nothing discharges the finding it cites on the spot
 * (D-127).
 *
 * `→ amended` is gated on the caller SHOWING the obligation discharged —
 * `amendsSatisfiedBy`, checked against the finding's own amends_task_ids and
 * amends_plan_version. The gate lives here for the reason the waiver gate does:
 * closeEpic is not the only caller, and while the satisfaction check lived only
 * there, `smith findings transition <id> amended` closed the unwaivable class
 * with nothing built — D-127 through the operator's door. Evidence is supplied
 * rather than folded here so transition() keeps costing one finding's history
 * instead of the whole task log; a caller that fabricates it is forging a
 * record, which is a different problem from an open door.
 */
export async function transition(
  findingId: string,
  newStatus: string,
  ctx: EventContext,
  opts: EventOpts = {},
  extra: TransitionExtra = {},
): Promise<Finding> {
  // Lineage (D-119): a finding raised in the first session of a cross-session
  // epic is otherwise not FOUND from the second, and this function's own
  // "unknown finding" error would be the answer to a finding that plainly
  // exists.
  const events = await readLineageEvents(ctx.sessionId, opts);
  let current: Finding | undefined;
  /**
   * The status the waiver closed over, from the grant's own from_status
   * (D-180). Read off the log rather than assumed: a finding waived out of
   * `raised` was never confirmed, and sending it back to `confirmed` would
   * credit it with a verification that never happened.
   */
  let preWaiverStatus: string | undefined;

  for (const { record } of events) {
    if (record.event_type === 'finding-raised') {
      const finding = record.payload as unknown as Finding;
      if (finding.finding_id === findingId) current = { ...finding };
    } else if (record.event_type === 'finding-transitioned') {
      const payload = record.payload as {
        finding_id: string;
        from_status?: string;
        to_status: string;
        waiver_id?: string;
        waiver_revoked_by?: string;
        amends_task_ids?: string[];
        amends_plan_version?: number;
      };
      if (payload.finding_id === findingId && current) {
        if (payload.to_status === 'waived') preWaiverStatus = payload.from_status;
        if (payload.waiver_revoked_by) delete current.waiver_id;
        current = {
          ...current,
          finding_status: payload.to_status,
          ...(payload.waiver_id ? { waiver_id: payload.waiver_id } : {}),
          ...(payload.amends_task_ids ? { amends_task_ids: payload.amends_task_ids } : {}),
          ...(payload.amends_plan_version
            ? { amends_plan_version: payload.amends_plan_version }
            : {}),
        };
      }
    } else if (record.event_type === FINDING_OBLIGATION_REPAIRED_EVENT_TYPE) {
      // D-21 Part 4: a repair changes amends_task_ids without touching
      // finding_status, so it is folded here too -- otherwise a -> amended
      // discharge (outstandingObligations, just below) would keep judging the
      // ORIGINAL, possibly-malformed obligation rather than the repaired one.
      const payload = record.payload as {
        finding_id: string;
        to_obligation?: string[];
        reason?: string;
      };
      if (payload.finding_id === findingId && current) {
        current = {
          ...current,
          ...(payload.to_obligation ? { amends_task_ids: [...payload.to_obligation] } : {}),
          ...(payload.reason !== undefined ? { obligation_repair_reason: payload.reason } : {}),
        };
      }
    }
  }

  if (!current) {
    throw new FindingError(
      'findings.unknown-finding',
      `No raised finding with id "${findingId}".`,
      {
        findingId,
      },
    );
  }

  const legal = LEGAL_TRANSITIONS[current.finding_status] ?? [];
  if (!legal.includes(newStatus)) {
    throw new FindingError(
      'findings.illegal-transition',
      `Cannot transition finding "${findingId}" from "${current.finding_status}" to "${newStatus}".`,
      { findingId, from: current.finding_status, to: newStatus },
    );
  }

  // D-180: the only way out of `waived` is a revocation the log can be pointed
  // at. Checked before the target is compared so "you named no denial" is the
  // answer to a caller who named none, rather than a status complaint.
  if (current.finding_status === 'waived') {
    if (extra.waiverRevokedBy === undefined) {
      throw new FindingError(
        'findings.waiver-revocation-unproven',
        `Finding "${findingId}" is waived, and a waiver is undone by revoking it, not by typing a status at it. Record the operator's reversal first — "smith waiver apply" with a "denied" decision on this fingerprint reopens the finding as part of writing the denial.`,
        { findingId, to: newStatus },
      );
    }
    if (newStatus !== preWaiverStatus) {
      throw new FindingError(
        'findings.waiver-revocation-wrong-status',
        `Finding "${findingId}" was waived out of "${preWaiverStatus ?? 'an unrecorded status'}", so revoking that waiver returns it there, not to "${newStatus}". A revocation restores what the waiver closed over; it does not re-grade the finding.`,
        { findingId, to: newStatus, preWaiverStatus: preWaiverStatus ?? null },
      );
    }
  }

  if (newStatus === 'waived' && !WAIVABLE_SEVERITIES.includes(current.severity)) {
    throw new FindingError(
      'findings.not-waivable',
      `Finding "${findingId}" has severity "${current.severity}"; only ${WAIVABLE_SEVERITIES.join('/')} findings are waivable.`,
      { findingId, severity: current.severity },
    );
  }

  if (AMENDMENT_STATUSES.includes(newStatus) && findingScope(current) !== SPEC_FINDING_SCOPE) {
    throw new FindingError(
      'findings.not-amendable',
      `Finding "${findingId}" is scoped "${findingScope(current)}", so it cannot take the amendment path at "${newStatus}": only a spec finding closes by amending the plan. A defect in the diff is closed by fixing the diff.`,
      { findingId, scope: findingScope(current), to: newStatus },
    );
  }

  if (newStatus === AMEND_PENDING_STATUS && (extra.amendsTaskIds?.length ?? 0) === 0) {
    throw new FindingError(
      'findings.amendment-without-obligation',
      `Finding "${findingId}" cannot enter "${AMEND_PENDING_STATUS}" naming no task ids. An amendment that obligates nothing discharges the finding the moment it is written, which is D-127 — say which added or superseded task this finding is now waiting on. "smith plan amend" derives that list from the plan diff and is the only verb that does (D-136).`,
      { findingId },
    );
  }

  if (newStatus === AMENDED_STATUS) {
    const outstanding = outstandingObligations(current, extra.amendsSatisfiedBy ?? []);
    if (outstanding === null || outstanding.length > 0) {
      throw new FindingError(
        'findings.amendment-not-discharged',
        outstanding === null
          ? `Finding "${findingId}" is at "${AMEND_PENDING_STATUS}" but names no task ids at a plan version, so no evidence can discharge it. Expire it at the epic boundary instead.`
          : `Finding "${findingId}" cannot close at "${AMENDED_STATUS}": ${outstanding.join(', ')} has not been shown to have landed at plan version ${current.amends_plan_version} or later. An amendment is discharged by its tasks landing, not by being told they did — this is D-127. "smith epic close" computes and supplies that evidence.`,
        {
          findingId,
          outstanding: outstanding ?? [],
          amendsPlanVersion: current.amends_plan_version,
        },
      );
    }
  }

  const { taxonomy } = resolveTaxonomyAndSchemas(opts);
  validateTag(taxonomy, 'finding_status', newStatus);

  const payload: Record<string, unknown> = {
    finding_id: findingId,
    fingerprint: current.fingerprint,
    from_status: current.finding_status,
    to_status: newStatus,
  };
  if (extra.waiverId !== undefined) payload.waiver_id = extra.waiverId;
  if (extra.waiverRevokedBy !== undefined) payload.waiver_revoked_by = extra.waiverRevokedBy;
  if (extra.amendsTaskIds !== undefined) payload.amends_task_ids = [...extra.amendsTaskIds];
  if (extra.amendsPlanVersion !== undefined) payload.amends_plan_version = extra.amendsPlanVersion;
  // The evidence goes in the log, not on the finding: it is why THIS
  // transition was allowed, and a reader asking "what closed this?" gets the
  // landed tasks and their versions rather than having to re-derive them.
  if (extra.amendsSatisfiedBy !== undefined)
    payload.amends_satisfied_by = extra.amendsSatisfiedBy.map((row) => ({ ...row }));

  await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: 'finding-transitioned',
      task_id: current.task_id,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload,
    },
    opts,
  );

  const result: Finding = {
    ...current,
    finding_status: newStatus,
    ...(extra.waiverId !== undefined ? { waiver_id: extra.waiverId } : {}),
    ...(extra.amendsTaskIds !== undefined ? { amends_task_ids: [...extra.amendsTaskIds] } : {}),
    ...(extra.amendsPlanVersion !== undefined
      ? { amends_plan_version: extra.amendsPlanVersion }
      : {}),
  };
  // A reopened finding carrying the id of the waiver that no longer holds it
  // is the same split state D-180 is about, one field smaller.
  if (extra.waiverRevokedBy !== undefined) delete result.waiver_id;
  return result;
}

// ---------------------------------------------------------------------------
// Obligation repair (D-21 Part 4)
// ---------------------------------------------------------------------------

/** Whether `value` is the shape a real task id always has — never a non-empty check alone. */
/**
 * Whether `value` is the shape a real task id always has -- never a
 * non-empty check alone. Exported: epic.ts's malformed-obligation check
 * (summarizeEpic) has to agree with this definition exactly, or a "" entry
 * reads as well-formed to one reader and corrupt to the other -- which is
 * precisely the D-21 Part 4 review finding this sharing closes. epic.ts is
 * the side that had to move: bareTaskId/taskIdsMatch can never match "" to a
 * real task id downstream, so a looser epic.ts definition would leave this
 * shape permanently unrepairable rather than merely unusual.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * describeType, but naming an empty string as itself rather than merely
 * "string" -- an empty task id is exactly as malformed as a non-string one,
 * and "string" alone would misname it as fine. Exported for the same reason
 * as isNonEmptyString above: epic.ts's malformed-entries blocker names the
 * bad entry the same way guard 6's refusal does, one register.
 */
export function describeMalformedTaskId(value: unknown): string {
  if (typeof value === 'string' && value.length === 0) return 'an empty string';
  return describeType(value);
}

export interface RepairObligationInput {
  findingId: string;
  /** The corrected amends_task_ids list this repair writes down. */
  replaceWith: readonly string[];
  /** Why the repair is happening — required, non-empty (guard 4). */
  reason: string;
}

/** One entry of the ORIGINAL obligation this repair could not read as a task id. */
export interface MalformedObligationEntry {
  index: number;
  type: string;
}

/**
 * D-21 Part 4. Corrects a malformed `amends_task_ids` entry on a finding
 * parked at `amend-pending` — the shape `f-demo-rpg-reading-interface/
 * integration-3e6bd014` carries (`[null, "…/task-5-reader-memory"]`), written
 * by a `plan amend` call parts 1-3 of D-21 now refuse at the source. The log
 * is append-only, so a record written before that guard existed still holds
 * the malformed entry, and no existing verb can discharge it truthfully:
 * `reverify` is not a status transition, `amend-pending -> expired` asserts
 * the replacement work never landed (it did), a fresh `plan amend` citing the
 * same finding cannot re-enter `amend-pending` from `amend-pending`, and S2 is
 * categorically unwaivable (severity.yml) — the epic deadlocks.
 *
 * This verb can discharge an unwaivable finding, so every one of the six
 * guards below is load-bearing (D-21 part 4 brief):
 *   1. Repairs corruption only — refused unless the CURRENT obligation
 *      already holds at least one entry that is not a non-empty string.
 *   2. Cannot weaken — the replacement must retain every well-formed id from
 *      the original (taskIdsMatch, D-46/P9-29: either spelling counts).
 *   3. Cannot empty — the resulting obligation must be non-empty; naming
 *      nothing discharges the finding on the sentence that wrote it (D-127).
 *   4. Reason required, non-empty — an unaudited repair is not a repair.
 *   5. Only from `amend-pending` — the only status where the obligation is
 *      load-bearing.
 *   6. Every replacement id is a non-empty string.
 *
 * Appends a `finding-obligation-repaired` event — never `finding-transitioned`,
 * because a repair changes no status. The fold applies the LATEST such event
 * for a finding onto `amends_task_ids` directly, last-decision-wins, mirroring
 * `isWaived`'s waiver-granted/waiver-denied fold — so `outstandingObligations`
 * (transition()'s own `-> amended` gate) and summarizeEpic both evaluate the
 * repaired list, never the original. `obligation_repair_reason` rides along so
 * a later discharge can be shown to rest on a repaired list rather than
 * quietly dropping the null (epic.ts's SatisfiedAmendment).
 */
export async function repairObligation(
  input: RepairObligationInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<Finding> {
  const events = await readLineageEvents(ctx.sessionId, opts);
  let current: Finding | undefined;
  for (const { record } of events) {
    if (record.event_type === 'finding-raised') {
      const finding = record.payload as unknown as Finding;
      if (finding.finding_id === input.findingId) current = { ...finding };
    } else if (record.event_type === 'finding-transitioned') {
      const payload = record.payload as {
        finding_id: string;
        to_status: string;
        waiver_id?: string;
        waiver_revoked_by?: string;
        amends_task_ids?: string[];
        amends_plan_version?: number;
      };
      if (payload.finding_id === input.findingId && current) {
        if (payload.waiver_revoked_by) delete current.waiver_id;
        current = {
          ...current,
          finding_status: payload.to_status,
          ...(payload.waiver_id ? { waiver_id: payload.waiver_id } : {}),
          ...(payload.amends_task_ids ? { amends_task_ids: payload.amends_task_ids } : {}),
          ...(payload.amends_plan_version
            ? { amends_plan_version: payload.amends_plan_version }
            : {}),
        };
      }
    } else if (record.event_type === FINDING_OBLIGATION_REPAIRED_EVENT_TYPE) {
      const payload = record.payload as {
        finding_id: string;
        to_obligation?: string[];
        reason?: string;
      };
      if (payload.finding_id === input.findingId && current) {
        current = {
          ...current,
          ...(payload.to_obligation ? { amends_task_ids: [...payload.to_obligation] } : {}),
          ...(payload.reason !== undefined ? { obligation_repair_reason: payload.reason } : {}),
        };
      }
    }
  }

  if (!current) {
    throw new FindingError(
      'findings.unknown-finding',
      `No raised finding with id "${input.findingId}".`,
      { findingId: input.findingId },
    );
  }

  // Guard 5: only from amend-pending. That is the only status where the
  // obligation is load-bearing -- checked before guard 1 (repairs corruption
  // only) so a finding in the wrong status is refused for that, first, rather
  // than for whatever its (irrelevant) amends_task_ids happens to look like.
  if (current.finding_status !== AMEND_PENDING_STATUS) {
    throw new FindingError(
      'findings.repair-not-pending',
      `Finding "${input.findingId}" is at "${current.finding_status}", not ` +
        `"${AMEND_PENDING_STATUS}" -- an obligation is only load-bearing while a finding waits ` +
        'on it. Repairing it anywhere else changes a fact nothing is waiting on.',
      { findingId: input.findingId, findingStatus: current.finding_status },
    );
  }

  const original = current.amends_task_ids ?? [];
  const malformedEntries: MalformedObligationEntry[] = [];
  const wellFormedOriginal: string[] = [];
  original.forEach((id, index) => {
    if (isNonEmptyString(id)) wellFormedOriginal.push(id);
    else malformedEntries.push({ index, type: describeType(id) });
  });

  // Guard 1: repairs corruption only. This verb repairs malformed data; it
  // never renegotiates a well-formed obligation — that is "smith plan amend"'s
  // job, and it is the one that can compute a real diff against the plan.
  if (malformedEntries.length === 0) {
    throw new FindingError(
      'findings.repair-not-corrupt',
      `Finding "${input.findingId}"'s obligation names ${original.length} task id(s), all ` +
        'well-formed — there is nothing to repair. This verb repairs malformed amends_task_ids ' +
        'data; it never renegotiates a well-formed obligation. Use "smith plan amend" to change ' +
        'what a finding is waiting on.',
      { findingId: input.findingId },
    );
  }

  // Guard 4: reason required, non-empty. An unaudited repair is not a repair.
  const reason = input.reason.trim();
  if (reason === '') {
    throw new FindingError(
      'findings.repair-reason-required',
      `Repairing finding "${input.findingId}"'s obligation needs a non-empty --reason: an ` +
        'unaudited repair is not a repair.',
      { findingId: input.findingId },
    );
  }

  // Guard 3: cannot empty. Checked before guard 2 (cannot weaken) so an empty
  // replacement is named for what it is -- naming nothing -- rather than as
  // "dropped every well-formed id", which is true but not the clearest thing
  // to tell the caller first.
  if (input.replaceWith.length === 0) {
    throw new FindingError(
      'findings.repair-would-empty',
      `Refusing to repair finding "${input.findingId}"'s obligation to an empty list: an ` +
        'obligation naming nothing discharges the finding it names on the sentence that wrote ' +
        'it (D-127) -- name at least one task id.',
      { findingId: input.findingId },
    );
  }

  // Guard 2: cannot weaken. The replacement must retain every well-formed id
  // from the original -- it may drop only malformed entries, and it may add.
  // Without this, "repair" becomes a way to delete a real obligation.
  const dropped = wellFormedOriginal.filter(
    (id) => !input.replaceWith.some((replacement) => taskIdsMatch(id, replacement)),
  );
  if (dropped.length > 0) {
    throw new FindingError(
      'findings.repair-would-weaken',
      `Refusing to repair finding "${input.findingId}"'s obligation: the replacement drops ` +
        `${dropped.join(', ')}, which the original obligation already named and is well-formed. ` +
        'A repair may drop only malformed entries and may add, never drop a real obligation.',
      { findingId: input.findingId, dropped },
    );
  }

  // Guard 6: every replacement id is a non-empty string. Same describeType
  // error style as part 1 -- name the type and the index, never the value.
  // describeMalformedTaskId also names an empty string as itself, not merely
  // "string" -- an empty entry is exactly as malformed as a non-string one.
  input.replaceWith.forEach((id, index) => {
    if (!isNonEmptyString(id)) {
      throw new FindingError(
        'findings.repair-replacement-not-string',
        `--replace-with[${index}] is ${describeMalformedTaskId(id)}, not a task id. Every ` +
          'replacement entry must be a non-empty string.',
        { findingId: input.findingId, index, received: describeMalformedTaskId(id) },
      );
    }
  });

  const toObligation = [...input.replaceWith];
  const payload: Record<string, unknown> = {
    finding_id: input.findingId,
    from_obligation: original,
    to_obligation: toObligation,
    malformed_entries: malformedEntries,
    reason,
  };
  if (current.amends_plan_version !== undefined) {
    payload.amends_plan_version = current.amends_plan_version;
  }

  await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'user',
      event_type: FINDING_OBLIGATION_REPAIRED_EVENT_TYPE,
      task_id: current.task_id,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload,
    },
    opts,
  );

  return { ...current, amends_task_ids: toObligation, obligation_repair_reason: reason };
}

// ---------------------------------------------------------------------------
// Stale evidence and re-verification (P9-15 (b))
// ---------------------------------------------------------------------------

export interface StaleEvidence {
  findingId: string;
  /** The finding's anchoring path, as stored. */
  filePath: string;
  /** The task whose merge rewrote it. */
  mergedTaskId: string;
  /**
   * How the merge was matched to the file. `files-changed` reads the merge
   * commit's own file list; `claims` is the fallback for wave-merged events
   * written before that list existed, and is reported because a claim glob is
   * a broader answer than a file list — an operator seeing `claims` knows the
   * match may be over-broad.
   */
  basis: 'files-changed' | 'claims';
  /** The file path or claim glob that matched. */
  matched: string;
}

/**
 * Which open findings are answering about code that no longer exists.
 *
 * A finding's evidence — the failure scenario, the summary, the line it points
 * at — is a claim about one file at one moment. Once a wave merges over that
 * file, the evidence describes code that has been rewritten, and a waiver
 * granted from it is a decision made on deleted evidence. This reports the
 * findings in that state so the gate can demand a re-read first.
 *
 * Strictly ordering-based: a finding is stale iff the last `wave-merged`
 * touching its file comes *after* both its raise and its most recent
 * `finding-reverified`. Reading positions out of one ordered log is what makes
 * "re-verified, then merged over again" come out stale — a timestamp
 * comparison across separately-clocked producers would not.
 *
 * Over the lineage since D-119, and that caution survives the change: within a
 * session the positions are still the writer's own append order, and only
 * BETWEEN sessions does `readLineageEvents` fall back to the wall clock, which
 * is the only reference two sessions share. The alternative was leaving a
 * continuation blind to every merge its parent recorded, which reports a
 * finding raised against long-rewritten code as fresh evidence.
 */
export async function staleFindings(
  sessionId: string,
  opts: EventOpts = {},
): Promise<Map<string, StaleEvidence>> {
  const events = await readLineageEvents(sessionId, opts);

  const raisedAt = new Map<string, { index: number; finding: Finding }>();
  const reverifiedAt = new Map<string, number>();
  const merges: { index: number; taskId: string; filesChanged?: string[] }[] = [];

  events.forEach(({ record }, index) => {
    if (record.event_type === 'finding-raised') {
      const finding = record.payload as unknown as Finding;
      raisedAt.set(finding.finding_id, { index, finding });
    } else if (record.event_type === 'finding-reverified') {
      const payload = record.payload as { finding_id?: string };
      if (payload.finding_id) reverifiedAt.set(payload.finding_id, index);
    } else if (record.event_type === 'wave-merged' && record.task_id) {
      const payload = record.payload as { files_changed?: unknown };
      merges.push({
        index,
        taskId: record.task_id,
        ...(Array.isArray(payload.files_changed)
          ? { filesChanged: payload.files_changed as string[] }
          : {}),
      });
    }
  });

  if (raisedAt.size === 0 || merges.length === 0) return new Map();

  // Only loaded when a merge actually needs the fallback, so the common path
  // (every wave-merged carries its file list) costs nothing.
  let claimsByTask: Map<string, unknown> | undefined;
  const claimsFor = async (taskId: string): Promise<string[]> => {
    if (claimsByTask === undefined) {
      const added = await readAddedTasks({ sessionId }, opts);
      claimsByTask = new Map(added.map((task) => [task.taskId, task.claims]));
    }
    // Empty is the safe direction for THIS question, unlike the wave gate's:
    // this list decides whether a merge could have rewritten the file a
    // finding names, and a task whose claims cannot be read is one this cannot
    // show rewrote anything — so the finding stays answerable rather than
    // being marked stale on evidence nobody has.
    const claims = claimsByTask.get(taskId);
    return Array.isArray(claims) ? claims.filter((c) => typeof c === 'string') : [];
  };

  const stale = new Map<string, StaleEvidence>();
  for (const [findingId, { index: raisedIndex, finding }] of raisedAt) {
    const freshUntil = Math.max(raisedIndex, reverifiedAt.get(findingId) ?? -1);
    // Last merge wins: it names the most recent rewrite the operator has to
    // answer for, and reporting an older one would point at the wrong task.
    // Both bases below are joins on the path, so a finding that never carried
    // one is unanswerable here rather than fresh or stale (D-191). Skipped, not
    // dereferenced: the claims branch used to throw on it.
    const filePath = finding.file_path;
    if (filePath === undefined) continue;
    for (const merge of merges) {
      if (merge.index <= freshUntil) continue;
      if (merge.filesChanged) {
        const hit = merge.filesChanged.find((changed) => normalizeFilePath(changed) === filePath);
        if (hit === undefined) continue;
        stale.set(findingId, {
          findingId,
          filePath,
          mergedTaskId: merge.taskId,
          basis: 'files-changed',
          matched: hit,
        });
        continue;
      }
      const claim = (await claimsFor(merge.taskId)).find((glob) => claimCoversPath(glob, filePath));
      if (claim === undefined) continue;
      stale.set(findingId, {
        findingId,
        filePath,
        mergedTaskId: merge.taskId,
        basis: 'claims',
        matched: claim,
      });
    }
  }
  return stale;
}

/**
 * Record that a finding's evidence was re-read against the current code.
 *
 * Deliberately not a `finding_status` transition: `confirmed` cannot be
 * re-entered and `refuted` means the finding was wrong. Neither says "someone
 * looked again after the file was rewritten and the finding still stands",
 * which is the only thing that can un-stale evidence. So it is its own event,
 * and the status machine keeps meaning exactly what it meant before.
 */
export async function reverifyFinding(
  findingId: string,
  note: string,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<void> {
  // Lineage (D-119): staleFindings reads the lineage, so the findings it names
  // as stale have to be re-verifiable from the session that was told about them.
  const events = await readLineageEvents(ctx.sessionId, opts);
  let current: Finding | undefined;
  for (const { record } of events) {
    if (record.event_type !== 'finding-raised') continue;
    const finding = record.payload as unknown as Finding;
    if (finding.finding_id === findingId) current = finding;
  }

  if (!current) {
    throw new FindingError(
      'findings.unknown-finding',
      `No raised finding with id "${findingId}".`,
      {
        findingId,
      },
    );
  }

  await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: 'finding-reverified',
      task_id: current.task_id,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: {
        finding_id: findingId,
        fingerprint: current.fingerprint,
        file_path: current.file_path,
        note,
      },
    },
    opts,
  );
}
