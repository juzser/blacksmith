# factory/scheduler/

Declared in the repo layout (architecture §2) as the scheduler's home; the
implementation itself lives at
[`factory/orchestrator/src/scheduler.ts`](../orchestrator/src/scheduler.ts)
(TS strict + Vitest project rootDir, per `tsconfig.json`) alongside the rest
of the loop runner. Policy knobs: [`factory/policies/scheduler.yml`](../policies/scheduler.yml).
CLI: `smith scheduler run [--dry] [--project <dir>]`.
