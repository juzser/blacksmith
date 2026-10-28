**Heavy runs take the machine lock.** One full suite or e2e run at a time
runs on the machine. A full-suite or e2e command — the project's `test_unit` or
`test_e2e` from `bs stack show`, a full-suite gate command your brief names, or
a check marked heavy — runs as
bs heavy run --label <task-id>-<role> -- <cmd>
(the bare `--` ends the options; everything after it is the command).
`bs gate run`, `bs integration check` and `bs queue run` take the lock
themselves and are never wrapped. Exit 75 is `heavy.wait-timeout`: another
holder kept the lock past the wait. Put the holder it names in your result and
do not retry blind. A scoped run of your own new test file runs directly.
