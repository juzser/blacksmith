# Black Smith — Claude Code entry point

Thin on purpose. This repo practises progressive disclosure: nothing here is
restated from another file, because a second copy is a copy that drifts.

## Read first

[`AGENTS.md`](AGENTS.md) is the router and the operating rules — branches,
worktrees, specs-as-contracts, declarations vs state, language, commits, and
which decisions stop for the operator. Read it before you act on this repo,
and follow its "Read on demand" table for anything deeper. **The rules live
there, not here.**

## Installing Black Smith — the self-install runbook

[`INSTALL.md`](INSTALL.md) is an executable runbook, not prose. When the
operator asks you to **install, set up, bootstrap, or verify** this repo —
including a bare *"install Black Smith"* — read that file and work through
Part 2 step by step, in order.

`INSTALL.md` Part 0 states the rules that bind you while you run it. The two
that matter most:

- **Ask before touching the machine outside the clone.** `brew`/`apt`/`dnf`/
  `apk`, anything with `sudo`, global npm installs, `corepack enable`, and
  `pnpm link --global` all change the operator's system: propose the exact
  command and wait for a yes. Everything inside the clone — `pnpm install`,
  `pnpm run build`, creating `.venv` — you may just do.
- **Never report a step as passing without running it.** `scripts/check.sh`
  degrades to a printed `SKIP` rather than a false `OK` when a tool is
  missing, so read the tail of its output, not the exit code, and say plainly
  which steps were skipped or declined.

## Driving the factory

[`.claude/skills/bs/SKILL.md`](.claude/skills/bs/SKILL.md) is the operator
console (`/bs new|plan|run|status|ui|waivers|lessons|report`). Its playbooks
own the dispatch contract, the event-log envelope, and the lessons splice —
use them rather than improvising a dispatch.
