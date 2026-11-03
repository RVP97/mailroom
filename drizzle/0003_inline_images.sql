CREATE TABLE `inline_images` (
	`organization_id` text NOT NULL,
	`hash` text NOT NULL,
	`content_type` text NOT NULL,
	`bytes` blob NOT NULL,
	`last_used_at` text NOT NULL,
	PRIMARY KEY(`organization_id`, `hash`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `inline_images_last_used` ON `inline_images` (`last_used_at`);