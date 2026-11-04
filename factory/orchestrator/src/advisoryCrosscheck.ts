// Advisory cross-check (docs/specs/lean-mode-scope.md section 5).
//
// The lean `/bs do` path wants ONE review of the combined diff by a different
// model, not a quorum vote. This module is that review, built from the paths
// the full factory already has and nothing parallel to them:
//
//   - providers/index.ts runJudge()      the transport, read-only (rule 5)
//   - immutability.ts                    the worktree fingerprint taken around
//                                        the call (rule 6)
//   - findings.ts mintFindings()         parse + taxonomy-check + fingerprint
//   - findings.ts raiseFinding()/transition()   what `reproduce` reuses
//
// What it does NOT do, on purpose: it never calls recordJudgeRun(), so it
// writes no `judge-verdict` and no `dispatch_decision`. Those are what
// providerAgreement() and the quorum read; an advisory finding is neither a
// vote nor a verdict. It writes one `advisory-crosscheck` event holding the
// findings, and the findings are NOT in the finding fold, so epic close, the
// gates and `stats` cannot count them. A finding becomes real only when the
// session reproduces it (`reproduceAdvisoryFinding`): that raises it through
// the ordinary `finding-raised` path and confirms it, which is the existing
// route to the coder.
import { type CrosscheckPolicy, loadCrosscheckPolicy, providerModel } from './crosscheck.js';
import { SmithError } from './errors.js';
import { appendEvent, type EventOpts } from './events.js';
import {
  computeFingerprint,
  type EventContext,
  type FindingEvidence,
  mintFindings,
  normalizeFilePath,
  raiseFinding,
  transition,
} from './findings.js';
import { runGit, runGitRaw } from './git.js';
import { checkWorktreeImmutable, fingerprintWorktree, type WorktreeDrift } from './immutability.js';
import { readLineage } from './lineageSnapshot.js';
import { commandOnPath } from './preconditions.js';
import { runJudge } from './providers/index.js';
import type { JudgeBudget, JudgeRequest, JudgeResult } from './providers/types.js';
import { JUDGE_SCHEMA_FAILURE_CODES } from './providers/types.js';
import { loadTaxonomy } from './taxonomy.js';

export class AdvisoryCrosscheckError extends SmithError {}

export const ADVISORY_EVENT_TYPE = 'advisory-crosscheck';
export const ADVISORY_REPRODUCED_EVENT_TYPE = 'advisory-finding-reproduced';

/** taxonomy `agent` role the evidence is attributed to once reproduced: a reviewer, run by someone else. */
const REVIEWER_ROLE = 'reviewer';

export type AdvisoryStatus = 'ok' | 'skipped' | 'failed' | 'discarded';

export interface AdvisoryFinding extends FindingEvidence {
  finding_id: string;
  task_id: string;
  fingerprint: string;
  advisory: true;
  found_by_provider: string;
}

export interface AdvisoryResult {
  status: AdvisoryStatus;
  reason?: string;
  provider?: string;
  findings: AdvisoryFinding[];
  event_id: string;
}

// ---------------------------------------------------------------------------
// Pure pieces.
// ---------------------------------------------------------------------------

/**
 * The first enabled external provider, in crosscheck.yml order. An enabled CLI
 * provider whose binary is not on PATH is passed over: it cannot be called, and
 * "available" is the question. Never prompts; `name: null` carries the reason.
 */
export function selectAdvisoryProvider(
  policy: CrosscheckPolicy,
  onPath: (command: string) => boolean = commandOnPath,
): { name: string } | { name: null; reason: string } {
  const missing: string[] = [];
  for (const [name, config] of Object.entries(policy.providers)) {
    if (config.kind === 'native' || !config.enabled) continue;
    if (config.transport === 'cli' && !onPath(config.command)) {
      missing.push(`${name} (${config.command} is not on PATH)`);
      continue;
    }
    return { name };
  }
  return {
    name: null,
    reason:
      missing.length > 0
        ? `no external provider is available: ${missing.join(', ')}`
        : 'no external provider is enabled in crosscheck.yml',
  };
}

const TEST_FILE_RE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[a-z0-9]+$|_test\.[a-z0-9]+$/i;

/** The test files among a diff's changed paths. */
export function testFilesFromDiffNames(names: readonly string[]): string[] {
  return names.filter((n) => TEST_FILE_RE.test(n));
}

export interface AdvisoryRequestInput {
  taskId: string;
  diffRef: string;
  diff: string;
  criteria: readonly string[];
  testFiles: readonly { path: string; content: string }[];
  budget: JudgeBudget;
}

/**
 * The prompt: criteria, diff and test files, and the two questions of scope
 * section 5. It carries no check labels (the trial's refute misread an
 * "unit (pre-merge)" label), which is why this builder has no input for one.
 */
export function advisoryRequest(input: AdvisoryRequestInput): JudgeRequest {
  const taxonomy = loadTaxonomy();
  const severities = (taxonomy.dimensions.severity ?? []).join(' | ');
  const categories = (taxonomy.dimensions.finding_category ?? []).join(' | ');
  const prompt = [
    'You are a one-shot code reviewer from a different vendor than the author.',
    'Your value is a fresh context. Answer exactly two questions about the change below.',
    '',
    '1. Real defects. Report a defect only with a concrete input and the output you expect',
    '   against the output you would get. No scenario, no finding; style is not a defect.',
    '2. Acceptance criteria that no test would catch if removed. For each criterion, say',
    '   whether some test below would fail if the behaviour were deleted. If no test would fail,',
    '   report it as a finding (use category test-coverage) and name the criterion in the summary.',
    '',
    `Change: ${input.diffRef}`,
    '',
    'Acceptance criteria:',
    ...(input.criteria.length > 0 ? input.criteria.map((c) => `  - ${c}`) : ['  (none supplied)']),
    '',
    'Combined diff:',
    '```diff',
    input.diff,
    '```',
    '',
    'Test files, as they stand after the change:',
    ...(input.testFiles.length > 0
      ? input.testFiles.flatMap((f) => [`--- ${f.path}`, '```', f.content, '```'])
      : ['(none)']),
    '',
    'Return ONLY a JSON array, one element per finding:',
    `[{"file_path": "<repo-relative path>", "finding_category": "<one of: ${categories}>",`,
    `  "severity": "<one of: ${severities}>", "summary": "<one sentence>",`,
    '  "failure_scenario": {"inputs": "...", "expected": "...", "actual": "..."}}]',
    'Return [] if you find nothing. An empty array is a real answer; an invented finding is not.',
    'Do not return finding_id, task_id, fingerprint, finding_status or found_by.',
  ].join('\n');
  return {
    kind: 'review',
    taskId: input.taskId,
    inputRefs: { diff_ref: input.diffRef, diff_bytes: String(Buffer.byteLength(input.diff)) },
    prompt,
    schemaName: 'finding-evidence',
    budget: input.budget,
  };
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

export interface AdvisoryRunInput {
  taskId: string;
  /** Repo the base..head range lives in; also the worktree fingerprinted around the call unless `worktree` is given. */
  project: string;
  worktree?: string;
  base: string;
  head: string;
  criteria: readonly string[];
  /** Repo-relative test paths. Absent: derived from the diff. */
  testFiles?: readonly string[];
  budget: JudgeBudget;
  policy?: CrosscheckPolicy;
  /** Test seams: a fake transport and a fake PATH probe. */
  runJudgeImpl?: (name: string, request: JudgeRequest) => Promise<JudgeResult>;
  commandOnPathImpl?: (command: string) => boolean;
}

function readAtHead(project: string, head: string, file: string): string | null {
  try {
    return runGitRaw(project, ['show', `${head}:${file}`]);
  } catch {
    return null;
  }
}

function errorCode(err: unknown): string {
  return err instanceof SmithError ? err.code : 'provider.unknown-error';
}

export async function runAdvisoryCrosscheck(
  input: AdvisoryRunInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<AdvisoryResult> {
  const policy = input.policy ?? loadCrosscheckPolicy();
  const range = `${input.base}..${input.head}`;
  const base = {
    task_id: input.taskId,
    base: input.base,
    head: input.head,
    criteria_count: input.criteria.length,
  };

  const record = async (
    status: AdvisoryStatus,
    extra: {
      reason?: string;
      provider?: string;
      model?: string;
      error_code?: string;
      drift?: WorktreeDrift[];
      findings?: AdvisoryFinding[];
      test_files?: string[];
      usage?: unknown;
    } = {},
  ): Promise<AdvisoryResult> => {
    const findings = extra.findings ?? [];
    const stored = await appendEvent(
      {
        session_id: ctx.sessionId,
        actor: ctx.actor ?? 'system',
        event_type: ADVISORY_EVENT_TYPE,
        task_id: input.taskId,
        plan_version: ctx.planVersion,
        causal_parent: ctx.causalParent,
        payload: { ...base, status, ...extra, findings },
      },
      opts,
    );
    return {
      status,
      ...(extra.reason === undefined ? {} : { reason: extra.reason }),
      ...(extra.provider === undefined ? {} : { provider: extra.provider }),
      findings,
      event_id: stored.event_id,
    };
  };

  const chosen = selectAdvisoryProvider(policy, input.commandOnPathImpl);
  if (chosen.name === null) return record('skipped', { reason: chosen.reason });
  const providerName = chosen.name;
  const config = policy.providers[providerName];
  if (!config) return record('skipped', { reason: `provider ${providerName} vanished` });

  // The operator's standing answer to "may worktree source leave this machine".
  if (!policy.independentFinder.sendDiff) {
    return record('skipped', {
      provider: providerName,
      reason:
        'crosscheck.yml independent_finder.send_diff is false, so the diff may not be sent to an external provider',
    });
  }

  const diff = runGitRaw(input.project, ['diff', range]);
  if (diff.trim().length === 0) {
    return record('skipped', { provider: providerName, reason: `${range} has an empty diff` });
  }
  const bytes = Buffer.byteLength(diff, 'utf8');
  if (bytes > policy.independentFinder.maxDiffBytes) {
    return record('skipped', {
      provider: providerName,
      reason: `${range} is ${bytes} bytes, over independent_finder.max_diff_bytes (${policy.independentFinder.maxDiffBytes}); refused rather than truncated`,
    });
  }

  const names = runGit(input.project, ['diff', '--name-only', range]).split('\n').filter(Boolean);
  const testPaths = input.testFiles ? [...input.testFiles] : testFilesFromDiffNames(names);
  const testFiles = testPaths.flatMap((p) => {
    const content = readAtHead(input.project, input.head, p);
    return content === null ? [] : [{ path: p, content }];
  });

  const request = advisoryRequest({
    taskId: input.taskId,
    diffRef: range,
    diff,
    criteria: input.criteria,
    testFiles,
    budget: input.budget,
  });

  const worktree = input.worktree ?? input.project;
  const before = fingerprintWorktree(worktree);
  const call = input.runJudgeImpl ?? ((name, req) => runJudge(name, req, { policy }));
  const model = providerModel(config);
  const testNames = testFiles.map((f) => f.path);

  let judged: JudgeResult;
  try {
    judged = await call(providerName, request);
  } catch (err) {
    const code = errorCode(err);
    const message = err instanceof Error ? err.message : String(err);
    const common = { provider: providerName, model, error_code: code, reason: message };
    // The provider answered and the answer was unusable: a recorded failure.
    // Anything else means no usable answer ever arrived: nobody was available.
    return record(JUDGE_SCHEMA_FAILURE_CODES.has(code) ? 'failed' : 'skipped', common);
  }

  const after = checkWorktreeImmutable(worktree, before);
  if (!after.unchanged) {
    return record('discarded', {
      provider: providerName,
      model,
      test_files: testNames,
      reason: 'the worktree moved while the provider was reading it; its result was discarded',
      drift: after.drift,
    });
  }

  let findings: AdvisoryFinding[];
  try {
    if (!Array.isArray(judged.output)) {
      throw new AdvisoryCrosscheckError(
        'crosscheck.malformed-output',
        'the provider did not return a JSON array of findings',
      );
    }
    findings = mintFindings(
      judged.output as FindingEvidence[],
      { taskId: input.taskId, foundBy: REVIEWER_ROLE, foundByProvider: providerName },
      opts,
    ).map(({ finding, filePath }) => ({
      finding_id: finding.finding_id,
      task_id: input.taskId,
      fingerprint: fingerprintOf(filePath, finding.finding_category, finding.summary),
      file_path: normalizeFilePath(filePath),
      finding_category: finding.finding_category,
      severity: finding.severity,
      summary: finding.summary,
      failure_scenario: finding.failure_scenario,
      advisory: true as const,
      found_by_provider: providerName,
    }));
  } catch (err) {
    return record('failed', {
      provider: providerName,
      model,
      test_files: testNames,
      error_code: errorCode(err),
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  return record('ok', {
    provider: providerName,
    model,
    test_files: testNames,
    findings,
    ...(judged.raw_usage ? { usage: judged.raw_usage } : {}),
  });
}

// mintFindings() does not hand back the fingerprint, only the draft it was
// derived from; recompute it with the same function raiseFinding() uses so the
// two always agree.
function fingerprintOf(filePath: string, category: string, summary: string): string {
  return computeFingerprint({ filePath, category, summary });
}

// ---------------------------------------------------------------------------
// Reproduction: the only way an advisory finding gains power.
// ---------------------------------------------------------------------------

export interface ReproduceInput {
  findingId: string;
  /** The failing test or probe run that reproduced it. Required: "I believe it" is not reproduction. */
  evidence: string;
}

export async function reproduceAdvisoryFinding(
  input: ReproduceInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<{ finding: Awaited<ReturnType<typeof transition>>; event_id: string }> {
  if (input.evidence.trim().length === 0) {
    throw new AdvisoryCrosscheckError(
      'crosscheck.reproduce-needs-evidence',
      'crosscheck reproduce needs --evidence: the failing test or probe that reproduced the finding.',
      { findingId: input.findingId },
    );
  }
  const events = await readLineage(ctx.sessionId, opts);
  let advisory: AdvisoryFinding | undefined;
  let advisoryEventId: string | undefined;
  for (const stored of events) {
    const { record } = stored;
    if (record.event_type === ADVISORY_REPRODUCED_EVENT_TYPE) {
      const payload = record.payload as { finding_id?: string };
      if (payload.finding_id === input.findingId) {
        throw new AdvisoryCrosscheckError(
          'crosscheck.already-reproduced',
          `Advisory finding "${input.findingId}" was already reproduced.`,
          { findingId: input.findingId },
        );
      }
    }
    if (record.event_type !== ADVISORY_EVENT_TYPE) continue;
    const found = ((record.payload as { findings?: AdvisoryFinding[] }).findings ?? []).find(
      (f) => f.finding_id === input.findingId,
    );
    if (found) {
      advisory = found;
      advisoryEventId = stored.event_id;
    }
  }
  if (!advisory) {
    throw new AdvisoryCrosscheckError(
      'crosscheck.unknown-finding',
      `No advisory cross-check finding "${input.findingId}" in this session's lineage.`,
      { findingId: input.findingId },
    );
  }

  const raised = await raiseFinding(
    {
      filePath: advisory.file_path,
      finding: {
        finding_id: advisory.finding_id,
        task_id: advisory.task_id,
        finding_category: advisory.finding_category,
        severity: advisory.severity,
        finding_status: 'raised',
        summary: advisory.summary,
        failure_scenario: advisory.failure_scenario,
        found_by: REVIEWER_ROLE,
        found_by_provider: advisory.found_by_provider,
      },
    },
    ctx,
    opts,
  );
  if (raised.suppressed) {
    throw new AdvisoryCrosscheckError(
      'crosscheck.reproduce-suppressed',
      `Finding "${input.findingId}" is waived (fingerprint ${raised.fingerprint}); a waiver already answers it.`,
      { findingId: input.findingId },
    );
  }
  const confirmed = await transition(
    advisory.finding_id,
    'confirmed',
    { ...ctx, causalParent: raised.event_id },
    opts,
  );
  const stored = await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: ADVISORY_REPRODUCED_EVENT_TYPE,
      task_id: advisory.task_id,
      plan_version: ctx.planVersion,
      causal_parent: confirmed.event_id,
      payload: {
        finding_id: advisory.finding_id,
        task_id: advisory.task_id,
        fingerprint: advisory.fingerprint,
        evidence: input.evidence,
        advisory_event_id: advisoryEventId,
      },
    },
    opts,
  );
  return { finding: confirmed, event_id: stored.event_id };
}
