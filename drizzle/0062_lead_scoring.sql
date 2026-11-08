CREATE TABLE `lead_scoring` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`rules` text NOT NULL,
	`days` integer DEFAULT 90 NOT NULL,
	`hot` integer DEFAULT 50 NOT NULL,
	`warm` integer DEFAULT 20 NOT NULL,
	`updated_by` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
