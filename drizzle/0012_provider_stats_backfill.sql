-- Stats by mailbox provider started with brands (2026-10-30), so Overview showed a few emails per
-- provider while its link opened all of them. Rebuilt from the emails kept, like domain_stats: by
-- the first recipient, on the day it was created in America/Mexico_City.
DELETE FROM `provider_stats`;
--> statement-breakpoint
INSERT INTO `provider_stats` (`organization_id`, `day`, `provider`, `sent`, `delivered`, `bounced`, `complained`, `opened`)
SELECT `organization_id`, `day`,
	CASE
		WHEN `d` IN ('gmail.com', 'googlemail.com') THEN 'gmail'
		WHEN `d` IN ('outlook.com', 'hotmail.com', 'hotmail.es', 'hotmail.com.mx', 'live.com', 'live.com.mx', 'msn.com') THEN 'outlook'
		WHEN `d` IN ('yahoo.com', 'yahoo.com.mx', 'yahoo.es', 'ymail.com', 'rocketmail.com', 'aol.com') THEN 'yahoo'
		WHEN `d` IN ('icloud.com', 'me.com', 'mac.com') THEN 'icloud'
		ELSE 'other'
	END,
	SUM(`sent_at` IS NOT NULL),
	SUM(`delivered_at` IS NOT NULL),
	SUM(`status` = 'bounced'),
	SUM(`complained_at` IS NOT NULL),
	SUM(`opened_at` IS NOT NULL)
FROM (
	SELECT *, date(`created_at`, '-6 hours') AS `day`,
		lower(trim(replace(substr(json_extract(`to`, '$[0]'), instr(json_extract(`to`, '$[0]'), '@') + 1), '>', ''))) AS `d`
	FROM `emails` WHERE `sent_at` IS NOT NULL
)
GROUP BY 1, 2, 3;
