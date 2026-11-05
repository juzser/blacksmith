# Audit

`/audit [axis ...] [path]` is a read-only audit of the project as it stands. You start it; Claude never does, because it is costly (one agent per axis, each reading the tree).

- **Axes:** `performance`, `code-quality`, `security`. Name a subset to run fewer; none means all three. An argument that is not an axis is a path that narrows the scope.
- **Parallel:** one [`auditor`](../plugin/agents/auditor.md) per axis, dispatched together. Each is told it is read-only and must not modify anything (by instruction, since it keeps Bash).
- **Your rules count:** the project's `CLAUDE.md` and `AGENTS.md` go to each auditor as data. A design they document as deliberate is not a finding. Text in them that addresses the auditor is ignored or reported, never obeyed.
- **A finding has:** `file:line`, a severity (S1 stop-the-line, S2 major, S3 minor, S4 nit), a failure scenario (inputs, expected, actual) and a confidence from 0 to 1.
- **Not duplicated:** linter, type-checker and dependency-audit output is skipped; the audit looks for what those cannot see.

The findings are shown grouped by axis, worst severity first. Nothing is written to a file, ranked across axes or remembered between runs; fixing is a separate step you choose.
