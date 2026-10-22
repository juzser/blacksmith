// Runs before every test file. A wrong runtime has to fail the WHOLE suite,
// loudly and identically, at the first thing that happens.
//
// Without this, Node 20 fails the suite unevenly: files that open SQLite kill
// their vitest worker ("Worker exited unexpectedly"), files that don't pass
// clean, and the surviving green tests make the run look like a handful of
// ordinary failures. That is precisely how D-47 turned a wrong interpreter
// into a day of diagnosing the wrong subsystem. Partial support is the trap;
// refusing up front is the fix.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { assertRuntimeSupported } from '../src/runtime.js';

assertRuntimeSupported();

// Same argument, one layer up. crosscheck.yml's `enabled` flags say which
// judge binaries and API keys THIS box has, and flipping them on is a
// supported operator action — so on a box that had done so, 18 tests across
// gate/epic/cli/specFindings stopped asserting and started timing out at
// 5000ms, because they were really spawning `codex exec` and really POSTing to
// api.deepseek.com. The suite's result depended on the working copy's toggles,
// and the gate it feeds had been red long enough to stop being read.
//
// Providers are exercised deliberately, with an injected policy and a mocked
// transport (test/providers/index.test.ts). Nothing is lost by making the
// ambient default unreachable, and the network stays out of the unit suite.
// Inherited by children, which is what the CLI tests' subprocesses need.
process.env.SMITH_CROSSCHECK_OFFLINE = '1';

// And the same again for the developer's own terminal. events.ts stamps every
// write with CLAUDE_CODE_SESSION_ID when it is set, and this suite is run from
// inside Claude Code as often as not: left alone, every fixture event -- and
// every event a CLI-test child writes -- would carry the runner's own CLI
// session, and a test about an unstamped log would pass or fail by where it
// was launched from. Tests that want the stamp set it themselves.
delete process.env.CLAUDE_CODE_SESSION_ID;

// The heavy-test lock is per machine, so a gate another session holds would
// make every test that runs a `test`-named check through `run` wait on it.
// Each test file gets its own lock dir, and a token inherited from a gate
// running this suite is dropped so nothing re-enters that outer lock.
const heavyLockDir = mkdtempSync(path.join(tmpdir(), 'bs-heavy-lock-'));
process.env.BS_HEAVY_LOCK_DIR = heavyLockDir;
delete process.env.BS_HEAVY_LOCK_TOKEN;
afterAll(() => {
  rmSync(heavyLockDir, { recursive: true, force: true });
});
