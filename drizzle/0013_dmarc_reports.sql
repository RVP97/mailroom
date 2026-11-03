CREATE TABLE `dmarc_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter` text NOT NULL,
	`report_id` text NOT NULL,
	`domain` text NOT NULL,
	`policy` text,
	`begin_at` text NOT NULL,
	`end_at` text NOT NULL,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dmarc_reports_reporter_id_uidx` ON `dmarc_reports` (`reporter`,`report_id`);--> statement-breakpoint
CREATE INDEX `dmarc_reports_domain_idx` ON `dmarc_reports` (`domain`,`begin_at`);--> statement-breakpoint
CREATE TABLE `dmarc_rows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`report_id` text NOT NULL,
	`header_from` text NOT NULL,
	`begin_at` text NOT NULL,
	`source_ip` text NOT NULL,
	`count` integer NOT NULL,
	`disposition` text,
	`dkim` text,
	`spf` text,
	`dkim_domain` text,
	`spf_domain` text,
	FOREIGN KEY (`report_id`) REFERENCES `dmarc_reports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dmarc_rows_from_idx` ON `dmarc_rows` (`header_from`,`begin_at`);--> statement-breakpoint
CREATE INDEX `dmarc_rows_report_idx` ON `dmarc_rows` (`report_id`);