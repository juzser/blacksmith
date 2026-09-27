# R1-R4: SubagentStop hook fields + frontmatter hooks

**R1 (stdin fields).** SubagentStop stdin includes `session_id`, `prompt_id`,
`transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`,
`hook_event_name`, `agent_id`, and `agent_type` (the subagent's name, e.g.
`security-reviewer`); `last_assistant_message` is also available for
Stop/SubagentStop. Both transcript path and agent type/name are provided.
Source: https://code.claude.com/docs/en/hooks (page did not expose a full
JSON example in the fetched excerpt — see open question).

**R2 (block output shape / stop_hook_active).** The docs table confirms
`Stop`-family events "can block" and on exit code 2 "prevents Claude from
stopping, continues the conversation." A `decision`/`reason` JSON shape is
implied by the standard hook decision model but the fetched excerpt did not
show the literal `{"decision":"block","reason":"..."}` example for
SubagentStop, nor did it mention a `stop_hook_active` re-entry flag.
Source: https://code.claude.com/docs/en/hooks — **not fully confirmed,
flag as open question**, recommend a follow-up fetch of the page's JSON
Output section before implementing.

**R3 (frontmatter hooks).** Confirmed: `.claude/agents/*.md` frontmatter
supports a `hooks` field, and "When the agent is invoked as a subagent,
`Stop` hooks in frontmatter are automatically converted to `SubagentStop`
events" — so the frontmatter should say `Stop`, not `SubagentStop`, to be
honored for a subagent. Source: https://code.claude.com/docs/en/sub-agents.

**R4 (plugin agents).** Documented explicitly: "For security reasons,
plugin subagents don't support the `hooks`, `mcpServers`, or
`permissionMode` frontmatter fields... ignored when loading agents from a
plugin." Only `.claude/agents/` (project) or `~/.claude/agents/` (user)
honor frontmatter hooks. Source: https://code.claude.com/docs/en/sub-agents.

**Existing guard hook pattern.** `.claude/settings.json:9` registers
`guard.sh` via `"$CLAUDE_PROJECT_DIR/.claude/hooks/guard.sh"` (quoted, so
spaces in the path are safe) on `PreToolUse`. `guard.sh` itself does not use
`$CLAUDE_PROJECT_DIR` at runtime — it derives `REPO_ROOT` independently via
`cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd` (guard.sh:54), then reads
the whole hook payload with `INPUT="$(cat)"` (guard.sh:92) and pipes it to a
node entry point (guard.sh:106). A new `judge-stop.sh` should mirror this:
resolve its own root via `BASH_SOURCE`, read stdin once with `cat`, delegate
parsing/decision logic to a dedicated node/TS entry point rather than
bash regex, and register itself in `.claude/settings.json` under `hooks`
with a `SubagentStop` (or `Stop`, if declared per-agent in frontmatter per
R3) matcher, quoting `$CLAUDE_PROJECT_DIR` the same way.

## Open questions
- Exact literal JSON block-output shape (`decision`/`reason` field names)
  for SubagentStop was not confirmed verbatim from the fetched page excerpt
  — re-fetch the "JSON Output" section of
  https://code.claude.com/docs/en/hooks before implementing the blocking
  logic.
- Whether `stop_hook_active` (or an equivalent re-entry guard) exists for
  SubagentStop was not found in the fetched excerpt — verify before relying
  on it to prevent infinite block loops; if absent, the coder must add its
  own loop guard.
