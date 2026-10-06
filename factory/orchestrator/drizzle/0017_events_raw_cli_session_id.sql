ALTER TABLE `events_raw` ADD `cli_session_id` text;--> statement-breakpoint
CREATE INDEX `events_raw_cli_session_idx` ON `events_raw` (`cli_session_id`);