CREATE TABLE `operator_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`session_id` text NOT NULL,
	`body` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text,
	`author` text,
	`recorded_at` text NOT NULL,
	`recorded_event_id` text NOT NULL,
	`resolved_at` text,
	`resolution` text,
	`follow_up_task_id` text
);
--> statement-breakpoint
CREATE INDEX `operator_feedback_task_idx` ON `operator_feedback` (`task_id`);--> statement-breakpoint
CREATE INDEX `operator_feedback_session_idx` ON `operator_feedback` (`session_id`);--> statement-breakpoint
CREATE INDEX `operator_feedback_external_idx` ON `operator_feedback` (`external_id`);