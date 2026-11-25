-- B2B Companies / Accounts
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL REFERENCES `organization`(`id`) ON DELETE cascade,
	`name` text NOT NULL,
	`domain` text,
	`plan` text,
	`mrr` real,
	`seats` integer,
	`renewal_at` text,
	`website` text,
	`notes` text,
	`properties` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `companies_org_idx` ON `companies` (`organization_id`, `updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_domain_uidx` ON `companies` (`organization_id`, `domain`) WHERE `domain` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `contacts` ADD `company_id` text REFERENCES `companies`(`id`) ON DELETE set null;
--> statement-breakpoint
CREATE INDEX `contacts_company_idx` ON `contacts` (`company_id`);
--> statement-breakpoint
-- Native Stripe / Polar / LemonSqueezy billing webhook connectors
CREATE TABLE `billing_connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL REFERENCES `organization`(`id`) ON DELETE cascade,
	`provider` text NOT NULL,
	`name` text NOT NULL,
	`secret_encrypted` text NOT NULL,
	`secret_hint` text NOT NULL,
	`enabled` integer NOT NULL DEFAULT 1,
	`events_processed` integer NOT NULL DEFAULT 0,
	`last_event_at` text,
	`last_error` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `billing_connectors_org_idx` ON `billing_connectors` (`organization_id`);
--> statement-breakpoint
-- Conversation <-> GitHub / Linear issue links
CREATE TABLE `conversation_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL REFERENCES `organization`(`id`) ON DELETE cascade,
	`conversation_id` text NOT NULL REFERENCES `conversations`(`id`) ON DELETE cascade,
	`provider` text NOT NULL DEFAULT 'github',
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`status` text NOT NULL DEFAULT 'open',
	`reopen_on_close` integer NOT NULL DEFAULT 1,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversation_issues_conv_idx` ON `conversation_issues` (`conversation_id`);
--> statement-breakpoint
CREATE INDEX `conversation_issues_ext_idx` ON `conversation_issues` (`organization_id`, `provider`, `external_id`);
--> statement-breakpoint
-- Inbound integration secrets (GitHub, Linear, two-way Slack, WhatsApp Cloud API)
CREATE TABLE `org_webhook_integrations` (
	`organization_id` text NOT NULL REFERENCES `organization`(`id`) ON DELETE cascade,
	`kind` text NOT NULL,
	`secret_encrypted` text,
	`secret_hint` text,
	`config` text,
	`enabled` integer NOT NULL DEFAULT 1,
	`updated_by` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`organization_id`, `kind`)
);
--> statement-breakpoint
-- Widget Changelog / Newsfeed emoji reactions
CREATE TABLE `changelog_reactions` (
	`broadcast_id` text NOT NULL,
	`emoji` text NOT NULL,
	`count` integer NOT NULL DEFAULT 0,
	PRIMARY KEY(`broadcast_id`, `emoji`)
);
--> statement-breakpoint
-- Optional pluggable email transport per brand (Resend / Postmark fallback alongside Amazon SES)
CREATE TABLE `brand_transports` (
	`organization_id` text PRIMARY KEY NOT NULL REFERENCES `organization`(`id`) ON DELETE cascade,
	`provider` text NOT NULL DEFAULT 'ses',
	`api_key_encrypted` text,
	`api_key_hint` text,
	`enabled` integer NOT NULL DEFAULT 0,
	`updated_by` text,
	`updated_at` text NOT NULL
);
