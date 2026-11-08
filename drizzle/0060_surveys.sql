CREATE TABLE `survey_responses` (
	`id` text PRIMARY KEY NOT NULL,
	`survey_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`contact_id` text,
	`email` text,
	`score` integer,
	`choice` text,
	`comment` text,
	`source` text NOT NULL,
	`source_id` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `survey_responses_one_idx` ON `survey_responses` (`survey_id`,`contact_id`,`source_id`);--> statement-breakpoint
CREATE INDEX `survey_responses_survey_idx` ON `survey_responses` (`survey_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `survey_responses_contact_idx` ON `survey_responses` (`contact_id`);--> statement-breakpoint
CREATE TABLE `surveys` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`question` text NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`low_label` text,
	`high_label` text,
	`comment_prompt` text,
	`thanks` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `surveys_org_idx` ON `surveys` (`organization_id`);