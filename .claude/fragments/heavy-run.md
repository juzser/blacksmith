**Heavy runs take the machine lock.** One full suite or e2e run at a time
runs on the machine. A full-suite or e2e command — the project's `test_unit` or
`test_e2e` from `bs stack show`, a full-suite gate command your brief names, or
a check marked heavy — starts in the background (Bash `run_in_background: true`)
and is waited for in the foreground. Before every start, in a foreground call,
make a new empty output file outside the worktree, in the directory your own
result goes to (never `state/artifacts/`, which holds declared evidence):
mktemp <results-dir>/<task-id>-<role>-XXXXXX
It prints `<out>`; use that path and no other, so nothing carries over between
runs. Start (the bare `--` ends the options; the `printf` puts the exit code on
a line of its own):
bs heavy run --label <task-id>-<role> -- <cmd> > <out> 2>&1; printf '\nEXIT=%s\n' "$?" >> <out>
Then wait in the foreground:
bs heavy wait --file <out>
Each wait call ends inside the Bash tool's timeout. `"done"`, not the exit code,
says whether to call again (a suite may itself exit 124): on `"done": false`
call it again, without re-running the command and without `sleep`, and do not
end your turn while the run is live. Pass `bs heavy wait --file <out> --max-wait-ms 540000`
only together with a Bash `timeout` of 600000. Two calls in a row with `"done": false` and
`"holder": null` mean the run is gone: report it with the file's tail rather
than waiting on it. On `"done": true` the exit code is the suite's. Exit 75 is
`heavy.wait-timeout`: another holder kept the lock past the wait. Put the holder
it names in your result and do not retry blind. `bs gate run`,
`bs integration check` and `bs queue run` take the lock themselves and are
never wrapped. A scoped run of your own new test file runs directly.
