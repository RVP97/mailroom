ALTER TABLE `chat_widgets` ADD `identity_secret` text;--> statement-breakpoint
ALTER TABLE `chat_widgets` ADD `identity_required` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `visitor_user_id` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `visitor_attributes` text;--> statement-breakpoint
CREATE INDEX `conversations_chat_user_idx` ON `conversations` (`inbox_id`,`visitor_user_id`,`last_message_at`);