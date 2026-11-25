CREATE TABLE `org_ai_settings` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'anthropic' NOT NULL,
	`model` text DEFAULT 'claude-sonnet-4-5' NOT NULL,
	`base_url` text,
	`api_key_encrypted` text,
	`api_key_hint` text,
	`copilot_enabled` integer DEFAULT true NOT NULL,
	`auto_mode` text DEFAULT 'off' NOT NULL,
	`system_prompt` text,
	`updated_by` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
