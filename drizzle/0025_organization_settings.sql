CREATE TABLE `organization_settings` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`archive` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL
);
