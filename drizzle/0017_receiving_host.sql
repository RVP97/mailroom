ALTER TABLE `domains` ADD `receiving_host` text;
--> statement-breakpoint
-- Domains already receiving receive at the domain itself (before prefixes).
UPDATE `domains` SET `receiving_host` = `name` WHERE `receiving` = 1;
