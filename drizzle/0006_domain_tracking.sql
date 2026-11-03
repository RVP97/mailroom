ALTER TABLE `domains` ADD `open_tracking` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `domains` ADD `click_tracking` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `domains` ADD `tracking_host` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `tracking_status` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `tracking_hostname_id` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `tracking_route_id` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `tracking_checked_at` text;