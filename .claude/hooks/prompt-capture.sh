#!/usr/bin/env bash
# Blacksmith -- prompt-capture hook, transport shim.
#
# Registered by the plugin's hooks/hooks.json for UserPromptSubmit (no
# argument) and for PostToolUse on AskUserQuestion (argument `answer`). It
# hands the hook JSON on stdin to the lean `promptHook.js` entry and relays
# its one stdout line, which is how the model learns the stored event id.
#
# It is a recorder and never a gate: every failure is a silent exit 0, stderr
# goes to /dev/null, and nothing here can block a prompt. The plugin cache
# holds only `.claude/`, so the entry is looked up, first match wins:
#   1. $CLAUDE_PROJECT_DIR/factory/orchestrator/dist/promptHook.js
#   2. the same path in the main clone, via `git rev-parse --git-common-dir`
#      (worktrees have no build)
#   3. `bs-prompt-hook` on PATH (a global install or `pnpm link --global`)
#   4. otherwise nothing.

set -u

MODE="${1:-}"
case "$MODE" in
  answer) ARGS=(answer) ;;
  *) ARGS=() ;;
esac

ENTRY=""
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  CAND="$CLAUDE_PROJECT_DIR/factory/orchestrator/dist/promptHook.js"
  if [ -f "$CAND" ]; then
    ENTRY="$CAND"
  elif COMMON="$(cd "$CLAUDE_PROJECT_DIR" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null)"; then
    case "$COMMON" in
      /*) ;;
      *) COMMON="$CLAUDE_PROJECT_DIR/$COMMON" ;;
    esac
    CAND="$(cd "$COMMON/.." 2>/dev/null && pwd)/factory/orchestrator/dist/promptHook.js"
    [ -f "$CAND" ] && ENTRY="$CAND"
  fi
fi

if [ -n "$ENTRY" ]; then
  command -v node >/dev/null 2>&1 || exit 0
  node "$ENTRY" ${ARGS[@]+"${ARGS[@]}"} 2>/dev/null
  exit 0
fi

if command -v bs-prompt-hook >/dev/null 2>&1; then
  bs-prompt-hook ${ARGS[@]+"${ARGS[@]}"} 2>/dev/null
  exit 0
fi

exit 0
