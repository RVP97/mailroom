CREATE TABLE `access_log` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`action` text NOT NULL,
	`subject` text NOT NULL,
	`channel` text NOT NULL,
	`user_id` text,
	`actor` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `access_log_org_created_idx` ON `access_log` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `disposable_domains` (
	`domain` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `firewall` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`block_disposable` integer DEFAULT false NOT NULL,
	`block_free` integer DEFAULT false NOT NULL,
	`block_plus` integer DEFAULT false NOT NULL,
	`never` text DEFAULT '[]' NOT NULL,
	`always` text DEFAULT '[]' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `provider_stats` (
	`organization_id` text NOT NULL,
	`day` text NOT NULL,
	`provider` text NOT NULL,
	`sent` integer DEFAULT 0 NOT NULL,
	`delivered` integer DEFAULT 0 NOT NULL,
	`bounced` integer DEFAULT 0 NOT NULL,
	`complained` integer DEFAULT 0 NOT NULL,
	`opened` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`organization_id`, `day`, `provider`)
);
--> statement-breakpoint
ALTER TABLE `domains` ADD `purpose` text DEFAULT 'transactional' NOT NULL;--> statement-breakpoint
ALTER TABLE `domains` ADD `paused_at` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `paused_reason` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `resumed_at` text;--> statement-breakpoint
ALTER TABLE `org_sending` ADD `marketing_tenant_name` text;--> statement-breakpoint
ALTER TABLE `org_sending` ADD `marketing_tenant_arn` text;--> statement-breakpoint
ALTER TABLE `org_sending` ADD `marketing_configuration_set` text;--> statement-breakpoint
ALTER TABLE `org_sending` ADD `marketing_tenant_status` text;--> statement-breakpoint
ALTER TABLE `org_sending` ADD `paused_at` text;--> statement-breakpoint
ALTER TABLE `org_sending` ADD `paused_by` text;--> statement-breakpoint
ALTER TABLE `org_sending` ADD `paused_reason` text;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `down_since` text;--> statement-breakpoint
-- Brands: an organization's other brands have no people, keys or webhooks of their own; its
-- members, keys and webhooks cover them all.
UPDATE `api_keys` SET `organization_id` = (SELECT `parent_id` FROM `managed_organizations` WHERE `managed_organizations`.`organization_id` = `api_keys`.`organization_id`) WHERE `organization_id` IN (SELECT `organization_id` FROM `managed_organizations`);--> statement-breakpoint
UPDATE `webhooks` SET `organization_id` = (SELECT `parent_id` FROM `managed_organizations` WHERE `managed_organizations`.`organization_id` = `webhooks`.`organization_id`) WHERE `organization_id` IN (SELECT `organization_id` FROM `managed_organizations`);--> statement-breakpoint
UPDATE `webhook_deliveries` SET `organization_id` = (SELECT `parent_id` FROM `managed_organizations` WHERE `managed_organizations`.`organization_id` = `webhook_deliveries`.`organization_id`) WHERE `organization_id` IN (SELECT `organization_id` FROM `managed_organizations`);--> statement-breakpoint
UPDATE `api_requests` SET `organization_id` = (SELECT `parent_id` FROM `managed_organizations` WHERE `managed_organizations`.`organization_id` = `api_requests`.`organization_id`) WHERE `organization_id` IN (SELECT `organization_id` FROM `managed_organizations`);--> statement-breakpoint
DELETE FROM `invitation` WHERE `organization_id` IN (SELECT `organization_id` FROM `managed_organizations`);--> statement-breakpoint
DELETE FROM `member` WHERE `organization_id` IN (SELECT `organization_id` FROM `managed_organizations`);
--> statement-breakpoint
UPDATE `session` SET `active_organization_id` = (SELECT `parent_id` FROM `managed_organizations` WHERE `managed_organizations`.`organization_id` = `session`.`active_organization_id`) WHERE `active_organization_id` IN (SELECT `organization_id` FROM `managed_organizations`);
