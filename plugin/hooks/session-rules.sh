#!/bin/sh
# SessionStart hook: print rules.md as additionalContext. POSIX sh + awk + tr only.
# Always exits 0: a hook failure must never block a session.
root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)}"
rules="$root/rules.md"
[ -r "$rules" ] || exit 0
# Drop control bytes JSON cannot carry (keep tab, newline, CR), then escape for a JSON string.
body="$(tr -d '\000-\010\013\014\016-\037' < "$rules" | awk '
  BEGIN { ORS = "" }
  { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r"); print $0 "\\n" }
')" || exit 0
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$body"
exit 0
