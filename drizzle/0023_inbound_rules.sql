CREATE TABLE `inbound_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`match_to` text DEFAULT '*' NOT NULL,
	`match_from` text,
	`match_subject` text,
	`action` text NOT NULL,
	`forward_to` text,
	`continue` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `inbound_rules_org_idx` ON `inbound_rules` (`organization_id`,`position`);--> statement-breakpoint
ALTER TABLE `received_emails` ADD `answers_email_id` text;--> statement-breakpoint
ALTER TABLE `received_emails` ADD `actions` text;--> statement-breakpoint
CREATE INDEX `received_emails_answers_idx` ON `received_emails` (`answers_email_id`) WHERE answers_email_id IS NOT NULL;