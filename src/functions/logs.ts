import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { maskDigits } from "@/lib/roles";
import { db, schema } from "@/server/db";
import { requestLogRetentionDays } from "@/server/env";
import { orgMiddleware } from "@/server/middleware";
import { getRequest, listRequests } from "@/server/request-logs";

/** The Logs page: the organization's calls to the public API. */

const keysOf = (organizationId: string) =>
	db
		.select({
			id: schema.apiKeys.id,
			name: schema.apiKeys.name,
			permission: schema.apiKeys.permission,
		})
		.from(schema.apiKeys)
		.where(eq(schema.apiKeys.organization_id, organizationId));

export const listLogsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(
		z.object({
			search: z.string().nullish(),
			status: z.enum(["2xx", "4xx", "5xx"]).nullish(),
			key: z.string().nullish(),
			days: z.number().int().min(1).max(90).nullish(),
			before: z.string().nullish(),
		}),
	)
	.handler(async ({ data, context }) => {
		const [page, keys] = await Promise.all([
			listRequests(context.organizationId, {
				search: data.search,
				status: data.status,
				apiKeyId: data.key,
				days: data.days,
				before: data.before,
				limit: 50,
			}),
			keysOf(context.organizationId),
		]);
		return { ...page, keys, retention_days: requestLogRetentionDays() };
	});

export const getLogFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(async ({ data, context }) => {
		const log = await getRequest(context.organizationId, data.id);
		if (!log)
			throw new Response("This log doesn't exist, or is past its retention", { status: 404 });
		const [key, email] = await Promise.all([
			log.api_key_id
				? db
						.select({
							id: schema.apiKeys.id,
							name: schema.apiKeys.name,
							permission: schema.apiKeys.permission,
						})
						.from(schema.apiKeys)
						.where(eq(schema.apiKeys.id, log.api_key_id))
						.get()
				: undefined,
			log.email_id
				? db
						.select({ id: schema.emails.id, subject: schema.emails.subject })
						.from(schema.emails)
						.where(
							and(
								eq(schema.emails.id, log.email_id),
								eq(schema.emails.organization_id, context.organizationId),
							),
						)
						.get()
				: undefined,
		]);
		// The bodies hold what was sent (codes, card numbers): dotted like the email itself.
		if (context.masked)
			return {
				...log,
				request_body:
					log.request_body == null ? log.request_body : maskDigits(log.request_body),
				response_body:
					log.response_body == null ? log.response_body : maskDigits(log.response_body),
				key: key ?? null,
				email: email ? { ...email, subject: maskDigits(email.subject) } : null,
			};
		return { ...log, key: key ?? null, email: email ?? null };
	});
