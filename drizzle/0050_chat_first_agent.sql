ALTER TABLE `chat_widgets` ADD `first_agent` text;--> statement-breakpoint
ALTER TABLE `chat_widgets` ADD `agent_wait` integer DEFAULT 5 NOT NULL;