ALTER TABLE `organization_settings` ADD `digest` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `organization_settings` ADD `digest_sent_at` text;