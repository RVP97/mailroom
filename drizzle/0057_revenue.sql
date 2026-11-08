ALTER TABLE `contact_events` ADD `value` real;--> statement-breakpoint
ALTER TABLE `contact_events` ADD `currency` text;--> statement-breakpoint
ALTER TABLE `contact_events` ADD `credit_type` text;--> statement-breakpoint
ALTER TABLE `contact_events` ADD `credit_id` text;--> statement-breakpoint
ALTER TABLE `contact_events` ADD `credit_email_id` text;--> statement-breakpoint
CREATE INDEX `contact_events_value_idx` ON `contact_events` (`organization_id`,`created_at`) WHERE value IS NOT NULL;--> statement-breakpoint
CREATE INDEX `contact_events_credit_idx` ON `contact_events` (`credit_type`,`credit_id`) WHERE credit_id IS NOT NULL;