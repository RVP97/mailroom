CREATE TABLE `api_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`api_key_id` text,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`query` text,
	`status` integer NOT NULL,
	`user_agent` text,
	`request_body` text,
	`response_body` text,
	`email_id` text,
	`duration_ms` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `api_requests_org_created_idx` ON `api_requests` (`organization_id`,`created_at`);