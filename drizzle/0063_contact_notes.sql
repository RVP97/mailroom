CREATE TABLE `contact_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`text` text NOT NULL,
	`author_type` text DEFAULT 'person' NOT NULL,
	`author_id` text,
	`author_name` text NOT NULL,
	`due_at` text,
	`assignee_id` text,
	`assignee_name` text,
	`done_at` text,
	`done_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contact_notes_contact_idx` ON `contact_notes` (`contact_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `contact_notes_due_idx` ON `contact_notes` (`organization_id`,`done_at`,`due_at`);