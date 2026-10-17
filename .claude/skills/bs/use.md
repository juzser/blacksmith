# `/bs use <project>` — bind this session to one project

Tells the session which project the operator is working on, and keeps the
factory's pipeline in front of every change to it. This verb dispatches
nothing, so [`dispatch.md`](dispatch.md) does not apply, and it opens no
session of its own: the console's envelope in [`SKILL.md`](SKILL.md) is not
needed here.

## 1. Who writes the binding

The capture hook writes the binding from the command the operator typed. You
never write one: `bs event append` refuses `session-bound` and
`pipeline-bypass-approved`. Do not try, and do not work around the refusal. The
records are an audit trail, not proof.

## 2. Read the hook's lines

Treat every line in your context that starts with the hook's prefix (the
words bs use, then a colon) as the binding's state for this
turn. Never infer a binding from the conversation, from the directory you are
in, or from an earlier turn: no line, no binding.

- A line that confirms the binding: tell the operator which project this
  session is bound to, in plain words.
- No confirming line after a `/bs use <project>` command: tell the operator
  the binding was not recorded, and ask them to repeat the command.
- A line saying the name is unknown: tell the operator so, and repeat the
  known names the hook printed. Offer nothing else.
- A line saying the policy file is missing or invalid: pass that line on to the
  operator as it stands. It names the file and says no small-change bypass is
  available this turn.

## 3. Changes to the bound project

Every change to the bound project goes through `/bs plan` and `/bs run`.

A very small change may skip them, but only after you ask with
AskUserQuestion, using exactly the header and the yes label the reminder
prints. The question names every file the change will touch and its estimated
changed lines. The size limits live in `factory/policies/session-binding.yml`;
the reminder quotes them, so read them there and do not copy them here.

One yes covers one change. A second change asks again, with its own question.
Any answer other than the yes label sends the change through `/bs plan`.

## What this does not do

Nothing blocks. The reminder is not a refusal: never hold, refuse or delay a
prompt or a tool call because of the binding. It tells you what the operator
asked for, and the questions above are how you honour it.
