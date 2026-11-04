import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The static guard behind envelopePreflight.test.ts. Which verbs write outside
// the log (a worktree, a plan version, a branch, an overlay file, an external
// process) before they append was swept by hand; this keeps the sweep honest by
// SOURCE ORDER, not by name:
//
//   * PINNED handlers: the pin call must come before the first write-like call,
//     or sit inside that call's own argument list (arguments run first).
//   * APPEND_ONLY handlers: no write-like call in the handler, and, for the
//     library functions listed in APPEND_ONLY_FUNCTIONS, none before the first
//     append-like call in the function body.
//   * Helpers outside `main` that build a context are classified too.
//
// It is a heuristic over text. WRITE lists only calls that write or mutate
// outside the log: the fs writers (writeFile*, appendFileSync, mkdirSync,
// renameSync, rmSync, copyFileSync), process spawners (execFileSync, spawnSync,
// execSync), the plan-file writers (amendPlan, approveSpecChange, nextVersion,
// writePlanFile), the async and fs/promises forms (mkdir, rm, rename, appendFile,
// copyFile, execFile, spawn), mutating git calls (worktree add|remove|prune,
// commit, merge, branch, update-ref, reset, checkout, push, tag, rebase,
// cherry-pick, revert, stash through runGit/git), the overlay writers (writeOverlay, reconcileOverlay), and the
// entry points that run git, checks, tests or providers (openAudit, closeAudit,
// step, batchStep, runGate, runIntegrationCheck, runPostMerge, runScheduler,
// runPlanQuorum, runEpicVerdict, closeEpic, promoteAfterCatch, runJudge,
// runCrossFinding, runAdvisoryCrosscheck). A new name belongs here the day a verb starts using it.
// Comments are blanked first. It cannot see a write hidden behind a function
// it does not name; the by-hand sweep covers the rest.

const WRITE =
  /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|mkdir|renameSync|rename|rmSync|rm|copyFileSync|copyFile|execFileSync|execFile|spawnSync|spawn|execSync|runJudge|runCrossFinding|runAdvisoryCrosscheck|amendPlan|approveSpecChange|nextVersion|writePlanFile|writeOverlay|reconcileOverlay|runGate|step|batchStep|runIntegrationCheck|runPostMerge|openAudit|closeAudit|runScheduler|runPlanQuorum|runEpicVerdict|closeEpic|promoteAfterCatch)\(/g;
// A mutating git call: runGit/git with a mutating subcommand among its arguments.
// Reads (rev-parse, rev-list, show, ls-tree, status, diff, log, merge-base) stay out.
const GIT_WRITE =
  /\b(?:runGit|git)\([^;]*?['"](?:worktree['"]\s*,\s*['"](?:add|remove|prune)|commit|merge|branch|update-ref|reset|checkout|push|tag|rebase|cherry-pick|revert|stash)['"]/g;
const APPEND =
  /\b(?:appendEvent|appendWithin|appendEdge|startSession|emit\w*|raiseFinding|transition\w*|recordJudge\w*)\(/;
const PIN = /pinnedEventContext\(|checksEnvelope\(/;
const PLAIN = /(?<!await pinnedEventContext\()eventContextFromFlags\(flags\)/;

const APPEND_ONLY = [
  "namespace === 'audit' && action === 'record'",
  "namespace === 'audit' && action === 'decide'",
  "namespace === 'audit' && action === 'cut'",
  "namespace === 'audit' && action === 'resolve'",
  "namespace === 'plan' && action === 'ingest'",
  "namespace === 'plan' && action === 'propose'",
  "namespace === 'plan' && action === 'reject'",
  "namespace === 'wave' && action === 'check'",
  "namespace === 'prompt' && action === 'record'",
  "namespace === 'feedback' && action === 'record'",
  "namespace === 'feedback' && action === 'resolve'",
  "namespace === 'queue' && action === 'adopt'",
  "namespace === 'results' && action === 'record'",
  "namespace === 'uiux' && action === 'check'",
  "namespace === 'epic' && action === 'spec-review'",
  "namespace === 'epic' && action === 'goal-check'",
  "namespace === 'findings' && action === 'raise'",
  "namespace === 'findings' && action === 'transition'",
  "namespace === 'findings' && action === 'reverify'",
  "namespace === 'findings' && action === 'repair-obligation'",
  "namespace === 'task' && action === 'reinstate'",
  "namespace === 'waivers' && action === 'approve-task'",
  "namespace === 'mcp' && action === 'override'",
  "namespace === 'waivers' && action === 'apply'",
  "namespace === 'lessons' && action === 'raise'",
  "namespace === 'lessons' && (action === 'approve' || action === 'reject')",
  "namespace === 'dream'",
  "namespace === 'judge' && action === 'dispatch'",
  "namespace === 'judge' && action === 'report'",
];

/** Handlers that run `scheduler run --dry` plain (it appends nothing) and pinned otherwise. */
const BOTH = ["namespace === 'scheduler' && action === 'run'"];

const PINNED = [
  "namespace === 'audit' && action === 'open'",
  "namespace === 'audit' && action === 'close'",
  "namespace === 'plan' && action === 'quorum'",
  "namespace === 'plan' && action === 'amend'",
  "namespace === 'plan' && action === 'approve'",
  "namespace === 'scheduler' && action === 'run'",
  "namespace === 'queue' && action === 'run'",
  "namespace === 'gate' && action === 'run'",
  "namespace === 'integration' && action === 'check'",
  "namespace === 'epic' && action === 'verdict'",
  "namespace === 'epic' && action === 'close'",
  "namespace === 'checks' && action === 'post-merge'",
  "namespace === 'checks' && action === 'proposals'",
  "namespace === 'checks' && action === 'apply'",
  "namespace === 'crossfind'",
  "namespace === 'crosscheck'",
];

/** Library functions an append-only verb calls: nothing write-like before the first append. */
const APPEND_ONLY_FUNCTIONS: Array<[string, string]> = [
  ['audit.ts', 'recordAudit'],
  ['audit.ts', 'decideAudit'],
  ['audit.ts', 'cutAudit'],
  ['audit.ts', 'resolveAudit'],
  ['specChange.ts', 'rejectSpecChange'],
  ['taskEvents.ts', 'emitWaveAdmitted'],
  ['prompts.ts', 'recordUserPrompt'],
  ['feedback.ts', 'recordFeedback'],
  ['feedback.ts', 'resolveFeedback'],
  ['waivers.ts', 'approveTaskWaiver'],
  ['mcp.ts', 'recordMcpOverride'],
  ['judges.ts', 'recordJudgeDispatch'],
  ['judges.ts', 'recordJudgeReport'],
  ['reinstate.ts', 'reinstateTask'],
];

/** Helpers outside `main` that build a context, and why each is fine. */
const HELPERS_WITH_PLAIN_CONTEXT: Record<string, string> = {
  runResultsCheck: 'read-only verb: it never appends',
};

const SRC = path.join(import.meta.dirname, '..', 'src');

/** Comments blanked to spaces, so offsets stay put and prose cannot match. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(
      /(^|[^:'"`])\/\/[^\n]*/g,
      (m, lead: string) => lead + ' '.repeat(m.length - lead.length),
    );
}

/** Offset just past the call opening at `start`, i.e. where its arguments end. */
function callEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = text.indexOf('(', start); i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return text.length;
}

/** The first write-like call that runs before `limit` (a pin or an append), or undefined. */
function writeBefore(text: string, limit: number): string | undefined {
  for (const re of [WRITE, GIT_WRITE]) {
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      if (at < limit && !(limit < callEnd(text, at))) return m[0];
    }
  }
  return undefined;
}

function handlerChunks(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const chunk of source.split(/\n {2}if \((?=namespace === )/).slice(1)) {
    out.set(chunk.slice(0, chunk.indexOf(') {')), stripComments(chunk));
  }
  return out;
}

describe('the pre-flight sweep stays complete', () => {
  const source = readFileSync(path.join(SRC, 'cli.ts'), 'utf8');
  const chunks = handlerChunks(source);

  it('every write-first verb pins its parent before its first write', () => {
    for (const key of PINNED) {
      const chunk = chunks.get(key);
      expect(chunk, key).toBeDefined();
      const pin = (chunk as string).search(PIN);
      expect(pin, `${key}: no pin call`).toBeGreaterThanOrEqual(0);
      expect(writeBefore(chunk as string, pin), `${key}: write before the pin`).toBeUndefined();
    }
  });

  it('every append-only handler has no write-like call of its own', () => {
    for (const key of APPEND_ONLY) {
      const chunk = chunks.get(key);
      expect(chunk, key).toBeDefined();
      expect(writeBefore(chunk as string, (chunk as string).length + 1), key).toBeUndefined();
    }
  });

  it('every handler with a plain context is classified', () => {
    const classified = new Set([...APPEND_ONLY, ...BOTH]);
    const offenders = [...chunks]
      .filter(([, c]) => PLAIN.test(c))
      .map(([key]) => key)
      .filter((key) => !classified.has(key));
    expect(offenders).toEqual([]);
  });

  it('every helper outside the handlers that builds a plain context is classified', () => {
    const head = stripComments(source.slice(0, source.search(/\n {2}if \(namespace === /)));
    const found = new Set<string>();
    for (const m of head.matchAll(/eventContextFromFlags\(flags\)/g)) {
      const before = head.slice(0, m.index);
      const fn = [...before.matchAll(/\n(?:async )?function (\w+)/g)].pop()?.[1] ?? '';
      found.add(fn);
    }
    // The definitions themselves build the context; nothing else may, unclassified.
    for (const own of ['pinnedEventContext']) found.delete(own);
    const unclassified = [...found].filter((fn) => !(fn in HELPERS_WITH_PLAIN_CONTEXT));
    expect(unclassified).toEqual([]);
  });

  it('library functions behind append-only verbs write nothing before their first append', () => {
    for (const [file, fn] of APPEND_ONLY_FUNCTIONS) {
      const text = stripComments(readFileSync(path.join(SRC, file), 'utf8'));
      const start = text.search(new RegExp(`export async function ${fn}\\b`));
      expect(start, `${file}: ${fn} not found`).toBeGreaterThanOrEqual(0);
      const end = text.indexOf('\n}\n', start);
      const body = text.slice(start, end);
      const append = body.search(APPEND);
      const limit = append === -1 ? body.length + 1 : append;
      expect(writeBefore(body, limit), `${file}: ${fn}`).toBeUndefined();
    }
  });
});
