ALTER TABLE `organization_settings` ADD `quiet_mode` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `organization_settings` ADD `cap_count` integer;--> statement-breakpoint
ALTER TABLE `organization_settings` ADD `cap_days` integer;