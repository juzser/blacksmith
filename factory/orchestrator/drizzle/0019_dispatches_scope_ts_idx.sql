CREATE INDEX `dispatches_ts_idx` ON `dispatches` (`ts`);--> statement-breakpoint
CREATE INDEX `dispatches_project_ts_idx` ON `dispatches` (`project`,`ts`);--> statement-breakpoint
CREATE INDEX `dispatches_session_ts_idx` ON `dispatches` (`session_id`,`ts`);