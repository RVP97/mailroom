ALTER TABLE `chat_widgets` ADD `files_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_widgets` ADD `file_kinds` text DEFAULT '["images","pdf","documents"]' NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_widgets` ADD `file_max_mb` integer DEFAULT 10 NOT NULL;