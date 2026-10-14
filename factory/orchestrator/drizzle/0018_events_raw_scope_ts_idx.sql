CREATE INDEX `events_raw_session_ts_idx` ON `events_raw` (`session_id`,`ts`);--> statement-breakpoint
CREATE INDEX `events_raw_task_ts_idx` ON `events_raw` (`task_id`,`ts`);