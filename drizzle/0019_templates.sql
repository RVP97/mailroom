CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`alias` text,
	`draft` text NOT NULL,
	`published` text,
	`published_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `templates_org_idx` ON `templates` (`organization_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `templates_alias_uidx` ON `templates` (`organization_id`,`alias`);--> statement-breakpoint
ALTER TABLE `emails` ADD `template_id` text;