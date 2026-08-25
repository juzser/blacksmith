#!/usr/bin/env node
// Fake CLI judge (test/providers/cli-transport.test.ts). Reads the whole
// prompt off stdin (mirrors what a real `codex exec` does) and behaves per
// `process.argv[2]`:
//   success          -> valid judge-verdict JSON, immediately
//   refute            -> valid judge-verdict JSON, verdict: refute (the
//                        critic mandate actually killing a finding —
//                        test/gate.test.ts's active-quorum path)
//   retry-aware       -> garbage unless the stdin prompt contains the
//                        cli-transport.ts retry nudge, then valid JSON
//   garbage           -> never valid JSON, even after a retry
//   prose             -> valid JSON wrapped in surrounding prose/markdown
//   slow              -> sleeps well past any test timeout
//   slow-grandchild   -> spawns a NON-detached grandchild (inherits this
//                        process's group, same as testgate.test.ts's
//                        regression scenario) whose pid is written to
//                        argv[3], then sleeps
//   huge              -> a single response well over any reasonable byte cap
//   refuse            -> a refusing judge (D-116) that puts its protocol banner
//                        on stdout — balanced JSON, but not a verdict — and its
//                        reason on stderr, exit 1. Appends one line to argv[3]
//                        per invocation so a test can prove no retry happened.
//   refuse-codex      -> the shape `codex exec --json` was OBSERVED to produce
//                        when its quota ran out, which is `refuse` mirrored:
//                        progress chatter on stderr, and the reason on stdout,
//                        inside a JSON event stream whose first balanced object
//                        is a content-free banner. Neither stream is reliably
//                        the one carrying the reason — hence both fixtures.
//   refuse-valid      -> nonzero exit but a schema-valid verdict on stdout: the
//                        judge answered, so the answer stands.
//   echo-prompt       -> echoes the whole stdin prompt back onto stderr before
//                        answering, which is what `codex exec` does without
//                        `--json` (D-118 stopped passing it). The answer is
//                        the file named by argv[3], so a test can pick which
//                        schema the judge is answering under.
import { spawn } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';

const mode = process.argv[2] ?? 'success';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.resume();
  });
}

async function main() {
  const stdin = await readStdin();

  if (mode === 'success') {
    process.stdout.write(JSON.stringify({ verdict: 'confirm', rationale: 'looks real' }));
    return;
  }

  if (mode === 'refute') {
    process.stdout.write(JSON.stringify({ verdict: 'refute', rationale: 'not reachable in practice' }));
    return;
  }

  if (mode === 'retry-aware') {
    if (stdin.includes('Return only valid JSON per schema')) {
      process.stdout.write(JSON.stringify({ verdict: 'refute', rationale: 'after nudge' }));
    } else {
      process.stdout.write('not json at all, sorry');
    }
    return;
  }

  if (mode === 'garbage') {
    process.stdout.write('complete garbage, no braces here at all');
    return;
  }

  if (mode === 'prose') {
    const payload = JSON.stringify({ verdict: 'confirm', rationale: 'wrapped in prose' });
    process.stdout.write(`Sure, here's my verdict:\n${payload}\nHope that helps!`);
    return;
  }

  if (mode === 'slow') {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    process.stdout.write(JSON.stringify({ verdict: 'confirm', rationale: 'too slow' }));
    return;
  }

  if (mode === 'slow-grandchild') {
    const pidFile = process.argv[3];
    const child = spawn('sleep', ['30']);
    await writeFile(pidFile, String(child.pid));
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    return;
  }

  if (mode === 'refuse') {
    const countFile = process.argv[3];
    if (countFile) await appendFile(countFile, 'x');
    // Banner first, exactly like `codex exec --json`: balanced JSON, and the
    // first balanced JSON in the buffer, so a scanner that takes the first
    // match never reaches the reason below.
    process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 't_1' })}\n`);
    process.stderr.write("You've hit your usage limit. Try again later.\n");
    process.exitCode = 1;
    return;
  }

  if (mode === 'refuse-codex') {
    // Transcribed from a real `codex exec --json` run on an exhausted quota:
    // stderr carries only progress, and every word that explains the failure
    // is on stdout, after a banner that is itself balanced JSON.
    process.stderr.write('Reading prompt from stdin...\n');
    const reason =
      "You've hit your usage limit. To continue using Codex, start a free trial of Plus today, or try again at Sep 10th, 2026 6:49 PM.";
    for (const event of [
      { type: 'thread.started', thread_id: 't_1' },
      { type: 'turn.started' },
      { type: 'error', message: reason },
      { type: 'turn.failed', error: { message: reason } },
    ]) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
    process.exitCode = 1;
    return;
  }

  if (mode === 'refuse-valid') {
    process.stdout.write(JSON.stringify({ verdict: 'refute', rationale: 'answered, then exited nonzero' }));
    process.exitCode = 3;
    return;
  }

  if (mode === 'echo-prompt') {
    process.stderr.write(stdin);
    process.stdout.write(await readFile(process.argv[3], 'utf8'));
    return;
  }

  if (mode === 'huge') {
    process.stdout.write(JSON.stringify({ verdict: 'confirm', rationale: 'x'.repeat(2_000_000) }));
    return;
  }

  process.stdout.write(`unknown fixture mode: ${mode}`);
}

main();
