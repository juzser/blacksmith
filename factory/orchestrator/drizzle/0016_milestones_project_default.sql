PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_milestones` (
	`milestone_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`sequence` integer NOT NULL,
	`goal` text,
	`epic_ids` text NOT NULL,
	`project` text DEFAULT 'blacksmith' NOT NULL,
	`kind` text DEFAULT 'factory' NOT NULL,
	`error_issues` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_milestones`("milestone_id", "name", "status", "sequence", "goal", "epic_ids", "project", "kind", "error_issues") SELECT "milestone_id", "name", "status", "sequence", "goal", "epic_ids", "project", "kind", "error_issues" FROM `milestones`;--> statement-breakpoint
DROP TABLE `milestones`;--> statement-breakpoint
ALTER TABLE `__new_milestones` RENAME TO `milestones`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `milestones_project_idx` ON `milestones` (`project`);--> statement-breakpoint
-- The factory's own project was renamed from 'black-smith' to 'blacksmith'.
-- History (events, committed plan files, old roadmap.md bullets) keeps the
-- old spelling, but every table's read model should not: rewrite every row
-- that already carries the old name in every table with a project column.
UPDATE `events_raw` SET `project` = 'blacksmith' WHERE `project` = 'black-smith';--> statement-breakpoint
UPDATE `dispatches` SET `project` = 'blacksmith' WHERE `project` = 'black-smith';--> statement-breakpoint
UPDATE `tasks` SET `project` = 'blacksmith' WHERE `project` = 'black-smith';--> statement-breakpoint
UPDATE `errors` SET `project` = 'blacksmith' WHERE `project` = 'black-smith';--> statement-breakpoint
UPDATE `findings` SET `project` = 'blacksmith' WHERE `project` = 'black-smith';--> statement-breakpoint
UPDATE `epics` SET `project` = 'blacksmith' WHERE `project` = 'black-smith';--> statement-breakpoint
UPDATE `milestones` SET `project` = 'blacksmith' WHERE `project` = 'black-smith';--> statement-breakpoint
UPDATE `issue_reports` SET `project` = 'blacksmith' WHERE `project` = 'black-smith';