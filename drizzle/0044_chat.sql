CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`inbox_id` text,
	`author` text NOT NULL,
	`author_id` text,
	`author_name` text,
	`text` text NOT NULL,
	`attachments` text,
	`via` text NOT NULL,
	`client_id` text,
	`sent_by` text,
	`notified_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_messages_conversation_idx` ON `chat_messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_messages_client_uidx` ON `chat_messages` (`conversation_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `chat_messages_pending_idx` ON `chat_messages` (`notified_at`,`author`,`created_at`);--> statement-breakpoint
CREATE TABLE `chat_visitors` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`inbox_id` text NOT NULL,
	`ip_hash` text,
	`created_at` text NOT NULL,
	`last_seen_at` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_visitors_conversation_idx` ON `chat_visitors` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `chat_visitors_ip_idx` ON `chat_visitors` (`ip_hash`,`created_at`);--> statement-breakpoint
CREATE TABLE `chat_widgets` (
	`inbox_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`public_key` text NOT NULL,
	`origins` text NOT NULL,
	`design` text NOT NULL,
	`ask_email` text DEFAULT 'optional' NOT NULL,
	`notify` text NOT NULL,
	`daily_limit` integer DEFAULT 100 NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`inbox_id`) REFERENCES `inboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_widgets_key_uidx` ON `chat_widgets` (`public_key`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `channel` text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `visitor_name` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `visitor_email` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `page_url` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `chat_key` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `visitor_seen_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_chat_key_uidx` ON `conversations` (`chat_key`);--> statement-breakpoint
ALTER TABLE `inboxes` ADD `retention_days` integer;