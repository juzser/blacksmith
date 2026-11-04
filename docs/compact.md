# Compact

The rule is section 5 of [`plugin/rules.md`](../plugin/rules.md#5-compact): compact at about 60% of the context window, keep the goal, decisions, current step, open items and key paths and ids, and drop raw tool output and agents' raw returns.

## Make it automatic

A plugin cannot set environment variables, so the 60% trigger is yours to set. Add this to your own `~/.claude/settings.json`, merging it with any `env` you already have:

```json
{ "env": { "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "60" } }
```

The value (1 to 100) can only lower Claude Code's threshold, never raise it. Without it, the rules ask the model to tell you when it nears 60% so you can run `/compact <what to keep>`; the model cannot run `/compact` itself. A hook cannot add context before a compaction, which is why the keep and drop guidance travels in the rules, and the SessionStart hook re-sends them after one.
