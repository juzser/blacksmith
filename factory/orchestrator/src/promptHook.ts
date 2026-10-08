#!/usr/bin/env node
// The prompt-capture hook, as an entry point and nothing else.
//
// The plugin's UserPromptSubmit hook execs this file on every prompt, so it
// stays off `cli.ts` and the db layer, as `policyHook.ts` does for the guard.
// The logic is `promptCapture.ts`; `bs prompt capture` reaches the same
// function. Deliberately unconditional (no `import.meta.url` guard) for the
// reason `policyHook.ts` gives.
//
// Never blocks a prompt: every failure is a silent exit 0.
//   promptHook.js                 stdin = hook JSON; prints one line on a write
//   promptHook.js answer          stdin = PostToolUse AskUserQuestion JSON; same line
//   promptHook.js --resolve <cwd> prints the store this cwd records into, if any
import { readFileSync } from 'node:fs';
import { captureContext, capturePrompt, resolveLine } from './promptCapture.js';

try {
  const args = process.argv.slice(2);
  if (args[0] === '--resolve') {
    const cwd = args[1];
    const line = cwd === undefined ? null : resolveLine(cwd, captureContext(cwd, process.env));
    if (line !== null) process.stdout.write(`${line}\n`);
  } else {
    const line = await capturePrompt(
      readFileSync(0, 'utf8'),
      captureContext(process.cwd(), process.env),
      args[0] === 'answer' ? 'answer' : 'prompt',
    );
    if (line !== null) process.stdout.write(`${line}\n`);
  }
} catch {
  // A capture that fails loses one record; the prompt itself goes through.
}
process.exitCode = 0;
