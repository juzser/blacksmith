ALTER TABLE `agents` ADD `epic_id` text;--> statement-breakpoint
CREATE INDEX `agents_epic_idx` ON `agents` (`epic_id`);