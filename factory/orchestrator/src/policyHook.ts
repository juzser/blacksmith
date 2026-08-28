#!/usr/bin/env node
// The guard hook, as an entry point and nothing else.
//
// `.claude/hooks/guard.sh` execs this file. Everything about what to decide
// lives in `hookDecision.ts`; what lives here is the process contract, which
// is the whole reason this file is separate from `cli.ts`: its import graph
// is the decision's and no more. `cli.ts` reaches the same function through
// `smith policy hook`, so the two cannot drift, but it carries 64 top-level
// imports to get there and this carries three.
//
// Deliberately unconditional. There is no `import.meta.url === argv[1]` guard
// here, because a guard that mis-fires would exit 0 having printed nothing —
// indistinguishable, to guard.sh, from a genuine allow. That is precisely the
// failure this module's history is made of, and the cheapest way not to have
// it again is to have no condition at all: this file only ever runs as a
// process, and `cli.ts` imports the decision, never this.
import { readFileSync } from 'node:fs';
import { decideHookPayload } from './hookDecision.js';

// Reads fd 0 rather than accumulating 'data' events: the payload is one small
// JSON object a shell pipes in and closes, and a throw on a broken read is the
// outcome we want anyway.
const output = decideHookPayload(readFileSync(0, 'utf8'), process.cwd());
if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
// Any throw above is left to propagate: node exits non-zero with a stack on
// stderr, and guard.sh reads that as "the policy layer could not answer" and
// escalates to `ask`. Nothing is caught here, because catching it could only
// produce a quieter, less honest version of the same failure.
