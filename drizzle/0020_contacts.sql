CREATE TABLE `contact_properties` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`key` text NOT NULL,
	`type` text DEFAULT 'string' NOT NULL,
	`fallback_value` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_properties_key_uidx` ON `contact_properties` (`organization_id`,`key`);--> statement-breakpoint
CREATE TABLE `contact_segments` (
	`contact_id` text NOT NULL,
	`segment_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`segment_id`, `contact_id`),
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`segment_id`) REFERENCES `segments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contact_segments_contact_idx` ON `contact_segments` (`contact_id`);--> statement-breakpoint
CREATE TABLE `contact_topics` (
	`contact_id` text NOT NULL,
	`topic_id` text NOT NULL,
	`subscription` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`topic_id`, `contact_id`),
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contact_topics_contact_idx` ON `contact_topics` (`contact_id`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`first_name` text,
	`last_name` text,
	`unsubscribed` integer DEFAULT false NOT NULL,
	`properties` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_email_uidx` ON `contacts` (`organization_id`,`email`);--> statement-breakpoint
CREATE INDEX `contacts_org_created_idx` ON `contacts` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `segments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `segments_org_idx` ON `segments` (`organization_id`);--> statement-breakpoint
CREATE TABLE `topics` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`default_subscription` text DEFAULT 'opt_out' NOT NULL,
	`visibility` text DEFAULT 'public' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `topics_org_idx` ON `topics` (`organization_id`);