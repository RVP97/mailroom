CREATE TABLE `contact_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`name` text NOT NULL,
	`data` text,
	`source` text DEFAULT 'api' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contact_events_contact_idx` ON `contact_events` (`contact_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `contact_events_name_idx` ON `contact_events` (`organization_id`,`name`,`created_at`);--> statement-breakpoint
CREATE INDEX `contact_events_created_idx` ON `contact_events` (`created_at`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `contact_address` text;--> statement-breakpoint
CREATE INDEX `conversations_address_idx` ON `conversations` (`organization_id`,`contact_address`);--> statement-breakpoint
ALTER TABLE `emails` ADD `recipient` text;--> statement-breakpoint
CREATE INDEX `emails_recipient_idx` ON `emails` (`organization_id`,`recipient`,`created_at`);--> statement-breakpoint
UPDATE `conversations` SET `contact_address` = nullif(lower(trim(CASE
	WHEN `channel` = 'chat' THEN coalesce(`visitor_email`, '')
	WHEN instr(`contact`, '<') > 0 AND instr(`contact`, '>') > instr(`contact`, '<')
		THEN substr(`contact`, instr(`contact`, '<') + 1, instr(`contact`, '>') - instr(`contact`, '<') - 1)
	ELSE `contact`
END)), '') WHERE `contact_address` IS NULL;--> statement-breakpoint
UPDATE `emails` SET `recipient` = lower(trim(CASE
	WHEN instr(json_extract(`to`, '$[0]'), '<') > 0
		THEN substr(json_extract(`to`, '$[0]'), instr(json_extract(`to`, '$[0]'), '<') + 1,
			instr(json_extract(`to`, '$[0]'), '>') - instr(json_extract(`to`, '$[0]'), '<') - 1)
	ELSE json_extract(`to`, '$[0]')
END)) WHERE `recipient` IS NULL AND json_extract(`to`, '$[0]') IS NOT NULL;