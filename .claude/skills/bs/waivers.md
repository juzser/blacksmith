# `/bs waivers` — answer the pending waiver batch

1. `smith waivers pending <epic> --session <session-id>` — every S3/S4
   finding for the epic with no waiver decision yet (a decided fingerprint
   never resurfaces).
2. Present the whole batch to the operator as **one** question ("ignore
   these?") — never ask per-finding (architecture §11, `severity.yml`).
3. Write the answers to `decisions.json`
   (`Array<{fingerprint, decision: "granted"|"denied", operatorNote}>`) and
   run `smith waivers apply decisions.json --session ... --plan-version ...
   --causal-parent ... --actor operator`. S1/S2 findings are rejected by
   the command itself if attempted — they go through the escalation ladder
   instead, never a waiver.
4. A denial discharges nothing — the finding stays open with no further
   move of its own. The command's output carries `findingIdsToCarry`: every
   finding id this batch denied. If a later `smith plan amend` is cut to
   fix any of them, its `--findings` must name every id from that list or
   the finding stays open forever with no path back (issue #221) — carry
   the whole list forward until each id is either named in an amendment or
   closed some other way (waived on a later grant, refuted, etc.).
