# Plugin guard

A clone of this repository enforces Blacksmith's policy on every tool call
through a hook. A plugin install does not, by default: nothing runs in front of
your tool calls and nothing changes for you. The plugin guard is an opt-in way
to get the same policy decisions in a plugin install.

## What it enforces

When it is on, every Bash, Write, Edit, MultiEdit, NotebookEdit, Agent and
Task call is passed to Blacksmith's policy hook. The hook applies the rules in
`factory/policies/guardrails.yml`. A call that breaks a rule is denied; a call
that breaks none goes on to Claude Code's normal permission flow, unchanged.
A force push to main is denied, and `git status` is not.

If the guard is on but cannot reach the hook, it asks you instead of allowing
the call. The message names the fix: put `bs-policy-hook` on your PATH, or set
`BS_POLICY_HOOK` to the path of the built `policyHook.js`.

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
