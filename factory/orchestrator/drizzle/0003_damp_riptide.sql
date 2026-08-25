ALTER TABLE `dispatches` ADD `project` text;--> statement-breakpoint
CREATE INDEX `dispatches_project_idx` ON `dispatches` (`project`);--> statement-breakpoint
ALTER TABLE `errors` ADD `project` text;--> statement-breakpoint
CREATE INDEX `errors_project_idx` ON `errors` (`project`);--> statement-breakpoint
ALTER TABLE `events_raw` ADD `project` text;--> statement-breakpoint
CREATE INDEX `events_raw_project_idx` ON `events_raw` (`project`);--> statement-breakpoint
ALTER TABLE `findings` ADD `project` text;--> statement-breakpoint
CREATE INDEX `findings_project_idx` ON `findings` (`project`);--> statement-breakpoint
ALTER TABLE `milestones` ADD `project` text DEFAULT 'black-smith' NOT NULL;--> statement-breakpoint
CREATE INDEX `milestones_project_idx` ON `milestones` (`project`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `project` text;--> statement-breakpoint
CREATE INDEX `tasks_project_idx` ON `tasks` (`project`);