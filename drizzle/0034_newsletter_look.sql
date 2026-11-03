ALTER TABLE `newsletters` ADD `look` text;--> statement-breakpoint
ALTER TABLE `newsletters` ADD `rss_style` text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE `newsletters` ADD `rss_intro` text;