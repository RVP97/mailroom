CREATE TABLE `domain_health` (
	`domain_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`problems` text NOT NULL,
	`listings` text NOT NULL,
	`checked_at` text NOT NULL,
	`alerted` text,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
