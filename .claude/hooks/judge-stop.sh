#!/usr/bin/env bash
# Blacksmith — SubagentStop hook for the judge-class roles (reviewer,
# verifier, grader, spec-reviewer, security-reviewer, auditor).
#
# Declared in each judge template's frontmatter as a `Stop` hook, which Claude
# Code converts to `SubagentStop` for that subagent. Reads the SubagentStop
# payload from stdin, hands it to `node dist/judgeStopHook.js` unchanged, and
# relays that command's decision -- same shape as guard.sh's relationship to
# dist/policyHook.js.
#
# Clone-only, deliberately: the hook needs a checkout's built dist/, so a
# plugin-loaded copy of this template must stay inert wherever it runs
# (pluginManifest.test.ts pins that). Resolves itself via `$CLAUDE_PROJECT_DIR`
# and exits 0 with empty stdout the moment the script or the built hook is not
# where a clone would put it -- no fallback to `smith` on PATH or a
# plugin-root script.
#
# `JUDGE_STOP_HOOK_ROOT` points this at a different repo root (used by
# pluginManifest.test.ts's inert-outside-clone assertion).

set -u
set -o pipefail

ROOT="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$ROOT" ]; then
  # No project dir at all -- cannot be a clone-rooted install. Silent allow.
  exit 0
fi

HOOK="${JUDGE_STOP_HOOK_ROOT:-$ROOT}/factory/orchestrator/dist/judgeStopHook.js"

if [ ! -f "$HOOK" ]; then
  # dist/judgeStopHook.js missing means either this is a plugin install (no
  # checkout, no dist/ ever) or a clone that has not been built yet. Either
  # way there is no decision layer to consult, so this stays silent -- a
  # missing artifact is already caught downstream by `judge report`'s
  # `judges.artifact-missing`, and a Stop hook that blocked here would trap
  # the agent for a reason it cannot fix from inside its own turn.
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

INPUT="$(cat)"
OUTPUT="$(printf '%s' "$INPUT" | node "$HOOK")"

if [ -n "$OUTPUT" ]; then
  printf '%s\n' "$OUTPUT"
fi

exit 0
