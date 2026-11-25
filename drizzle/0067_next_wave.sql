-- Team alert channels (Slack, Discord, custom webhooks) for real-time Inbox, SLA & deliverability notifications
CREATE TABLE `org_alert_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL REFERENCES `organization`(`id`) ON DELETE cascade,
	`kind` text NOT NULL DEFAULT 'slack',
	`name` text NOT NULL,
	`webhook_url_encrypted` text NOT NULL,
	`url_hint` text NOT NULL,
	`events` text NOT NULL DEFAULT '[]',
	`enabled` integer NOT NULL DEFAULT 1,
	`last_sent_at` text,
	`last_error` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `org_alert_channels_org_idx` ON `org_alert_channels` (`organization_id`);
--> statement-breakpoint
-- Inbox macros: multi-action reply/triage shortcuts
CREATE TABLE `inbox_macros` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL REFERENCES `organization`(`id`) ON DELETE cascade,
	`inbox_id` text REFERENCES `inboxes`(`id`) ON DELETE cascade,
	`name` text NOT NULL,
	`shortcut` text,
	`reply_text` text,
	`note_text` text,
	`actions` text NOT NULL DEFAULT '{}',
	`uses` integer NOT NULL DEFAULT 0,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `inbox_macros_org_idx` ON `inbox_macros` (`organization_id`, `inbox_id`);
--> statement-breakpoint
-- Custom saved inbox views (team-shared or personal filter presets)
CREATE TABLE `inbox_views` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL REFERENCES `organization`(`id`) ON DELETE cascade,
	`name` text NOT NULL,
	`color` text,
	`filters` text NOT NULL DEFAULT '{}',
	`shared` integer NOT NULL DEFAULT 1,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `inbox_views_org_idx` ON `inbox_views` (`organization_id`);
--> statement-breakpoint
-- Multi-language support for Help Center articles
ALTER TABLE `help_articles` ADD `locale` text NOT NULL DEFAULT 'en';
--> statement-breakpoint
ALTER TABLE `help_articles` ADD `translations` text;
