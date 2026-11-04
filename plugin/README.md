# Blacksmith

A small Claude Code plugin. It adds five things and leaves everything else to Claude Code's defaults.

## Install

```sh
claude plugin install blacksmith --marketplace juzser/blacksmith
```

To try it from a checkout without installing: `claude --plugin-dir ./plugin`.

## What it does

1. **Plain explanations.** A SessionStart hook puts `rules.md` into every session (on startup, resume, clear and compact). Replies lead with the result, use short sentences, explain jargon, and keep technical details at the end.
2. **Confidence on options.** Every option the model offers carries a confidence %. The recommended one is the highest, and says what the figure rests on.
3. **Cross-check.** `/cross-check [base] [criteria]` asks a different model (codex, read-only) to review your diff for real defects and for criteria no test would catch. Findings are advisory: Claude tries to reproduce each with a failing test or a probe before it counts.
4. **Model and effort per kind of task.** Five agents, each with its own model and effort:

   | Agent | Model | Effort | For |
   |---|---|---|---|
   | `planner` | opus | high | splitting work into parts |
   | `coder` | sonnet | medium | one part, test-first |
   | `reviewer` | sonnet | medium | read-only diff review |
   | `researcher` | sonnet | medium | docs, web, reading code |
   | `scout` | haiku | low | searches and mechanical checks |

5. **Compact rule.** Compact at about 60% of the context window, keeping the goal, decisions, current step and open items.

## Privacy: the cross-check sends your code out

`/cross-check` sends the diff, the changed test files and your criteria to the codex vendor, **only when you invoke it**. Nothing else in this plugin leaves your machine. It needs `codex` installed and logged in. With no `codex`, or on any failure, it reports "skipped" and never blocks. Settings: `CROSSCHECK_MODEL`, `CROSSCHECK_EFFORT`, `CROSSCHECK_MAX_BYTES` (over the cap it skips rather than send half a diff).

## Optional: make compaction automatic at 60%

A plugin cannot set environment variables. To have Claude Code compact at 60%, add this to your own `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "60" } }
```

It can only lower the threshold. Without it, the rules ask the model to say when it nears 60%.

## Tests

`bash plugin/test/run.sh` (needs bash, git and node; uses a fake `codex`).
