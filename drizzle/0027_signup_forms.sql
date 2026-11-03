CREATE TABLE `signup_forms` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`title` text NOT NULL,
	`segment_id` text,
	`topic_id` text,
	`from` text NOT NULL,
	`ask_name` integer DEFAULT true NOT NULL,
	`website` text,
	`redirect_url` text,
	`enabled` integer DEFAULT true NOT NULL,
	`signups` integer DEFAULT 0 NOT NULL,
	`confirmed` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `signup_forms_org_idx` ON `signup_forms` (`organization_id`);--> statement-breakpoint
CREATE TABLE `turnstile_widgets` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`sitekey` text NOT NULL,
	`secret` text NOT NULL,
	`domains` text NOT NULL,
	`error` text,
	`updated_at` text NOT NULL
);
