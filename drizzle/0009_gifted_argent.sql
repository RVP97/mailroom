CREATE TABLE `managed_organizations` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`parent_id` text NOT NULL,
	`external_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `managed_organizations_parent_idx` ON `managed_organizations` (`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `managed_organizations_external_uidx` ON `managed_organizations` (`parent_id`,`external_id`);