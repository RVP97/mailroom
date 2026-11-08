CREATE TABLE `help_articles` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`category` text,
	`design` text,
	`html` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	`helpful` integer DEFAULT 0 NOT NULL,
	`unhelpful` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`published_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `help_articles_slug_idx` ON `help_articles` (`organization_id`,`slug`);--> statement-breakpoint
CREATE INDEX `help_articles_org_idx` ON `help_articles` (`organization_id`,`status`);--> statement-breakpoint
CREATE TABLE `help_centers` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`intro` text,
	`enabled` integer DEFAULT true NOT NULL,
	`accent` text,
	`updated_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `help_centers_slug_unique` ON `help_centers` (`slug`);--> statement-breakpoint
CREATE TABLE `help_gaps` (
	`organization_id` text NOT NULL,
	`query` text NOT NULL,
	`example` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`source` text NOT NULL,
	`last_at` text NOT NULL,
	PRIMARY KEY(`organization_id`, `query`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `help_gaps_last_idx` ON `help_gaps` (`organization_id`,`last_at`);