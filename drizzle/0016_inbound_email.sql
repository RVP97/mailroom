CREATE TABLE `received_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`domain_id` text,
	`ses_message_id` text NOT NULL,
	`message_id` text,
	`in_reply_to` text,
	`from` text NOT NULL,
	`to` text NOT NULL,
	`cc` text,
	`reply_to` text,
	`subject` text NOT NULL,
	`recipients` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`attachments` text,
	`spam` text,
	`virus` text,
	`spf` text,
	`dkim` text,
	`dmarc` text,
	`object_key` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `received_emails_org_created_idx` ON `received_emails` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `received_emails_message_uidx` ON `received_emails` (`organization_id`,`ses_message_id`);--> statement-breakpoint
CREATE INDEX `received_emails_created_idx` ON `received_emails` (`created_at`);--> statement-breakpoint
ALTER TABLE `domains` ADD `receiving` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `domains` ADD `receiving_status` text;