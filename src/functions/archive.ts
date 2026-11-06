import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	archiveBucket,
	archiveEnabled,
	archiveLink,
	listArchive,
	setArchiveEnabled,
} from "@/server/archive";
import { brandIds, brandNames } from "@/server/brands";
import { bodyRetentionDays, inboundRetentionDays, logRetentionDays } from "@/server/env";
import { can, orgMiddleware } from "@/server/middleware";

/** The long-term archive on the settings page: the latest files of each brand, with links. */
export const listArchiveFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }) => {
		const ids = await brandIds(context.organizationId);
		const names = await brandNames(ids);
		const lists = await Promise.all(
			ids.slice(0, 20).map((id) => listArchive(id, { limit: 60 })),
		);
		// The files are the emails as sent and received, digits and all: only for members who see them.
		const files = context.masked
			? []
			: lists
					.flatMap((l) => l.data)
					.sort((a, b) => b.day.localeCompare(a.day) || a.key.localeCompare(b.key))
					.slice(0, 100);
		return {
			/** An R2 bucket is bound (and ARCHIVE_EMAILS isn't false). */
			available: !!archiveBucket(),
			/** This organization keeps its emails there (off until someone turns it on). */
			on: await archiveEnabled(context.organizationId),
			retention: {
				bodies: bodyRetentionDays(),
				emails: logRetentionDays(),
				received: inboundRetentionDays(),
			},
			files: await Promise.all(
				files.map(async (f) => ({
					...f,
					brand: names.get(f.brand_id) ?? f.brand_id,
					url: await archiveLink(f.key),
				})),
			),
		};
	});

/** Turns the organization's archive on or off (owners and admins). */
export const setArchiveFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(z.object({ on: z.boolean() }))
	.handler(async ({ data, context }) => {
		await setArchiveEnabled(context.organizationId, data.on);
		return { on: data.on };
	});
