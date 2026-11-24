CREATE TABLE `user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`combine_digests` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
