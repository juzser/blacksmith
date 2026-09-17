#!/usr/bin/env node
// Fake harness program (test/runner.test.ts). Reads the whole stdin (the
// template body smith-run prepends, then the prompt) and behaves per
// `process.argv[2]`:
//
//   codex-json        -> a `codex exec --json` -shaped JSONL stream: one
//                        non-fatal `item.completed` error item first (must
//                        not become the answer), then the real
//                        `item.completed` agent_message, then a
//                        `turn.completed` usage event.
//   codex-json-error  -> a top-level `{"type":"error","message":"boom"}`
//                        line only, no agent_message anywhere — the harness
//                        exits 0 but reported failure in its own stream.
//   codex-json-agent-then-error -> a real `item.completed` agent_message,
//                        THEN a top-level `{"type":"error", ...}` line —
//                        proves an answer and a harness_error can both be
//                        populated from the same run.
//   claude-json        -> a `claude -p --output-format json` -shaped single
//                        JSON object: `result`, `session_id`,
//                        `total_cost_usd`, `usage` with Anthropic's split
//                        cache-creation/cache-read counters.
//   claude-json-error  -> the same shape with `is_error: true` and a
//                        `subtype`, the way `claude -p` reports a failed
//                        turn that still exits 0.
//   text               -> plain prose, no JSON anywhere in it.
//   echo               -> prints `{"stdin": <all of stdin>, "env": <process.env>}`
//                        as one JSON line, so a test can inspect exactly what
//                        reached this process on either channel.
//   slow-grandchild    -> spawns a NON-detached grandchild (inherits this
//                        process's group) whose pid is written to argv[3],
//                        then sleeps well past any test timeout — proves a
//                        timeout kills the whole group, not just this pid.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const mode = process.argv[2] ?? 'text';

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

  if (mode === 'codex-json') {
    const events = [
      { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'non-fatal notice' } },
      {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'agent_message',
          text: JSON.stringify({ verdict: 'confirm', rationale: 'codex says so' }),
        },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 },
      },
    ];
    for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }

  if (mode === 'codex-json-error') {
    const events = [{ type: 'error', message: 'boom' }];
    for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }

  if (mode === 'codex-json-agent-then-error') {
    const events = [
      {
        type: 'item.completed',
        item: { id: 'item_1', type: 'agent_message', text: 'the answer' },
      },
      { type: 'error', message: 'boom' },
    ];
    for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }

  if (mode === 'claude-json-error') {
    const payload = {
      type: 'result',
      is_error: true,
      subtype: 'error_during_execution',
      result: 'API error 529',
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    };
    process.stdout.write(JSON.stringify(payload));
    return;
  }

  if (mode === 'claude-json') {
    const payload = {
      result: JSON.stringify({ verdict: 'confirm', rationale: 'claude says so' }),
      session_id: 'sess_1',
      total_cost_usd: 0.05,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
        output_tokens: 5,
      },
    };
    process.stdout.write(JSON.stringify(payload));
    return;
  }

  if (mode === 'text') {
    process.stdout.write('Hello from the fake harness, no JSON here.');
    return;
  }

  if (mode === 'echo') {
    process.stdout.write(JSON.stringify({ stdin, env: process.env }));
    return;
  }

  if (mode === 'slow-grandchild') {
    const pidFile = process.argv[3];
    const child = spawn('sleep', ['30']);
    await writeFile(pidFile, String(child.pid));
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    return;
  }

  process.stdout.write(`unknown fixture mode: ${mode}`);
}

main();
