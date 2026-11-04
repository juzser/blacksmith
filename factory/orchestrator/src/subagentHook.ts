#!/usr/bin/env node
// The SubagentStart / SubagentStop hooks, as an entry point and nothing else.
//
// The plugin's hooks.json execs this on every subagent start and stop, so it
// stays off `cli.ts` and the db layer, as `promptHook.ts` does. The logic is
// `subagentUsage.ts`; `bs subagent start|stop` reaches the same function.
//   subagentHook.js start   stdin = SubagentStart JSON; prints nothing
//   subagentHook.js stop    stdin = SubagentStop JSON; prints one systemMessage
//                           JSON line when the role crossed its task cap
//
// Never blocks a subagent: every failure is a quiet exit 0.
import { readFileSync } from 'node:fs';
import { captureContext } from './promptCapture.js';
import { recordSubagent } from './subagentUsage.js';

try {
  const mode = process.argv[2];
  if (mode === 'start' || mode === 'stop') {
    const out = await recordSubagent(
      readFileSync(0, 'utf8'),
      mode,
      captureContext(process.cwd(), process.env),
    );
    if (out !== null) process.stdout.write(`${out}\n`);
  }
} catch {
  // A recorder that fails loses one record; the subagent goes on.
}
process.exitCode = 0;
