Plan v4 adds two tasks. Each one closes one verdict-v3 gap: task-19 closes 38e415f2 (timeline page index) and task-20 closes a2da2311 (overview poll bounded).
Slicing: one task per failed criterion, so each verdict line maps to one diff and one proof (a query plan for 19, counts for 20). Splitting task-20 further would cut through queries.ts and app.ts, the hub pair that both of its halves edit.
Claim overlap: both tasks claim queries.ts, schema.ts and drizzle/meta/_journal.json. Each may also write its own migration (0018, then 0019). Running them concurrently would collide on the migration number and the journal.
The overlap is answered with a claim-order edge task-20 -> task-19 rather than a re-slice. 20 also reads what 19 landed and reuses any index that already serves. This makes the work a 2-task chain: depth 2, widest 1.
Import crossings, checked with `bs claims impact` on a scratch plan of these two tasks against the integration worktree: status clean, 0 unpromised crossings.
It reports 3 promised crossings. Each is queries.ts (task-19) imported by a task-20 file: overviewCost.test.ts, ui/server/src/app.ts and ui/server/test/overviewShared.test.ts. Task-19's keeps_exports on queries.ts covers all three, and the edge orders them anyway.
`bs wave schedule` on the same scratch plan gives 2 rounds of 1 task, with nothing stalled.
Probe (in-memory, bundled SQLite 3.53.4): the page plans as type_idx plus a temp B-tree. `+event_type` moves it onto events_raw_ts_idx. A composite (event_type, ts) or (ts, event_type) index alone does not.
The GROUP BY max(ts) stays an O(N) covering scan even with a (session_id, ts) index. Task-20 therefore asks for one indexed lookup per session, not a better GROUP BY.
runningSessions groups by session_id, not cli_session_id, so task-20's index wording follows the code.
diff_lines (2400 and 3200) are sized for one generated drizzle meta snapshot each, about 1,800 lines, which the diff cap counts.
The overviewShared bound test asserts expiry at maxAgeMs, which this change removes. Task-20 therefore claims that file and rewrites that one test to the new contract, naming the old and new intent in its Result.
Rationale: Plan v4 adds task-19 and task-20, chained by a claim-order edge because both write queries.ts, schema.ts and the drizzle journal. task-19 closes 38e415f2 by serving the timeline page from a ts-ordered index proven by EXPLAIN QUERY PLAN, and task-20 closes a2da2311 by memoising overview's projection stage until the projection advances and bounding each poll's work to the clock windows by index.
