CREATE TABLE `subscriber_pages` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`look` text NOT NULL,
	`updated_by` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
