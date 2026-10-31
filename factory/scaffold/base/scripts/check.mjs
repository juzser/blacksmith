// The project's gate: one script, run the same way on a laptop
// (`pnpm run check`) and in CI (`node scripts/check.mjs --tier <tier> --ci`).
// Node built-ins only; nothing here needs GitHub Actions or a network.
//
//   node scripts/check.mjs [--tier pre-merge|post-merge|pre-release|all] [--list] [--ci]
//
// Without a `checks.json` at the project root it runs the project's own gates
// (lint, typecheck, typecheck:test, test:coverage, build), unlabelled, so every
// one of them is pre-merge. With a `checks.json` it runs that file's entries:
// `[{ "name": "...", "cmd": "...", "tier": "post-merge", "timeout_ms": 60000 }]`.
// `tier` is one of the three exact strings below, and absent means `pre-merge`;
// nothing in this script picks a tier for a check. The file is written and
// committed by the project's own operator, and CI follows only what it declares.
//
// The selected entries run in file order through the shell and stop at the
// first red. `timeout_ms` kills the check's whole process group. `heavy` is
// accepted and ignored: a CI runner runs one job's checks alone.
//
// `--list` prints the names this run would run, as a JSON array, and runs
// nothing: a query that CI uses to skip a job with nothing to run. A run whose
// selection is empty exits 1, never 0: no checks ran, so nothing passed.
//
// `--ci` leaves one entry to the e2e workflow: the one named `e2e` whose `cmd`
// is exactly `pnpm run test:e2e`, when `.github/workflows/e2e.yml` exists and
// package.json declares a `test:e2e` script (the condition that workflow runs
// on). Any other `e2e` entry runs here.
//
// pnpm 9 forwards a `--` to the script (`pnpm run check -- --tier x`), so one
// leading `--` is dropped before the arguments are read.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TIERS = ['pre-merge', 'post-merge', 'pre-release'];
const GATES = ['lint', 'typecheck', 'typecheck:test', 'test:coverage', 'build'];
const MAX_TIMEOUT_MS = 2_147_483_647;
const E2E_CMD = 'pnpm run test:e2e';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checksFile = path.join(root, 'checks.json');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const opts = { tier: 'all', list: false, ci: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--list') opts.list = true;
    else if (arg === '--ci') opts.ci = true;
    else if (arg === '--tier') opts.tier = args[++i];
    else fail(`unknown argument "${arg}"`);
  }
  if (opts.tier !== 'all' && !TIERS.includes(opts.tier)) {
    fail(`--tier must be one of ${[...TIERS, 'all'].join(', ')}; got ${JSON.stringify(opts.tier)}`);
  }
  return opts;
}

/** The entries to choose from: the file's, validated, else the project's own gates. */
function readEntries() {
  if (!existsSync(checksFile)) {
    return GATES.map((name) => ({ name, cmd: `pnpm run ${name}`, tier: 'pre-merge' }));
  }
  let entries;
  try {
    entries = JSON.parse(readFileSync(checksFile, 'utf8'));
  } catch (error) {
    fail(`${checksFile} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(`${checksFile} must be a non-empty array of checks.`);
  }
  return entries.map((entry, index) => {
    const where = `entry ${index} of ${checksFile}`;
    if (entry === null || typeof entry !== 'object') fail(`${where} is not an object.`);
    const { name, cmd, heavy, timeout_ms: timeoutMs, tier = 'pre-merge' } = entry;
    if (typeof name !== 'string' || name === '') fail(`${where} needs a string "name".`);
    if (typeof cmd !== 'string' || cmd === '') fail(`"${name}" in ${checksFile} needs a string "cmd".`);
    if (heavy !== undefined && typeof heavy !== 'boolean') {
      fail(`"${name}" in ${checksFile} has heavy ${JSON.stringify(heavy)}; it must be true or false.`);
    }
    if (!TIERS.includes(tier)) {
      fail(
        `"${name}" in ${checksFile} has tier ${JSON.stringify(tier)}; it must be one of ${TIERS.map((t) => `"${t}"`).join(', ')}.`,
      );
    }
    if (
      timeoutMs !== undefined &&
      (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS)
    ) {
      fail(`"${name}" in ${checksFile} has timeout_ms ${JSON.stringify(timeoutMs)}; it must be a positive whole number of milliseconds, at most ${MAX_TIMEOUT_MS}.`);
    }
    return { name, cmd, tier, timeoutMs };
  });
}

/** Whether the e2e workflow will run `pnpm run test:e2e` for this project. */
function e2eWorkflowRuns() {
  if (!existsSync(path.join(root, '.github', 'workflows', 'e2e.yml'))) return false;
  try {
    const script = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts?.['test:e2e'];
    return typeof script === 'string' && script !== '';
  } catch {
    return false;
  }
}

function runCheck(entry) {
  return new Promise((resolve) => {
    const started = Date.now();
    // A timed check gets its own process group so the kill reaches its children.
    const child = spawn(entry.cmd, {
      shell: true,
      cwd: root,
      stdio: 'inherit',
      detached: entry.timeoutMs !== undefined,
    });
    let timedOut = false;
    const timer =
      entry.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          }, entry.timeoutMs);
    // The detached group no longer shares our terminal, so pass an interrupt on to it.
    const CONVENTIONAL = { SIGINT: 130, SIGTERM: 143 };
    let interrupted;
    const forward = (sig) => {
      interrupted = sig;
      try {
        process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    };
    const handlers = entry.timeoutMs === undefined ? [] : Object.keys(CONVENTIONAL);
    for (const sig of handlers) process.on(sig, forward);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      for (const sig of handlers) process.off(sig, forward);
      if (interrupted) process.exit(CONVENTIONAL[interrupted]);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (timedOut) resolve(`timed out after ${entry.timeoutMs} ms`);
      else if (code === 0) resolve(null);
      else resolve(code === null ? `killed by ${signal} after ${seconds}s` : `exit ${code} after ${seconds}s`);
    });
    child.on('error', (error) => resolve(`could not start: ${error.message}`));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const entries = readEntries();
  const inTier = (entry) => opts.tier === 'all' || entry.tier === opts.tier;
  // Counted over the file, before anything is left to the e2e workflow.
  if (opts.tier === 'pre-merge' && !entries.some(inTier)) {
    fail(`${checksFile} holds no pre-merge check; --tier pre-merge would run nothing.`);
  }
  const omit = opts.ci && e2eWorkflowRuns();
  const selected = [];
  for (const entry of entries.filter(inTier)) {
    if (omit && entry.name === 'e2e' && entry.cmd === E2E_CMD) {
      // stdout of a --list is the JSON array alone.
      (opts.list ? console.error : console.log)(`"e2e" (${E2E_CMD}) is left to the e2e workflow.`);
    } else selected.push(entry);
  }

  if (opts.list) {
    console.log(JSON.stringify(selected.map((entry) => entry.name)));
    return;
  }
  if (selected.length === 0) {
    console.log(`no checks in tier ${opts.tier}`);
    process.exit(1);
  }
  for (const entry of selected) {
    console.log(`==> ${entry.name}: ${entry.cmd}`);
    const failure = await runCheck(entry);
    if (failure !== null) fail(`FAIL ${entry.name}: ${failure}`);
  }
  console.log(`all ${selected.length} checks in tier ${opts.tier} passed`);
}

await main();
