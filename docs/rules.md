# The always-on rules

The rules are one file, [`plugin/rules.md`](../plugin/rules.md). It covers how to talk to a person, a confidence % on options, model and effort routing, the cross-check, and the compact rule. Read that file for the text; this page only says how it gets into a session.

## How they load

[`plugin/hooks/hooks.json`](../plugin/hooks/hooks.json) registers a `SessionStart` hook for `startup`, `resume`, `clear` and `compact`. It runs [`session-rules.sh`](../plugin/hooks/session-rules.sh), which prints `rules.md` to stdout. Claude Code adds that stdout to the session as context. The script always exits 0, so a hook failure never blocks a session. Registering `compact` brings the rules back after a compaction.

## Turn them off

- For every session: `claude plugin disable blacksmith`, then start a new session. This also drops the agents, `/audit` and `/cross-check`.
- Only the rules: there is no setting for that. Fork the plugin and delete the hook, or override the parts you dislike (below).

## Override them

Add your own rules to `~/.claude/CLAUDE.md` or the project's `CLAUDE.md`. Both load in the same session, so say plainly which rule yours replaces, for example "Ignore the confidence % rule in this project". Where two rules conflict, the more specific and more recent instruction usually wins, but this is model behaviour, not a guarantee.

To change the text itself, edit `plugin/rules.md` in a clone and load it with `claude --plugin-dir ./plugin`.
