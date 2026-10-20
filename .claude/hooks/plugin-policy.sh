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

[ "${BS_PLUGIN_GUARD:-}" = "1" ] || exit 0

ask() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' "$1"
  exit 0
}

NO_HOOK="Blacksmith's plugin guard is on (BS_PLUGIN_GUARD=1) but no policy hook was found. Install the global package so bs-policy-hook is on PATH, or set BS_POLICY_HOOK to the path of policyHook.js. Until then every command needs your approval."

if [ -n "${BS_POLICY_HOOK:-}" ] && [ -f "$BS_POLICY_HOOK" ]; then
  command -v node >/dev/null 2>&1 || ask "Blacksmith's plugin guard cannot check this command: node is not on PATH. Until it is, every command needs your approval."
  OUTPUT="$(node "$BS_POLICY_HOOK")" || ask "Blacksmith's plugin guard could not get a decision from BS_POLICY_HOOK (it exited with an error). Rebuild or reinstall the package; until then every command needs your approval."
elif command -v bs-policy-hook >/dev/null 2>&1; then
  OUTPUT="$(bs-policy-hook)" || ask "Blacksmith's plugin guard could not get a decision from bs-policy-hook (it exited with an error). Reinstall the package; until then every command needs your approval."
else
  ask "$NO_HOOK"
fi

if [ -n "$OUTPUT" ]; then
  printf '%s\n' "$OUTPUT"
fi
exit 0
