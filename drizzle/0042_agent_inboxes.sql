CREATE TABLE `conversation_reads` (
	`conversation_id` text NOT NULL,
	`reader` text NOT NULL,
	`read_at` text NOT NULL,
	PRIMARY KEY(`conversation_id`, `reader`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversation_reads_reader_idx` ON `conversation_reads` (`reader`);--> statement-breakpoint
CREATE TABLE `conversation_refs` (
	`organization_id` text NOT NULL,
	`scope` text NOT NULL,
	`ref` text NOT NULL,
	`conversation_id` text NOT NULL,
	PRIMARY KEY(`organization_id`, `scope`, `ref`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversation_refs_conversation_idx` ON `conversation_refs` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `conversation_replies` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`inbox_id` text,
	`in_reply_to` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`from` text,
	`to` text NOT NULL,
	`cc` text,
	`subject` text NOT NULL,
	`text` text NOT NULL,
	`html` text,
	`author_type` text NOT NULL,
	`author_id` text,
	`author_name` text NOT NULL,
	`sent_by` text,
	`email_id` text,
	`sent_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversation_replies_conversation_idx` ON `conversation_replies` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`inbox_id` text,
	`subject` text NOT NULL,
	`contact` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`messages` integer DEFAULT 0 NOT NULL,
	`snippet` text,
	`last_message_at` text NOT NULL,
	`last_inbound_at` text,
	`last_reply_at` text,
	`replied_by` text,
	`resolved_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversations_org_last_idx` ON `conversations` (`organization_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `conversations_inbox_last_idx` ON `conversations` (`inbox_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `conversations_last_idx` ON `conversations` (`last_message_at`);--> statement-breakpoint
CREATE TABLE `inbox_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`inbox_id` text,
	`conversation_id` text,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`actor_name` text NOT NULL,
	`action` text NOT NULL,
	`detail` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `inbox_activity_inbox_idx` ON `inbox_activity` (`inbox_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `inbox_activity_conversation_idx` ON `inbox_activity` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `inbox_activity_created_idx` ON `inbox_activity` (`created_at`);--> statement-breakpoint
CREATE TABLE `inbox_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`inbox_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`start` text NOT NULL,
	`hash` text NOT NULL,
	`permissions` text NOT NULL,
	`send_scope` text DEFAULT 'replies' NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`rotated_at` text,
	`revoked_at` text,
	FOREIGN KEY (`inbox_id`) REFERENCES `inboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_credentials_hash_uidx` ON `inbox_credentials` (`hash`);--> statement-breakpoint
CREATE INDEX `inbox_credentials_inbox_idx` ON `inbox_credentials` (`inbox_id`);--> statement-breakpoint
CREATE TABLE `inboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`address` text NOT NULL,
	`domain_id` text,
	`reply_from` text,
	`send_allow` text,
	`send_block` text,
	`description` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inboxes_address_uidx` ON `inboxes` (`address`);--> statement-breakpoint
CREATE INDEX `inboxes_org_idx` ON `inboxes` (`organization_id`);--> statement-breakpoint
DROP INDEX `received_emails_message_uidx`;--> statement-breakpoint
ALTER TABLE `received_emails` ADD `inbox_id` text;--> statement-breakpoint
ALTER TABLE `received_emails` ADD `conversation_id` text;--> statement-breakpoint
ALTER TABLE `received_emails` ADD `references` text;--> statement-breakpoint
CREATE UNIQUE INDEX `received_emails_message_inbox_uidx` ON `received_emails` (`organization_id`,`ses_message_id`,coalesce(`inbox_id`, ''));--> statement-breakpoint
CREATE INDEX `received_emails_conversation_idx` ON `received_emails` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `received_emails_inbox_created_idx` ON `received_emails` (`inbox_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `webhooks` ADD `inbox_id` text REFERENCES inboxes(id) ON DELETE cascade;--> statement-breakpoint
-- What was received before conversations: one conversation each. No last_inbound_at, so it
-- reads as already read for everyone; the next message in it makes it unread.
INSERT INTO `conversations` (`id`, `organization_id`, `inbox_id`, `subject`, `contact`, `status`, `messages`, `last_message_at`, `created_at`, `updated_at`)
SELECT `id`, `organization_id`, NULL, `subject`, `from`, 'open', 1, `created_at`, `created_at`, `created_at` FROM `received_emails`;--> statement-breakpoint
UPDATE `received_emails` SET `conversation_id` = `id`;--> statement-breakpoint
INSERT OR IGNORE INTO `conversation_refs` (`organization_id`, `scope`, `ref`, `conversation_id`)
SELECT `organization_id`, '', lower(trim(`message_id`, '<> ')), `id` FROM `received_emails` WHERE `message_id` IS NOT NULL AND `message_id` != '';