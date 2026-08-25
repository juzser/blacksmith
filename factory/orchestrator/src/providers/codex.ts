// Thin binding: Codex is a CLI judge (`codex exec` headless, ChatGPT-
// subscription auth — docs/runbooks/providers.md documents the one-time
// `codex login` prerequisite). No Codex-specific request shaping is needed
// today; this indirection exists so a future Codex-only quirk (a different
// nudge wording, extra flags) has one place to land without touching the
// generic cli-transport.ts.
import type { CliProviderConfig } from '../crosscheck.js';
import { runCliJudge } from './cli-transport.js';
import type { JudgeRequest, JudgeResult } from './types.js';

export function runCodexJudge(
  config: CliProviderConfig,
  request: JudgeRequest,
): Promise<JudgeResult> {
  return runCliJudge('codex', { command: config.command, args: config.args }, request);
}
