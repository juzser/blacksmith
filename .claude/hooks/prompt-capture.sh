#!/usr/bin/env bash
# Blacksmith -- prompt-capture hook, transport shim.
#
# Registered by the plugin's hooks/hooks.json for UserPromptSubmit (no
# argument) and for PostToolUse on AskUserQuestion (argument `answer`). It
# hands the hook JSON on stdin to the lean `promptHook.js` entry and relays
# its one stdout line, which is how the model learns the stored event id.
#
# It is a recorder and never a gate: every failure is a silent exit 0, stderr
# goes to /dev/null, and nothing here can block a prompt. The hook runs only
# an entry the operator named, never a file from the project that is open.
# The entry is looked up, first match wins:
#   1. $BS_PROMPT_HOOK, when it is an absolute path to an existing file
#      (run with node; a relative or missing path is skipped)
#   2. `bs-prompt-hook` on PATH (a global install or `pnpm link --global`)
#   3. otherwise nothing.

set -u

MODE="${1:-}"
case "$MODE" in
  answer) ARGS=(answer) ;;
  *) ARGS=() ;;
esac

case "${BS_PROMPT_HOOK:-}" in
  /*)
    if [ -f "$BS_PROMPT_HOOK" ] && command -v node >/dev/null 2>&1; then
      node "$BS_PROMPT_HOOK" ${ARGS[@]+"${ARGS[@]}"} 2>/dev/null
      exit 0
    fi
    ;;
esac

if command -v bs-prompt-hook >/dev/null 2>&1; then
  bs-prompt-hook ${ARGS[@]+"${ARGS[@]}"} 2>/dev/null
  exit 0
fi

exit 0
