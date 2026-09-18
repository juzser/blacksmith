ALTER TABLE `findings` ADD `finding_scope` text DEFAULT 'diff' NOT NULL;--> statement-breakpoint
ALTER TABLE `findings` ADD `spec_plan_version` integer;--> statement-breakpoint
ALTER TABLE `findings` ADD `criterion_ref` text;