# Comparison trial

This folder holds what a comparison trial needs: a small sample application
(`sample-app/`), a set of task kinds with hidden checks (`tasks/`), and a
harness (`harness/trial.mjs`) that prepares a workspace, records one run and
summarizes the recorded runs.

Running the trial, and the spend that comes with it, is the operator's
decision. The harness never starts `claude`, never calls the network and never
publishes anything. It prepares, measures and prints; the operator runs the
sessions.

Build first, because the harness imports the built module:

    pnpm run build

## The three verbs

### prepare

    node trial/harness/trial.mjs prepare --task <kind> --arm plain|blacksmith --dir <empty dir>

Copies the sample application into the directory, applies the task kind's
start state when its manifest names one, runs `git init` and makes one commit.
It then prints the prompt, the command the operator runs to open the session,
and the `record` command to run afterwards. The arm `blacksmith` also tells the
operator to install Blacksmith in the directory before starting.

### record

    node trial/harness/trial.mjs record --task <kind> --arm <arm> --dir <dir> \
      --cli-session <id> [--claude-config-dir <dir>] [--interventions <n>] \
      --results <file.jsonl>

Runs the task kind's hidden check against the prepared directory, reads the
session's token spend from its transcript, measures the diff against the start
commit and appends one JSON line to the results file. The line has exactly
these fields: task_kind, arm, check, tokens, wall_clock_ms, diff,
interventions, cli_session_id, recorded_at, harness_version.

- check is one of four labels: passed, failed, not-run or unknown.
- tokens is null when the session's transcript is not found. Otherwise it holds
  the spend and whether the reading was complete; an incomplete reading is a
  floor, not a total.
- wall_clock_ms is the span between the first and last timestamp of the
  session's main transcript, and null when the transcript is not found or has
  fewer than two timestamps.
- interventions comes only from the flag, and is null when it is not given.
  Nothing is estimated.

The configuration directory defaults to the CLAUDE_CONFIG_DIR environment
variable, then to the Claude Code folder in the home directory.

### summarize

    node trial/harness/trial.mjs summarize --results <file.jsonl>

Prints one Markdown table per task kind with a row per arm. Every cell says how
many runs it rests on: a single run is labelled as such, and a mean appears only
when there is more than one measured run, with the number of runs behind it.
A value that was not recorded is printed as NOT MEASURED. Lines of the results
file that cannot be read are skipped and counted.
