# Agents

Five agents, each with its own model and effort in its frontmatter. The routing table lives in [`plugin/rules.md`](../plugin/rules.md#3-model-and-effort-routing); the agent files are in [`plugin/agents/`](../plugin/agents/).

| Agent | Model | Effort |
|---|---|---|
| `planner` | opus | high |
| `coder` | sonnet | medium |
| `reviewer` | sonnet | medium |
| `researcher` | sonnet | medium |
| `scout` | haiku | low |

Use subagents for independent work that can run in parallel, and to keep bulky output out of the main session.

## Change a model or effort

Claude Code uses the highest-priority agent when names collide: managed settings, then the `--agents` flag, then the project's `.claude/agents/`, then the user's `~/.claude/agents/`, then plugin agents (see the [sub-agents docs](https://code.claude.com/docs/en/sub-agents)). So:

1. Copy the agent file, for example `plugin/agents/coder.md`, to `~/.claude/agents/coder.md` (every project) or `.claude/agents/coder.md` (one project).
2. Edit `model:` or `effort:` in the copy. `model` takes `sonnet`, `opus`, `haiku`, `fable`, a full model id, or `inherit`. `effort` takes `low`, `medium`, `high`, `xhigh` or `max`, depending on the model.

The copy shadows the plugin's agent of the same name and no longer follows plugin updates. A plugin cannot set these per agent in settings: plugin settings honour only `agent` and `subagentStatusLine`. Two environment variables act on all agents at once: `CLAUDE_CODE_SUBAGENT_MODEL` (with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` to override every agent) and `CLAUDE_CODE_EFFORT_LEVEL`.
