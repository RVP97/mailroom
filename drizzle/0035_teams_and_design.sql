CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text,
	`subject_name` text,
	`detail` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `activity_org_created_idx` ON `activity` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_subject_idx` ON `activity` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `brand_kits` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`kit` text NOT NULL,
	`updated_by` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`user_id` text NOT NULL,
	`body` text NOT NULL,
	`block_id` text,
	`kind` text DEFAULT 'comment' NOT NULL,
	`resolved_at` text,
	`resolved_by` text,
	`created_at` text NOT NULL,
	`updated_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `comments_subject_idx` ON `comments` (`subject_type`,`subject_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `content_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`user_id` text,
	`snapshot` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `content_versions_subject_idx` ON `content_versions` (`subject_type`,`subject_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `saved_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`blocks` text NOT NULL,
	`created_by` text,
	`updated_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `saved_sections_org_idx` ON `saved_sections` (`organization_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `organization_role` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`role` text NOT NULL,
	`permission` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`all_permissions` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_role_org_role_uidx` ON `organization_role` (`organization_id`,`role`);--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `review` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `review_requested_by` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `review_requested_at` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `reviewed_by` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `reviewed_at` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `review_hash` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `created_by` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `updated_by` text;--> statement-breakpoint
ALTER TABLE `organization_settings` ADD `require_approval` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `member` ADD `extra_permissions` text;--> statement-breakpoint
ALTER TABLE `member` ADD `revoked_permissions` text;