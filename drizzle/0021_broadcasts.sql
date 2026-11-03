CREATE TABLE `broadcasts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`segment_id` text,
	`topic_id` text,
	`from` text DEFAULT '' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`reply_to` text,
	`preview_text` text,
	`html` text DEFAULT '' NOT NULL,
	`text` text,
	`template_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`scheduled_at` text,
	`cursor` text,
	`queued` integer DEFAULT 0 NOT NULL,
	`started_at` text,
	`completed_at` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `broadcasts_org_created_idx` ON `broadcasts` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `broadcasts_due_idx` ON `broadcasts` (`scheduled_at`) WHERE status IN ('scheduled', 'sending');--> statement-breakpoint
ALTER TABLE `emails` ADD `broadcast_id` text;--> statement-breakpoint
CREATE INDEX `emails_broadcast_idx` ON `emails` (`broadcast_id`) WHERE broadcast_id IS NOT NULL;