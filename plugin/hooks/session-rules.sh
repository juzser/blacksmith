#!/bin/sh
# SessionStart hook: plain stdout is added to the session as context, so print
# rules.md as it is. Nothing is parsed or escaped. Always exits 0: a hook failure
# must never block a session.
root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)}"
[ -r "$root/rules.md" ] && cat "$root/rules.md" 2>/dev/null
exit 0
