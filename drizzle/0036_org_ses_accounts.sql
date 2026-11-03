CREATE TABLE `org_aws_accounts` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`access_key_id` text NOT NULL,
	`secret_encrypted` text NOT NULL,
	`region` text NOT NULL,
	`account_id` text NOT NULL,
	`topic_arn` text,
	`subscription_confirmed_at` text,
	`last_event_at` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
