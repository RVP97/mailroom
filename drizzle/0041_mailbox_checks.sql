CREATE TABLE `mailbox_checks` (
	`address` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`checked_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mailbox_checks_checked_idx` ON `mailbox_checks` (`checked_at`);--> statement-breakpoint
-- Everyone SES already delivered to is known: Emailable is only asked about first-time addresses.
INSERT OR IGNORE INTO `mailbox_checks` (`address`, `state`, `checked_at`)
SELECT lower(`recipient`), 'delivered', max(`at`) FROM `email_events`
WHERE `type` = 'email.delivered' AND `recipient` IS NOT NULL GROUP BY lower(`recipient`);
