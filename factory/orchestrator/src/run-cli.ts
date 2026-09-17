#!/usr/bin/env node
// smith-run: a separate executable, not a `smith` verb. `smith harness plan`
// renders a WorkerInvocation and stops there — architecture §18 rule 3,
// "nothing that observes may dispatch". This program is the only thing in
// this repo that actually starts one, and it does nothing else: no event
// log, no state/, no DB (see runner.ts's own header and its source-level
// test in test/runner.test.ts).
import { readFileSync, writeFileSync } from 'node:fs';
import { type FlagSpec, parseArgs } from './args.js';
import type { WorkerInvocation } from './harness.js';
import { type RunOutcome, runInvocation } from './runner.js';

const HELP = `Usage: smith-run <invocation.json | -> [--prompt-file <path>] [--timeout-ms <n>] [--out <file>]

Spawns ONE already-rendered worker invocation (the JSON \`smith harness plan\`
prints) and reports what happened as JSON. This is not \`smith harness run\`:
\`smith\` only ever renders an invocation and never starts it (§18 rule 3,
"nothing that observes may dispatch"), so starting the process an invocation
describes lives in its own binary instead.

Arguments:
  <invocation.json>     Path to a rendered WorkerInvocation, or "-" for stdin.

Options:
  --prompt-file <path>  Read the prompt from this file instead of invocation.promptFile.
  --timeout-ms <n>       Override invocation.budget.timeout_ms for this run.
  --out <file>           Write the JSON result here instead of stdout.
  --help                 Show this message.

Exit codes:
  0  completed (exit 0), answer validated against its schema (or no schema set)
  1  the harness process failed to start, or exited non-zero, or the harness
     reported an error in its output
  2  completed (exit 0), but schema validation failed
  3  timed out, or exceeded the output size cap
`;

const FLAG_SPEC: FlagSpec = new Map([
  ['prompt-file', true],
  ['timeout-ms', true],
  ['out', true],
  ['help', false],
]);

function readInvocation(source: string): WorkerInvocation {
  const text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');
  return JSON.parse(text) as WorkerInvocation;
}

/** See HELP's own exit-code table — kept in one place so the two cannot drift. */
function exitCodeFor(outcome: RunOutcome): number {
  if (outcome.spawnError !== null) return 1;
  if (outcome.timedOut || outcome.sizeExceeded) return 3;
  if (outcome.exitCode !== 0) return 1;
  // The process exited 0, but its own output reported a failure (a codex
  // top-level `error` event, or claude's `is_error: true`) — only reachable
  // for a clean exit, since a nonzero exitCode above already returned 1.
  if (outcome.harness_error !== null) return 1;
  if (outcome.validation !== null && !outcome.validation.ok) return 2;
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv, FLAG_SPEC);

  if (parsed.flags.help === 'true') {
    process.stdout.write(HELP);
    return 0;
  }

  const source = parsed.positional[0];
  if (source === undefined) {
    process.stderr.write('smith-run: missing <invocation.json | -> argument.\n\n');
    process.stderr.write(HELP);
    return 1;
  }

  let invocation: WorkerInvocation;
  try {
    invocation = readInvocation(source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`smith-run: could not read/parse invocation: ${message}\n`);
    return 1;
  }

  const timeoutOverride = parsed.flags['timeout-ms'];
  if (timeoutOverride !== undefined && invocation.kind === 'cli') {
    const timeout_ms = Number.parseInt(timeoutOverride, 10);
    if (Number.isNaN(timeout_ms)) {
      process.stderr.write(`smith-run: --timeout-ms must be a number, got "${timeoutOverride}".\n`);
      return 1;
    }
    invocation = { ...invocation, budget: { ...invocation.budget, timeout_ms } };
  }

  const opts: { promptText?: string } = {};
  const promptFile = parsed.flags['prompt-file'];
  if (promptFile !== undefined) {
    try {
      opts.promptText = readFileSync(promptFile, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`smith-run: could not read --prompt-file: ${message}\n`);
      return 1;
    }
  }

  let outcome: RunOutcome;
  try {
    outcome = await runInvocation(invocation, opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`smith-run: ${message}\n`);
    return 1;
  }

  const json = `${JSON.stringify(outcome, null, 2)}\n`;
  const outFile = parsed.flags.out;
  if (outFile !== undefined) {
    writeFileSync(outFile, json);
  } else {
    process.stdout.write(json);
  }

  return exitCodeFor(outcome);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`smith-run: unexpected error: ${message}\n`);
    process.exitCode = 1;
  },
);
