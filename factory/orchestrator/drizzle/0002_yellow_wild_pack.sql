CREATE TABLE `milestones` (
	`milestone_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`sequence` integer NOT NULL,
	`goal` text,
	`epic_ids` text NOT NULL
);
