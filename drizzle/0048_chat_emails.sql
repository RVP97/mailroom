ALTER TABLE `chat_widgets` ADD `email_team` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_widgets` ADD `email_team_after` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_widgets` ADD `email_visitor` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_widgets` ADD `email_visitor_after` integer DEFAULT 3 NOT NULL;