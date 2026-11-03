CREATE TABLE `org_aws_moves` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`to_access_key_id` text,
	`to_secret_encrypted` text,
	`to_region` text NOT NULL,
	`to_account_id` text NOT NULL,
	`to_topic_arn` text,
	`subscription_confirmed_at` text,
	`max_send_rate` real,
	`error` text,
	`started_by` text,
	`started_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `domains` ADD `move_dkim_tokens` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `move_status` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `move_ses_owned` integer;--> statement-breakpoint
ALTER TABLE `org_aws_accounts` ADD `credentials_error` text;--> statement-breakpoint
ALTER TABLE `org_aws_accounts` ADD `credentials_error_at` text;--> statement-breakpoint
ALTER TABLE `org_aws_accounts` ADD `max_send_rate` real;--> statement-breakpoint
ALTER TABLE `org_aws_accounts` ADD `costs` text;--> statement-breakpoint
ALTER TABLE `org_aws_accounts` ADD `inbound_bucket` text;--> statement-breakpoint
ALTER TABLE `org_aws_accounts` ADD `inbound_rule_set` text;