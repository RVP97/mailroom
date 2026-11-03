ALTER TABLE `automation_runs` ADD `path` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `design` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `ab_test` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `test_ends_at` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `local_time` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `resend_of` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `timezone` text;--> statement-breakpoint
ALTER TABLE `emails` ADD `variant` integer;