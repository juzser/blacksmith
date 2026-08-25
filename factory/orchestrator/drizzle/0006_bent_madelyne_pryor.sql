CREATE TABLE `epics` (
	`epic_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`epic_status` text NOT NULL,
	`closed_by` text NOT NULL,
	`machine_verdict` text,
	`machine_reason` text,
	`override_rationale` text,
	`blockers` text,
	`closed_at` text NOT NULL,
	`event_id` text NOT NULL,
	`project` text
);
--> statement-breakpoint
CREATE INDEX `epics_session_idx` ON `epics` (`session_id`);--> statement-breakpoint
CREATE INDEX `epics_project_idx` ON `epics` (`project`);