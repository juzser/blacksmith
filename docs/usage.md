# Using the plugin

## Rules

The always-on rules are one file, [`plugin/rules.md`](../plugin/rules.md): how to talk to a person, a confidence % on options, model and effort routing, the cross-check, the compact rule, and verifying before calling something done. Read that file for the text; this section says how it gets into a session.

**How they load.** [`plugin/hooks/hooks.json`](../plugin/hooks/hooks.json) registers a `SessionStart` hook for `startup`, `resume`, `clear` and `compact`. It runs [`session-rules.sh`](../plugin/hooks/session-rules.sh), which prints `rules.md` to stdout; Claude Code adds that stdout to the session as context. The script always exits 0, so a hook failure never blocks a session. Registering `compact` brings the rules back after a compaction.

**Turn them off.** For every session: `claude plugin disable blacksmith`, then start a new session. This also drops the agents, `/audit` and `/cross-check`. There is no setting for only the rules: fork the plugin and delete the hook, or override the parts you dislike.

**Override them.** Add your own rules to `~/.claude/CLAUDE.md` or the project's `CLAUDE.md`. Both load in the same session, so say which rule yours replaces, for example "Ignore the confidence % rule in this project". The more specific and more recent instruction usually wins, but this is model behaviour, not a guarantee. To change the text itself, edit `plugin/rules.md` in a clone and load it with `claude --plugin-dir ./plugin`.

## Agents

Four agents, `planner`, `coder`, `reviewer` and `auditor`, each with its own model and effort in its frontmatter. The routing table is in [`plugin/rules.md`](../plugin/rules.md#3-model-and-effort-routing); the files are in [`plugin/agents/`](../plugin/agents/). Each `description` says what to send the agent and what not to. `auditor` is started by [`/audit`](audit.md), one per axis.

**Change a model or effort.** Plugin agents register under the plugin's name (`blacksmith:coder`), so a file of your own named `coder.md` sits beside the plugin's agent, it does not replace it. To use other settings, copy the agent file (for example `plugin/agents/coder.md`) to `~/.claude/agents/` (every project) or `.claude/agents/` (one project) under a name of your own, edit `model:` (`sonnet`, `opus`, `haiku`, `fable`, a full model id, or `inherit`) or `effort:` (`low`, `medium`, `high`, `xhigh` or `max`, depending on the model), and route work to it; or edit the plugin's copy in a clone, which then no longer follows plugin updates. A plugin cannot set these per agent in settings. Two environment variables act on all agents at once: `CLAUDE_CODE_SUBAGENT_MODEL` (with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` to override every agent) and `CLAUDE_CODE_EFFORT_LEVEL`.

## Compact

The rule is section 5 of [`plugin/rules.md`](../plugin/rules.md#5-compact): compact at about 60% of the context window, keep the goal, decisions, current step, open items and key paths and ids, and drop raw tool output and agents' raw returns.

A plugin cannot set environment variables, so the 60% trigger is yours to set. Add this to your own `~/.claude/settings.json`, merging it with any `env` you already have:

```json
{ "env": { "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "60" } }
```

The value (1 to 100) can only lower Claude Code's threshold, never raise it. Without it, the rules ask the model to tell you when it nears 60% so you can run `/compact <what to keep>`; the model cannot run `/compact` itself. A hook cannot add context before a compaction, which is why the keep and drop guidance travels in the rules, and the SessionStart hook re-sends them after one.
