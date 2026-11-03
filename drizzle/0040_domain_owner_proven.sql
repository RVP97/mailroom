ALTER TABLE `domains` ADD `owner_proven` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Domains already verified, and those Mailroom created, never need the new TXT proof.
UPDATE `domains` SET `owner_proven` = true WHERE `status` = 'verified' OR `ses_owned` = true;
