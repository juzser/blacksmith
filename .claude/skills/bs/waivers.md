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
