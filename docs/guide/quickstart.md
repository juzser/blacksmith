# Quickstart

From nothing to a first epic running. Every command below is one the CLI ships;
[`INSTALL.md`](../../INSTALL.md) has the long form, per-platform setup and the
failure branch of each step.

## 1. Install

One command in a shell:

```bash
npm i -g @juzser/blacksmith
```

Two inside a Claude Code session:

```
/plugin marketplace add juzser/blacksmith
/plugin install blacksmith@blacksmith
```

Both halves are required: the package is the `bs` CLI, the plugin is `/bs` and
the agent roles it dispatches.

## 2. Check the machine

```bash
bs doctor
```

It reports what is present and what is missing, with a reason for each gap.
Fix what it names before going on; [`INSTALL.md`](../../INSTALL.md) says how
for each platform.

## 3. Initialise a project

In the project you want Blacksmith to work on:

```bash
bs init
```

That creates `.blacksmith/` beside your code: the event log, your epic plans, a
roadmap and a `stack.yml` to answer. It writes nothing anywhere else.

## 4. Your first epic

Open a Claude Code session in that directory. To scaffold a separate project
first, say:

```
/bs new my-app
```

Then plan a goal against a project and run it:

```
/bs plan <goal>
/bs run <epic>
```

`/bs plan` drafts spec contracts and asks you to sign them. `/bs run` admits a
wave, runs each task in its own worktree, grades it through the gates and ends
in one pull request that you review and merge.

## Where to look next

- [The operator loop](operator-loop.md): the six steps in the order you meet
  them.
- [Operator guide](operator-guide.md): the same ground with real commands and
  real output.
- [The dashboard](dashboard.md): an optional, read-only view of the event log.
- [Plugin modules](mods.md): the live HUD and the pull-request view.
- [`INSTALL.md`](../../INSTALL.md): install detail, the clone path and
  troubleshooting.
