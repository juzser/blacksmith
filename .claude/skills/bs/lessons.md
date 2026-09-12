# `/bs lessons` — review pending lesson candidates

[`dispatch.md`](dispatch.md) binds every agent this playbook dispatches;
none of it is restated here.

1. `smith lessons candidates [--session <id>] [--db state/smith.db]` —
   pending candidates with their statement, type, scope, and evidence/
   provenance event ids.
2. Present each to the operator. Approve, edit, or reject is **always**
   their call — nothing here self-modifies an agent
   (architecture §9.4, the memory-poisoning safety boundary).
   - **Approve**: `smith lessons approve <lesson-id> --session <id>
     --plan-version <n> --causal-parent <event-id> --actor operator
     [--note "<why>"]`.
   - **Edit then approve**: add `--statement`, `--lesson-type` and/or
     `--lesson-scope` to the same call — it writes the `lesson-edited`
     first and chains the approval onto it, one commit. A `--statement`
     goes through **the same novelty gate `raise` uses** (P9-34): if the
     new text duplicates another lesson the call exits 1 with
     `lessons.edit-not-novel` and writes **nothing**. Report that to the
     operator with the id it duplicates and let them choose — approve the
     lesson it duplicates, reword, or re-run with `--accept-duplicate`,
     which lands it and records `novelty_override` on the event. Never add
     `--accept-duplicate` on your own initiative.
   - **Read the `novelty` block on every approval** (P9-35). The gate
     catches copy-paste and one-word re-raises — since P9-35 (a) the
     threshold is corrected per pair for the shorter statement's length —
     but two changed words, containment and any real rewording all pass it,
     so the printed `mostSimilarLessonId` and score are the real
     near-duplicate check, and the operator is the one making it. Quote the
     score with the bar the block reports, not the configured threshold;
     they differ whenever the correction applied. An
     approval that lands non-novel text exits 1 *with the transition
     applied*: surface it, do not retry it. The UI's Edit action runs the
     same gate since P9-36 — but it has no `--accept-duplicate` control, so
     a duplicate the operator decides to keep has to come back to the CLI.
   - **Reject**: `smith lessons reject <lesson-id> …` — transitions to
     `invalidated`, the same status the UI's reject action uses
     (`ui/server/src/app.ts`'s `/reject` route); there is no separate
     operator-rejection status in taxonomy.yml's `lesson_status`.
   - `invalidated`, `novelty-rejected` and `superseded` are **terminal**
     (`LEGAL_LESSON_TRANSITIONS`, `lessons.ts`). Reviving a rejected lesson
     means raising it again with its own provenance — the command refuses
     `lessons.illegal-transition` rather than rewriting the decision.
3. Rebuild the projection so the change is visible:
   `smith db apply --db state/smith.db --session <id>`.
4. Periodically run `smith dream [--since <iso-date>]` to extract new raw
   candidates from decision checkpoints (plan sign-offs, waiver decisions,
   escalations, gate blocks) before this review — it needs the same
   `--session/--plan-version/--causal-parent` envelope. Candidates it
   raises carry `needs_distillation: true`; dispatch **`scribe`**
   (`.claude/agents/scribe.md`) to turn a promising raw one into a
   checkable, principle-level statement before presenting it, rather than
   showing the operator raw event text.
5. Once a batch is approved, recompile the committed file:
   `smith lessons compile [--session <id>] [--db state/smith.db]` —
   regenerates `factory/policies/lessons.md` from every `approved` lesson,
   sectioned by scope (architecture §9.5). Commit the regenerated file — it
   is the file every later dispatch reads (`smith lessons for-dispatch`), so
   an approved-but-uncompiled lesson reaches nobody.
6. After a compile — or whenever `lessons.md` has grown enough that nobody
   reads it — ask which entries still earn their place:
   `smith lessons audit <session-id> [--lessons <file>] [--state-dir <dir>]`.
   It **recommends only**; every removal is still the operator's call, the
   same boundary step 2 draws. Read the two evidence classes apart
   (operator-guide/lessons-and-daemon.md §10b): `retire`/`unreachable` is
   structural — an earlier entry shadows this one, provable from the corpus
   text alone — while `idle`/`rescope` needs a log showing the entry was
   actually loaded and still did not fire. `no-evidence` means the audit
   could not see enough, and is **never** a reason to drop an entry.
   Contradictions are reported,
   not resolved: two entries that disagree are a question for the operator,
   not something a tool should pick a winner in.
