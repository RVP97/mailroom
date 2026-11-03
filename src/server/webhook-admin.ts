import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db";
import { notFound } from "./errors";
import { iso } from "./time";
import { forgetHooks, newSecret, WEBHOOK_EVENTS } from "./webhooks";

const input = z.object({
	url: z
		.string()
		.url()
		.refine(
			(u) => u.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)/.test(u),
			"the URL must use https",
		),
	events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
	enabled: z.boolean().optional(),
});

export async function createWebhook(organizationId: string, raw: unknown) {
	const v = input.parse(raw);
	const row = {
		id: crypto.randomUUID(),
		organization_id: organizationId,
		url: v.url,
		events: v.events,
		secret: newSecret(),
		enabled: v.enabled ?? true,
		created_at: iso(),
	};
	await db.insert(schema.webhooks).values(row);
	forgetHooks(organizationId);
	return { object: "webhook", ...row };
}

export async function updateWebhook(organizationId: string, id: string, raw: unknown) {
	const v = input.partial().parse(raw);
	const [row] = await db
		.update(schema.webhooks)
		.set(v)
		.where(and(eq(schema.webhooks.id, id), eq(schema.webhooks.organization_id, organizationId)))
		.returning();
	if (!row) throw notFound("Webhook");
	forgetHooks(organizationId);
	const { secret: _s, ...rest } = row;
	return { object: "webhook", ...rest };
}

export async function deleteWebhook(organizationId: string, id: string) {
	const [row] = await db
		.delete(schema.webhooks)
		.where(and(eq(schema.webhooks.id, id), eq(schema.webhooks.organization_id, organizationId)))
		.returning({ id: schema.webhooks.id });
	if (!row) throw notFound("Webhook");
	forgetHooks(organizationId);
}
