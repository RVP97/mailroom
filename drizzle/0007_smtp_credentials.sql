CREATE TABLE `smtp_credentials` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`iam_user` text NOT NULL,
	`access_key_id` text NOT NULL,
	`region` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
