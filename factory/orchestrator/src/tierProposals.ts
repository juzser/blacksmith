// Tier-move proposals (epic bs-check-tiers, spec D7-D9): a pure fold that prices
// moving a costly, low-value check to a later tier, one validator shared by the
// proposals and by apply, an apply that writes only the overlay and decision
// events, and the automatic promotion of an overlay-demoted check after a catch.
// The project's checks file is never opened for writing here.
import { createHash } from 'node:crypto';
import { isOperatorActor } from './actors.js';
import { type CheckLedger, LEDGER_WINDOW_DAYS, type LedgerRow } from './checkLedger.js';
import { SmithError } from './errors.js';
import { appendEvent, type StoredEvent } from './events.js';
import { stageBoundCheckNames } from './gate.js';
import { gatherLedgerInputs, type LedgerInputsOptions } from './ledgerInputs.js';
import {
  type CheckCommand,
  type CheckTier,
  commandDigest,
  isNotRun,
  sleptDuringCheck,
} from './testgate.js';
import {
  type OverlayEntry,
  OverlayError,
  type OverlayRead,
  type OverlayReportItem,
  type OverlayWritable,
  overlayPath,
  overlayReport,
  overlayWritable,
  type ReconcileCtx,
  type ReconcileOpts,
  readOverlay,
  reconcileOverlay,
  resolveEffectiveTiers,
  type TierSource,
  withOverlayLock,
  writeOverlay,
} from './tierOverlay.js';

export const CHECK_TIER_DECIDED_EVENT = 'check-tier-decided';
export const CHECK_TIER_PROMOTED_EVENT = 'check-tier-promoted';
export const CHECK_TIER_BATCH_ANSWERED_EVENT = 'check-tier-batch-answered';

/** Spec D7, "Who is proposed": at least this many measured runs in the window. */
export const MIN_RUNS = 20;
/** Spec D7, "Who is proposed": at least this many measured minutes in the window. */
export const MIN_MEASURED_MINUTES = 30;
/** Spec D7, "Apply": a declined proposal stays quiet this long. */
export const DECLINE_QUIET_DAYS = 90;

const DAY_MS = 86_400_000;
const FROM_TIER: CheckTier = 'pre-merge';

export interface Measure {
  value: number;
  kind: 'measured' | 'estimated';
}

/** The D7 inputs behind an option's saving, each named with how it was known. */
export interface ProposalBasis {
  R: Measure;
  d: Measure;
  B: Measure;
  E: Measure;
  excluded: string[];
}

export interface ProposalOption {
  to_tier: CheckTier;
  runs_covered: number;
  minutes_spent: number;
  minutes_saved: number;
  basis: ProposalBasis;
}

export interface ProposalItem {
  proposal_id: string;
  check: string;
  cmd_sha256: string;
  from_tier: CheckTier;
  options: ProposalOption[];
  flake_rate: number;
  importance: number;
  real_catches: number;
  evidence_event_ids: string[];
}

export interface ProposalNotice {
  code: string;
  check?: string;
  message: string;
}

/** A degraded ledger blocks both the proposal fold and apply, so neither side asks or applies blind. */
const DEGRADED_CODE = 'checks.session-unreadable';
const DEGRADED_WHY = 'a session log could not be read, so a catch may be hidden';

/** The ledger, plus the `degraded` mark task-13's inputs carry when a session log was unreadable. */
export type ProposalLedger = CheckLedger & { degraded?: boolean };

export type EffectiveCheck = CheckCommand & { tier: CheckTier; tierSource: TierSource };

export interface PendingResult {
  items: ProposalItem[];
  notices: ProposalNotice[];
  overlay: OverlayReportItem[];
  answered_in_epic: boolean;
  handed_off: { code: string; decisions_path: string; event_id: string } | null;
}

export interface ItemFailure {
  proposal_id: string;
  check: string;
  reason: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const round1 = (n: number): number => Math.round(n * 10) / 10;
const proposalId = (check: string, sha: string, from: string): string =>
  createHash('sha256').update(`${check}|${sha}|${from}`).digest('hex').slice(0, 16);
const digestOf = (c: CheckCommand): string => commandDigest(c.cmd);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** A decision that still holds: any approval, or a decline younger than the quiet period. */
function liveDecision(events: readonly StoredEvent[], id: string, now: Date): boolean {
  return events.some(({ record }) => {
    const p = record.payload;
    if (record.event_type !== CHECK_TIER_DECIDED_EVENT || p.proposal_id !== id) return false;
    if (p.decision === 'approve') return true;
    // An unreadable time keeps the decline live: protecting is the safe direction.
    const age = now.getTime() - Date.parse(record.ts);
    return !(age >= DECLINE_QUIET_DAYS * DAY_MS);
  });
}

/**
 * Every check D7's numbers qualify for a move, whatever else would refuse it:
 * the measured runs and minutes, and no live decision. The guardrails are
 * `itemBlocker`'s, so apply can name an item the log has since made unsafe.
 */
function candidates(
  ledger: CheckLedger,
  events: readonly StoredEvent[],
  now: Date,
): ProposalItem[] {
  const to = now.getTime();
  const from = to - LEDGER_WINDOW_DAYS * DAY_MS;
  const byIdentity = new Map<string, LedgerRow[]>();
  for (const r of ledger.rows) {
    const t = Date.parse(r.ts);
    // Probes and not-run results are no runs; an unmeasured run has no minutes to price.
    if (r.source === 'probe' || r.outcome === 'not-run' || r.duration_ms === null) continue;
    if (!(t >= from && t <= to)) continue;
    byIdentity.set(r.identity, [...(byIdentity.get(r.identity) ?? []), r]);
  }
  const post = ledger.project.post_merge_runs;
  const B: Measure =
    post > 0
      ? { value: post, kind: 'measured' }
      : { value: ledger.project.task_merges, kind: 'estimated' };
  const E: Measure = { value: ledger.project.epics_with_merges, kind: 'measured' };
  const out: ProposalItem[] = [];
  for (const c of ledger.checks) {
    if (c.cmd_sha256 === null) continue;
    const rows = byIdentity.get(c.identity) ?? [];
    const minutes = rows.map((r) => (r.duration_ms as number) / 60_000);
    const M = minutes.reduce((s, m) => s + m, 0);
    if (rows.length < MIN_RUNS || M < MIN_MEASURED_MINUTES) continue;
    const id = proposalId(c.name, c.cmd_sha256, FROM_TIER);
    if (liveDecision(events, id, now)) continue;
    const d = median(minutes);
    const basis: ProposalBasis = {
      R: { value: rows.length, kind: 'measured' },
      d: { value: round1(d), kind: 'measured' },
      B,
      E,
      excluded: ['probes', 'not-run'],
    };
    const option = (to_tier: CheckTier, saved: number): ProposalOption => ({
      to_tier,
      runs_covered: rows.length,
      minutes_spent: round1(M),
      minutes_saved: round1(saved),
      basis,
    });
    out.push({
      proposal_id: id,
      check: c.name,
      cmd_sha256: c.cmd_sha256,
      from_tier: FROM_TIER,
      options: [
        option(FROM_TIER, 0),
        option('post-merge', Math.max(0, M - B.value * d)),
        option('pre-release', Math.max(0, M - E.value * d)),
      ],
      flake_rate: c.flake_rate,
      importance: c.importance,
      real_catches: c.real_catches,
      evidence_event_ids: [...new Set(rows.map((r) => r.event_id))],
    });
  }
  return out;
}

/**
 * Why a move may not be applied, or null. The one guardrail both the proposal
 * fold (to exclude) and apply (to refuse) call, so the batch never asks about a
 * move apply would refuse. `_now` keeps the signature stable for a rule that
 * needs the clock; the ledger already holds the window.
 */
export function itemBlocker(
  item: Pick<ProposalItem, 'check' | 'cmd_sha256'>,
  ledger: CheckLedger,
  effectiveChecks: readonly EffectiveCheck[],
  _now: Date,
): string | null {
  const check = effectiveChecks.find(
    (c) => c.name === item.check && digestOf(c) === item.cmd_sha256,
  );
  if (check === undefined) return 'the check is not in the checks file';
  if (check.tierSource === 'declared') return 'the check declares its tier';
  if (stageBoundCheckNames().includes(check.name)) return 'the check is bound to a gate stage';
  const lc = ledger.checks.find((c) => c.identity === `${item.check}@${item.cmd_sha256}`);
  if (lc?.guards_sensitive === true) return 'the check guards a sensitive path';
  if (lc !== undefined && lc.real_catches > 0) return 'an S1 or S2 catch in the window';
  // An unconfirmed failure is unverifiable, so it protects the check as a real catch does.
  if (lc !== undefined && lc.unconfirmed.length > 0) return 'an unconfirmed failure in the window';
  return null;
}

/** The items a batch may ask about now: candidates that sit pre-merge by default or overlay and pass the guardrails. */
function eligibleItems(
  ledger: CheckLedger,
  events: readonly StoredEvent[],
  effectiveChecks: readonly EffectiveCheck[],
  now: Date,
): ProposalItem[] {
  return candidates(ledger, events, now).filter((i) => {
    const check = effectiveChecks.find((c) => c.name === i.check && digestOf(c) === i.cmd_sha256);
    return (
      check !== undefined &&
      check.tier === FROM_TIER &&
      itemBlocker(i, ledger, effectiveChecks, now) === null
    );
  });
}

/** The declarations as the file holds them: a resolved check's tier only when it was declared. */
function declaredOf(checks: readonly EffectiveCheck[]): CheckCommand[] {
  return checks.map(({ tier, tierSource, ...rest }) =>
    tierSource === 'declared' ? { ...rest, tier } : rest,
  );
}

const WRITABLE_NOTICE: Record<Exclude<OverlayWritable, 'ok'>, string> = {
  'not-a-repo': 'the project is not inside a git repository, so there is no overlay to write',
  tracked: 'git tracks the overlay file, and bs never edits a tracked file',
  unreadable: 'the overlay is unreadable; fix or remove it first',
};

/** Spec D7: the pending proposals, notices and overlay report. Reads only its arguments. */
export function pendingProposals(
  ledger: ProposalLedger,
  events: readonly StoredEvent[],
  effectiveChecks: readonly EffectiveCheck[],
  overlay: OverlayRead,
  o: { epicId: string; writable: OverlayWritable; now: Date },
): PendingResult {
  const notices: ProposalNotice[] = [];
  if (o.writable !== 'ok') {
    notices.push({
      code: `checks.overlay-${o.writable}`,
      message: `No proposals: ${WRITABLE_NOTICE[o.writable]}.`,
    });
  }
  if (ledger.degraded === true) {
    notices.push({
      code: DEGRADED_CODE,
      message: `No proposals: ${DEGRADED_WHY}.`,
    });
  }
  for (const c of effectiveChecks) {
    const lc = ledger.checks.find((x) => x.identity === `${c.name}@${digestOf(c)}`);
    if (c.tierSource === 'declared' && c.tier !== FROM_TIER && (lc?.real_catches ?? 0) > 0) {
      notices.push({
        code: 'checks.declared-tier-catch',
        check: c.name,
        message: `${c.name} declares ${c.tier} and caught a real defect in the window; consider moving it in your file.`,
      });
    }
  }
  const items = notices.some((n) => n.code !== 'checks.declared-tier-catch')
    ? []
    : eligibleItems(ledger, events, effectiveChecks, o.now).sort(
        (a, b) =>
          (b.options[1] as ProposalOption).minutes_saved -
            (a.options[1] as ProposalOption).minutes_saved || a.check.localeCompare(b.check),
      );
  const answered = events.filter(
    (e) =>
      e.record.event_type === CHECK_TIER_BATCH_ANSWERED_EVENT &&
      e.record.payload.epic_id === o.epicId,
  );
  let handed: PendingResult['handed_off'] = null;
  for (const e of answered) {
    const h = e.record.payload.handed_off;
    handed = isObj(h)
      ? { code: String(h.code), decisions_path: String(h.decisions_path), event_id: e.event_id }
      : null;
  }
  return {
    items,
    notices,
    overlay: overlayReport(declaredOf(effectiveChecks), overlay),
    answered_in_epic: answered.length > 0,
    handed_off: handed,
  };
}

const DECISION_KEYS = new Set(['proposal_id', 'check', 'decision', 'to_tier', 'note']);

/** Spec D7's decisions.json: every failing item, or `[]` when the whole array is valid. */
export function validateDecisions(json: unknown, pending: readonly ProposalItem[]): ItemFailure[] {
  if (!Array.isArray(json)) {
    return [{ proposal_id: '', check: '', reason: 'decisions must be a JSON array' }];
  }
  const failures: ItemFailure[] = [];
  const seen = new Set<string>();
  for (const raw of json as unknown[]) {
    if (!isObj(raw)) {
      failures.push({ proposal_id: '', check: '', reason: 'a decision must be an object' });
      continue;
    }
    const pid = typeof raw.proposal_id === 'string' ? raw.proposal_id : '';
    const check = typeof raw.check === 'string' ? raw.check : '';
    const reason = ((): string | null => {
      const stray = Object.keys(raw).find((k) => !DECISION_KEYS.has(k));
      if (stray !== undefined) return `unknown key "${stray}"`;
      const item = pending.find((i) => i.proposal_id === pid);
      if (item === undefined) return 'unknown or decided proposal_id';
      if (seen.has(pid)) return 'duplicate proposal_id';
      seen.add(pid);
      if (raw.check !== item.check) return 'check does not match the proposal';
      if (raw.note !== undefined && typeof raw.note !== 'string') return 'note must be a string';
      if (raw.decision === 'approve') {
        if (raw.to_tier === undefined) return 'approve requires to_tier';
        const moves = item.options.map((x) => x.to_tier).filter((t) => t !== item.from_tier);
        return moves.includes(raw.to_tier as CheckTier)
          ? null
          : 'to_tier is not one of the options';
      }
      if (raw.decision === 'decline') {
        return raw.to_tier === undefined ? null : 'decline must not carry to_tier';
      }
      return 'decision must be approve or decline';
    })();
    if (reason !== null) failures.push({ proposal_id: pid, check, reason });
  }
  return failures;
}

/** A refused apply. `items` names every item with its own cause, and is empty when the call's own state is the cause. */
export class TierApplyRefusal extends SmithError {
  get items(): ItemFailure[] {
    return (this.details.items as ItemFailure[] | undefined) ?? [];
  }
}

export interface ApplyInput {
  dir: string;
  /** Named for the callers; the file is never opened for writing. */
  checksFile: string;
  epicId: string;
  effectiveChecks: readonly EffectiveCheck[];
  actor: string;
  ledger: ProposalLedger;
  /** The caller's earlier read of the project's events (task-13's `events`). */
  events: readonly StoredEvent[];
  /** The options the caller gathered `ledger` and `events` with; re-gathered under the lock. */
  gather: LedgerInputsOptions;
  now: Date;
}

export interface ApplyResult {
  decided: string[];
  pending: string[];
  batch_answered_event_id: string;
}

interface Decision {
  proposal_id: string;
  check: string;
  decision: 'approve' | 'decline';
  to_tier?: CheckTier;
  note?: string;
}

/**
 * Spec D7/D8: once the lock is held, the log as it stands rather than the
 * caller's earlier read, so a write the previous lock holder made is seen.
 * It is task-13's gather with the caller's own options: one project's events,
 * every session of its epics, and no time filter, so an approve older than the
 * ledger window is still read. Snapshot events the gather does not return come
 * first: the log is append-only, so they can only be events it cannot attribute.
 * A degraded or refused gather answers `null`, never a throw.
 */
async function currentProjectLog(
  snapshot: readonly StoredEvent[],
  gather: LedgerInputsOptions,
): Promise<StoredEvent[] | null> {
  let read: Awaited<ReturnType<typeof gatherLedgerInputs>>;
  try {
    read = await gatherLedgerInputs(gather);
  } catch (err) {
    if (err instanceof SmithError) return null;
    throw err;
  }
  if (read.degraded) return null;
  const seen = new Set(read.events.map((e) => e.event_id));
  return [...snapshot.filter((e) => !seen.has(e.event_id)), ...read.events];
}

const UNREADABLE_LOG_WHY =
  "the project's log cannot be gathered (an unreadable session log or plans naming more than one project), so it is not current";

/** An overlay refusal (busy lock, failed repair) is the call's own state, so it names no item. */
const noItems = (err: OverlayError): OverlayError & { items: ItemFailure[] } =>
  Object.assign(err, { items: [] as ItemFailure[] });

/**
 * Spec D7/D8, apply: validate the whole array, then append one decision per item,
 * then write the overlay, then record the batch. A refusal appends none of the
 * batch's events and writes none of its decisions; it may leave only what
 * `reconcileOverlay` repairs and the empty `.blacksmith/` the lock creates.
 */
export async function applyTierDecisions(
  decisions: unknown,
  input: ApplyInput,
  ctx: ReconcileCtx,
  opts: ReconcileOpts = {},
): Promise<ApplyResult> {
  const { dir, ledger, now } = input;
  if (overlayPath(dir) === null) {
    throw new TierApplyRefusal(
      'checks.overlay-not-a-repo',
      `"${dir}" is not inside a git repository.`,
      { items: [] },
    );
  }
  if (!isOperatorActor(input.actor)) {
    throw new TierApplyRefusal(
      'checks.apply-not-operator',
      'Only the operator may apply a tier decision.',
      { items: [] },
    );
  }
  if (!Array.isArray(decisions)) {
    throw new TierApplyRefusal(
      'checks.decisions-not-array',
      'The decisions must be a JSON array.',
      {
        items: [],
      },
    );
  }
  let entered = false;
  try {
    return await withOverlayLock(dir, async () => {
      entered = true;
      const events = await currentProjectLog(input.events, input.gather);
      // Reconcile needs the current log, so with none no repair is made either.
      if (events === null) {
        throw new TierApplyRefusal(
          'checks.session-unreadable',
          `Cannot apply: ${UNREADABLE_LOG_WHY}.`,
          { items: [] },
        );
      }
      try {
        await reconcileOverlay(dir, events, ctx, opts);
      } catch (err) {
        if (err instanceof OverlayError) throw noItems(err);
        throw err;
      }
      const writable = overlayWritable(dir);
      if (writable === 'tracked') {
        throw new TierApplyRefusal('checks.overlay-tracked', 'git tracks the overlay file.', {
          items: [],
        });
      }
      if (writable !== 'ok') {
        throw new TierApplyRefusal('checks.overlay-unreadable', 'The overlay is unreadable.', {
          items: [],
        });
      }
      if (ledger.degraded === true) {
        throw new TierApplyRefusal('checks.session-unreadable', `Cannot apply: ${DEGRADED_WHY}.`, {
          items: [],
        });
      }
      const cands = candidates(ledger, events, now);
      const failures = validateDecisions(decisions, cands);
      const shapeFailed = new Set(failures.map((f) => f.proposal_id));
      for (const d of decisions as Decision[]) {
        if (!isObj(d)) continue;
        const item = cands.find((c) => c.proposal_id === d.proposal_id);
        if (item === undefined || shapeFailed.has(d.proposal_id)) continue;
        const why = itemBlocker(item, ledger, input.effectiveChecks, now);
        if (why !== null)
          failures.push({ proposal_id: item.proposal_id, check: item.check, reason: why });
      }
      if (failures.length > 0) {
        throw new TierApplyRefusal(
          'checks.apply-refused',
          `${failures.length} decision(s) cannot be applied: ${failures.map((f) => `${f.check || f.proposal_id}: ${f.reason}`).join('; ')}`,
          { items: failures },
        );
      }

      const approved: OverlayEntry[] = [];
      for (const d of decisions as Decision[]) {
        const item = cands.find((c) => c.proposal_id === d.proposal_id) as ProposalItem;
        const stored = await appendEvent(
          {
            ...ctx,
            event_type: CHECK_TIER_DECIDED_EVENT,
            payload: {
              proposal_id: item.proposal_id,
              check: item.check,
              cmd_sha256: item.cmd_sha256,
              from_tier: item.from_tier,
              to_tier: d.decision === 'approve' ? (d.to_tier as CheckTier) : null,
              decision: d.decision,
              note: d.note ?? null,
            },
          },
          opts.events,
        );
        if (d.decision === 'approve') {
          approved.push({
            check: item.check,
            cmd_sha256: item.cmd_sha256,
            tier: d.to_tier as CheckTier,
            decided_by_event_id: stored.event_id,
            decided_at: stored.record.ts,
          });
        }
      }
      if (approved.length > 0) {
        const o = readOverlay(dir);
        const state = 'entries' in o ? o : { revision: 0, entries: [] };
        const same = (e: OverlayEntry): boolean =>
          approved.some((a) => a.check === e.check && a.cmd_sha256 === e.cmd_sha256);
        writeOverlay(dir, {
          entries: [...state.entries.filter((e) => !same(e)), ...approved],
          expectedRevision: state.revision,
        });
      }

      const decided = (decisions as Decision[]).map((d) => d.proposal_id);
      const after = resolveEffectiveTiers(declaredOf(input.effectiveChecks), readOverlay(dir));
      const pending = eligibleItems(ledger, events, after, now)
        .filter((i) => !decided.includes(i.proposal_id))
        .sort(
          (a, b) =>
            (b.options[1] as ProposalOption).minutes_saved -
              (a.options[1] as ProposalOption).minutes_saved || a.check.localeCompare(b.check),
        )
        .map((i) => i.proposal_id);
      const answered = await appendEvent(
        {
          ...ctx,
          event_type: CHECK_TIER_BATCH_ANSWERED_EVENT,
          payload: { epic_id: input.epicId, decided, pending },
        },
        opts.events,
      );
      return { decided, pending, batch_answered_event_id: answered.event_id };
    });
  } catch (err) {
    // A lock that could not be taken is the call's own state, never an item's.
    if (!entered && err instanceof OverlayError) throw noItems(err);
    throw err;
  }
}

/**
 * Record that the batch was asked and its reply handed to the operator. It
 * validates nothing, takes no lock and writes no overlay, so it decides nothing
 * and every item stays pending; `answered_in_epic` reads it like any answer.
 */
export async function recordBatchHandOff(
  epicId: string,
  hand: { code: string; decisionsPath: string; pending: string[] },
  ctx: ReconcileCtx,
  opts: ReconcileOpts = {},
): Promise<{ eventId: string }> {
  const stored = await appendEvent(
    {
      ...ctx,
      event_type: CHECK_TIER_BATCH_ANSWERED_EVENT,
      payload: {
        epic_id: epicId,
        decided: [],
        pending: hand.pending,
        handed_off: { code: hand.code, decisions_path: hand.decisionsPath },
      },
    },
    opts.events,
  );
  return { eventId: stored.event_id };
}

/** A post-merge culprit result from task-7: the evidence promotion reads. */
export interface PromotionCulprit {
  failing_checks: string[];
  red_record_event_id: string;
  reproduced: true;
}

export interface PromotionAnswer {
  check: string;
  result: 'promoted' | 'declared-tier-wins' | 'not-promoted' | 'promotion-skipped';
  reason: string | null;
}

/**
 * Spec D7, automatic promotion: one answer per failing check, in order, never a
 * throw for a case below. Only an actual promotion takes the lock; every other
 * answer is decided from the arguments and an unlocked read of the overlay.
 */
export async function promoteAfterCatch(
  culprit: PromotionCulprit,
  input: {
    dir: string;
    checks: readonly CheckCommand[];
    events: readonly StoredEvent[];
    gather: LedgerInputsOptions;
  },
  ctx: ReconcileCtx,
  opts: ReconcileOpts = {},
): Promise<PromotionAnswer[]> {
  const log = [...input.events];
  const red = log.find((e) => e.event_id === culprit.red_record_event_id);
  const answer = (
    check: string,
    result: PromotionAnswer['result'],
    reason: string | null,
  ): PromotionAnswer => ({ check, result, reason });

  const one = async (name: string): Promise<PromotionAnswer> => {
    const payload = red?.record.payload;
    const results = Array.isArray(payload?.results) ? (payload.results as unknown[]) : [];
    const i = results.findIndex((r) => isObj(r) && r.name === name);
    const own = results[i];
    if (!isObj(own) || own.pass !== false) {
      return answer(name, 'promotion-skipped', 'red-record-unreadable');
    }
    const check = input.checks.find((c) => c.name === name);
    if (check?.tier !== undefined) return answer(name, 'declared-tier-wins', null);
    const overlay = readOverlay(input.dir);
    const eff = check === undefined ? undefined : resolveEffectiveTiers([check], overlay)[0];
    const entry =
      eff !== undefined && 'entries' in overlay
        ? overlay.entries.find((e) => e.check === name && e.cmd_sha256 === digestOf(eff))
        : undefined;
    const decision = log.find((e) => e.event_id === entry?.decided_by_event_id);
    if (
      eff?.tierSource !== 'overlay' ||
      eff.tier === FROM_TIER ||
      decision?.record.event_type !== CHECK_TIER_DECIDED_EVENT ||
      decision.record.payload.decision !== 'approve'
    ) {
      return answer(name, 'not-promoted', 'not-demoted');
    }
    const notRun = Array.isArray(payload?.not_run) && (payload.not_run as unknown[]).includes(name);
    if (isNotRun({ reason: typeof own.reason === 'string' ? own.reason : undefined }) || notRun) {
      return answer(name, 'not-promoted', 'not-run');
    }
    const env = Array.isArray(payload?.environment) ? (payload.environment as unknown[])[i] : null;
    if (isObj(env) && env.name === name && sleptDuringCheck(env as never)) {
      return answer(name, 'not-promoted', 'env-failure');
    }
    try {
      return await withOverlayLock(input.dir, async () => {
        // Each lock reads the log afresh, so a promotion made while this call waited is
        // seen and never undone by the reconcile.
        const fresh = await currentProjectLog(log, input.gather);
        if (fresh === null) return answer(name, 'promotion-skipped', 'checks.session-unreadable');
        log.splice(0, log.length, ...fresh);
        await reconcileOverlay(input.dir, log, ctx, opts);
        const now = readOverlay(input.dir);
        const cur =
          'entries' in now
            ? now.entries.find((e) => e.check === name && e.cmd_sha256 === entry?.cmd_sha256)
            : undefined;
        if (!('entries' in now) || cur === undefined || cur.tier === FROM_TIER) {
          return answer(name, 'not-promoted', 'not-demoted');
        }
        const promoted = {
          check: name,
          cmd_sha256: cur.cmd_sha256,
          from_tier: cur.tier,
          to_tier: FROM_TIER,
          catch_event_id: culprit.red_record_event_id,
          decided_by_event_id: cur.decided_by_event_id,
        };
        const pending_event = { event_type: CHECK_TIER_PROMOTED_EVENT, payload: promoted };
        const same = (e: OverlayEntry): boolean =>
          e.check === cur.check && e.cmd_sha256 === cur.cmd_sha256;
        const written = writeOverlay(input.dir, {
          entries: now.entries.map((e) => (same(e) ? { ...e, tier: FROM_TIER, pending_event } : e)),
          expectedRevision: now.revision,
        });
        log.push(await appendEvent({ ...ctx, ...pending_event }, opts.events));
        writeOverlay(input.dir, {
          entries: written.entries.map((e) => {
            if (!same(e)) return e;
            const { pending_event: _done, ...rest } = e;
            return rest;
          }),
          expectedRevision: written.revision,
        });
        return answer(name, 'promoted', null);
      });
    } catch (err) {
      if (err instanceof OverlayError) return answer(name, 'promotion-skipped', err.code);
      throw err;
    }
  };

  const answers: PromotionAnswer[] = [];
  for (const name of culprit.failing_checks) answers.push(await one(name));
  return answers;
}
