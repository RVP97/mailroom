CREATE TABLE `conversation_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`inbox_id` text,
	`author_type` text NOT NULL,
	`author_id` text,
	`author_name` text NOT NULL,
	`text` text NOT NULL,
	`mentions` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversation_notes_conversation_idx` ON `conversation_notes` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`actor` text NOT NULL,
	`key` text NOT NULL,
	`request` text NOT NULL,
	`status` integer,
	`response` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`actor`, `key`)
);
--> statement-breakpoint
CREATE INDEX `idempotency_keys_created_idx` ON `idempotency_keys` (`created_at`);--> statement-breakpoint
CREATE TABLE `inbox_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`inbox_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`match` text DEFAULT 'all' NOT NULL,
	`conditions` text NOT NULL,
	`actions` text NOT NULL,
	`stop` integer DEFAULT false NOT NULL,
	`matched` integer DEFAULT 0 NOT NULL,
	`last_matched_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inbox_id`) REFERENCES `inboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `inbox_rules_inbox_idx` ON `inbox_rules` (`inbox_id`,`position`);--> statement-breakpoint
CREATE TABLE `saved_replies` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`inbox_id` text,
	`name` text NOT NULL,
	`shortcut` text,
	`text` text NOT NULL,
	`add_tags` text,
	`set_status` text,
	`snooze_days` integer,
	`uses` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inbox_id`) REFERENCES `inboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `saved_replies_org_idx` ON `saved_replies` (`organization_id`);--> statement-breakpoint
ALTER TABLE `conversation_replies` ADD `review` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `assignee` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `assignee_name` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `claimed_until` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `tags` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `priority` text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `snoozed_until` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `first_reply_at` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `sla_first_due_at` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `sla_resolve_due_at` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `sla_breached` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `sla_warned_at` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `csat_sent_at` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `csat_rating` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `csat_comment` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `csat_at` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `held_at` text;--> statement-breakpoint
CREATE INDEX `conversations_assignee_idx` ON `conversations` (`assignee`,`status`);--> statement-breakpoint
CREATE INDEX `conversations_snoozed_idx` ON `conversations` (`snoozed_until`);--> statement-breakpoint
CREATE INDEX `conversations_sla_idx` ON `conversations` (`sla_first_due_at`);--> statement-breakpoint
ALTER TABLE `inboxes` ADD `settings` text;--> statement-breakpoint
ALTER TABLE `received_emails` ADD `flags` text;--> statement-breakpoint
ALTER TABLE `received_emails` ADD `held` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `conversations` SET `first_reply_at` = (SELECT min(`sent_at`) FROM `conversation_replies` r WHERE r.`conversation_id` = `conversations`.`id` AND r.`status` = 'sent');
