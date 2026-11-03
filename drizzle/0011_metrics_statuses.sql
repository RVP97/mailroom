CREATE TABLE `domain_stats` (
	`organization_id` text NOT NULL,
	`day` text NOT NULL,
	`domain` text NOT NULL,
	`sent` integer DEFAULT 0 NOT NULL,
	`delivered` integer DEFAULT 0 NOT NULL,
	`bounced` integer DEFAULT 0 NOT NULL,
	`soft_bounced` integer DEFAULT 0 NOT NULL,
	`complained` integer DEFAULT 0 NOT NULL,
	`opened` integer DEFAULT 0 NOT NULL,
	`clicked` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`delayed` integer DEFAULT 0 NOT NULL,
	`suppressed` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`organization_id`, `day`, `domain`)
);
--> statement-breakpoint
ALTER TABLE `daily_stats` ADD `suppressed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Soft bounces get their own status (they were "failed"). The counters below are rebuilt from the
-- emails kept, by the day they were created in America/Mexico_City (this deployment's TIMEZONE).
UPDATE `emails` SET `status` = 'soft_bounced' WHERE `status` = 'failed' AND `bounce_type` LIKE 'Transient%';
--> statement-breakpoint
INSERT INTO `daily_stats` (`organization_id`, `day`, `suppressed`, `failed`)
SELECT `organization_id`, date(`created_at`, '-6 hours'),
	SUM(`status` = 'suppressed'), SUM(`status` = 'failed' AND `message_id` IS NULL)
FROM `emails` WHERE `status` IN ('suppressed', 'failed')
GROUP BY 1, 2
ON CONFLICT (`organization_id`, `day`) DO UPDATE SET `suppressed` = `suppressed` + excluded.`suppressed`, `failed` = `failed` + excluded.`failed`;
--> statement-breakpoint
INSERT INTO `domain_stats` (`organization_id`, `day`, `domain`, `sent`, `delivered`, `bounced`, `soft_bounced`, `complained`, `opened`, `clicked`, `failed`, `suppressed`)
SELECT `organization_id`, date(`created_at`, '-6 hours'),
	lower(trim(replace(substr(`from`, instr(`from`, '@') + 1), '>', ''))),
	SUM(`sent_at` IS NOT NULL),
	SUM(`delivered_at` IS NOT NULL),
	SUM(`bounced_at` IS NOT NULL AND coalesce(`bounce_type`, '') NOT LIKE 'Transient%'),
	SUM(coalesce(`bounce_type`, '') LIKE 'Transient%'),
	SUM(`complained_at` IS NOT NULL),
	SUM(`opened_at` IS NOT NULL),
	SUM(`clicked_at` IS NOT NULL),
	SUM(`status` = 'failed'),
	SUM(`status` = 'suppressed')
FROM `emails` WHERE instr(`from`, '@') > 0
GROUP BY 1, 2, 3;
