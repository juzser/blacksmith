#!/bin/sh
# Blacksmith -- opt-in policy guard for plugin installs.
#
# Registered by the plugin's hooks/hooks.json for PreToolUse. It does nothing
# at all unless BS_PLUGIN_GUARD=1 is set in the environment, so a plugin
# install behaves exactly as before until an operator turns it on.
#
# When on, it hands the hook JSON on stdin, unchanged, to the policy hook the
# operator names, first match wins:
#   1. $BS_POLICY_HOOK, an existing file (run with node)
#   2. `bs-policy-hook` on PATH (the bin of the global package)
# and relays what it prints. If neither exists, or the hook cannot answer, it
# returns an `ask` decision so a person sees each command; it never allows on
# its own. The shim never runs anything taken from the hook input.
#
# The shim always answers in time: the hook runs under a watchdog (POSIX shell
# only: a background job, sleep, and kill of the PIDs this shim started) that
# is shorter than the hook entry's timeout in hooks.json. If the hook has not
# answered when the watchdog fires, it is stopped and an `ask` is returned.
# BS_PLUGIN_GUARD_WATCHDOG (seconds, digits and dots only) shortens the limit
# for tests; the default is 3.

[ "${BS_PLUGIN_GUARD:-}" = "1" ] || exit 0

ask() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' "$1"
  exit 0
}

NO_HOOK="Blacksmith's plugin guard is on (BS_PLUGIN_GUARD=1) but no policy hook was found. Install the global package so bs-policy-hook is on PATH, or set BS_POLICY_HOOK to the path of policyHook.js. Until then every command needs your approval."

LIMIT=3
case "${BS_PLUGIN_GUARD_WATCHDOG:-}" in
  '' | *[!0-9.]*) ;;
  *) LIMIT="$BS_PLUGIN_GUARD_WATCHDOG" ;;
esac

if [ -n "${BS_POLICY_HOOK:-}" ] && [ -f "$BS_POLICY_HOOK" ]; then
  command -v node >/dev/null 2>&1 || ask "Blacksmith's plugin guard cannot check this command: node is not on PATH. Until it is, every command needs your approval."
  WHICH="BS_POLICY_HOOK"
elif command -v bs-policy-hook >/dev/null 2>&1; then
  WHICH="bs-policy-hook"
else
  ask "$NO_HOOK"
fi

WORK="$(mktemp -d 2>/dev/null)" || ask "Blacksmith's plugin guard could not create a temporary directory to check this command. Until it can, every command needs your approval."
HPID=""
WPID=""
cleanup() {
  [ -n "$HPID" ] && kill -9 "$HPID" 2>/dev/null
  [ -n "$WPID" ] && kill "$WPID" 2>/dev/null
  rm -f "$WORK/in" "$WORK/out" "$WORK/fired"
  rmdir "$WORK" 2>/dev/null
}
trap cleanup EXIT
trap 'exit 0' HUP INT TERM

# A background job gets /dev/null as stdin, so hold the input in a file.
cat >"$WORK/in"

if [ "$WHICH" = "BS_POLICY_HOOK" ]; then
  node "$BS_POLICY_HOOK" <"$WORK/in" >"$WORK/out" 2>/dev/null &
else
  bs-policy-hook <"$WORK/in" >"$WORK/out" 2>/dev/null &
fi
HPID=$!

(
  sleep "$LIMIT" &
  SPID=$!
  trap 'kill "$SPID" 2>/dev/null; exit 0' TERM
  if wait "$SPID"; then
    : >"$WORK/fired"
    kill -9 "$HPID" 2>/dev/null
  fi
) &
WPID=$!

wait "$HPID"
STATUS=$?
HPID=""

if [ -e "$WORK/fired" ]; then
  ask "Blacksmith's plugin guard did not get an answer from $WHICH in time, so it stopped the check. Until the hook answers in time, every command needs your approval."
fi
[ "$STATUS" -eq 0 ] || ask "Blacksmith's plugin guard could not get a decision from $WHICH (it exited with an error). Rebuild or reinstall the package; until then every command needs your approval."

OUTPUT="$(cat "$WORK/out")"
if [ -n "$OUTPUT" ]; then
  printf '%s\n' "$OUTPUT"
fi
exit 0
