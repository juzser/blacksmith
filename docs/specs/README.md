# `docs/specs/` — what each file is, and how much of it to read

Three kinds of file live here, and the kind decides how a file is read. A
**contract** is read on demand by section. A **scope** is read whole, once,
by whoever plans the work it scopes. A **record of the past** is never
loaded whole: it is cited by id, and the id's own section is the whole read.
The test corpus draws the same line — `recordOfThePast()` in
`factory/orchestrator/test/helpers/instructionSurface.ts` is the machine
definition of the third group, matched by filename shape so a new dogfood
record joins it the day it is written.

The sizes are the point. Two of the records together are a megabyte; an
agent that opens one to "check the finding" has spent its window before it
reads the finding.

## Contracts — read by section

| File | Size | Cited as | Find the section with |
| --- | --- | --- | --- |
| [`black-smith-architecture.md`](black-smith-architecture.md) | 78 kB | `architecture §7` | `grep -n '^## 7\.' docs/specs/black-smith-architecture.md` and read to the next `## ` |
| [`agent-interviews.md`](agent-interviews.md) | 39 kB | `agent-interviews.md N-9`, `M-6` | the ids are bold inline leads, not headings — use [`agent-interviews-index.md`](agent-interviews-index.md), which maps every id to its lines and heading and records that `M-1` is defined twice |
| [`agent-interviews-index.md`](agent-interviews-index.md) | 9 kB | — | read whole; it is the map |
| [`black-smith-interview.md`](black-smith-interview.md) | 6 kB | — | read whole; the founding interview the architecture answers |

## Scopes — read whole, when planning that work

| File | Size | Scopes |
| --- | --- | --- |
| [`phase-10-scope.md`](phase-10-scope.md) | 31 kB | Phase 10 |
| [`audit-command-scope.md`](audit-command-scope.md) | 22 kB | the `audit` verb — a whole-project audit as a command, not a conversation |
| [`continuous-loop-scope.md`](continuous-loop-scope.md) | 19 kB | the continuous loop — the factory running epic after epic without an operator turn between them |
| [`plugin-port-scope.md`](plugin-port-scope.md) | 21 kB | the plugin port (status: planned) |

A scope is not a contract: once its work has shipped, the architecture and
the guides say what exists, and the scope says only what was intended.

## Records of the past — cite by id, never load

| File | Size | Ids | Find one with |
| --- | --- | --- | --- |
| [`dogfood-4-findings.md`](dogfood-4-findings.md) | 782 kB, 15 408 lines | `D-14`..`D-298` (171 findings, not contiguous) | `grep -n '^## D-245 ' docs/specs/dogfood-4-findings.md`, then `sed -n` from that line to the next `^## ` |
| [`phase-9-punch-list.md`](phase-9-punch-list.md) | 229 kB | `P9-1`..`P9-37` | `grep -n '^## P9-15 ' docs/specs/phase-9-punch-list.md` |
| [`dogfood-envkit-findings.md`](dogfood-envkit-findings.md) | 143 kB | `D0`..`D13` (no hyphen — the first dogfood, before the id scheme settled; `D3a` is a sub-heading) | `grep -n '^## D12 ' docs/specs/dogfood-envkit-findings.md` |
| [`dogfood-csb-audit-1-findings.md`](dogfood-csb-audit-1-findings.md) | 30 kB | `FD-1`..`FD-36` | `grep -n '^## FD-30 ' docs/specs/dogfood-csb-audit-1-findings.md` |
| [`dogfood-csb-signing-policy-1-findings.md`](dogfood-csb-signing-policy-1-findings.md) | 8 kB | `FD-37`..`FD-50` | the ids are bold inline leads: `grep -n '^\*\*FD-42 ' docs/specs/dogfood-csb-signing-policy-1-findings.md` |
| [`dogfood-mcp-close.md`](dogfood-mcp-close.md) | 34 kB | — | a close-out, read by heading; its headline is the first section |
| [`dogfood-envkit-close.md`](dogfood-envkit-close.md) + [`dogfood-envkit-close-event.json`](dogfood-envkit-close-event.json) | 9 kB + 3 kB | — | a close-out and the event that recorded it |
| `evidence/` | 37 screenshots | — | named by the finding they belong to (`d140-…`); open one only when its finding names it |
| [`../../CHANGELOG.md`](../../CHANGELOG.md) | at the repo root | — | the same rule: a renamed verb stays under its old name in the entry that shipped it |

When a record's id is the whole cite (`D-30` in a guide, `P9-15` in a
playbook), the section under that heading is the entire context the citer
meant. The rest of the file is other findings, and reading them is not
diligence — it is the window going to somebody else's bug.

There is no `archive/` here on purpose. The exclusion is by shape
(`dogfood-*`, `evidence/`, `*punch-list.md`, the changelog), so moving a file
would change nothing the tests see and would break every path a citation
carries.
