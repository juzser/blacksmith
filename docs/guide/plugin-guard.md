# Plugin guard

A clone of this repository enforces Blacksmith's policy on every tool call
through a hook. A plugin install does not, by default: nothing runs in front of
your tool calls and nothing changes for you, with one exception described under "On by default: operator verbs in subagents". The plugin guard is an opt-in way
to get the same policy decisions in a plugin install.

## What it enforces

When it is on, every Bash, Write, Edit, MultiEdit, NotebookEdit, Agent and
Task call is passed to Blacksmith's policy hook. The hook applies the rules in
`factory/policies/guardrails.yml`. A call that breaks a rule is denied; a call
that breaks none goes on to Claude Code's normal permission flow, unchanged.
A force push to main is denied, and `git status` is not.

The same hook also denies two habits that waste an orchestrator's turns, and
names the fix in the reason. An `Agent` call whose prompt opens with a brief
marker for one role (the first line `bs brief compose` writes) must go to that
role's agent, `blacksmith:bs-<role>` under the plugin (the hook accepts the
bare `bs-<role>` too); one sent to `general-purpose` or to another role is
denied. A foreground `sleep` of 2 seconds or more is denied too, with a
background task or the Monitor tool as the fix; a shorter or backgrounded
sleep, and one inside a script the command runs, are not. A prompt with no
marker is decided as before.

If the guard is on but cannot reach the hook, it asks you instead of allowing
the call. The message names the fix: put `bs-policy-hook` on your PATH, or set
`BS_POLICY_HOOK` to the path of the built `policyHook.js`.

## On by default: operator verbs in subagents

One check does not wait for the switch. When Claude Code runs a tool call
inside a subagent, it adds `agent_id` to the hook input, and the plugin's hook
then runs Blacksmith's policy hook in a subagent-only mode. That mode refuses
the `bs` verbs and git operations that stand for the operator's own decision
(see "Operator verbs inside a subagent" in `docs/standards/guardrails.md`) and
decides nothing else: a force push from a subagent is still left to the opt-in
guard. A call from your own session has no `agent_id` and is untouched. If the
hook cannot be found, errors, is slow or is an older package without this mode,
this check stays silent; it never asks. `bs doctor` shows whether it is active:
its `subagent-lane` line probes the hook with an operator verb from a subagent. The reason it can be on while the rest is off: it is about who is calling,
needs nothing from your project, and cannot make a call that your own session
makes fail.

## The one switch

Set `BS_PLUGIN_GUARD=1` in the environment Claude Code starts in. Unset, empty
or any other value, the guard does nothing and prints nothing.

```sh
export BS_PLUGIN_GUARD=1
```

The hook is found in this order: the file named by `BS_POLICY_HOOK`, run with
node, then `bs-policy-hook` on PATH. The global package installs the
`bs-policy-hook` command.

Setting the switch through an `env` entry in a Claude Code settings file is
not tested here, so this guide does not claim it works. Export it in the shell
that starts Claude Code.

## Deny rules to copy

The guard decides what the policy rules say. Claude Code's own deny list is a
second layer that works without any hook. To use the same list a clone uses,
paste this into your project's settings file:

```json
{
  "permissions": {
    "deny": [
      "Bash(git push origin main)",
      "Bash(git push origin master)",
      "Bash(git push upstream main)",
      "Bash(git push upstream master)",
      "Bash(git push --force*)",
      "Bash(git push -f*)",
      "Bash(git push --force-with-lease*)",
      "Bash(git filter-branch*)",
      "Bash(wrangler deploy*)",
      "Bash(wrangler pages publish*)",
      "Bash(rm -rf /*)",
      "Bash(rm -rf ~*)"
    ]
  }
}
```

A test keeps this block equal to the deny list in the clone's own settings.
