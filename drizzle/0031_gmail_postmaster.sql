CREATE TABLE `postmaster_domains` (
	`domain_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`status` text,
	`token` text,
	`compliance` text,
	`error` text,
	`checked_at` text,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `postmaster_stats` (
	`domain` text NOT NULL,
	`organization_id` text NOT NULL,
	`day` text NOT NULL,
	`spam_rate` real,
	`spf_rate` real,
	`dkim_rate` real,
	`dmarc_rate` real,
	`tls_rate` real,
	`delivery_error_rate` real,
	PRIMARY KEY(`domain`, `day`)
);
