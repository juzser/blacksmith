**Never set `finding_id`, `task_id`, `fingerprint`, `finding_status`,
`found_by` or `found_by_provider`.** The orchestrator mints all six
(`mintFindings` in `factory/orchestrator/src/findings.ts`) and throws
`findings.evidence-carries-identity` if you set one — the fingerprint in
particular is what deduplicates you against the other judges, and it is only
stable because one place computes it.
