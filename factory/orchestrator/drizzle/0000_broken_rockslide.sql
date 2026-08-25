CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`task_id` text,
	`agent_id` text,
	`agent_role` text NOT NULL,
	`provider` text NOT NULL,
	`model_tier` text NOT NULL,
	`dispatched_at` text NOT NULL,
	`terminal_event_id` text,
	`terminal_at` text,
	`terminal_type` text,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agents_session_idx` ON `agents` (`session_id`);--> statement-breakpoint
CREATE INDEX `agents_status_idx` ON `agents` (`status`);--> statement-breakpoint
CREATE INDEX `agents_role_idx` ON `agents` (`agent_role`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`task_id` text NOT NULL,
	`event_id` text NOT NULL,
	`ts` text NOT NULL,
	`type` text NOT NULL,
	`path` text NOT NULL,
	`description` text
);
--> statement-breakpoint
CREATE INDEX `artifacts_session_idx` ON `artifacts` (`session_id`);--> statement-breakpoint
CREATE INDEX `artifacts_task_idx` ON `artifacts` (`task_id`);--> statement-breakpoint
CREATE TABLE `dispatches` (
	`event_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`ts` text NOT NULL,
	`task_id` text,
	`agent_id` text,
	`agent_role` text NOT NULL,
	`provider` text NOT NULL,
	`model_tier` text NOT NULL,
	`spec_ref` text,
	`reason` text,
	`parent_prompt_id` text,
	`causal_parent` text
);
--> statement-breakpoint
CREATE INDEX `dispatches_session_idx` ON `dispatches` (`session_id`);--> statement-breakpoint
CREATE INDEX `dispatches_task_idx` ON `dispatches` (`task_id`);--> statement-breakpoint
CREATE INDEX `dispatches_role_idx` ON `dispatches` (`agent_role`);--> statement-breakpoint
CREATE INDEX `dispatches_provider_idx` ON `dispatches` (`provider`);--> statement-breakpoint
CREATE INDEX `dispatches_model_tier_idx` ON `dispatches` (`model_tier`);--> statement-breakpoint
CREATE TABLE `edges` (
	`event_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`ts` text NOT NULL,
	`task_id` text NOT NULL,
	`depends_on` text NOT NULL,
	`edge_type` text NOT NULL,
	`edge_provenance` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `edges_session_idx` ON `edges` (`session_id`);--> statement-breakpoint
CREATE INDEX `edges_task_idx` ON `edges` (`task_id`);--> statement-breakpoint
CREATE TABLE `errors` (
	`event_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`ts` text NOT NULL,
	`task_ref` text,
	`agent_id` text,
	`error_group` text NOT NULL,
	`error_class` text NOT NULL,
	`severity` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `errors_session_idx` ON `errors` (`session_id`);--> statement-breakpoint
CREATE INDEX `errors_group_idx` ON `errors` (`error_group`);--> statement-breakpoint
CREATE INDEX `errors_severity_idx` ON `errors` (`severity`);--> statement-breakpoint
CREATE INDEX `errors_ts_idx` ON `errors` (`ts`);--> statement-breakpoint
CREATE TABLE `events_raw` (
	`event_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`ts` text NOT NULL,
	`event_type` text NOT NULL,
	`task_id` text,
	`agent_id` text,
	`plan_version` integer NOT NULL,
	`causal_parent` text,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_raw_session_idx` ON `events_raw` (`session_id`);--> statement-breakpoint
CREATE INDEX `events_raw_task_idx` ON `events_raw` (`task_id`);--> statement-breakpoint
CREATE INDEX `events_raw_type_idx` ON `events_raw` (`event_type`);--> statement-breakpoint
CREATE INDEX `events_raw_ts_idx` ON `events_raw` (`ts`);--> statement-breakpoint
CREATE TABLE `findings` (
	`finding_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`task_id` text NOT NULL,
	`epic_id` text,
	`fingerprint` text NOT NULL,
	`finding_category` text NOT NULL,
	`severity` text NOT NULL,
	`finding_status` text NOT NULL,
	`summary` text NOT NULL,
	`found_by` text NOT NULL,
	`found_by_provider` text,
	`verified_by` text,
	`verified_by_provider` text,
	`same_mistake_of_lesson_id` text,
	`waiver_id` text,
	`raised_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `findings_session_idx` ON `findings` (`session_id`);--> statement-breakpoint
CREATE INDEX `findings_task_idx` ON `findings` (`task_id`);--> statement-breakpoint
CREATE INDEX `findings_status_idx` ON `findings` (`finding_status`);--> statement-breakpoint
CREATE INDEX `findings_severity_idx` ON `findings` (`severity`);--> statement-breakpoint
CREATE INDEX `findings_fingerprint_idx` ON `findings` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `lessons` (
	`lesson_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`lesson_type` text NOT NULL,
	`lesson_level` text NOT NULL,
	`lesson_status` text NOT NULL,
	`lesson_scope` text NOT NULL,
	`statement` text NOT NULL,
	`valid_from` text NOT NULL,
	`superseded_by` text,
	`invalidated_by_event_id` text,
	`provenance_event_ids` text,
	`evidence` text,
	`times_prevented` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lessons_session_idx` ON `lessons` (`session_id`);--> statement-breakpoint
CREATE INDEX `lessons_status_idx` ON `lessons` (`lesson_status`);--> statement-breakpoint
CREATE TABLE `prompts` (
	`event_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`ts` text NOT NULL,
	`prompt` text NOT NULL,
	`causal_parent` text
);
--> statement-breakpoint
CREATE INDEX `prompts_session_idx` ON `prompts` (`session_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`last_event_at` text NOT NULL,
	`event_count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`task_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`epic_id` text,
	`case_tag` text,
	`origin` text,
	`task_status` text NOT NULL,
	`plan_version` integer,
	`objective` text,
	`claims` text,
	`branch` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tasks_session_idx` ON `tasks` (`session_id`);--> statement-breakpoint
CREATE INDEX `tasks_epic_idx` ON `tasks` (`epic_id`);--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`task_status`);--> statement-breakpoint
CREATE TABLE `waivers` (
	`event_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`ts` text NOT NULL,
	`fingerprint` text NOT NULL,
	`decision` text NOT NULL,
	`operator_note` text
);
--> statement-breakpoint
CREATE INDEX `waivers_session_idx` ON `waivers` (`session_id`);--> statement-breakpoint
CREATE INDEX `waivers_fingerprint_idx` ON `waivers` (`fingerprint`);