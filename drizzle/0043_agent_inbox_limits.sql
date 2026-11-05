CREATE TABLE `message_reads` (
	`message_id` text NOT NULL,
	`reader` text NOT NULL,
	`read_at` text NOT NULL,
	PRIMARY KEY(`message_id`, `reader`),
	FOREIGN KEY (`message_id`) REFERENCES `received_emails`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `conversation_replies` ADD `attachments` text;--> statement-breakpoint
ALTER TABLE `inbox_credentials` ADD `scope` text DEFAULT 'inbox' NOT NULL;--> statement-breakpoint
ALTER TABLE `inbox_credentials` ADD `inbox_ids` text;