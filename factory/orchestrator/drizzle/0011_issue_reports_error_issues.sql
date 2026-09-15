CREATE TABLE `issue_reports` (
	`event_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`ts` text NOT NULL,
	`task_ref` text,
	`error_class` text NOT NULL,
	`fingerprint` text NOT NULL,
	`issue_url` text,
	`latest_event_id` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`repo_slug` text,
	`source` text NOT NULL,
	`project` text
);
--> statement-breakpoint
CREATE INDEX `issue_reports_session_idx` ON `issue_reports` (`session_id`);--> statement-breakpoint
CREATE INDEX `issue_reports_fingerprint_idx` ON `issue_reports` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `issue_reports_outcome_idx` ON `issue_reports` (`outcome`);--> statement-breakpoint
ALTER TABLE `milestones` ADD `error_issues` integer DEFAULT true NOT NULL;