CREATE TABLE `unsubscribes` (
	`organization_id` text NOT NULL,
	`group` text NOT NULL,
	`address` text NOT NULL,
	`email_id` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`organization_id`, `group`, `address`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `unsubscribes_org_created_idx` ON `unsubscribes` (`organization_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `emails` ADD `unsubscribe_group` text;