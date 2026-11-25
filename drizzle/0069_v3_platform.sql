-- Mailroom 3.0 platform expansion:
-- Live visitor session context, domain warm-up ramp, AI Knowledge Sources & Custom Actions,
-- Public Status Page components/incidents, and B2B Customer Support Portal tokens.

ALTER TABLE `conversations` ADD COLUMN `visitor_context` text;
--> statement-breakpoint
ALTER TABLE `domains` ADD COLUMN `warmup` text;
--> statement-breakpoint
CREATE INDEX `emails_org_sent_idx` ON `emails` (`organization_id`, `sent_at`);
--> statement-breakpoint
CREATE TABLE `org_public_pages` (
	`organization_id` text PRIMARY KEY NOT NULL REFERENCES `organization`(`id`) ON DELETE cascade,
	`status_page_enabled` integer NOT NULL DEFAULT 0,
	`portal_enabled` integer NOT NULL DEFAULT 0,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_knowledge_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL REFERENCES `organization`(`id`) ON DELETE cascade,
	`kind` text NOT NULL DEFAULT 'url',
	`title` text NOT NULL,
	`url` text,
	`content` text,
	`chunks_count` integer NOT NULL DEFAULT 0,
	`status` text NOT NULL DEFAULT 'ready',
	`last_error` text,
	`last_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_knowledge_sources_org_idx` ON `ai_knowledge_sources` (`organization_id`, `updated_at`);
--> statement-breakpoint
CREATE TABLE `ai_knowledge_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL REFERENCES `ai_knowledge_sources`(`id`) ON DELETE cascade,
	`organization_id` text NOT NULL REFERENCES `organization`(`id`) ON DELETE cascade,
	`title` text NOT NULL,
	`url` text,
	`content` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_knowledge_chunks_org_idx` ON `ai_knowledge_chunks` (`organization_id`, `source_id`);
--> statement-breakpoint
CREATE TABLE `ai_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL REFERENCES `organization`(`id`) ON DELETE cascade,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`method` text NOT NULL DEFAULT 'GET',
	`url` text NOT NULL,
	`headers_encrypted` text,
	`body_template` text,
	`enabled` integer NOT NULL DEFAULT 1,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_actions_org_idx` ON `ai_actions` (`organization_id`);
--> statement-breakpoint
CREATE TABLE `status_components` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL REFERENCES `organization`(`id`) ON DELETE cascade,
	`name` text NOT NULL,
	`description` text,
	`status` text NOT NULL DEFAULT 'operational',
	`position` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `status_components_org_idx` ON `status_components` (`organization_id`, `position`);
--> statement-breakpoint
CREATE TABLE `status_incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL REFERENCES `organization`(`id`) ON DELETE cascade,
	`title` text NOT NULL,
	`impact` text NOT NULL DEFAULT 'minor',
	`status` text NOT NULL DEFAULT 'investigating',
	`component_ids` text,
	`resolved_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `status_incidents_org_idx` ON `status_incidents` (`organization_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `status_incident_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL REFERENCES `status_incidents`(`id`) ON DELETE cascade,
	`status` text NOT NULL,
	`message` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `status_incident_updates_inc_idx` ON `status_incident_updates` (`incident_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `portal_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL REFERENCES `organization`(`id`) ON DELETE cascade,
	`kind` text NOT NULL DEFAULT 'login',
	`email` text NOT NULL,
	`company_id` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `portal_tokens_org_email_idx` ON `portal_tokens` (`organization_id`, `email`);
