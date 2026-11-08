ALTER TABLE `automation_runs` ADD `waiting_for` text;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `waiting_since` text;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `converted_at` text;--> statement-breakpoint
CREATE INDEX `automation_runs_waiting_idx` ON `automation_runs` (`contact_id`,`waiting_for`) WHERE waiting_for IS NOT NULL;--> statement-breakpoint
ALTER TABLE `automations` ADD `goal_event` text;