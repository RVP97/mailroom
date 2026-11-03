import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db";
import { uploadMedia } from "@/server/media";
import { orgMiddleware } from "@/server/middleware";
import { brandLooks } from "@/server/signup-forms";
import { NO_PERMISSION_MESSAGE, type Permission } from "@/lib/permissions";
import { call } from "./call";

/** Who builds what images go in: emails, templates, the brand kit, newsletters, brands. */
const UPLOADERS: Permission[] = [
	"broadcasts:edit",
	"templates:edit",
	"library:edit",
	"newsletters:edit",
	"brands:edit",
	"forms:edit",
	"settings:manage",
];

/** An image for an email, from the email editor. */
export const uploadMediaFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(z.object({ data: z.string().max(4_500_000) }))
	.handler(({ data, context }) =>
		call(() => {
			if (!UPLOADERS.some((p) => context.access.can(p))) throw new Response(NO_PERMISSION_MESSAGE, { status: 403 });
			return uploadMedia(context.organizationId, data.data);
		}),
	);

/** The organization's logo and name, for the email editor's logo block and starting designs. */
export const emailLookFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }) => {
		const id = context.organizationId;
		const [logos, org] = await Promise.all([
			brandLooks([id]),
			db
				.select({ name: schema.organization.name })
				.from(schema.organization)
				.where(eq(schema.organization.id, id))
				.get(),
		]);
		const logo = logos[id] ?? null;
		// Most inboxes don't show SVG.
		return { logo: logo && !/\.svg(\?|$)/i.test(logo) ? logo : null, name: org?.name ?? "" };
	});
