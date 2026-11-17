ALTER TABLE `organization` ADD `handle` text;--> statement-breakpoint
CREATE UNIQUE INDEX `organization_handle_unique` ON `organization` (`handle`);--> statement-breakpoint
-- Every organization and brand gets its URL handle (src/lib/org-handle.ts): 4 hex characters, a
-- digit from 2-9 (so it always has one) and 1 more hex character. New ones get the app's own shape.
UPDATE `organization` SET `handle` = lower(hex(randomblob(2))) || substr('23456789', (abs(random()) % 8) + 1, 1) || substr(lower(hex(randomblob(1))), 1, 1) WHERE `handle` IS NULL;
