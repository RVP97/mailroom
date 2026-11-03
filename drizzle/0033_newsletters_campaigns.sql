CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`utm_campaign` text,
	`starts_on` text,
	`ends_on` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `campaigns_org_idx` ON `campaigns` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `newsletters` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`segment_id` text,
	`topic_id` text,
	`from` text DEFAULT '' NOT NULL,
	`form_id` text,
	`public` integer DEFAULT true NOT NULL,
	`accent` text,
	`rss_url` text,
	`rss_mode` text DEFAULT 'draft' NOT NULL,
	`rss_seen` text,
	`rss_checked_at` text,
	`rss_error` text,
	`referrals` integer DEFAULT false NOT NULL,
	`referral_rewards` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `newsletters_slug_uidx` ON `newsletters` (`slug`);--> statement-breakpoint
CREATE INDEX `newsletters_org_idx` ON `newsletters` (`organization_id`);--> statement-breakpoint
CREATE TABLE `poll_votes` (
	`broadcast_id` text NOT NULL,
	`poll_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`answer` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`broadcast_id`, `poll_id`, `contact_id`),
	FOREIGN KEY (`broadcast_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `poll_votes_contact_idx` ON `poll_votes` (`contact_id`);--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `newsletter_id` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `web` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `slug` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `rss_items` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `campaign_id` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `campaign_dedupe` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `broadcasts_newsletter_idx` ON `broadcasts` (`newsletter_id`,`started_at`) WHERE newsletter_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `broadcasts_campaign_idx` ON `broadcasts` (`campaign_id`) WHERE campaign_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE `contacts` ADD `source` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `source_detail` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `unsubscribed_at` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `referral_code` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `referred_by` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `referrals` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_referral_uidx` ON `contacts` (`referral_code`) WHERE referral_code IS NOT NULL;--> statement-breakpoint
CREATE INDEX `contacts_org_unsubscribed_idx` ON `contacts` (`organization_id`,`unsubscribed_at`) WHERE unsubscribed_at IS NOT NULL;--> statement-breakpoint
UPDATE `contacts` SET `unsubscribed_at` = `updated_at` WHERE `unsubscribed` = 1;