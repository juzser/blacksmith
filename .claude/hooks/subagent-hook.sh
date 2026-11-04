#!/usr/bin/env bash
# Blacksmith -- subagent usage hook, transport shim.
#
# Registered by the plugin's hooks/hooks.json for SubagentStart (argument
# `start`) and SubagentStop (argument `stop`). It hands the hook JSON on stdin
# to the lean `subagentHook.js` entry and relays its stdout, which carries the
# role's token-cap warning on a stop.
#
# It is a recorder and never a gate: every failure is a silent exit 0, stderr
# goes to /dev/null, and nothing here can block a subagent. The entry is looked
# up like prompt-capture.sh's, first match wins:
#   1. $BS_SUBAGENT_HOOK, when it is an absolute path to an existing file
#      (run with node; a relative or missing path is skipped)
#   2. `bs-subagent-hook` on PATH (a global install or `pnpm link --global`)
#   3. otherwise nothing.

set -u

MODE="${1:-}"
case "$MODE" in
  start|stop) ;;
  *) exit 0 ;;
esac

case "${BS_SUBAGENT_HOOK:-}" in
  /*)
    if [ -f "$BS_SUBAGENT_HOOK" ] && command -v node >/dev/null 2>&1; then
      node "$BS_SUBAGENT_HOOK" "$MODE" 2>/dev/null
      exit 0
    fi
    ;;
esac

if command -v bs-subagent-hook >/dev/null 2>&1; then
  bs-subagent-hook "$MODE" 2>/dev/null
  exit 0
fi

exit 0
