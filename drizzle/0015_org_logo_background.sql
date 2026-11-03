CREATE TABLE `__new_org_logos` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`content_type` text,
	`data` text,
	`background` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_org_logos`("organization_id", "content_type", "data", "background", "updated_at") SELECT "organization_id", "content_type", "data", NULL, "updated_at" FROM `org_logos`;--> statement-breakpoint
DROP TABLE `org_logos`;--> statement-breakpoint
ALTER TABLE `__new_org_logos` RENAME TO `org_logos`;
